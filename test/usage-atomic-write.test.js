import assert from 'node:assert/strict';
import filesystem, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeProviderInvocation } from '../dist/src/usage/observe.js';
import { configureUsage, inspectUsage } from '../dist/src/usage/service.js';
import { USAGE_PATH } from '../dist/src/usage/store.js';

test(
  'observed usage survives Windows sharing failures without retaining provider output',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-usage-atomic-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    await configureUsage(root, { enabled: true });
    const target = path.join(root, USAGE_PATH);
    const originalBytes = await readFile(target, 'utf8');
    const originalRename = filesystem.rename;
    let attempts = 0;
    t.mock.method(filesystem, 'rename', async (from, to) => {
      if (to !== target) return originalRename(from, to);
      attempts += 1;
      assert.equal(await readFile(target, 'utf8'), originalBytes);
      if (attempts < 3)
        throw Object.assign(new Error('Reader temporarily holds usage state'), { code: 'EPERM' });
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const privateOutput = 'private-provider-output-not-for-storage';
    const result = {
      status: 'exited',
      exitCode: 0,
      stdout: [
        { type: 'thread.started', thread_id: 'fixture-thread' },
        {
          type: 'turn.completed',
          usage: { input_tokens: 12, output_tokens: 5 },
          output: privateOutput,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    };
    let launches = 0;
    const observed = await observeProviderInvocation({
      root,
      providerId: 'codex',
      taskId: 'task_fixture',
      invocationId: 'fixture-invocation',
      input: {
        provider: { id: 'codex' },
        plan: { executable: 'fixture-never-launched', args: ['exec', 'fixture'], cwd: root },
        executionProfile: 'host-local-authorized',
      },
      launch: async (input) => {
        launches += 1;
        if (input.plan.args[0] === '--version')
          return { status: 'exited', exitCode: 0, stdout: 'codex-cli 0.42.1' };
        return result;
      },
    });

    assert.equal(observed, result);
    assert.equal(launches, 2);
    const usage = await inspectUsage(root);
    assert.equal(usage.records.length, 1);
    assert.equal(usage.records[0].providerVersion, '0.42.1');
    assert.equal(usage.records[0].sessionId, 'fixture-thread');
    assert.equal(usage.records[0].taskId, 'task_fixture');
    assert.equal(usage.summary.tokens.input, 12);
    assert.equal(usage.summary.tokens.output, 5);
    assert.ok(attempts >= 3 && attempts <= 9);
    assert.equal((await readFile(target, 'utf8')).includes(privateOutput), false);
    assert.deepEqual(await readdir(path.dirname(target)), ['state-v1.json']);
  },
);
