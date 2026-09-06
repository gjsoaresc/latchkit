import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLifecycleDispatcher } from '../dist/src/providers/contracts.js';
import { createTask, resumeTask } from '../dist/src/task-state/service.js';
import { executeQualityGates, selectQualityGates } from '../dist/src/quality-gates/service.js';

const provider = (blocking = 'supported') => ({
  schemaVersion: 1,
  id: 'fixture',
  label: 'Fixture',
  command: process.execPath,
  skillDirectory: '.fixture',
  capabilities: {
    skills: { state: 'supported', reason: 'fixture', versionRange: '*', evidenceUrl: '' },
    invocation: { state: 'supported', reason: 'fixture', versionRange: '*', evidenceUrl: '' },
    hooks: {},
    decisions: {
      blocking: { state: blocking, reason: 'fixture decision', versionRange: '*', evidenceUrl: '' },
      advisory: {
        state: 'supported',
        reason: 'fixture advisory',
        versionRange: '*',
        evidenceUrl: '',
      },
    },
    compaction: { state: 'unknown', reason: 'fixture', versionRange: '*', evidenceUrl: '' },
    resume: { state: 'unknown', reason: 'fixture', versionRange: '*', evidenceUrl: '' },
    cancellation: { state: 'supported', reason: 'fixture', versionRange: '*', evidenceUrl: '' },
    usage: { state: 'unknown', reason: 'fixture', versionRange: '*', evidenceUrl: '' },
  },
  verification: {
    installed: 'verified',
    authenticated: 'unknown',
    configured: 'unknown',
    endToEnd: 'unverified',
  },
});

const event = (decisionMode = 'blocking') => ({
  decisionModes: ['advisory', 'blocking'],
  payload: { qualityGateTrigger: true, decisionMode },
});

async function taskFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-gates-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.writeFile(path.join(root, 'source.txt'), 'source\n');
  let task = await createTask(root, {
    title: 'Gate task',
    authorization: { source: 'user', scope: 'run declared checks', reference: 'test' },
    criteria: [{ description: 'test check' }, { description: 'docs check' }],
  });
  task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
  return { root, task };
}

function checks(task) {
  return [
    {
      id: 'test',
      criterionId: task.criteria[0].id,
      label: 'node --test',
      plan: { executable: process.execPath, args: ['--version'] },
      timeoutMs: 100,
      watchPaths: ['src'],
    },
    {
      id: 'docs',
      criterionId: task.criteria[1].id,
      label: 'docs check',
      plan: { executable: process.execPath, args: ['--version'] },
      watchPaths: ['docs'],
    },
  ];
}

test('normalizes equivalent provider event policy and never blocks an unsupported provider', () => {
  const rawAdapters = [event(), { ...event(), providerSpecific: 'ignored' }];
  const selected = rawAdapters.map((input) =>
    selectQualityGates({ provider: provider(), event: input, checks: [], changedPaths: [] }),
  );
  assert.deepEqual(selected, [selected[0], selected[0]]);
  const unavailable = selectQualityGates({
    provider: provider('unsupported'),
    event: event(),
    checks: [],
  });
  assert.equal(unavailable.decision, 'advisory');
  assert.match(unavailable.limitation, /fixture decision/);
  assert.equal(
    selectQualityGates({ provider: provider(), event: { payload: {} }, checks: [] }).status,
    'not-applicable',
  );
});

test('only applicable changed paths select checks; unrelated changes do not rerun everything', async (t) => {
  const { task } = await taskFixture(t);
  const selected = selectQualityGates({
    provider: provider(),
    event: event(),
    checks: checks(task),
    changedPaths: ['src/gate.js'],
  });
  assert.deepEqual(
    selected.checks.map((check) => check.id),
    ['test'],
  );
  const unrelated = selectQualityGates({
    provider: provider(),
    event: event(),
    checks: checks(task),
    changedPaths: ['README.md'],
  });
  assert.equal(unrelated.status, 'skipped');
});

test('records distinct process outcomes with redacted bounded command evidence', async (t) => {
  const outcomes = [
    ['exited', 0, 'passed'],
    ['exited', 7, 'failed'],
    ['timed-out', null, 'timed-out'],
    ['cancelled', null, 'cancelled'],
    ['output-limit', null, 'failed'],
    ['spawn-failed', null, 'failed'],
    ['refused', null, 'unsupported'],
  ];
  for (const [status, exitCode, expected] of outcomes) {
    const { root, task } = await taskFixture(t);
    const result = await executeQualityGates({
      root,
      task,
      event: event('advisory'),
      provider: provider(),
      checks: checks(task).slice(0, 1),
      isExecutionAuthorized: () => true,
      run: async () => ({ status, exitCode, stdout: 'authorization: top-secret', outputBytes: 10 }),
    });
    assert.equal(result.results[0].outcome, expected);
    const evidence = result.task.evidence.at(-1);
    assert.equal(evidence.outcome, expected);
    assert.match(evidence.artifact, new RegExp(`"status":"${status}"`));
    assert.match(evidence.artifact, /\[redacted\]/);
    assert.doesNotMatch(evidence.artifact, /top-secret/);
  }
});

test('a denied command never launches and already granted authorization adds no extra approval', async (t) => {
  const { root, task } = await taskFixture(t);
  let launches = 0;
  const result = await executeQualityGates({
    root,
    task,
    event: event(),
    provider: provider(),
    checks: checks(task).slice(0, 1),
    isExecutionAuthorized: () => false,
    run: async () => {
      launches += 1;
      return { status: 'exited', exitCode: 0 };
    },
  });
  assert.equal(launches, 0);
  assert.equal(result.results[0].outcome, 'skipped');
  assert.equal(result.task.authorizations.length, 1);

  const authorized = await executeQualityGates({
    root,
    task,
    event: event(),
    provider: provider(),
    checks: checks(task).slice(0, 1),
    isExecutionAuthorized: () => true,
    run: async () => ({ status: 'exited', exitCode: 0 }),
  });
  assert.equal(authorized.task.authorizations.length, 1);
});

test('unsupported blocking enforcement records unsupported evidence and duplicate events cannot relaunch', async (t) => {
  const { root, task } = await taskFixture(t);
  let launches = 0;
  const unavailable = await executeQualityGates({
    root,
    task,
    event: event(),
    provider: provider('unsupported'),
    checks: checks(task).slice(0, 1),
    isExecutionAuthorized: () => true,
    run: async () => {
      launches += 1;
      return { status: 'exited', exitCode: 0 };
    },
  });
  assert.equal(launches, 0);
  assert.equal(unavailable.decision, 'advisory');
  assert.equal(unavailable.results[0].outcome, 'unsupported');
  assert.equal(unavailable.task.evidence.at(-1).outcome, 'unsupported');

  let handled = 0;
  const dispatch = createLifecycleDispatcher({
    lookupTask: () => task,
    authorize: () => true,
    handle: () => {
      handled += 1;
      return { decision: 'advisory' };
    },
  });
  const normalized = {
    schemaVersion: 1,
    provider: { id: 'fixture', version: '1', runtime: 'test' },
    correlation: { projectId: 'project', taskId: task.id, sessionId: 'session' },
    eventId: `event_${randomUUID()}`,
    timestamp: 1,
    kind: 'turn-completed',
    payload: { qualityGateTrigger: true },
    decisionModes: ['advisory'],
  };
  assert.equal((await dispatch(normalized)).status, 'handled');
  assert.equal((await dispatch(normalized)).status, 'duplicate');
  assert.equal(handled, 1);
});

test('typed acceptance checks extend the quality-gate interface and share task evidence', async (t) => {
  const { root, task } = await taskFixture(t);
  const result = await executeQualityGates({
    root,
    task,
    event: event('advisory'),
    provider: provider(),
    checks: [
      {
        id: 'runtime-cli',
        criterionId: task.criteria[0].id,
        label: 'runtime CLI',
        type: 'cli',
        plan: { executable: process.execPath, args: ['--version'] },
        watchPaths: ['src'],
      },
    ],
    changedPaths: ['src/runtime.js'],
    isExecutionAuthorized: () => true,
    run: async () => ({
      status: 'exited',
      exitCode: 0,
      stdout: process.version,
      stderr: '',
      outputBytes: process.version.length,
    }),
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.results[0].outcome, 'passed');
  const artifact = JSON.parse(result.task.evidence.at(-1).artifact);
  assert.equal(artifact.type, 'cli');
  assert.match(artifact.location, /acceptance-evidence/);
});
