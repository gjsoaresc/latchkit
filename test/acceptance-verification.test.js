import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { createAcceptanceVerifier } from '../dist/src/acceptance/service.js';
import { validateAcceptanceDocument } from '../dist/src/acceptance/contracts.js';
import { runProviderProcess } from '../dist/src/runtime/process-runner.js';
import {
  completeTask,
  createTask,
  registerEnhancedWorkflow,
  resumeTask,
  verifyTask,
} from '../dist/src/task-state/service.js';
import { runEnhancedWorkflowChecks } from '../dist/src/acceptance/service.js';

const fixtureApp = path.resolve('test/fixtures/acceptance/fixture-app.js');
const cli = path.resolve('dist/src/cli.js');
const execFile = promisify(execFileCallback);
const fixture = (mode = 'success', port = 0) => ({
  plan: {
    executable: process.execPath,
    args: [fixtureApp],
    environment: { FIXTURE_MODE: mode },
  },
  port,
  readinessPath: '/ready',
  readinessTimeoutMs: 3_000,
});

async function setup(t, descriptions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-acceptance-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.writeFile(path.join(root, 'source.txt'), 'source\n');
  let task = await createTask(root, {
    title: 'Acceptance fixture',
    authorization: { source: 'user', scope: 'execute checks', reference: 'test' },
    criteria: descriptions.map((description) => ({ description })),
  });
  task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
  return { root, task };
}

const document = (checks) => ({ schemaVersion: 1, checks });

test('validates stable typed declarations and refuses remote automated browser targets', () => {
  assert.throws(
    () =>
      validateAcceptanceDocument(
        document([
          {
            id: 'web',
            criterionId: 'criterion_x',
            label: 'Web',
            type: 'browser',
            target: 'https://example.com',
            assertions: [{ kind: 'title', equals: 'x' }],
          },
        ]),
      ),
    { code: 'REMOTE_BROWSER_TARGET_REFUSED' },
  );
});

test('real CLI and HTTP drivers record criterion-bound, sanitized, digest-addressed artifacts', async (t) => {
  const { root, task } = await setup(t, ['CLI succeeds', 'API is correct']);
  const verifier = createAcceptanceVerifier({ root });
  const result = await verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    document: document([
      {
        id: 'cli',
        criterionId: task.criteria[0].id,
        label: 'CLI check',
        type: 'cli',
        plan: { executable: process.execPath, args: ['-e', "console.log('token=super-secret')"] },
      },
      {
        id: 'api',
        criterionId: task.criteria[1].id,
        label: 'HTTP check',
        type: 'http',
        target: 'http://127.0.0.1:${PORT}/api',
        fixture: fixture(),
        assertions: [
          { kind: 'status', equals: 200 },
          { kind: 'json', pointer: '/ok', equals: true },
        ],
      },
    ]),
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(
    result.results.map((item) => item.outcome),
    ['passed', 'passed'],
  );
  for (const item of result.results) {
    assert.match(item.artifact.location, /^\.latchkit\/tasks\/acceptance-evidence\//);
    assert.match(item.artifact.sha256, /^[a-f0-9]{64}$/);
    const content = await fs.readFile(path.join(root, item.artifact.location), 'utf8');
    assert.doesNotMatch(content, /super-secret|fixture-secret/);
    assert.match(content, new RegExp(item.criterionId));
  }
});

test('enhanced workflow runs only its persisted definition and verification binds its hash', async (t) => {
  const { root, task: started } = await setup(t, ['persisted acceptance']);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'plans', 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(root, 'docs', 'plans', 'plan.md'), '# Plan\n');
  const definition = {
    id: 'persisted-cli',
    criterionId: started.criteria[0].id,
    label: 'persisted CLI',
    type: 'cli',
    plan: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
  };
  const enrolled = await registerEnhancedWorkflow(root, {
    taskId: started.id,
    expectedRevision: started.revision,
    artifacts: {
      prd: { path: 'docs/plans/prd.md', templateVersion: 1 },
      technicalPlan: { path: 'docs/plans/plan.md', templateVersion: 1 },
    },
    checks: [{ id: 'persisted-cli', criterionId: started.criteria[0].id, type: 'cli', definition }],
  });
  const result = await runEnhancedWorkflowChecks(root, {
    taskId: enrolled.id,
    executionAuthorized: true,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.task.evidence.at(-1).kind, 'enhanced-check:persisted-cli');
  const completed = await completeTask(root, {
    taskId: result.task.id,
    runId: result.task.owner.runId,
    expectedRevision: result.task.revision,
  });
  assert.equal(
    (await verifyTask(root, { taskId: completed.id, expectedRevision: completed.revision })).state,
    'verified',
  );
});

test(
  'acceptance evidence retries Windows sharing failures before reporting a result',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { root, task } = await setup(t, ['Command succeeds']);
    const rename = fs.rename;
    let attempts = 0;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to.includes('acceptance-evidence')) {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('Sharing failure'), { code: 'EBUSY' });
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const result = await createAcceptanceVerifier({ root }).verify({
      taskId: task.id,
      executionAuthorized: true,
      document: document([
        {
          id: 'cli',
          criterionId: task.criteria[0].id,
          label: 'CLI',
          type: 'cli',
          plan: { executable: process.execPath, args: ['-e', "console.log('passed')"] },
        },
      ]),
    });
    assert.equal(result.status, 'passed');
    assert.ok(attempts >= 3 && attempts <= 9);
    assert.match(
      await fs.readFile(path.join(root, result.results[0].artifact.location), 'utf8'),
      /passed/,
    );
  },
);

test('wrong API, redirect, and oversized response have distinct non-passing evidence', async (t) => {
  const { root, task } = await setup(t, ['wrong', 'redirect', 'large']);
  const verifier = createAcceptanceVerifier({ root });
  const result = await verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    document: document([
      {
        id: 'wrong',
        criterionId: task.criteria[0].id,
        label: 'wrong',
        type: 'http',
        target: 'http://127.0.0.1:${PORT}/api',
        fixture: fixture('wrong'),
        assertions: [{ kind: 'json', pointer: '/ok', equals: true }],
      },
      {
        id: 'redirect',
        criterionId: task.criteria[1].id,
        label: 'redirect',
        type: 'http',
        target: 'http://127.0.0.1:${PORT}/redirect',
        fixture: fixture(),
        assertions: [{ kind: 'status', equals: 200 }],
      },
      {
        id: 'large',
        criterionId: task.criteria[2].id,
        label: 'large',
        type: 'http',
        target: 'http://127.0.0.1:${PORT}/large',
        fixture: fixture(),
        outputLimitBytes: 128,
        assertions: [{ kind: 'status', equals: 200 }],
      },
    ]),
  });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ['assertions-failed', 'redirected', 'response-too-large'],
  );
  assert.ok(result.results.every((item) => item.outcome === 'failed'));
});

test('timeout, missing runtime, cancellation, and port conflict remain distinct and preserve partial evidence', async (t) => {
  const { root, task } = await setup(t, ['timeout', 'missing', 'cancel', 'port']);
  const blocker = http.createServer((_req, res) => res.end('unrelated'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const occupied = blocker.address().port;
  let markProcessStarted;
  const processStarted = new Promise((resolve) => {
    markProcessStarted = resolve;
  });
  const verifier = createAcceptanceVerifier({
    root,
    launch: (options) =>
      runProviderProcess({
        ...options,
        onEvent(event) {
          if (event.type === 'process-start') markProcessStarted();
        },
      }),
  });
  const controller = new AbortController();
  const cancellation = verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    signal: controller.signal,
    document: document([
      {
        id: 'cancel',
        criterionId: task.criteria[2].id,
        label: 'cancel',
        type: 'cli',
        timeoutMs: 5_000,
        plan: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      },
    ]),
  });
  await processStarted;
  controller.abort();
  const cancelled = await cancellation;
  assert.equal(cancelled.results[0].status, 'cancelled');

  const outcomes = await verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    document: document([
      {
        id: 'timeout',
        criterionId: task.criteria[0].id,
        label: 'timeout',
        type: 'cli',
        timeoutMs: 50,
        plan: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      },
      {
        id: 'missing',
        criterionId: task.criteria[1].id,
        label: 'missing',
        type: 'cli',
        plan: { executable: path.join(root, 'missing-runtime'), args: [] },
      },
      {
        id: 'port',
        criterionId: task.criteria[3].id,
        label: 'port',
        type: 'http',
        target: `http://127.0.0.1:${occupied}/api`,
        fixture: fixture('success', occupied),
        assertions: [{ kind: 'status', equals: 200 }],
      },
    ]),
  });
  assert.deepEqual(
    outcomes.results.map((item) => item.status),
    ['timed-out', 'spawn-failed', 'fixture-port-conflict'],
  );
  assert.equal(
    await new Promise((resolve) =>
      http.get(`http://127.0.0.1:${occupied}`, (res) => {
        res.resume();
        resolve(res.statusCode);
      }),
    ),
    200,
  );
});

test('manual/browser-owned verification is explicit unsupported evidence, not a screenshot pass', async (t) => {
  const { root, task } = await setup(t, ['device']);
  const result = await createAcceptanceVerifier({ root }).verify({
    taskId: task.id,
    executionAuthorized: true,
    document: document([
      {
        id: 'device',
        criterionId: task.criteria[0].id,
        label: 'Real device',
        type: 'manual',
        instructions: 'Verify on an owned device.',
      },
    ]),
  });
  assert.equal(result.results[0].outcome, 'unsupported');
  assert.equal(result.results[0].status, 'manual-verification-required');
});

test('CLI executes the same versioned document and a source change rejects an apparent pass', async (t) => {
  const { root, task } = await setup(t, ['CLI route']);
  const checks = path.join(root, 'acceptance.json');
  await fs.writeFile(
    checks,
    JSON.stringify(
      document([
        {
          id: 'cli-route',
          criterionId: task.criteria[0].id,
          label: 'CLI route',
          type: 'cli',
          plan: { executable: process.execPath, args: ['--version'] },
        },
      ]),
    ),
  );
  const { stdout } = await execFile(process.execPath, [
    cli,
    'acceptance',
    'verify',
    '--project',
    root,
    '--task',
    task.id,
    '--file',
    checks,
    '--host-local-authorized',
  ]);
  assert.equal(JSON.parse(stdout).status, 'passed');
  await fs.writeFile(
    checks,
    JSON.stringify(
      document([
        {
          id: 'cli-route',
          criterionId: task.criteria[0].id,
          label: 'CLI route',
          type: 'cli',
          plan: { executable: process.execPath, args: ['-e', 'process.exit(2)'] },
        },
      ]),
    ),
  );
  await assert.rejects(
    execFile(process.execPath, [
      cli,
      'acceptance',
      'verify',
      '--project',
      root,
      '--task',
      task.id,
      '--file',
      checks,
      '--host-local-authorized',
    ]),
    (error) => error.code === 1 && JSON.parse(error.stdout).status === 'failed',
  );

  const changed = await setup(t, ['source stability']);
  const stale = await createAcceptanceVerifier({
    root: changed.root,
    launch: async () => {
      await fs.writeFile(path.join(changed.root, 'source.txt'), 'changed\n');
      return { status: 'exited', exitCode: 0, stdout: '', stderr: '', outputBytes: 0 };
    },
  }).verify({
    taskId: changed.task.id,
    executionAuthorized: true,
    document: document([
      {
        id: 'source',
        criterionId: changed.task.criteria[0].id,
        label: 'source',
        type: 'cli',
        plan: { executable: process.execPath, args: ['--version'] },
      },
    ]),
  });
  assert.equal(stale.results[0].status, 'source-changed');
  assert.equal(stale.results[0].outcome, 'failed');
});

test('fast mode reuses an unchanged passing check and standard mode always reruns', async (t) => {
  const { root, task } = await setup(t, ['fast reuse']);
  let launches = 0;
  const launch = async () => {
    launches += 1;
    return { status: 'exited', exitCode: 0, stdout: '', stderr: '', outputBytes: 0 };
  };
  const verifier = createAcceptanceVerifier({ root, launch });
  const check = {
    id: 'cli',
    criterionId: task.criteria[0].id,
    label: 'CLI check',
    type: 'cli',
    plan: { executable: process.execPath, args: ['--version'] },
    watchPaths: ['src'],
  };

  const first = await verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    mode: 'fast',
    document: document([check]),
  });
  assert.equal(launches, 1);
  assert.equal(first.results[0].reused, false);
  assert.equal(first.stats.mode, 'fast');
  assert.equal(first.stats.executed, 1);
  assert.equal(first.stats.reused, 0);

  const second = await verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    mode: 'fast',
    document: document([check]),
  });
  assert.equal(launches, 1, 'an unchanged source reuses the prior passing evidence');
  assert.equal(second.results[0].reused, true);
  assert.equal(second.results[0].artifact, null);
  assert.equal(second.stats.reused, 1);
  assert.equal(second.stats.executed, 0);
  assert.equal(second.status, 'passed');

  const standard = await verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    document: document([check]),
  });
  assert.equal(launches, 2, 'standard mode (the default) never reuses evidence');
  assert.equal(standard.stats.mode, 'standard');
  assert.ok(standard.stats.reused === 0 && standard.stats.selected === 1);
});

test('fast mode applies an explicit execution budget and reports a fallback with the next check', async (t) => {
  const { root, task } = await setup(t, ['first check', 'second check']);
  let launches = 0;
  const launch = async () => {
    launches += 1;
    return { status: 'exited', exitCode: 0, stdout: '', stderr: '', outputBytes: 0 };
  };
  const verifier = createAcceptanceVerifier({ root, launch });
  const checkFor = (index, id) => ({
    id,
    criterionId: task.criteria[index].id,
    label: id,
    type: 'cli',
    plan: { executable: process.execPath, args: ['--version'] },
  });
  const result = await verifier.verify({
    taskId: task.id,
    executionAuthorized: true,
    mode: 'fast',
    maxExecutions: 1,
    document: document([checkFor(0, 'first'), checkFor(1, 'second')]),
  });
  assert.equal(launches, 1, 'the budget bounds actual executions, never zero of them');
  assert.equal(result.stats.executed, 1);
  assert.equal(result.stats.skippedForBudget, 1);
  assert.equal(result.stats.fallback, 'standard');
  assert.match(result.stats.fallbackReason, /budget exceeded/);
  assert.deepEqual(result.stats.nextChecks, ['second']);
  const skipped = result.results.find((item) => item.checkId === 'second');
  assert.equal(skipped.outcome, 'skipped');
  assert.equal(skipped.status, 'fast-mode-budget-exceeded');
  assert.equal(
    result.task.evidence.find((item) => item.criterionId === task.criteria[1].id).outcome,
    'skipped',
  );
  assert.equal(result.status, 'failed', 'a bounded gap is never silently reported as verified');
});
