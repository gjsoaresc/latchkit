#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

async function command(executable, args, options = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      timeout: options.timeoutMs,
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
  if (/\.zip$/i.test(archive)) {
    if (process.platform === 'win32') {
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
      await command('unzip', ['-q', archive, '-d', destination], { timeoutMs: 120_000 });
    }
    return;
  }
  if (!/\.(?:tar\.gz|tgz)$/i.test(archive))
    throw new Error('--artifact must be a standalone .zip, .tar.gz, or .tgz bundle.');
  await command('tar', ['-xzf', archive, '-C', destination], { timeoutMs: 120_000 });
}

async function runInner(node, script, args, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn(node, [script, '--inner', ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    const timer = setTimeout(async () => {
      await terminateOwnedTree(child.pid).catch(() => {});
      reject(new Error('Live lifecycle qualification exceeded its total time budget.'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Private-Node lifecycle qualification exited ${code}.`));
    });
  });
}

async function terminateOwnedTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Provider PID was not recorded.');
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const child = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      child.once('error', resolve);
      child.once('close', resolve);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function processIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function fileExists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function handoffFile(root) {
  const directory = path.join(root, '.latchkit', 'notes');
  const entries = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const name = entries.find((entry) => /handoff/i.test(entry) && entry.endsWith('.md'));
  return name ? path.join(directory, name) : null;
}

async function writeFixture(root) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'latchkit-live-lifecycle-fixture',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, 'REQUIREMENTS.md'),
    [
      '# Accepted requirement',
      '',
      '`multiply(left, right)` must return the numeric product for positive, negative, and zero inputs.',
      'Keep the implementation dependency-free and do not change the accepted test cases.',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'calculator.js'),
    [
      'export function multiply() {',
      "  throw new Error('multiply is not implemented');",
      '}',
      '',
    ].join('\n'),
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
  await writeFile(
    path.join(root, '.gitignore'),
    ['node_modules/', '.latchkit/tasks/', '.latchkit/reviews/', '.latchkit/artifacts/', ''].join(
      '\n',
    ),
  );
}

async function rejectedCode(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error.code ?? error.name;
  }
}

async function inner(values) {
  if (values.authorized !== true) throw new Error('Live lifecycle evidence requires --authorized.');
  if (values.provider !== 'codex')
    throw new Error('This bounded lifecycle currently supports only the Codex adapter.');
  const bundle = path.resolve(required(values.bundle, '--bundle'));
  const output = path.resolve(required(values.output, '--output'));
  const artifactSha256 = required(values['archive-sha256'], '--archive-sha256');
  if (!/^[a-f0-9]{64}$/.test(artifactSha256))
    throw new Error('--archive-sha256 must be a lowercase SHA-256 digest.');
  const app = path.join(bundle, 'app');
  const privateNode = path.join(
    bundle,
    'runtime',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  const normalizePath = (value) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalizePath(process.execPath) !== normalizePath(privateNode))
    throw new Error('Qualification is not running under the extracted private Node runtime.');
  const manifest = JSON.parse(await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'));
  if (manifest.dirty || !/^[a-f0-9]{40}$/i.test(manifest.commit))
    throw new Error('The extracted archive is not bound to a clean candidate commit.');
  const packageDocument = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (packageDocument.version !== manifest.version)
    throw new Error('Bundle and application versions differ.');
  if (manifest.target !== `${process.platform}-${process.arch}`)
    throw new Error('Bundle target differs from the qualification host.');
  if (process.version !== `v${manifest.nodeVersion}`)
    throw new Error('The extracted private Node version differs from the bundle manifest.');
  const providerVersion = (await command('codex', ['--version'])).stdout.trim();
  const base = await mkdtemp(path.join(os.tmpdir(), 'latchkit-live-lifecycle-'));
  const root = path.join(base, 'project');
  const providerPids = [];
  let providerProcessStarts = 0;
  const startedAt = iso();

  try {
    const moduleAt = (relative) => pathToFileURL(path.join(app, relative)).href;
    const { initProject, syncProject } = await import(moduleAt('dist/src/core.js'));
    const { createReviewOrchestrator } = await import(moduleAt('dist/src/reviews/orchestrator.js'));
    const { runProviderProcess } = await import(moduleAt('dist/src/runtime/process-runner.js'));
    const { createTaskController } = await import(moduleAt('dist/src/runtime/task-controller.js'));
    const { completeTask, createTask, inspectTask, recordEvidence, resumeTask, verifyTask } =
      await import(moduleAt('dist/src/task-state/service.js'));
    const { cleanupTaskWorkspace } = await import(moduleAt('dist/src/workspaces/git.js'));

    await mkdir(root);
    await writeFixture(root);
    await command('git', ['init', '--initial-branch=main'], { cwd: root });
    await git(root, ['config', 'user.name', 'Latchkit Qualification']);
    await git(root, ['config', 'user.email', 'qualification@example.invalid']);
    await initProject(root, {
      providers: ['codex'],
      skills: ['requirements', 'spec', 'build', 'review', 'handoff'],
    });
    await syncProject(root);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'fixture: accepted failing requirement']);

    const criteria = [
      { description: 'The accepted multiply cases pass.' },
      { description: 'An independent review completes without blocker or high findings.' },
      { description: 'A durable handoff note records the implemented state.' },
    ];
    let task = await createTask(root, {
      title: 'Implement the accepted multiply requirement',
      authorization: {
        source: 'user',
        scope: 'bounded disposable Codex implementation and review',
        reference: `archive:${artifactSha256};commit:${manifest.commit};version:${manifest.version}`,
      },
      criteria,
    });

    task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
    const failedCheck = await command(process.execPath, ['--test'], {
      cwd: root,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (failedCheck.exitCode === 0) throw new Error('The required initial failing check passed.');
    task = await recordEvidence(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
      criterionId: task.criteria[0].id,
      criterionRevision: task.criteria[0].revision,
      outcome: 'failed',
      command: 'node --test',
      artifact: `sha256:${sha256(`${failedCheck.stdout}\n${failedCheck.stderr}`)}`,
    });
    task = await completeTask(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
    });
    const failedEvidenceRejection = await rejectedCode(() =>
      verifyTask(root, { taskId: task.id, expectedRevision: task.revision }),
    );
    if (failedEvidenceRejection !== 'TASK_NOT_VERIFIABLE')
      throw new Error('Failed evidence was not rejected by task verification.');

    const launch = (options) =>
      runProviderProcess({
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 120_000, 120_000),
        outputLimitBytes: Math.min(options.outputLimitBytes ?? 1024 * 1024, 1024 * 1024),
        onEvent: (event) => {
          options.onEvent?.(event);
          if (event.type === 'process-start') {
            providerProcessStarts += 1;
            providerPids.push(event.pid);
          }
        },
      });
    let interruptedPid;
    let signalStarted;
    const providerStarted = new Promise((resolve) => {
      signalStarted = resolve;
    });
    const interruptingController = createTaskController({
      root,
      launch: (options) =>
        launch({
          ...options,
          onEvent: (event) => {
            options.onEvent?.(event);
            if (event.type === 'process-start') {
              interruptedPid = event.pid;
              signalStarted();
            }
          },
        }),
    });
    const interruptedRun = interruptingController.start({
      taskId: task.id,
      providerId: 'codex',
      prompt: 'Read REQUIREMENTS.md only. Do not edit files or run commands.',
      executionAuthorized: true,
    });
    let startTimer;
    await Promise.race([
      providerStarted,
      interruptedRun.then(() => {
        throw new Error('Provider process ended before its start boundary was observed.');
      }),
      new Promise((_, reject) => {
        startTimer = setTimeout(
          () => reject(new Error('Provider process did not reach its start boundary.')),
          10_000,
        );
      }),
    ]).finally(() => clearTimeout(startTimer));
    await terminateOwnedTree(interruptedPid);
    const interruptedResult = await interruptedRun;
    task = interruptedResult.task;
    if (!task.runs.some((run) => run.state === 'interrupted'))
      throw new Error('The terminated provider run was not recorded as interrupted.');

    const controller = createTaskController({ root, launch });
    const implementation = await controller.start({
      taskId: task.id,
      providerId: 'codex',
      executionAuthorized: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      prompt:
        'This is an explicitly authorized implementation request; do not stop after planning. REQUIREMENTS.md is accepted. Follow the installed $latchkit-spec and $latchkit-build workflows: inspect only REQUIREMENTS.md, test/calculator.test.js, and src/calculator.js; write a concise implementation spec to .latchkit/notes/lifecycle-spec.md; implement only multiply; run exactly node --test once; when it passes, stop immediately. Do not invoke git, npm, another package manager, network access, or any additional command. Do not commit.',
    });
    if (implementation.process.status !== 'exited' || implementation.process.exitCode !== 0)
      throw new Error(`Codex implementation ended as ${implementation.process.status}.`);
    if (!implementation.session.providerSessionId)
      throw new Error('Codex implementation did not expose a resumable thread identity.');
    const passingCheck = await command(process.execPath, ['--test'], {
      cwd: root,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (passingCheck.exitCode !== 0) {
      const sourceChanged = Boolean((await git(root, ['status', '--porcelain=v1'])).stdout.trim());
      const specNoteObserved = await fileExists(
        path.join(root, '.latchkit', 'notes', 'lifecycle-spec.md'),
      );
      throw new Error(
        `Codex implementation did not pass the test (exit=${passingCheck.exitCode}; sourceChanged=${sourceChanged}; specNoteObserved=${specNoteObserved}).`,
      );
    }
    if (!(await fileExists(path.join(root, '.latchkit', 'notes', 'lifecycle-spec.md'))))
      throw new Error('Codex implementation did not write the required spec note.');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'feat: implement accepted multiply requirement']);

    const handoff = await controller.resume({
      taskId: task.id,
      sessionId: implementation.session.id,
      executionAuthorized: true,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      prompt:
        'Use the installed $latchkit-handoff workflow. Read only REQUIREMENTS.md, src/calculator.js, test/calculator.test.js, and .latchkit/notes/lifecycle-spec.md; write a concise handoff to .latchkit/notes/lifecycle-handoff.md; then stop immediately. Do not change source or tests, invoke git/npm/network access, run unrelated commands, or commit.',
    });
    if (handoff.process.status !== 'exited' || handoff.process.exitCode !== 0)
      throw new Error(`Codex handoff resume ended as ${handoff.process.status}.`);
    const handoffPath = await handoffFile(root);
    if (!handoffPath) throw new Error('The resumed Codex session did not write a handoff note.');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', 'docs: record lifecycle handoff']);

    const review = await createReviewOrchestrator({ root, launch }).run({
      taskId: task.id,
      executionAuthorized: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      reviewers: [
        {
          id: 'codex-independent',
          providerId: 'codex',
          prompt:
            'Review only REQUIREMENTS.md, src/calculator.js, test/calculator.test.js, and .latchkit/notes/lifecycle-spec.md. Run node --test once, do not edit files or invoke git/npm/network access, and stop after returning only a JSON object with schemaVersion 1, state completed, findings as an array of objects with severity/title/detail/path when applicable, and a concise summary.',
        },
      ],
      limits: { maxReviewers: 1, concurrency: 1, timeoutMs: 120_000, maxIterations: 1 },
    });
    const assignment = review.reviewers[0];
    const seriousFindings = (review.findings ?? []).filter((finding) =>
      ['blocker', 'high'].includes(finding.severity),
    );
    if (
      review.state !== 'completed' ||
      assignment.state !== 'completed' ||
      assignment.result?.state !== 'completed' ||
      seriousFindings.length
    )
      throw new Error('Independent Codex review did not complete cleanly.');
    await cleanupTaskWorkspace(root, { taskId: assignment.childTaskId, authorized: true });

    task = (await inspectTask(root, task.id)).task;
    task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
    const finalChecks = [
      {
        criterion: task.criteria[0],
        outcome: 'passed',
        command: 'node --test',
        artifact: `sha256:${sha256(`${passingCheck.stdout}\n${passingCheck.stderr}`)}`,
      },
      {
        criterion: task.criteria[1],
        outcome: 'passed',
        command: 'independent Codex review',
        artifact: `sha256:${sha256(JSON.stringify({ state: review.state, findings: review.findings }))}`,
      },
      {
        criterion: task.criteria[2],
        outcome: 'passed',
        command: 'handoff note inspection',
        artifact: `sha256:${sha256(await readFile(handoffPath))}`,
      },
    ];
    for (const check of finalChecks) {
      task = await recordEvidence(root, {
        taskId: task.id,
        runId: task.owner.runId,
        expectedRevision: task.revision,
        criterionId: check.criterion.id,
        criterionRevision: check.criterion.revision,
        outcome: check.outcome,
        command: check.command,
        artifact: check.artifact,
      });
    }
    task = await completeTask(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
    });
    task = await verifyTask(root, { taskId: task.id, expectedRevision: task.revision });

    const unauthorized = await createTask(root, {
      title: 'Authorization guard fixture',
      criteria: [{ description: 'Must not run without direct authorization.' }],
    });
    const unauthorizedRejection = await rejectedCode(() =>
      resumeTask(root, { taskId: unauthorized.id, expectedRevision: unauthorized.revision }),
    );
    const unsupported = await createTask(root, {
      title: 'Unsupported gate fixture',
      authorization: {
        source: 'user',
        scope: 'exercise unsupported evidence guard',
        reference: `archive:${artifactSha256};commit:${manifest.commit};version:${manifest.version}`,
      },
      criteria: [{ description: 'Unavailable required gate.' }],
    });
    let unsupportedRun = await resumeTask(root, {
      taskId: unsupported.id,
      expectedRevision: unsupported.revision,
    });
    unsupportedRun = await recordEvidence(root, {
      taskId: unsupportedRun.id,
      runId: unsupportedRun.owner.runId,
      expectedRevision: unsupportedRun.revision,
      criterionId: unsupportedRun.criteria[0].id,
      criterionRevision: unsupportedRun.criteria[0].revision,
      outcome: 'unsupported',
    });
    unsupportedRun = await completeTask(root, {
      taskId: unsupportedRun.id,
      runId: unsupportedRun.owner.runId,
      expectedRevision: unsupportedRun.revision,
    });
    const unsupportedRejection = await rejectedCode(() =>
      verifyTask(root, {
        taskId: unsupportedRun.id,
        expectedRevision: unsupportedRun.revision,
      }),
    );
    if (unauthorizedRejection !== 'TASK_AUTHORIZATION_REQUIRED')
      throw new Error('Missing authorization did not block task resume.');
    if (unsupportedRejection !== 'TASK_NOT_VERIFIABLE')
      throw new Error('Unsupported required evidence did not block verification.');

    await new Promise((resolve) => setTimeout(resolve, 250));
    if (providerProcessStarts !== 4)
      throw new Error(
        `Expected four bounded provider processes, observed ${providerProcessStarts}.`,
      );
    const liveProviderPids = providerPids.filter(processIsLive);
    if (liveProviderPids.length) throw new Error('An owned provider process remained live.');

    const evidence = {
      schemaVersion: 1,
      kind: 'live-lifecycle-qualification',
      candidate: {
        commit: manifest.commit,
        package: `latchkit@${packageDocument.version}`,
        archiveSha256: artifactSha256,
        version: manifest.version,
        target: manifest.target,
        nodeVersion: manifest.nodeVersion,
      },
      testedAt: iso(),
      startedAt,
      runtime: {
        platform: process.platform,
        release: os.release(),
        architecture: process.arch,
        node: process.version,
      },
      provider: {
        id: 'codex',
        version: providerVersion,
        authenticatedSessionObserved: true,
        modelOverride: null,
        settingsPreserved: true,
      },
      bounds: {
        processTimeoutMs: 120_000,
        outputLimitBytes: 1024 * 1024,
        maximumProviderProcesses: 4,
        observedProviderProcesses: providerProcessStarts,
        retries: 0,
      },
      results: {
        exactArchiveExtractedOutsideCheckout: true,
        installedSkills: 'passed',
        initialVerification: 'failed-as-required',
        failedEvidenceRejection,
        interruption: {
          state: 'passed',
          interruptedRunRecorded: true,
          ownedProcessTerminated: true,
        },
        implementation: {
          state: 'passed',
          resumableIdentityObserved: true,
          testsPassed: true,
          specNoteObserved: true,
        },
        handoffResume: { state: 'passed', handoffNoteObserved: true },
        independentReview: {
          state: assignment.state,
          findingCounts: Object.fromEntries(
            ['blocker', 'high', 'medium', 'low', 'info'].map((severity) => [
              severity,
              (review.findings ?? []).filter((finding) => finding.severity === severity).length,
            ]),
          ),
        },
        finalTaskState: task.state,
        unauthorizedRejection,
        unsupportedRejection,
        liveOwnedProcessesAfterCleanup: 0,
      },
      privacy: {
        transcriptStored: false,
        commandArgumentsStored: false,
        credentialsStored: false,
        usageEstimateStored: false,
        disposableFixtureRetained: false,
      },
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await Promise.all(
      providerPids.filter(processIsLive).map((pid) => terminateOwnedTree(pid).catch(() => {})),
    );
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function outer(values) {
  if (values.authorized !== true) throw new Error('Live lifecycle evidence requires --authorized.');
  if (values.provider !== 'codex')
    throw new Error('This bounded lifecycle currently supports only the Codex adapter.');
  const artifact = path.resolve(required(values.artifact, '--artifact'));
  const artifactSha256 = required(values['artifact-sha256'], '--artifact-sha256');
  if (!/^[a-f0-9]{64}$/.test(artifactSha256))
    throw new Error('--artifact-sha256 must be a lowercase SHA-256 digest.');
  if (sha256(await readFile(artifact)) !== artifactSha256)
    throw new Error('The supplied archive does not match --artifact-sha256.');
  const output = path.resolve(required(values.output, '--output'));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-live-lifecycle-outer-'));
  try {
    const bundle = path.join(scratch, 'extracted-bundle');
    await extract(artifact, bundle, scratch);
    const privateNode = path.join(
      bundle,
      'runtime',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    await runInner(
      privateNode,
      path.resolve(process.argv[1]),
      [
        '--authorized',
        '--bundle',
        bundle,
        '--archive-sha256',
        artifactSha256,
        '--output',
        output,
        '--provider',
        'codex',
      ],
      600_000,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const { values } = parseArgs({
  options: {
    authorized: { type: 'boolean' },
    provider: { type: 'string', default: 'codex' },
    output: { type: 'string' },
    artifact: { type: 'string' },
    'artifact-sha256': { type: 'string' },
    inner: { type: 'boolean' },
    bundle: { type: 'string' },
    'archive-sha256': { type: 'string' },
  },
});

(values.inner ? inner(values) : outer(values)).catch((error) => {
  console.error(`Live lifecycle evidence: ${error.code ?? error.name}: ${error.message}`);
  process.exitCode = 1;
});
