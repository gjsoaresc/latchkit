import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProviderAdapter } from '../dist/src/providers/contracts.js';
import { ANTIGRAVITY_ADAPTER } from '../dist/src/providers/antigravity.js';
import { createTask } from '../dist/src/task-state/service.js';
import { createTaskController, readTaskSessions } from '../dist/src/runtime/task-controller.js';

const evidence = (state = 'supported') => ({
  state,
  reason: 'fixture capability',
  versionRange: '*',
  evidenceUrl: '',
});

function adapter(id = 'fixture', observePlan = () => {}) {
  const contract = {
    schemaVersion: 1,
    id,
    label: 'Fixture',
    command: process.execPath,
    skillDirectory: '.agents/skills',
    capabilities: {
      skills: evidence(),
      invocation: evidence(),
      compaction: evidence('unknown'),
      resume: evidence(),
      cancellation: evidence(),
      usage: evidence('unknown'),
      hooks: {},
      decisions: { blocking: evidence('unknown'), advisory: evidence() },
    },
    verification: {
      installed: 'verified',
      authenticated: 'unknown',
      configured: 'unverified',
      endToEnd: 'unverified',
    },
  };
  return createProviderAdapter(contract, {
    inspect() {},
    planInstall() {},
    planSkillExport() {},
    planRuleExport() {},
    planInvocation: (options) => {
      observePlan(options);
      return { executable: process.execPath, args: ['--version'], cwd: options.cwd };
    },
    planResume: (options) => {
      observePlan(options);
      return { executable: process.execPath, args: ['--version'], cwd: options.cwd };
    },
    translateLifecycleInput() {},
    translateLifecycleOutput() {},
    planUsage() {},
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-controller-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const task = await createTask(root, {
    title: 'Fixture task',
    authorization: { source: 'user', scope: 'run fixture', reference: 'test request' },
    criteria: [{ description: 'required result' }],
  });
  return { root, task };
}

test('controller starts one owned session, redacts results, and never treats exit as acceptance', async (t) => {
  const { root, task } = await fixture(t);
  const controller = createTaskController({
    root,
    adapters: new Map([['fixture', adapter()]]),
    launch: async ({ provider, onEvent }) => {
      assert.equal(provider.capabilities.invocation.state, 'supported');
      onEvent({ type: 'process-start', pid: 1234 });
      return {
        status: 'exited',
        exitCode: 0,
        stderr: 'token=secret',
        outputBytes: 2,
        sessionId: 'provider-session',
      };
    },
  });
  const result = await controller.start({
    taskId: task.id,
    providerId: 'fixture',
    executionAuthorized: true,
  });
  assert.equal(result.task.state, 'blocked');
  assert.equal(result.session.providerSessionId, 'provider-session');
  assert.equal(result.session.result.stderr, '[redacted]');
  assert.equal((await readTaskSessions(root))[0].state, 'finished');
});

test('controller extracts the resumable Codex thread identity from JSONL output', async (t) => {
  const { root, task } = await fixture(t);
  const controller = createTaskController({
    root,
    adapters: new Map([['codex', adapter('codex')]]),
    launch: async ({ provider, onEvent }) => {
      assert.equal(provider.capabilities.invocation.state, 'supported');
      onEvent({ type: 'process-start', pid: 1234 });
      return {
        status: 'exited',
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-provider-session' }),
          JSON.stringify({ type: 'turn.completed', usage: {} }),
        ].join('\n'),
      };
    },
  });
  const result = await controller.start({
    taskId: task.id,
    providerId: 'codex',
    executionAuthorized: true,
  });
  assert.equal(result.session.providerSessionId, 'thread-provider-session');
  assert.equal((await readTaskSessions(root))[0].providerSessionId, 'thread-provider-session');
});

test('controller records the Antigravity conversation ID and resumes it after a bounded version probe', async (t) => {
  const { root, task } = await fixture(t);
  const conversationId = '055a398f-db14-4c5f-abbb-1bf03f8120a7';
  const plans = [];
  const controller = createTaskController({
    root,
    adapters: new Map([['antigravity', ANTIGRAVITY_ADAPTER]]),
    launch: async ({ plan, timeoutMs, outputLimitBytes }) => {
      plans.push(plan);
      if (plan.args[0] === '--version') {
        assert.equal(timeoutMs, 5000);
        assert.equal(outputLimitBytes, 4096);
        return { status: 'exited', exitCode: 0, stdout: 'Antigravity CLI 1.1.27\n' };
      }
      return {
        status: 'exited',
        exitCode: 0,
        stdout: JSON.stringify({
          conversation_id: conversationId,
          status: 'SUCCESS',
          response: 'Fixture only.',
        }),
      };
    },
  });
  const started = await controller.start({
    taskId: task.id,
    providerId: 'antigravity',
    executionAuthorized: true,
  });
  assert.equal(started.session.providerSessionId, conversationId);
  assert.equal(started.task.state, 'blocked');
  const resumed = await controller.resume({
    taskId: task.id,
    sessionId: started.session.id,
    prompt: 'next',
    executionAuthorized: true,
  });
  assert.equal(resumed.session.providerSessionId, conversationId);
  assert.equal(resumed.task.state, 'blocked');
  assert.equal(plans.length, 4);
  assert.deepEqual(plans[3].args, [
    '-p',
    'next',
    '--output-format',
    'json',
    '--conversation',
    conversationId,
  ]);
});

test('controller refuses Antigravity resume after a version change without running the prompt', async (t) => {
  const { root, task } = await fixture(t);
  let versionResult = { status: 'exited', exitCode: 0, stdout: '1.1.27' };
  let turns = 0;
  const controller = createTaskController({
    root,
    adapters: new Map([['antigravity', ANTIGRAVITY_ADAPTER]]),
    launch: async ({ plan }) => {
      if (plan.args[0] === '--version') return versionResult;
      turns += 1;
      return {
        status: 'exited',
        exitCode: 0,
        stdout: JSON.stringify({
          conversation_id: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
          status: 'SUCCESS',
          response: 'Fixture.',
        }),
      };
    },
  });
  const started = await controller.start({
    taskId: task.id,
    providerId: 'antigravity',
    executionAuthorized: true,
  });
  for (const probe of [
    { status: 'exited', exitCode: 0, stdout: '1.1.28' },
    { status: 'exited', exitCode: 1, stdout: '1.1.27' },
    { status: 'output-limit', stdout: '1.1.27' },
    { status: 'timed-out' },
    { status: 'spawn-failed' },
  ]) {
    versionResult = probe;
    await assert.rejects(
      controller.resume({
        taskId: task.id,
        sessionId: started.session.id,
        executionAuthorized: true,
      }),
      { code: 'CAPABILITY_UNAVAILABLE' },
    );
  }
  assert.equal(turns, 1);
  assert.equal((await controller.inspect(task.id)).task.revision, started.task.revision);
  assert.equal((await readTaskSessions(root)).length, 1);
});

test('controller does not adopt an Antigravity identity from unknown, denied or incomplete output', async (t) => {
  for (const [version, processResult] of [
    ['1.1.28', { status: 'exited', exitCode: 0 }],
    ['1.1.27', { status: 'output-limit', exitCode: 0 }],
    ['1.1.27', { status: 'exited', exitCode: 1 }],
    ['1.1.27', { status: 'cancelled', exitCode: 0 }],
    ['1.1.27', { status: 'exited', exitCode: 0, stdout: '{"conversation_id":' }],
    [
      '1.1.27',
      {
        status: 'exited',
        exitCode: 0,
        stdout: JSON.stringify({
          conversation_id: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
          status: 'SUCCESS',
          response: 'Denied.',
          denied_actions: ['command'],
        }),
      },
    ],
  ]) {
    const { root, task } = await fixture(t);
    const controller = createTaskController({
      root,
      adapters: new Map([['antigravity', ANTIGRAVITY_ADAPTER]]),
      launch: async ({ plan }) =>
        plan.args[0] === '--version'
          ? { status: 'exited', exitCode: 0, stdout: version }
          : {
              stdout: JSON.stringify({
                conversation_id: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
                status: 'SUCCESS',
                response: 'Fixture.',
              }),
              sessionId: 'unvalidated-fallback',
              ...processResult,
            },
    });
    const started = await controller.start({
      taskId: task.id,
      providerId: 'antigravity',
      executionAuthorized: true,
    });
    assert.equal(started.session.providerSessionId, null);
    assert.notEqual(started.task.state, 'verified');
  }
});

test('unauthorized Antigravity execution performs no version probe', async (t) => {
  const { root, task } = await fixture(t);
  const controller = createTaskController({
    root,
    adapters: new Map([['antigravity', ANTIGRAVITY_ADAPTER]]),
    launch: async () => assert.fail('Unauthorized requests must not launch even a version probe.'),
  });
  await assert.rejects(controller.start({ taskId: task.id, providerId: 'antigravity' }), {
    code: 'EXECUTION_AUTHORIZATION_REQUIRED',
  });
  await assert.rejects(controller.resume({ taskId: task.id, sessionId: 'unknown' }), {
    code: 'EXECUTION_AUTHORIZATION_REQUIRED',
  });
});

test('controller cancellation reaches only its live child and late events cannot resurrect task', async (t) => {
  const { root, task } = await fixture(t);
  let aborted = false;
  let launched;
  const launchedPromise = new Promise((resolve) => {
    launched = resolve;
  });
  const controller = createTaskController({
    root,
    adapters: new Map([['fixture', adapter()]]),
    launch: ({ signal, onEvent }) =>
      new Promise((resolve) => {
        onEvent({ type: 'process-start', pid: 1234 });
        launched();
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve({ status: 'cancelled', stderr: '' });
          },
          { once: true },
        );
      }),
  });
  const running = controller.start({
    taskId: task.id,
    providerId: 'fixture',
    executionAuthorized: true,
  });
  await launchedPromise;
  const cancelled = await controller.cancel({ taskId: task.id, expectedRevision: 2 });
  const result = await running;
  assert.equal(aborted, true);
  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(result.task.state, 'cancelled');
  const event = {
    schemaVersion: 1,
    provider: { id: 'fixture', version: '1', runtime: 'test' },
    correlation: { projectId: 'p', taskId: task.id, sessionId: result.session.id },
    eventId: `event-${randomUUID()}`,
    timestamp: Date.now(),
    kind: 'session-terminated',
    payload: {},
    decisionModes: ['advisory'],
  };
  assert.equal((await controller.observe(event)).status, 'cancelled');
});

test('controller rejects host-local execution without direct authorization', async (t) => {
  const { root, task } = await fixture(t);
  const controller = createTaskController({ root, adapters: new Map([['fixture', adapter()]]) });
  await assert.rejects(
    controller.start({ taskId: task.id, providerId: 'fixture', executionAuthorized: false }),
    { code: 'EXECUTION_AUTHORIZATION_REQUIRED' },
  );
});

test('controller forwards a bounded provider sandbox only after direct authorization', async (t) => {
  const { root, task } = await fixture(t);
  let planned;
  const controller = createTaskController({
    root,
    adapters: new Map([['fixture', adapter('fixture', (options) => (planned = options))]]),
    launch: async () => ({ status: 'exited', exitCode: 0, stderr: '' }),
  });
  await controller.start({
    taskId: task.id,
    providerId: 'fixture',
    executionAuthorized: true,
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
  });
  assert.equal(planned.sandbox, 'workspace-write');
  assert.equal(planned.approvalPolicy, 'never');
  assert.equal(planned.cwd, root);
});
