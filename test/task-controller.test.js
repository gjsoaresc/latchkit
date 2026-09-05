import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProviderAdapter } from '../src/providers/contracts.js';
import { createTask } from '../src/task-state/service.js';
import { createTaskController, readTaskSessions } from '../src/runtime/task-controller.js';

const evidence = (state = 'supported') => ({
  state,
  reason: 'fixture capability',
  versionRange: '*',
  evidenceUrl: '',
});

function adapter(id = 'fixture') {
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
    planInvocation: ({ cwd }) => ({ executable: process.execPath, args: ['--version'], cwd }),
    planResume: ({ cwd }) => ({ executable: process.execPath, args: ['--version'], cwd }),
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
    launch: async ({ onEvent }) => {
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
    launch: async ({ onEvent }) => {
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
