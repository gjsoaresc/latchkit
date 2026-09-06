import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishArchiveSet } from '../scripts/atomic-publish.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-atomic-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('publishArchiveSet commits the archive and every sidecar', async (t) => {
  const root = await fixture(t);
  const staged = path.join(root, 'archive.zip.token.tmp');
  await writeFile(staged, 'archive bytes');
  const finalArchive = path.join(root, 'archive.zip');

  const committed = await publishArchiveSet(finalArchive, staged, [
    { path: `${finalArchive}.sha256`, bytes: 'deadbeef  archive.zip\n' },
    { path: `${finalArchive}.spdx.json`, bytes: '{"packages":[]}' },
    { path: `${finalArchive}.manifest.json`, bytes: '{"schemaVersion":1}' },
  ]);

  assert.deepEqual(committed, [
    finalArchive,
    `${finalArchive}.sha256`,
    `${finalArchive}.spdx.json`,
    `${finalArchive}.manifest.json`,
  ]);
  assert.equal(await readFile(finalArchive, 'utf8'), 'archive bytes');
  assert.equal(await readFile(`${finalArchive}.sha256`, 'utf8'), 'deadbeef  archive.zip\n');
  const entries = await readdir(root);
  assert.deepEqual(
    entries.sort(),
    [
      'archive.zip',
      'archive.zip.manifest.json',
      'archive.zip.sha256',
      'archive.zip.spdx.json',
    ].sort(),
    'no staging leftovers should remain after a successful publish',
  );
});

test('publishArchiveSet reclaims everything it staged when a sidecar write fails, preserving unrelated files', async (t) => {
  const root = await fixture(t);
  const staged = path.join(root, 'archive.zip.token.tmp');
  await writeFile(staged, 'archive bytes');
  const finalArchive = path.join(root, 'archive.zip');
  // A previously published, distinct artifact in the same directory.
  await writeFile(path.join(root, 'previous.zip'), 'previous archive');
  await writeFile(path.join(root, 'previous.zip.manifest.json'), '{"version":"0.9.0"}');

  await assert.rejects(
    publishArchiveSet(finalArchive, staged, [
      { path: `${finalArchive}.sha256`, bytes: 'deadbeef  archive.zip\n' },
      // A destination under a directory that does not exist forces the
      // sidecar write to fail partway through the ordered list.
      { path: path.join(root, 'missing-dir', 'archive.zip.spdx.json'), bytes: '{}' },
      { path: `${finalArchive}.manifest.json`, bytes: '{"schemaVersion":1}' },
    ]),
  );

  const entries = await readdir(root);
  assert.deepEqual(
    entries.sort(),
    ['previous.zip', 'previous.zip.manifest.json'].sort(),
    'a failed publish must leave no trace of its own archive, sidecars, or staging files',
  );
  assert.equal(await readFile(path.join(root, 'previous.zip'), 'utf8'), 'previous archive');
});

test('publishArchiveSet never commits the manifest before the archive and other sidecars exist', async (t) => {
  const root = await fixture(t);
  const staged = path.join(root, 'archive.zip.token.tmp');
  await writeFile(staged, 'archive bytes');
  const finalArchive = path.join(root, 'archive.zip');

  await assert.rejects(
    publishArchiveSet(finalArchive, staged, [
      { path: `${finalArchive}.sha256`, bytes: 'deadbeef  archive.zip\n' },
      { path: path.join(root, 'missing-dir', 'archive.zip.spdx.json'), bytes: '{}' },
      { path: `${finalArchive}.manifest.json`, bytes: '{"schemaVersion":1}' },
    ]),
  );

  assert.deepEqual(await readdir(root), []);
});

test('a retried publish succeeds cleanly after a prior failure', async (t) => {
  const root = await fixture(t);
  const finalArchive = path.join(root, 'archive.zip');

  const firstStaged = path.join(root, 'archive.zip.first.tmp');
  await writeFile(firstStaged, 'attempt one');
  await assert.rejects(
    publishArchiveSet(finalArchive, firstStaged, [
      { path: path.join(root, 'missing-dir', 'archive.zip.sha256'), bytes: 'x' },
    ]),
  );
  assert.deepEqual(await readdir(root), []);

  const secondStaged = path.join(root, 'archive.zip.second.tmp');
  await writeFile(secondStaged, 'attempt two');
  await publishArchiveSet(finalArchive, secondStaged, [
    { path: `${finalArchive}.manifest.json`, bytes: '{"schemaVersion":1}' },
  ]);
  assert.equal(await readFile(finalArchive, 'utf8'), 'attempt two');
});
