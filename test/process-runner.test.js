import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_LOCAL_EXECUTION_PROFILE,
  redactLaunchMetadata,
  runProviderProcess,
} from '../dist/src/runtime/process-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/processes/runner-fixture.js', import.meta.url));
const provider = (state = 'supported') => ({
  schemaVersion: 1,
  id: 'fixture',
  label: 'Fixture',
  command: process.execPath,
  skillDirectory: '.fixture',
  capabilities: {
    skills: { state: 'supported', reason: 'test', versionRange: '*', evidenceUrl: '' },
    invocation: { state, reason: 'test invocation', versionRange: '*', evidenceUrl: '' },
    hooks: {},
    decisions: {
      blocking: { state: 'unknown', reason: 'test', versionRange: '*', evidenceUrl: '' },
      advisory: { state: 'unknown', reason: 'test', versionRange: '*', evidenceUrl: '' },
    },
    compaction: { state: 'unknown', reason: 'test', versionRange: '*', evidenceUrl: '' },
    resume: { state: 'unknown', reason: 'test', versionRange: '*', evidenceUrl: '' },
    cancellation: { state: 'supported', reason: 'test', versionRange: '*', evidenceUrl: '' },
    usage: { state: 'unknown', reason: 'test', versionRange: '*', evidenceUrl: '' },
  },
  verification: {
    installed: 'verified',
    authenticated: 'unknown',
    configured: 'unknown',
    endToEnd: 'unverified',
  },
});
const plan = (...args) => ({ executable: process.execPath, args: [fixture, ...args] });
const authorized = { executionProfile: HOST_LOCAL_EXECUTION_PROFILE };

test('refuses unavailable profiles and unsupported invocation before process start', async () => {
  assert.equal(
    (await runProviderProcess({ provider: provider(), plan: plan('exit', '0') })).status,
    'refused',
  );
  assert.equal(
    (
      await runProviderProcess({
        ...authorized,
        provider: provider('unknown'),
        plan: plan('exit', '0'),
      })
    ).code,
    'INVOCATION_CAPABILITY_UNAVAILABLE',
  );
});

test('passes adversarial arguments through the native vector unchanged', async () => {
  const args = ['space path', '東京', 'quote"value', '&|<>^%!\n$(not-a-shell)'];
  const result = await runProviderProcess({
    ...authorized,
    provider: provider(),
    plan: plan('args', ...args),
  });
  assert.equal(result.status, 'exited');
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.deepEqual(redactLaunchMetadata(plan('args', 'secret')), {
    executable: path.basename(process.execPath),
    argumentCount: 3,
    hasWorkingDirectory: false,
    hasEnvironmentOverrides: false,
  });
});

test('preserves split UTF-8 output and bounds simultaneous output', async () => {
  const split = await runProviderProcess({
    ...authorized,
    provider: provider(),
    plan: plan('split'),
  });
  assert.equal(split.stdout, '😀');
  assert.equal(split.stderr, '€');
  const flood = await runProviderProcess({
    ...authorized,
    provider: provider(),
    plan: plan('flood'),
    outputLimitBytes: 2_000,
  });
  assert.equal(flood.status, 'output-limit');
  assert.equal(Buffer.byteLength(flood.stdout) + Buffer.byteLength(flood.stderr), 2_000);
  assert.ok(flood.outputBytes > 2_000);

  const splitAtLimit = await runProviderProcess({
    ...authorized,
    provider: provider(),
    plan: plan('split'),
    outputLimitBytes: 3,
  });
  assert.equal(splitAtLimit.status, 'output-limit');
  assert.equal(splitAtLimit.stdout.includes('\uFFFD'), false);
  assert.ok(Buffer.byteLength(splitAtLimit.stdout) + Buffer.byteLength(splitAtLimit.stderr) <= 3);
});

test('reports nonzero exit, timeout, cancellation, and closes stdin', async () => {
  assert.equal(
    (await runProviderProcess({ ...authorized, provider: provider(), plan: plan('exit', '7') }))
      .exitCode,
    7,
  );
  assert.equal(
    (
      await runProviderProcess({
        ...authorized,
        provider: provider(),
        plan: plan('sleep'),
        timeoutMs: 20,
      })
    ).status,
    'timed-out',
  );
  const controller = new AbortController();
  const running = runProviderProcess({
    ...authorized,
    provider: provider(),
    plan: plan('sleep'),
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await running).status, 'cancelled');
});

test('missing executable is a distinct spawn failure', async () => {
  const result = await runProviderProcess({
    ...authorized,
    provider: provider(),
    plan: { executable: 'definitely-not-a-latchkit-executable', args: [] },
  });
  assert.equal(result.status, 'spawn-failed');
});

test(
  'Windows CMD shim receives special arguments only on Windows',
  { skip: process.platform !== 'win32' },
  async () => {
    const shim = fileURLToPath(new URL('./fixtures/processes/windows-args.cmd', import.meta.url));
    await access(shim);
    const args = ['path with spaces', '東京', 'quoted-value', '&|<>!'];
    const result = await runProviderProcess({
      ...authorized,
      provider: provider(),
      plan: { executable: shim, args },
    });
    assert.equal(result.status, 'exited');
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), args);
  },
);
