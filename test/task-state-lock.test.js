import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withTaskStateLock } from '../src/task-state/lock.js';

test('same-process contenders retry when the prior owner releases between inspection and compare', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-task-lock-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let active = 0;
  let peak = 0;
  const completed = [];
  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      withTaskStateLock(root, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        completed.push(index);
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 1);
  assert.equal(completed.length, 24);
});
