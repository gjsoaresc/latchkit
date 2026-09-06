import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installBundle } from '../dist/src/installation/manager.js';
import { detectInstallationOwnership } from '../dist/src/installation/updates/ownership.js';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = `${process.platform}-${process.arch}`;
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

async function fixtureBundle(scratch) {
  const bundle = path.join(scratch, 'bundle');
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(
    process.execPath,
    path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      package: 'latchkit',
      version,
      target: TARGET,
      nodeVersion: process.version,
      files: await inventory(bundle),
    })}\n`,
  );
  return bundle;
}

async function tempRoot(t, prefix) {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return scratch;
}

test('an unsupported platform/architecture is reported before inspecting any root', async () => {
  const result = await detectInstallationOwnership({
    target: 'win32-arm64',
    runningFromInstallRoot: '/somewhere',
    root: '/should-not-be-touched',
  });
  assert.equal(result.kind, 'unsupported-platform');
  assert.equal(result.updateRoute, 'not-applicable');
  assert.equal(result.root, null);
});

test('no LATCHKIT_INSTALL_ROOT means a source/development checkout, not an installed bundle', async () => {
  const result = await detectInstallationOwnership({
    target: TARGET,
    runningFromInstallRoot: null,
  });
  assert.equal(result.kind, 'source-development');
  assert.equal(result.updateRoute, 'not-applicable');
});

test('a root under a Homebrew Cellar path is package-manager-owned', async () => {
  const result = await detectInstallationOwnership({
    target: TARGET,
    runningFromInstallRoot: '/opt/homebrew/Cellar/latchkit/1.0.0',
    root: '/opt/homebrew/Cellar/latchkit/1.0.0',
  });
  assert.equal(result.kind, 'package-manager');
  assert.equal(result.updateRoute, 'package-manager');
  assert.match(result.reason, /Homebrew/);
});

test('a root under a WinGet Packages path is package-manager-owned', async () => {
  const winGetRoot = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Latchkit';
  const result = await detectInstallationOwnership({
    target: TARGET,
    runningFromInstallRoot: winGetRoot,
    root: winGetRoot,
  });
  assert.equal(result.kind, 'package-manager');
  assert.equal(result.updateRoute, 'package-manager');
  assert.match(result.reason, /WinGet/);
});

test('a real direct install is self-managed and updatable', async (t) => {
  const root = await tempRoot(t, 'latchkit-ownership-self-managed-');
  const bundle = await fixtureBundle(root);
  await installBundle({ root: path.join(root, 'install'), bundle, target: TARGET });
  const result = await detectInstallationOwnership({
    target: TARGET,
    runningFromInstallRoot: path.join(root, 'install'),
    root: path.join(root, 'install'),
  });
  assert.equal(result.kind, 'self-managed');
  assert.equal(result.updateRoute, 'console-or-cli');
});

test('a directory that exists but was never installed/adopted is unowned', async (t) => {
  const root = await tempRoot(t, 'latchkit-ownership-unowned-');
  await mkdir(path.join(root, 'install'), { recursive: true });
  const result = await detectInstallationOwnership({
    target: TARGET,
    runningFromInstallRoot: path.join(root, 'install'),
    root: path.join(root, 'install'),
  });
  assert.equal(result.kind, 'unowned');
  assert.equal(result.updateRoute, 'manual-bootstrap');
});

test('a root that does not exist at all is unowned, not a crash', async (t) => {
  const root = await tempRoot(t, 'latchkit-ownership-missing-');
  const missing = path.join(root, 'nonexistent', 'nested');
  const result = await detectInstallationOwnership({
    target: TARGET,
    runningFromInstallRoot: missing,
    root: missing,
  });
  assert.equal(result.kind, 'unowned');
  assert.equal(result.updateRoute, 'manual-bootstrap');
});
