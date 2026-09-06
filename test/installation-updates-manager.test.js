import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  installBundle,
  inspectInstallation,
  rollbackInstallation,
  stageBundle,
} from '../dist/src/installation/manager.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(filename, relative)));
    else if (entry.isFile()) {
      const bytes = await readFile(filename);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}

async function fixtureBundle(scratch, version, label = version) {
  const bundle = path.join(scratch, `bundle-${label}`);
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(
    process.execPath,
    path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const target = `${process.platform}-${process.arch}`;
  if (version !== undefined) {
    const packageFile = path.join(bundle, 'app', 'dist', 'package.json');
    const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
    packageJson.version = version;
    await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  const resolvedVersion =
    version ?? JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      package: 'latchkit',
      version: resolvedVersion,
      target,
      nodeVersion: process.version,
      files: await inventory(bundle),
    })}\n`,
  );
  return { bundle, target, version: resolvedVersion };
}

/** Count exactly how many times the installation's `current` activation
 * pointer is actually renamed into place — the ground-truth signal for
 * "did an activation happen", independent of which code path triggered it. */
function countActivations(t, root) {
  const original = filesystem.rename;
  const activePath = path.join(root, 'current');
  let count = 0;
  t.mock.method(filesystem, 'rename', async (from, to) => {
    if (to === activePath) count += 1;
    return original(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => count;
}

test('stageBundle stages an immutable version without activating: current, launchers, and hooks are untouched', async (t) => {
  const scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-stage-separation-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'install root é');
  const { bundle, target, version } = await fixtureBundle(scratch, '9.9.9');
  const activations = countActivations(t, root);

  const staged = await stageBundle({ root, bundle, target });
  assert.equal(staged.version, version);
  assert.equal(staged.key, `${version}-${target}`);
  assert.equal(activations(), 0, 'staging must never write the activation pointer');
  await assert.rejects(readFile(path.join(root, 'current')), { code: 'ENOENT' });
  await assert.rejects(readdir(path.join(root, 'bin')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(root, 'versions')), [staged.key]);

  // Idempotent retry: staging the exact same bundle again re-verifies and
  // re-smokes the already-staged directory rather than erroring or
  // duplicating it, and still never activates.
  const restaged = await stageBundle({ root, bundle, target });
  assert.equal(restaged.key, staged.key);
  assert.equal(activations(), 0);
  assert.deepEqual(await readdir(path.join(root, 'versions')), [staged.key]);

  // Activation is a distinct, later step that reuses the existing rollback
  // primitive to point `current` at the staged immutable directory.
  const activated = await rollbackInstallation(root, version, target);
  assert.equal(activated.active, staged.key);
  assert.equal(activations(), 1, 'exactly one activation after the explicit activation call');
  assert.deepEqual(await readFile(path.join(root, 'current'), 'utf8'), `${staged.key}\n`);
  assert.ok((await readdir(path.join(root, 'bin'))).length > 0);
});

test('stageBundle rejects a corrupted source bundle without touching an existing activation', async (t) => {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'latchkit-stage-corrupt-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'root');
  const first = await fixtureBundle(scratch, '1.0.0', 'first');
  const activations = countActivations(t, root);
  await installBundle({ root, bundle: first.bundle, target: first.target });
  assert.equal(activations(), 1);
  const active = await readFile(path.join(root, 'current'), 'utf8');

  const second = await fixtureBundle(scratch, '2.0.0', 'second');
  await writeFile(path.join(second.bundle, 'app', 'dist', 'src', 'cli.js'), 'corrupted');
  await assert.rejects(
    () => stageBundle({ root, bundle: second.bundle, target: second.target }),
    /integrity check failed/,
  );
  assert.equal(activations(), 1, 'a failed staging attempt must never activate anything');
  assert.deepEqual(await readFile(path.join(root, 'current'), 'utf8'), active);
  assert.deepEqual(await readdir(path.join(root, 'versions')), [
    first.version + '-' + first.target,
  ]);
});

test('staging two versions and activating each independently leaves the other retained and inert', async (t) => {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'latchkit-stage-multi-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'root');
  const activations = countActivations(t, root);
  const first = await fixtureBundle(scratch, '1.0.0', 'first');
  const second = await fixtureBundle(scratch, '1.1.0', 'second');

  const stagedFirst = await stageBundle({ root, bundle: first.bundle, target: first.target });
  const stagedSecond = await stageBundle({ root, bundle: second.bundle, target: second.target });
  assert.equal(activations(), 0);
  assert.deepEqual(
    (await readdir(path.join(root, 'versions'))).sort(),
    [stagedFirst.key, stagedSecond.key].sort(),
  );

  await rollbackInstallation(root, second.version, second.target);
  assert.equal(activations(), 1);
  assert.equal((await inspectInstallation(root)).active, stagedSecond.key);

  await rollbackInstallation(root, first.version, first.target);
  assert.equal(activations(), 2);
  const inspected = await inspectInstallation(root);
  assert.equal(inspected.active, stagedFirst.key);
  assert.ok(inspected.retained.includes(stagedSecond.key));
});
