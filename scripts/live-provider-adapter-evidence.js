#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const run = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

async function command(executable, args, options = {}) {
  try {
    const result = await run(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!options.allowFailure) throw error;
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function extract(archive, destination, scratch) {
  await mkdir(destination, { recursive: true });
  if (archive.endsWith('.zip')) {
    const script = path.join(scratch, 'extract.ps1');
    await writeFile(
      script,
      'param($Archive,$Destination)\n$ErrorActionPreference="Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n',
    );
    await command(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', script, archive, destination],
      { timeoutMs: 120_000 },
    );
  } else {
    await command('tar', ['-xzf', archive, '-C', destination], { timeoutMs: 120_000 });
  }
}

async function terminateTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await command('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      allowFailure: true,
      timeoutMs: 15_000,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function runInner(node, script, args, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn(node, [script, '--inner', ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    const timer = setTimeout(async () => {
      await terminateTree(child.pid).catch(() => {});
      reject(new Error('Provider adapter qualification exceeded its total time budget.'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Private-Node provider qualification exited ${code}.`));
    });
  });
}

async function inventory(root, relative = '') {
  const entries = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && entry.name === '.git') continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) entries.push(...(await inventory(root, name)));
    else if (entry.isFile())
      entries.push(
        `${name.replaceAll(path.sep, '/')}\0${sha256(await readFile(path.join(root, name)))}`,
      );
    else entries.push(`${name.replaceAll(path.sep, '/')}\0unsupported`);
  }
  return entries.sort();
}

function adapterDisposition(provider) {
  if (provider === 'cursor')
    return {
      status: 'unavailable',
      reason: 'Cursor IDE is manual-only and has no bounded CLI invocation plan.',
    };
  if (provider === 'cursor-cli' || provider === 'antigravity')
    return {
      status: 'partial',
      reason: `${provider} has no adapter-enforceable read-only invocation mode.`,
    };
  return null;
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const authenticationFailure = (value) =>
  /\b(?:login|logged in|sign[ -]?in|authenti\w*|unauthorized|credentials?|permission|approval|api key)\b/i.test(
    String(value ?? ''),
  );

function failed(reason) {
  return { status: 'failed', reason };
}

function blocked(reason) {
  return { status: 'blocked', reason };
}

function claudeCompletion(stdout, nonce) {
  let completion;
  try {
    completion = JSON.parse(stdout);
  } catch {
    return failed('Claude returned malformed JSON output.');
  }
  if (!isRecord(completion) || completion.type !== 'result')
    return failed('Claude omitted its structured result record.');
  if (completion.permission_denials !== undefined && !Array.isArray(completion.permission_denials))
    return failed('Claude returned malformed permission-denial metadata.');
  if (Array.isArray(completion.permission_denials) && completion.permission_denials.length > 0)
    return blocked('Claude reported a permission denial.');
  if (completion.is_error === true || completion.subtype !== 'success') {
    return authenticationFailure(completion.result)
      ? blocked('Claude reported an authentication failure.')
      : failed('Claude reported an unsuccessful result.');
  }
  if (typeof completion.result !== 'string' || completion.result.trim() !== nonce)
    return failed('Claude result omitted the exact correlation nonce.');
  return null;
}

function codexCompletion(stdout, nonce) {
  const records = [];
  for (const line of String(stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) return failed('Codex returned a non-object JSONL record.');
      records.push(parsed);
    } catch {
      return failed('Codex returned malformed JSONL output.');
    }
  }
  if (!records.length) return failed('Codex omitted its structured completion records.');
  const errorRecord = records.find((record) =>
    ['error', 'turn.failed'].includes(String(record.type)),
  );
  if (errorRecord) {
    const detail = JSON.stringify(errorRecord);
    return authenticationFailure(detail)
      ? blocked('Codex reported an authentication failure.')
      : failed('Codex reported an unsuccessful turn.');
  }
  if (!records.some((record) => record.type === 'turn.completed'))
    return failed('Codex omitted its turn completion record.');
  const message = records.findLast(
    (record) =>
      record.type === 'item.completed' &&
      isRecord(record.item) &&
      record.item.type === 'agent_message' &&
      typeof record.item.text === 'string',
  );
  if (!message || message.item.text.trim() !== nonce)
    return failed('Codex assistant result omitted the exact correlation nonce.');
  return null;
}

export function resultStatus(provider, result, nonce, sourceUnchanged) {
  if (!sourceUnchanged)
    return { status: 'failed', reason: 'Provider changed the disposable read-only fixture.' };
  if (result.status === 'timed-out' || result.status === 'cancelled')
    return { status: 'blocked', reason: `Bounded provider execution ${result.status}.` };
  if (result.status !== 'exited' || result.exitCode !== 0) {
    return authenticationFailure(result.stderr)
      ? blocked('Provider reported an authentication failure.')
      : failed(`Provider process ended as ${result.status}.`);
  }
  const completion =
    provider === 'claude'
      ? claudeCompletion(String(result.stdout ?? ''), nonce)
      : provider === 'codex'
        ? codexCompletion(String(result.stdout ?? ''), nonce)
        : failed(`Provider ${provider} has no structured completion parser.`);
  if (completion) return completion;
  return {
    status: 'passed',
    reason: 'Bounded correlated response completed without file changes.',
  };
}

async function inner(values) {
  const bundle = path.resolve(required(values.bundle, '--bundle'));
  const output = path.resolve(required(values.output, '--output'));
  const archiveSha256 = required(values['archive-sha256'], '--archive-sha256');
  const provider = required(values.provider, '--provider');
  const timeoutMs = Number(values.timeout ?? 120_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error('--timeout must be an integer from 1 to 120000.');
  const privateNode = path.join(
    bundle,
    'runtime',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const normalizePath = (value) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalizePath(process.execPath) !== normalizePath(privateNode))
    throw new Error('Qualification is not running under the extracted private Node runtime.');
  const app = path.join(bundle, 'app');
  const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'));
  if (manifest.dirty || !/^[a-f0-9]{40}$/i.test(manifest.commit))
    throw new Error('The extracted archive is not bound to a clean commit.');
  const packageDocument = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (packageDocument.version !== manifest.version)
    throw new Error('Bundle and application versions differ.');
  if (manifest.target !== `${process.platform}-${process.arch}`)
    throw new Error('Bundle target differs from the qualification host.');
  if (process.version !== `v${manifest.nodeVersion}`)
    throw new Error('The extracted private Node version differs from the bundle manifest.');

  const moduleAt = (relative) => pathToFileURL(path.join(app, relative)).href;
  const [
    { runProviderProcess, HOST_LOCAL_EXECUTION_PROFILE },
    claude,
    codex,
    cursorCli,
    cursorIde,
    antigravity,
  ] = await Promise.all([
    import(moduleAt('dist/src/runtime/process-runner.js')),
    import(moduleAt('dist/src/providers/claude.js')),
    import(moduleAt('dist/src/providers/codex.js')),
    import(moduleAt('dist/src/providers/cursor-cli.js')),
    import(moduleAt('dist/src/providers/cursor-ide.js')),
    import(moduleAt('dist/src/providers/antigravity.js')),
  ]);
  const adapters = new Map([
    ['claude', claude.CLAUDE_ADAPTER],
    ['codex', codex.codexAdapter],
    ['cursor-cli', cursorCli.cursorCliAdapter],
    ['cursor', cursorIde.cursorIdeAdapter],
    ['antigravity', antigravity.ANTIGRAVITY_ADAPTER],
  ]);
  const adapter = adapters.get(provider);
  if (!adapter) throw new Error(`Unknown provider: ${provider}.`);
  const disposition = adapterDisposition(provider);
  const base = await mkdtemp(path.join(os.tmpdir(), 'latchkit-provider-adapter-'));
  const fixture = path.join(base, 'fixture');
  const nonce = `LATCHKIT_ADAPTER_OK_${randomBytes(12).toString('hex')}`;
  const startedAt = new Date().toISOString();
  try {
    await mkdir(fixture);
    await writeFile(
      path.join(fixture, 'README.md'),
      'Disposable read-only provider adapter qualification fixture.\n',
    );
    const before = await inventory(fixture);
    let result = disposition;
    let processResult = null;
    if (!result) {
      const prompt = `Do not use tools or modify files. Reply with exactly this token and nothing else: ${nonce}`;
      let plan = adapter.operations.planInvocation({
        prompt,
        cwd: fixture,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
      });
      if (provider === 'claude') {
        plan = { ...plan, args: [...plan.args, '--permission-mode', 'plan'] };
      }
      const readOnly =
        provider === 'codex'
          ? plan.args.some(
              (argument, index) => argument === '--sandbox' && plan.args[index + 1] === 'read-only',
            )
          : plan.args.some(
              (argument, index) =>
                argument === '--permission-mode' && plan.args[index + 1] === 'plan',
            );
      if (!readOnly) throw new Error('Provider probe lacks an enforceable read-only mode.');
      if (plan.args.some((argument) => /^--model(?:=|$)/.test(argument)))
        throw new Error('Adapter qualification must not override the configured model.');
      processResult = await runProviderProcess({
        provider: adapter.contract,
        plan,
        executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
        timeoutMs,
        outputLimitBytes: 262_144,
      });
      result = resultStatus(
        provider,
        processResult,
        nonce,
        JSON.stringify(await inventory(fixture)) === JSON.stringify(before),
      );
    }
    const evidence = {
      schemaVersion: 1,
      kind: 'live-provider-adapter-qualification',
      startedAt,
      finishedAt: new Date().toISOString(),
      candidate: {
        archiveSha256,
        commit: manifest.commit,
        version: manifest.version,
        target: manifest.target,
        nodeVersion: manifest.nodeVersion,
        privateNodeVersion: process.version,
      },
      provider: {
        id: provider,
        contractDigest: sha256(JSON.stringify(adapter.contract)),
        invocationCapability: adapter.contract.capabilities.invocation.state,
        modelOverride: null,
        settingsPreserved: true,
      },
      bounds: { timeoutMs, maxProviderRuns: disposition ? 0 : 1, outputLimitBytes: 262_144 },
      result: {
        ...result,
        process:
          processResult === null
            ? null
            : { status: processResult.status, exitCode: processResult.exitCode },
        responseStored: false,
        commandStored: false,
        nonceStored: false,
        fixtureUnchanged: JSON.stringify(await inventory(fixture)) === JSON.stringify(before),
      },
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    if (result.status !== 'passed' && !['partial', 'unavailable'].includes(result.status))
      process.exitCode = 1;
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function outer(values) {
  if (values.authorized !== true)
    throw new Error('Live provider adapter evidence requires explicit --authorized.');
  const archive = path.resolve(required(values.artifact, '--artifact'));
  const archiveSha256 = required(values['artifact-sha256'], '--artifact-sha256');
  if (!/^[a-f0-9]{64}$/.test(archiveSha256))
    throw new Error('--artifact-sha256 must be a lowercase SHA-256 digest.');
  if (sha256(await readFile(archive)) !== archiveSha256)
    throw new Error('The supplied archive does not match --artifact-sha256.');
  const output = path.resolve(required(values.output, '--output'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-live-provider-'));
  try {
    const bundle = path.join(scratch, 'extracted-bundle');
    await extract(archive, bundle, scratch);
    const privateNode = path.join(
      bundle,
      'runtime',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    await runInner(
      privateNode,
      path.resolve(process.argv[1]),
      [
        '--bundle',
        bundle,
        '--archive-sha256',
        archiveSha256,
        '--provider',
        required(values.provider, '--provider'),
        '--timeout',
        String(values.timeout ?? '120000'),
        '--output',
        output,
      ],
      180_000,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      authorized: { type: 'boolean' },
      provider: { type: 'string' },
      timeout: { type: 'string' },
      output: { type: 'string' },
      artifact: { type: 'string' },
      'artifact-sha256': { type: 'string' },
      inner: { type: 'boolean' },
      bundle: { type: 'string' },
      'archive-sha256': { type: 'string' },
    },
  });
  await (values.inner ? inner(values) : outer(values));
}
