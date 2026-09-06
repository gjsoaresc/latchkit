import test from 'node:test';
import assert from 'node:assert/strict';
import filesystem, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createTask } from '../dist/src/task-state/service.js';
import { createTaskController, readTaskSessions } from '../dist/src/runtime/task-controller.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-session-persistence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = await createTask(root, {
    title: 'Local session fixture',
    authorizationRequired: false,
  });
  return { root, task };
}

function interceptSessionRename(t, operation) {
  const original = filesystem.rename;
  t.mock.method(filesystem, 'rename', (from, to) =>
    String(to).endsWith('sessions-v1.json') ? operation(from, to, original) : original(from, to),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test(
  'session persistence recovers a Windows sharing denial before starting the owned command',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const { root, task } = await fixture(t);
    let attempts = 0;
    let launches = 0;
    interceptSessionRename(t, async (from, to, rename) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('Sharing denial'), { code: 'EPERM' });
      return rename(from, to);
    });
    const controller = createTaskController({
      root,
      launch: async () => {
        launches += 1;
        return { status: 'exited', exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await controller.start({ taskId: task.id, providerId: 'codex', executionAuthorized: true });
    assert.equal(launches, 1);
    assert.ok(attempts >= 3);
    assert.equal((await readTaskSessions(root))[0].state, 'finished');
  },
);

test('failed process-start persistence aborts the owned launch and rejects after draining without an unhandled promise', async (t) => {
  const { root, task } = await fixture(t);
  const failure = Object.assign(new Error('Synthetic read-only volume'), { code: 'EROFS' });
  let attempts = 0;
  let failedWrite;
  const writeFailed = new Promise((resolve) => {
    failedWrite = resolve;
  });
  let aborted = false;
  interceptSessionRename(t, async (from, to, rename) => {
    attempts += 1;
    if (attempts === 2) {
      failedWrite();
      throw failure;
    }
    return rename(from, to);
  });
  const controller = createTaskController({
    root,
    launch: async ({ onEvent, signal }) => {
      onEvent({ type: 'process-start', pid: process.pid });
      await writeFailed;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        const cancelled = () => {
          clearTimeout(timer);
          resolve();
        };
        if (signal.aborted) cancelled();
        else signal.addEventListener('abort', cancelled, { once: true });
      });
      aborted = signal.aborted;
      return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(
    controller.start({ taskId: task.id, providerId: 'codex', executionAuthorized: true }),
    (error) => error === failure,
  );
  assert.equal(aborted, true);
  assert.equal(attempts, 2);
  // Immediate removal has no retry and must not race an event-save continuation.
  await rm(root, { recursive: true, force: true });
});
