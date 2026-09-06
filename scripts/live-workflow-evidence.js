#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import {
  validateWorkflowProviderOptions,
  workflowProviderInnerArgs,
  workflowProviderInvocation,
} from './workflow-evidence-options.js';
import { fixtureGitScopeProof, workflowFailureEvidence } from './workflow-evidence-proof.js';
import { compareWorkflowChecks, fixturePlanScopeProof } from './workflow-plan-proof.js';

const run = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();

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

async function git(root, args) {
  return command('git', ['-C', root, ...args]);
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
      reject(new Error('Live workflow qualification exceeded its total time budget.'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Private-Node workflow qualification exited ${code}.`));
    });
  });
}

async function writeFixture(root) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'latchkit-live-workflow-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, 'REQUIREMENTS.md'),
    '# Accepted requirement\n\n`multiply(left, right)` returns the numeric product for positive, negative, and zero inputs. The accepted tests and requirements are immutable.\n',
  );
  await writeFile(
    path.join(root, 'src', 'calculator.js'),
    "export function multiply() {\n  throw new Error('not implemented');\n}\n",
  );
  await writeFile(
    path.join(root, 'test', 'calculator.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { multiply } from '../src/calculator.js';",
      '',
      "test('multiply returns the numeric product', () => {",
      '  assert.equal(multiply(3, 4), 12);',
      '  assert.equal(multiply(-2, 5), -10);',
      '  assert.equal(multiply(0, 99), 0);',
      '});',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(root, '.gitignore'), '.latchkit/\n');
}

async function inner(values) {
  const bundle = path.resolve(required(values.bundle, '--bundle'));
  const output = path.resolve(required(values.output, '--output'));
  const attemptId = required(values['attempt-id'], '--attempt-id');
  const archiveSha256 = required(values['archive-sha256'], '--archive-sha256');
  const app = path.join(bundle, 'app');
  const privateNode = path.join(
    bundle,
    'runtime',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const normalizePath = (value) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalizePath(process.execPath) !== normalizePath(privateNode))
    throw new Error('Inner qualification is not running under the extracted private Node runtime.');
  const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'));
  if (manifest.dirty || !/^[a-f0-9]{40}$/i.test(manifest.commit))
    throw new Error('The extracted archive is not bound to a clean candidate commit.');
  const packageDocument = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (packageDocument.version !== manifest.version)
    throw new Error('Bundle and application versions differ.');
  const privateNodeVersion = (await command(privateNode, ['--version'])).stdout.trim();
  if (privateNodeVersion !== `v${manifest.nodeVersion}`)
    throw new Error('The extracted private Node version differs from the bundle manifest.');

  const moduleAt = (relative) => pathToFileURL(path.join(app, relative)).href;
  const { createWorkflowController } = await import(moduleAt('dist/src/workflows/service.js'));
  const { policy_artifact_digest } = await import(moduleAt('dist/src/workflows/policy.js'));
  const { createTask, inspectTask } = await import(moduleAt('dist/src/task-state/service.js'));
  const { runProviderProcess } = await import(moduleAt('dist/src/runtime/process-runner.js'));
  const { validateAcceptanceDocument } = await import(moduleAt('dist/src/acceptance/contracts.js'));
  const { configureUsage, inspectUsage } = await import(moduleAt('dist/src/usage/service.js'));

  const base = await mkdtemp(path.join(os.tmpdir(), 'latchkit-live-workflow-inner-'));
  const root = path.join(base, 'fixture');
  const providerEvents = [];
  const processStarts = { inference: 0, versionProbe: 0, acceptance: 0 };
  const inferenceSessionIds = new Set();
  let controller;
  const startedAt = iso();
  let stage = 'fixture-setup';
  let workflow;
  let planDiagnostics;
  let failureCategory;
  try {
    await mkdir(root);
    await writeFixture(root);
    await command('git', ['init', '--initial-branch=main'], { cwd: root });
    await git(root, ['config', 'user.name', 'Latchkit Qualification']);
    await git(root, ['config', 'user.email', 'qualification@example.invalid']);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'fixture: accepted failing multiply requirement']);
    const fixtureHead = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    if (values['collect-usage']) await configureUsage(root, { enabled: true, retentionDays: 30 });
    const protectedPaths = (await git(root, ['ls-files', '-z'])).stdout
      .split('\0')
      .filter((name) => name && name !== 'src/calculator.js');
    const protectedFiles = new Map(
      await Promise.all(
        protectedPaths.map(async (name) => [name, sha256(await readFile(path.join(root, name)))]),
      ),
    );

    const immutable = {
      requirements: sha256(await readFile(path.join(root, 'REQUIREMENTS.md'))),
      tests: sha256(await readFile(path.join(root, 'test', 'calculator.test.js'))),
    };
    const task = await createTask(root, {
      title: 'Implement the accepted multiply requirement',
      criteria: [
        {
          description:
            'The immutable calculator test passes for positive, negative, and zero products.',
          required: true,
        },
      ],
      authorization: {
        source: 'user',
        scope: 'src/calculator.js only; requirements and tests are read-only',
        reference: `archive:${archiveSha256};commit:${manifest.commit}`,
      },
      mutationId: `event_${randomUUID()}`,
    });
    const exactChecks = validateAcceptanceDocument({
      schemaVersion: 1,
      checks: [
        {
          id: 'multiply-node-test',
          criterionId: task.criteria[0].id,
          label: 'Run the immutable multiply test',
          type: 'cli',
          timeoutMs: 30_000,
          outputLimitBytes: 262_144,
          plan: { executable: privateNode, args: ['--test'], cwd: root },
        },
      ],
    });
    const launch = async (options = {}) => {
      const kind =
        options.provider?.id !== 'codex'
          ? 'acceptance'
          : options.plan?.args?.length === 1 && options.plan.args[0] === '--version'
            ? 'versionProbe'
            : 'inference';
      const result = await runProviderProcess({
        ...workflowProviderInvocation(options, values),
        timeoutMs: Math.min(options.timeoutMs ?? 120_000, 120_000),
        outputLimitBytes: Math.min(options.outputLimitBytes ?? 1024 * 1024, 1024 * 1024),
        onEvent: (event) => {
          options.onEvent?.(event);
          providerEvents.push(event.type);
          if (event.type === 'process-start') processStarts[kind] += 1;
        },
      });
      if (kind === 'inference') {
        for (const line of (result.stdout ?? '').split(/\r?\n/)) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'thread.started' && typeof event.thread_id === 'string')
              inferenceSessionIds.add(event.thread_id);
          } catch {
            /* Non-JSON provider output is not usage evidence. */
          }
        }
      }
      return result;
    };
    controller = createWorkflowController({ root, launch });
    stage = 'requirements-plan';
    const started = await controller.run({
      taskId: task.id,
      providerId: 'codex',
      reviewProviderId: 'codex',
      executionAuthorized: true,
      checksDocument: exactChecks,
      prompt:
        'Implement only multiply in src/calculator.js for the accepted immutable REQUIREMENTS.md and test/calculator.test.js. Do not change any other file, dependency, configuration, test, or requirement. The supplied acceptance document is the only permitted check. Requirements, plan, and handoff are read-only phases. Return the workflow JSON shape exactly in every reasoning phase.',
    });
    const proposed = await controller.wait(started.taskId);
    workflow = proposed;
    if (proposed.status !== 'awaiting-approval' || !proposed.requirements || !proposed.plan) {
      throw new Error(`Workflow did not reach exact-plan approval: ${proposed.status}.`);
    }
    stage = 'plan-scope';
    planDiagnostics = {
      checks: compareWorkflowChecks(exactChecks, proposed.plan.checks),
      scope: fixturePlanScopeProof(proposed.plan.artifact),
    };
    if (!planDiagnostics.checks.equal) {
      failureCategory = 'plan-checks-mismatch';
      throw new Error('Generated plan changed the narrow predeclared acceptance document.');
    }
    if (!planDiagnostics.scope.fits) {
      failureCategory = 'plan-artifact-scope-mismatch';
      throw new Error('Generated plan does not fit the narrow approved fixture scope.');
    }

    stage = 'implementation-verification';
    await controller.approve({
      taskId: proposed.taskId,
      expectedRevision: proposed.revision,
      planDigest: proposed.plan.digest,
      requirementsDigest: proposed.requirements.digest,
      checksDigest: proposed.plan.checksDigest,
      scope: 'src/calculator.js only; requirements and tests are immutable',
      reference: `archive:${archiveSha256};commit:${manifest.commit};version:${manifest.version}`,
      mutationId: `event_${randomUUID()}`,
    });
    const completed = await controller.wait(proposed.taskId);
    workflow = completed;
    if (completed.status !== 'verified' || completed.phase !== 'handoff') {
      throw new Error(`Workflow did not reach verified handoff: ${completed.status}.`);
    }
    const packagedPolicyDigest = policy_artifact_digest([
      new URL(moduleAt('dist/src/workflows/service.js')),
      new URL(moduleAt('dist/src/reviews/orchestrator.js')),
    ]);
    if (completed.policyDigest !== packagedPolicyDigest)
      throw new Error('Workflow policy digest does not match the exact packaged implementation.');
    const inspected = await inspectTask(root, task.id);
    if (inspected.task.state !== 'verified') throw new Error('Host task did not become verified.');
    if (sha256(await readFile(path.join(root, 'REQUIREMENTS.md'))) !== immutable.requirements)
      throw new Error('Requirements changed during workflow execution.');
    if (sha256(await readFile(path.join(root, 'test', 'calculator.test.js'))) !== immutable.tests)
      throw new Error('Accepted tests changed during workflow execution.');
    stage = 'final-acceptance';
    const finalCheck = await command(privateNode, ['--test'], {
      cwd: root,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (finalCheck.exitCode !== 0) throw new Error('Final private-Node acceptance check failed.');
    stage = 'final-git-scope';
    // Read protected bytes independently of Git's assume-unchanged/index flags.
    for (const [name, digest] of protectedFiles)
      if (sha256(await readFile(path.join(root, name))) !== digest)
        throw new Error('Protected fixture bytes changed outside the approved implementation.');
    const paths = (result) => result.stdout.split('\0').filter(Boolean);
    const gitScope = fixtureGitScopeProof({
      beforeHead: fixtureHead,
      afterHead: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(),
      changedPaths: paths(await git(root, ['diff', '--name-only', '-z', fixtureHead, '--'])),
      untrackedPaths: [
        ...paths(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
        ...paths(
          await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
        ),
      ],
    });

    const phases = completed.completedActions.map((action) => ({
      kind: action.kind,
      phase: action.phase,
      status: action.status,
      inputDigest: action.inputDigest,
      resultDigest: action.resultDigest,
    }));
    for (const phase of [
      'requirements',
      'plan',
      'implementation',
      'verification',
      'review',
      'handoff',
    ])
      if (!phases.some((item) => item.phase === phase && item.status === 'passed'))
        throw new Error(`Workflow lacks passed ${phase} evidence.`);
    const review = phases.find((item) => item.phase === 'review');
    const handoff = completed.artifacts.find((artifact) => artifact.phase === 'handoff');
    if (!review || !handoff?.artifact.trim())
      throw new Error('Independent review or handoff artifact is missing.');

    stage = 'usage-observation';
    let usageEvidence = null;
    if (values['collect-usage']) {
      const usage = await inspectUsage(root);
      if (
        !usage.settings.enabled ||
        inferenceSessionIds.size !== processStarts.inference ||
        [...inferenceSessionIds].some(
          (id) => !usage.records.some((record) => record.sessionId === id),
        ) ||
        usage.records.length < processStarts.inference ||
        usage.records.some((record) => record.taskId !== task.id) ||
        usage.summary.unavailable > 0
      )
        throw new Error('Opted-in workflow usage did not cover every inference invocation.');
      usageEvidence = {
        enabled: true,
        ...usage.summary,
        billing: usage.billing,
        providers: [...new Set(usage.records.map((record) => record.provider))],
        providerVersions: [...new Set(usage.records.map((record) => record.providerVersion))],
        sources: [...new Set(usage.records.map((record) => record.source))],
        allRecordsBelongToTask: true,
        everyInferenceSessionRecorded: true,
      };
    }

    const evidence = {
      schemaVersion: 1,
      kind: 'live-workflow-qualification',
      attemptId,
      startedAt,
      finishedAt: iso(),
      candidate: {
        archiveSha256,
        commit: manifest.commit,
        version: manifest.version,
        target: manifest.target,
        nodeVersion: manifest.nodeVersion,
        privateNodeVersion,
      },
      provider: {
        id: 'codex',
        version: (await command('codex', ['--version'])).stdout.trim(),
        modelOverride: values.model ?? null,
        reasoningEffortOverride: values['reasoning-effort'] ?? null,
        settingsPreserved: true,
      },
      bounds: {
        providerTimeoutMs: 120_000,
        totalTimeoutMs: 900_000,
        outputLimitBytes: 1024 * 1024,
        providerProcessStarts: providerEvents.filter((event) => event === 'process-start').length,
        processStarts,
      },
      usage: usageEvidence,
      workflow: {
        workflowId: completed.workflowId,
        taskId: completed.taskId,
        revision: completed.revision,
        status: completed.status,
        phase: completed.phase,
        policyVersion: completed.policyVersion,
        policyDigest: completed.policyDigest,
        packagedPolicyDigest,
        promptDigest: completed.promptDigest,
        requirementsDigest: completed.requirements.digest,
        planDigest: completed.plan.digest,
        checksDigest: completed.plan.checksDigest,
        approval: completed.approval,
        repairAttempts: completed.repairAttempts,
        actions: phases,
        handoffDigest: handoff.digest,
      },
      proof: {
        awaitedExactApproval: true,
        exactChecksApproved: true,
        immutableRequirementsSha256: immutable.requirements,
        immutableTestsSha256: immutable.tests,
        implementationSha256: sha256(await readFile(path.join(root, 'src', 'calculator.js'))),
        finalPrivateNodeCheck: 'passed',
        independentReview: 'passed',
        handoff: 'present',
        taskState: inspected.task.state,
        gitScope,
      },
    };
    stage = 'write-evidence';
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        workflowFailureEvidence({
          attemptId,
          startedAt,
          finishedAt: iso(),
          stage,
          failureCategory,
          planDiagnostics,
          candidate: { ...manifest, archiveSha256 },
          provider: values,
          workflow,
          providerProcessStarts: providerEvents.filter((event) => event === 'process-start').length,
        }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    throw error;
  } finally {
    await controller?.shutdown().catch(() => {});
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function outer(values) {
  if (values.authorized !== true)
    throw new Error('Live workflow evidence requires explicit --authorized.');
  if (values.provider !== 'codex')
    throw new Error('Live workflow evidence currently supports only the Codex adapter.');
  const archive = path.resolve(required(values.artifact, '--artifact'));
  const archiveSha256 = required(values['artifact-sha256'], '--artifact-sha256');
  if (!/^[a-f0-9]{64}$/.test(archiveSha256))
    throw new Error('--artifact-sha256 must be a lowercase SHA-256 digest.');
  const output = path.resolve(required(values.output, '--output'));
  if (output === archive) throw new Error('Evidence output must differ from the input archive.');
  const attemptId = randomUUID();
  const startedAt = iso();
  let stage = 'archive-validation';
  let scratch;
  const failure = () =>
    workflowFailureEvidence({
      attemptId,
      startedAt,
      finishedAt: iso(),
      stage,
      candidate: { archiveSha256 },
      provider: values,
      providerProcessStarts: stage === 'archive-validation' ? 0 : null,
    });
  try {
    if (sha256(await readFile(archive)) !== archiveSha256)
      throw new Error('The supplied archive does not match --artifact-sha256.');
    stage = 'private-runtime';
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify({ ...failure(), kind: 'live-workflow-qualification-attempt', status: 'running', finishedAt: null }, null, 2)}\n`,
      { mode: 0o600 },
    );
    scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-live-workflow-'));
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
        '--output',
        output,
        '--provider',
        'codex',
        '--attempt-id',
        attemptId,
        ...workflowProviderInnerArgs(values),
      ],
      900_000,
    );
  } catch (error) {
    let existing;
    try {
      existing = JSON.parse(await readFile(output, 'utf8'));
    } catch {
      /* No completed inner failure evidence. */
    }
    if (
      existing?.kind !== 'live-workflow-qualification-failure' ||
      existing.attemptId !== attemptId
    ) {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(failure(), null, 2)}\n`, { mode: 0o600 });
    }
    throw error;
  } finally {
    if (scratch)
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const parsed = parseArgs({
  options: {
    authorized: { type: 'boolean' },
    provider: { type: 'string', default: 'codex' },
    model: { type: 'string' },
    'reasoning-effort': { type: 'string' },
    'collect-usage': { type: 'boolean' },
    output: { type: 'string' },
    artifact: { type: 'string' },
    'artifact-sha256': { type: 'string' },
    inner: { type: 'boolean' },
    bundle: { type: 'string' },
    'archive-sha256': { type: 'string' },
    'attempt-id': { type: 'string' },
  },
});

const values = validateWorkflowProviderOptions(parsed.values);

await (values.inner ? inner(values) : outer(values)).catch(() => {
  console.error(
    'Live workflow qualification failed. Inspect the sanitized evidence at the supplied output path.',
  );
  process.exitCode = 1;
});
