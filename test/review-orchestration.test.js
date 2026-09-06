import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureUsage, inspectUsage } from '../dist/src/usage/service.js';
import {
  createReviewOrchestrator,
  validateReviewResult,
} from '../dist/src/reviews/orchestrator.js';

const adapter = (providerId = 'codex') => ({
  contract: { id: providerId, capabilities: { invocation: { state: 'supported' } } },
  operations: {
    planInvocation: ({ cwd }) => ({
      executable: process.execPath,
      args:
        providerId === 'claude'
          ? ['--version', '--permission-mode', 'plan']
          : ['--version', '--sandbox', 'read-only'],
      cwd,
    }),
  },
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('review usage records each invocation including failure in the source project, not its workspace', async (t) => {
  const root = await fixture(t);
  const workspaceRoot = await fixture(t);
  await configureUsage(root, { enabled: true });
  let calls = 0;
  let invocations = 0;
  const orchestrator = createReviewOrchestrator({
    root,
    reviewerAdapters: new Map([['codex', adapter()]]),
    source: async () => ({ revision: 'abc', dirtyFingerprint: 'fixture' }),
    workspace: async () => ({ path: workspaceRoot, snapshotDigest: 'fixture' }),
    launch: async (input) => {
      calls += 1;
      assert.equal(input.plan.cwd, workspaceRoot);
      if (input.plan.args.length === 1)
        return { status: 'exited', exitCode: 0, stdout: 'codex-cli 0.99.0' };
      invocations += 1;
      return {
        status: 'exited',
        exitCode: 1,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'fixture-common-thread' }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 7 } }),
        ].join('\n'),
      };
    },
  });
  const result = await orchestrator.run({
    taskId: 'task_parent',
    reviewers: [{ providerId: 'codex' }, { providerId: 'codex' }],
    executionAuthorized: true,
    sandbox: 'read-only',
  });
  assert.equal(result.state, 'failed');
  const usage = await inspectUsage(root);
  assert.equal(usage.records.length, 2);
  assert.equal(usage.summary.tokens.input, 100);
  assert.ok(
    usage.records.every(
      (item) =>
        item.taskId === 'task_parent' &&
        item.providerVersion === '0.99.0' &&
        item.sessionId === 'fixture-common-thread',
    ),
  );
  assert.equal((await inspectUsage(workspaceRoot)).records.length, 0);
  assert.equal(calls, 4);
  assert.equal(invocations, 2);
});

test('review results are strict, independent, and deduplicated', async (t) => {
  const root = await fixture(t);
  let active = 0;
  let peak = 0;
  let launches = 0;
  const orchestrator = createReviewOrchestrator({
    root,
    reviewerAdapters: new Map([['codex', adapter()]]),
    source: async () => ({ revision: 'abc', dirtyFingerprint: 'dirty-1' }),
    workspace: async () => ({ path: root, snapshotDigest: 'fixture' }),
    launch: async () => {
      launches += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        status: 'exited',
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          state: 'completed',
          findings: [{ severity: 'high', title: 'Defect', detail: 'token=secret' }],
        }),
        stderr: '',
      };
    },
  });
  const result = await orchestrator.run({
    taskId: 'task_parent',
    reviewers: [
      { providerId: 'codex', prompt: 'inspect' },
      { providerId: 'codex', prompt: 'inspect' },
      { providerId: 'codex', prompt: 'inspect' },
    ],
    limits: { concurrency: 2, maxReviewers: 3 },
    executionAuthorized: true,
    sandbox: 'read-only',
  });
  assert.ok(peak <= 2);
  assert.equal(result.independent, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.reviewers[0].sourceSnapshot.dirtyFingerprint, 'dirty-1');
  assert.equal(result.reviewers[0].result.findings[0].detail, 'token=[REDACTED]');
  assert.equal(launches, 3);
  await assert.rejects(readFile(path.join(root, '.latchkit/usage/state-v1.json')), {
    code: 'ENOENT',
  });
});

test('real Codex JSONL and Claude JSON envelopes yield strict review results', async (t) => {
  const root = await fixture(t);
  const reviewResult = {
    schemaVersion: 1,
    state: 'completed',
    findings: [],
    summary: 'No findings.',
  };
  for (const [providerId, stdout] of [
    [
      'codex',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item-1', type: 'agent_message', text: JSON.stringify(reviewResult) },
        }),
        JSON.stringify({ type: 'turn.completed', usage: {} }),
      ].join('\n'),
    ],
    [
      'claude',
      JSON.stringify({
        type: 'result',
        session_id: 'session-1',
        result: JSON.stringify(reviewResult),
      }),
    ],
  ]) {
    const result = await createReviewOrchestrator({
      root,
      reviewerAdapters: new Map([[providerId, adapter(providerId)]]),
      source: async () => ({ revision: 'abc', dirtyFingerprint: 'dirty-1' }),
      workspace: async () => ({ path: root, snapshotDigest: 'fixture' }),
      launch: async () => ({ status: 'exited', exitCode: 0, stdout, stderr: '' }),
    }).run({
      taskId: `task-${providerId}`,
      reviewers: [{ providerId }],
      executionAuthorized: true,
      sandbox: 'read-only',
    });
    assert.equal(result.reviewers[0].state, 'completed');
    assert.deepEqual(result.reviewers[0].result, reviewResult);
  }
});

test('malformed, unavailable, nested, and unauthorized reviews remain explicit', async (t) => {
  const root = await fixture(t);
  const base = {
    root,
    workspace: async () => ({ path: root, snapshotDigest: 'fixture' }),
    reviewerAdapters: new Map([['codex', adapter()]]),
    launch: async () => ({ status: 'exited', exitCode: 0, stdout: 'nope' }),
  };
  await assert.rejects(
    () =>
      createReviewOrchestrator(base).run({
        taskId: 'task_parent',
        reviewers: [{ providerId: 'codex' }],
        executionAuthorized: false,
      }),
    { code: 'REVIEW_AUTHORIZATION_REQUIRED' },
  );
  await assert.rejects(
    () =>
      createReviewOrchestrator(base).run({
        taskId: 'task_parent',
        reviewers: [{ providerId: 'codex' }],
        executionAuthorized: true,
        sandbox: 'read-only',
        depth: 1,
      }),
    { code: 'REVIEW_NESTING_LIMIT' },
  );
  const result = await createReviewOrchestrator(base).run({
    taskId: 'task_parent',
    reviewers: [{ providerId: 'codex' }],
    executionAuthorized: true,
    sandbox: 'read-only',
  });
  assert.equal(result.reviewers[0].state, 'failed');
  assert.equal(result.reviewers[0].error.code, 'REVIEW_RESULT_MALFORMED');
  assert.throws(
    () =>
      validateReviewResult({
        schemaVersion: 1,
        state: 'completed',
        findings: [{ severity: 'x', title: 'a', detail: 'b' }],
      }),
    { code: 'REVIEW_RESULT_INVALID' },
  );
});

test('parent cancellation aborts owned reviewers and records partial results', async (t) => {
  const root = await fixture(t);
  let reviewId;
  let aborted = false;
  let launched;
  const launchedPromise = new Promise((resolve) => {
    launched = resolve;
  });
  const orchestrator = createReviewOrchestrator({
    root,
    workspace: async () => ({ path: root, snapshotDigest: 'fixture' }),
    reviewerAdapters: new Map([['codex', adapter()]]),
    launch: ({ signal }) =>
      new Promise((resolve) => {
        launched();
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ status: 'cancelled', stdout: '' });
        });
      }),
  });
  const run = orchestrator.run({
    taskId: 'task_parent',
    reviewers: [{ providerId: 'codex' }],
    executionAuthorized: true,
    sandbox: 'read-only',
  });
  // Launch occurs only after the review record is durably saved. Waiting for
  // that boundary avoids a scheduler-dependent polling deadline on loaded CI.
  await launchedPromise;
  const state = await orchestrator.inspect(root);
  reviewId = state.reviews[0]?.id;
  assert.ok(reviewId);
  await orchestrator.cancel({ reviewId });
  const result = await run;
  assert.equal(aborted, true);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.reviewers[0].state, 'cancelled');
});
