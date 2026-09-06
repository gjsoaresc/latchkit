import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listFiles, reconcileDirectory } from '../scripts/reconcile.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('listFiles reports POSIX-relative paths and tolerates a missing root', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'a');
  await writeFile(path.join(root, 'nested', 'b.txt'), 'b');
  await writeFile(path.join(root, 'nested', 'deep', 'c.txt'), 'c');
  assert.deepEqual(
    (await listFiles(root)).sort(),
    ['a.txt', 'nested/b.txt', 'nested/deep/c.txt'].sort(),
  );
  assert.deepEqual(await listFiles(path.join(root, 'does-not-exist')), []);
});

test('reconcileDirectory removes files absent from the keep set and prunes empty directories', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'current'), { recursive: true });
  await mkdir(path.join(root, 'stale-dir'), { recursive: true });
  await writeFile(path.join(root, 'current', 'keep.js'), 'keep');
  await writeFile(path.join(root, 'stale-dir', 'orphan.js'), 'orphan');
  await writeFile(path.join(root, 'stale-top-level.js'), 'stale');

  const result = await reconcileDirectory(root, ['current/keep.js']);

  assert.deepEqual(result.removed.sort(), ['stale-dir/orphan.js', 'stale-top-level.js'].sort());
  assert.equal(result.bytesReclaimed, 'orphan'.length + 'stale'.length);
  assert.deepEqual(await listFiles(root), ['current/keep.js']);
  await assert.rejects(stat(path.join(root, 'stale-dir')), /ENOENT/);
});

test('reconcileDirectory is idempotent', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'a'), { recursive: true });
  await writeFile(path.join(root, 'a', 'keep.js'), 'keep');
  await writeFile(path.join(root, 'stale.js'), 'stale');

  await reconcileDirectory(root, ['a/keep.js']);
  const second = await reconcileDirectory(root, ['a/keep.js']);

  assert.deepEqual(second, { removed: [], bytesReclaimed: 0 });
  assert.deepEqual(await listFiles(root), ['a/keep.js']);
});

test('reconcileDirectory dry-run reports without deleting', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'stale.js'), 'stale');

  const result = await reconcileDirectory(root, [], { dryRun: true });

  assert.deepEqual(result.removed, ['stale.js']);
  assert.equal(result.bytesReclaimed, 'stale'.length);
  assert.deepEqual(await listFiles(root), ['stale.js']);
});

test('reconcileDirectory leaves an ignored subtree untouched', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'licenses', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'licenses', 'pkg', 'LICENSE'), 'license');
  await writeFile(path.join(root, 'stale.js'), 'stale');

  const result = await reconcileDirectory(root, [], { ignore: ['licenses'] });

  assert.deepEqual(result.removed, ['stale.js']);
  assert.deepEqual(await listFiles(root), ['licenses/pkg/LICENSE']);
});

test('reconcileDirectory never follows or removes a symbolic link', async (t) => {
  const root = await fixture(t);
  const target = await fixture(t);
  await writeFile(path.join(target, 'outside.txt'), 'outside contents');
  const link = path.join(root, 'link');
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('links unavailable');
    throw error;
  }

  const result = await reconcileDirectory(root, []);

  assert.deepEqual(result.removed, []);
  assert.equal((await readdir(root)).includes('link'), true);
  assert.equal(await readdir(target).then((entries) => entries.includes('outside.txt')), true);
});

test('reconcileDirectory tolerates a missing root', async (t) => {
  const root = await fixture(t);
  const result = await reconcileDirectory(path.join(root, 'missing'), ['anything']);
  assert.deepEqual(result, { removed: [], bytesReclaimed: 0 });
});
