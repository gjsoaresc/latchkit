import assert from 'node:assert/strict';
import filesystem, {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeAtomic } from '../dist/src/storage.js';
import { emptyTaskState, readTaskState, writeTaskState } from '../dist/src/task-state/store.js';
import {
  emptyProjectMemory,
  readProjectMemory,
  writeProjectMemory,
} from '../dist/src/project-memory/store.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-sharing-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await mkdir(path.join(root, 'state'));
  await writeFile(path.join(root, 'state/value.json'), 'original');
  return root;
}

function interceptRename(t, operation) {
  const original = filesystem.rename;
  t.mock.method(filesystem, 'rename', (from, to) => operation(from, to, original));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test(
  'atomic state replacement retries Windows sharing failures without deleting old bytes',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    let attempts = 0;
    interceptRename(t, async (from, to, rename) => {
      attempts += 1;
      assert.equal(await readFile(to, 'utf8'), 'original');
      if (attempts < 4) throw Object.assign(new Error('Reader holds the file'), { code: 'EPERM' });
      return rename(from, to);
    });
    await writeAtomic(root, 'state/value.json', 'replacement');
    assert.ok(attempts >= 4 && attempts <= 9);
    assert.equal(await readFile(path.join(root, 'state/value.json'), 'utf8'), 'replacement');
    assert.deepEqual(await readdir(path.join(root, 'state')), ['value.json']);
  },
);

test(
  'atomic state sharing exhaustion is bounded and preserves the original error and file',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    const failure = Object.assign(new Error('Persistent sharing failure'), { code: 'EACCES' });
    let attempts = 0;
    interceptRename(t, async () => {
      attempts += 1;
      throw failure;
    });
    await assert.rejects(
      writeAtomic(root, 'state/value.json', 'replacement'),
      (error) => error === failure,
    );
    assert.ok(attempts > 1 && attempts <= 9);
    assert.equal(await readFile(path.join(root, 'state/value.json'), 'utf8'), 'original');
    assert.deepEqual(await readdir(path.join(root, 'state')), ['value.json']);
  },
);

test('atomic state writes do not retry unrelated failures', async (t) => {
  const root = await fixture(t);
  const failure = Object.assign(new Error('Read-only filesystem'), { code: 'EROFS' });
  let attempts = 0;
  interceptRename(t, async () => {
    attempts += 1;
    throw failure;
  });
  await assert.rejects(
    writeAtomic(root, 'state/value.json', 'replacement'),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(await readFile(path.join(root, 'state/value.json'), 'utf8'), 'original');
});

test(
  'atomic state retries refuse a substituted junction and preserve its target during cleanup',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    const unrelated = path.join(root, 'unrelated');
    await mkdir(unrelated);
    let temporaryName;
    let attempts = 0;
    interceptRename(t, async (from, _to, rename) => {
      attempts += 1;
      temporaryName = path.basename(from);
      await rename(path.join(root, 'state'), path.join(root, 'preserved-state'));
      await writeFile(path.join(unrelated, temporaryName), 'unrelated bytes');
      await symlink(unrelated, path.join(root, 'state'), 'junction');
      throw Object.assign(new Error('Sharing failure before retry'), { code: 'EPERM' });
    });
    await assert.rejects(writeAtomic(root, 'state/value.json', 'replacement'), /junction/);
    assert.equal(attempts, 1);
    assert.equal(await readFile(path.join(unrelated, temporaryName), 'utf8'), 'unrelated bytes');
    assert.equal(await readFile(path.join(root, 'preserved-state/value.json'), 'utf8'), 'original');
  },
);

test(
  'task and memory state survive sharing failures while task fault boundaries retain their ordering',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fixture(t);
    const taskState = emptyTaskState();
    const memory = emptyProjectMemory();
    await writeTaskState(root, taskState);
    await writeProjectMemory(root, memory);
    const originalTaskTime = taskState.updatedAt;
    const nextTime = new Date(Date.now() + 1000).toISOString();
    const attempts = new Map();
    interceptRename(t, async (from, to, rename) => {
      const attempt = (attempts.get(to) ?? 0) + 1;
      attempts.set(to, attempt);
      assert.notEqual(JSON.parse(await readFile(to, 'utf8')).updatedAt, nextTime);
      if (attempt < 3) throw Object.assign(new Error('Sharing failure'), { code: 'EPERM' });
      return rename(from, to);
    });
    taskState.updatedAt = nextTime;
    memory.updatedAt = nextTime;
    const boundaries = [];
    await writeTaskState(root, taskState, {
      faultBoundary: async (boundary, detail) => {
        boundaries.push(boundary);
        assert.equal(
          JSON.parse(await readFile(detail.target, 'utf8')).updatedAt,
          boundary === 'prepared' ? originalTaskTime : nextTime,
        );
        if (boundary === 'prepared')
          assert.equal(JSON.parse(await readFile(detail.temporary, 'utf8')).updatedAt, nextTime);
      },
    });
    await writeProjectMemory(root, memory);
    assert.deepEqual(boundaries, ['prepared', 'committed']);
    assert.equal((await readTaskState(root)).updatedAt, nextTime);
    assert.equal((await readProjectMemory(root)).updatedAt, nextTime);
    assert.equal(attempts.size, 2);
    assert.ok([...attempts.values()].every((attempt) => attempt >= 3 && attempt <= 9));
  },
);
