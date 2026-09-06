import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { observeProviderInvocation, isUsageVersionProbe } from '../dist/src/usage/observe.js';
import { configureUsage, inspectUsage } from '../dist/src/usage/service.js';
import { USAGE_PATH, readUsageState, writeUsageState } from '../dist/src/usage/store.js';

async function fixture(t, enabled = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-observe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (enabled) await configureUsage(root, { enabled: true });
  return root;
}
const result = (input = 12) => ({
  status: 'exited',
  exitCode: 0,
  stdout: JSON.stringify({
    type: 'result',
    session_id: 'fixture-session',
    result: 'not a workflow result',
    usage: { input_tokens: input, output_tokens: 5 },
  }),
});
const options = (signal) => ({
  provider: { id: 'claude' },
  plan: {
    executable: 'explicit-fixture.exe',
    args: ['-p', 'fixture'],
    cwd: 'fixture-cwd',
    environment: { FIXTURE_ONLY: 'preserved' },
  },
  environmentMode: 'replace',
  executionProfile: 'host-local-authorized',
  signal,
});
const observe = (root, input, launch, invocationId = 'fixture-invocation', clock) =>
  observeProviderInvocation({
    root,
    input,
    launch,
    providerId: 'claude',
    taskId: 'task_parent',
    invocationId,
    clock,
  });

test('disabled observation forwards one unchanged launch and creates no usage files', async (t) => {
  const root = await fixture(t, false);
  const input = options();
  const expected = result();
  let calls = 0;
  assert.equal(
    await observe(root, input, async (actual) => {
      calls += 1;
      assert.equal(actual, input);
      return expected;
    }),
    expected,
  );
  assert.equal(calls, 1);
  await assert.rejects(readFile(path.join(root, USAGE_PATH)), { code: 'ENOENT' });
});

test('probes preserve actual executable, cwd, cancellation and replacement environment without session hooks', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  const input = {
    ...options(controller.signal),
    timeoutMs: 2000,
    outputLimitBytes: 2048,
    onEvent: () => {},
  };
  let calls = 0;
  await observe(root, input, async (actual) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(actual.plan.executable, input.plan.executable);
      assert.equal(actual.plan.cwd, input.plan.cwd);
      assert.deepEqual(actual.plan.environment, input.plan.environment);
      assert.equal(actual.environmentMode, 'replace');
      assert.equal(actual.signal, input.signal);
      assert.equal(actual.onEvent, undefined);
      assert.equal(actual.input, undefined);
      assert.equal(actual.timeoutMs, 2000);
      assert.equal(actual.outputLimitBytes, 2048);
      assert.deepEqual(actual.plan.args, ['--version']);
      return { status: 'exited', exitCode: 0, stdout: '2.1.258 (Claude Code)' };
    }
    assert.equal(actual, input);
    return result();
  });
  const usage = await inspectUsage(root);
  assert.equal(calls, 2);
  assert.equal(usage.records.length, 1);
  assert.equal(usage.records[0].providerVersion, '2.1.258');
  assert.equal(usage.records[0].sessionId, 'fixture-session');
  assert.equal(usage.summary.estimatedPublicApiListPriceUsd, null);
  assert.equal(usage.billing.status, 'unknown');
});

test('unknown versions remain unavailable while failed and repeated invocations retain stable accounting', async (t) => {
  const root = await fixture(t);
  const input = options();
  const launch = async (actual) =>
    actual.plan.args.length === 1
      ? { status: 'exited', exitCode: 0, stdout: 'unrecognized fixture version' }
      : { ...result(), exitCode: 1 };
  const first = new Date();
  assert.equal((await observe(root, input, launch, 'fixture-invocation', () => first)).exitCode, 1);
  const stored = await readUsageState(root);
  const original = stored.records[0];
  original.deduplicationKey = createHash('sha256')
    .update(
      JSON.stringify([
        'claude',
        'unknown',
        'task_parent',
        'fixture-session',
        original.occurredAt,
        'claude-result-json',
        'fixture-invocation',
      ]),
    )
    .digest('hex');
  await writeUsageState(root, stored);
  await observe(root, input, launch, 'fixture-invocation', () => new Date(first.getTime() + 1000));
  let usage = await inspectUsage(root);
  assert.equal(usage.records.length, 1);
  assert.equal(usage.records[0].id, original.id);
  await observe(root, input, launch, 'fixture-invocation', () => new Date(first.getTime() + 2000));
  assert.equal((await inspectUsage(root)).records.length, 1);
  assert.equal(usage.records[0].status, 'unavailable');
  assert.equal(usage.records[0].providerVersion, 'unknown');
  assert.equal(usage.summary.tokens.input, null);
  const known = async (actual) =>
    actual.plan.args.length === 1
      ? { status: 'exited', exitCode: 0, stdout: 'claude 2.1.258' }
      : { ...result(), status: 'cancelled', exitCode: null };
  await observe(root, input, known, 'another-invocation');
  await observe(root, input, known, 'another-invocation');
  usage = await inspectUsage(root);
  assert.equal(usage.records.length, 2);
  assert.equal(usage.records.filter((item) => item.status === 'partial').length, 1);
  assert.equal(usage.summary.knownTokens.input, 12);
});

test('cancellation during a version probe starts no inference and records no probe usage', async (t) => {
  const root = await fixture(t);
  const abort = new AbortController();
  let calls = 0;
  const observed = await observe(root, options(abort.signal), async () => {
    calls += 1;
    abort.abort();
    return result(99999);
  });
  assert.equal(observed.status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal((await inspectUsage(root)).records.length, 0);
});

test('turning usage off during a run prevents recording and launch exceptions remain visible', async (t) => {
  const root = await fixture(t);
  const input = options();
  const marker = new Error('fixture-launch-error');
  await assert.rejects(
    observe(root, input, async (actual) => {
      if (actual.plan.args.length === 1) return { status: 'spawn-failed' };
      await configureUsage(root, { enabled: false });
      throw marker;
    }),
    (error) => error === marker,
  );
  assert.equal((await inspectUsage(root)).records.length, 0);
});

test('review version-probe exemption accepts only a bounded prompt-free exact version command', () => {
  const valid = {
    ...options(),
    plan: { ...options().plan, args: ['--version'] },
    timeoutMs: 5000,
    outputLimitBytes: 4096,
  };
  assert.equal(isUsageVersionProbe(valid), true);
  for (const altered of [
    { ...valid, plan: { ...valid.plan, args: ['--version', '--dangerously-skip-permissions'] } },
    { ...valid, plan: { ...valid.plan, args: ['-p', 'unsafe'] } },
    { ...valid, input: 'prompt' },
    { ...valid, timeoutMs: undefined },
    { ...valid, outputLimitBytes: 4097 },
    { ...valid, executionProfile: 'unavailable' },
    { ...valid, provider: { id: 'other' } },
  ])
    assert.equal(isUsageVersionProbe(altered), false);
});
