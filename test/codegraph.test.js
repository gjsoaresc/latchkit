import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  inspectCodegraph,
  exploreCodegraph,
  saveCodegraphSettings,
  syncCodegraph,
} from '../dist/src/integrations/codegraph/service.js';

const execute = promisify(execFile);

async function seedCurrentReceipt(root, status) {
  await fs.writeFile(
    path.join(root, '.codegraph', 'latchkit-source.sha256'),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceFingerprint: status.sourceFingerprint,
      indexDigest: status.indexDigest,
      index: status.indexFiles,
    })}\n`,
  );
}

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-codegraph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 1;\n');
  return fs.realpath(root);
}

test('CodeGraph is disabled by default, preserves an absent optional tool, and supplies a visible fallback', async (t) => {
  const root = await project(t);
  const result = await inspectCodegraph(root);
  assert.equal(result.enabled, false);
  assert.equal(result.index, 'missing');
  assert.match(result.fallback, /ordinary bounded source search/i);
  assert.equal(await fs.stat(path.join(root, '.codegraph')).catch(() => null), null);
});

test('CodeGraph rejects stale source indexes and query bounds before invocation', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, '.codegraph'));
  await fs.writeFile(path.join(root, '.codegraph', 'codegraph.db'), 'fixture');
  await saveCodegraphSettings(root, {
    schemaVersion: 1,
    enabled: true,
    exclusions: ['.codegraph/**', 'node_modules/**', '.git/**'],
  });
  const stale = await exploreCodegraph(root, 'value');
  assert.equal(stale.result, 'fallback');
  assert.equal(stale.freshness, 'stale');
  await assert.rejects(() => exploreCodegraph(root, 'x'.repeat(501)), /1-500/);
});

test('source drift and project roots are isolated; excluded files do not affect freshness', async (t) => {
  const first = await project(t),
    second = await project(t);
  await fs.mkdir(path.join(first, '.codegraph'));
  await fs.writeFile(path.join(first, '.codegraph', 'codegraph.db'), 'fixture');
  const settings = {
    schemaVersion: 1,
    enabled: true,
    exclusions: ['.codegraph/**', 'node_modules/**', '.git/**', '.latchkit/**'],
  };
  await saveCodegraphSettings(first, settings);
  const before = await inspectCodegraph(first);
  await seedCurrentReceipt(first, before);
  assert.equal((await inspectCodegraph(first)).freshness, 'current');
  await fs.mkdir(path.join(first, 'node_modules'));
  await fs.writeFile(path.join(first, 'node_modules', 'ignored.js'), 'x');
  assert.equal((await inspectCodegraph(first)).freshness, 'current');
  await fs.writeFile(path.join(first, 'app.ts'), 'export const value = 2;\n');
  assert.equal((await inspectCodegraph(first)).freshness, 'stale');
  assert.notEqual(
    (await inspectCodegraph(first)).project,
    (await inspectCodegraph(second)).project,
  );
});

test('settings are transaction-backed and malformed settings are rejected', async (t) => {
  const root = await project(t);
  await saveCodegraphSettings(root, {
    schemaVersion: 1,
    enabled: true,
    exclusions: ['.codegraph/**', '.latchkit/**'],
  });
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, '.latchkit', 'manifest.json'), 'utf8'))
      .schemaVersion,
    3,
  );
  assert.equal(
    await fs.stat(path.join(root, '.latchkit', 'transaction.json')).catch(() => null),
    null,
  );
  await fs.writeFile(path.join(root, '.latchkit', 'codegraph-v1.json'), '{broken');
  await assert.rejects(() => inspectCodegraph(root), /Invalid CodeGraph settings/);
  await assert.rejects(
    () =>
      saveCodegraphSettings(root, {
        schemaVersion: 1,
        enabled: true,
        exclusions: ['../outside'],
      }),
    /Invalid CodeGraph exclusions/,
  );
});

test('a failed settings transaction rolls back the setting and journal', async (t) => {
  const root = await project(t);
  const originalRename = filesystem.rename;
  let failed = false;
  t.mock.method(filesystem, 'rename', async (from, to) => {
    if (!failed && String(to).endsWith(`${path.sep}.latchkit${path.sep}manifest.json`)) {
      failed = true;
      throw Object.assign(new Error('Injected manifest rename failure'), { code: 'EIO' });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    () =>
      saveCodegraphSettings(root, {
        schemaVersion: 1,
        enabled: true,
        exclusions: ['.codegraph/**'],
      }),
    /Injected manifest rename failure/,
  );
  assert.equal(failed, true);
  assert.equal(
    await fs.stat(path.join(root, '.latchkit', 'codegraph-v1.json')).catch(() => null),
    null,
  );
  assert.equal(
    await fs.stat(path.join(root, '.latchkit', 'manifest.json')).catch(() => null),
    null,
  );
  assert.equal(
    await fs.stat(path.join(root, '.latchkit', 'transaction.json')).catch(() => null),
    null,
  );
});

test('receipt binds the source and SQLite WAL content, and unsafe junctions fail closed', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, '.codegraph'));
  await fs.writeFile(path.join(root, '.codegraph', 'codegraph.db'), 'database');
  await fs.writeFile(path.join(root, '.codegraph', 'codegraph.db-wal'), 'wal-v1');
  await saveCodegraphSettings(root, {
    schemaVersion: 1,
    enabled: true,
    exclusions: ['.codegraph/**', '.latchkit/**', 'node_modules/**', '.git/**'],
  });
  const before = await inspectCodegraph(root);
  await seedCurrentReceipt(root, before);
  assert.equal((await inspectCodegraph(root)).freshness, 'current');
  await fs.writeFile(path.join(root, '.codegraph', 'codegraph.db-wal'), 'wal-v2');
  assert.equal((await inspectCodegraph(root)).freshness, 'stale');
  assert.equal((await exploreCodegraph(root, 'value')).result, 'fallback');

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-codegraph-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.rm(path.join(root, '.codegraph'), { recursive: true, force: true });
  await fs.symlink(outside, path.join(root, '.codegraph'), 'junction');
  assert.equal((await inspectCodegraph(root)).index, 'unsafe');
  assert.equal((await inspectCodegraph(root)).freshness, 'unsafe');
});

test('the pinned private CLI completes init, query, edit, sync, query on Windows fixtures', async (t) => {
  const root = await project(t);
  const shim = path.resolve('node_modules/@colbymchenry/codegraph/npm-shim.js');
  const environment = {
    ...process.env,
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_NO_DOWNLOAD: '1',
  };
  const runPinned = (args, options = {}) =>
    execute(process.execPath, [shim, ...args], {
      cwd: root,
      env: environment,
      windowsHide: true,
      ...options,
    });
  await runPinned(['init', root]);
  const first = await runPinned(['explore', 'answer']);
  assert.match(first.stdout, /answer/);
  await fs.writeFile(
    path.join(root, 'app.ts'),
    'export function answer(): number { return 43; }\n',
  );
  const directSync = await runPinned(['sync']);
  assert.match(directSync.stdout, /Synced|Done/);
  const second = await runPinned(['explore', 'answer']);
  assert.match(second.stdout, /43/);

  await saveCodegraphSettings(root, {
    schemaVersion: 1,
    enabled: true,
    exclusions: ['.git/**', '.codegraph/**', '.latchkit/**', 'node_modules/**'],
  });
  await fs.writeFile(
    path.join(root, 'app.ts'),
    'export function answer(): number { return 44; }\n',
  );
  assert.equal((await syncCodegraph(root)).result, 'synced');
  assert.equal((await exploreCodegraph(root, 'answer')).result, 'graph');
});

test('query refuses a source race after the pre-query identity was captured', async (t) => {
  const root = await project(t);
  const shim = path.resolve('node_modules/@colbymchenry/codegraph/npm-shim.js');
  const environment = {
    ...process.env,
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_NO_DOWNLOAD: '1',
  };
  await execute(process.execPath, [shim, 'init', root], {
    cwd: root,
    env: environment,
    windowsHide: true,
  });
  await saveCodegraphSettings(root, {
    schemaVersion: 1,
    enabled: true,
    exclusions: ['.git/**', '.codegraph/**', '.latchkit/**', 'node_modules/**'],
  });
  const status = await inspectCodegraph(root);
  await seedCurrentReceipt(root, status);
  const originalReadFile = filesystem.readFile;
  let raced = false;
  t.mock.method(filesystem, 'readFile', async (...args) => {
    const value = await originalReadFile(...args);
    if (!raced && String(args[0]).endsWith('latchkit-source.sha256')) {
      raced = true;
      await fs.writeFile(
        path.join(root, 'app.ts'),
        'export function answer(): number { return 99; }\n',
      );
    }
    return value;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await exploreCodegraph(root, 'answer');
  assert.equal(raced, true);
  assert.equal(result.result, 'fallback');
  assert.match(result.reason, /source or index changed/i);
});

test('sync refuses to stamp a receipt when the source changes during indexing', async (t) => {
  const root = await project(t);
  const shim = path.resolve('node_modules/@colbymchenry/codegraph/npm-shim.js');
  const environment = {
    ...process.env,
    DO_NOT_TRACK: '1',
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_NO_DOWNLOAD: '1',
  };
  await execute(process.execPath, [shim, 'init', root], {
    cwd: root,
    env: environment,
    windowsHide: true,
  });
  await saveCodegraphSettings(root, {
    schemaVersion: 1,
    enabled: true,
    exclusions: ['.git/**', '.codegraph/**', '.latchkit/**', 'node_modules/**'],
  });
  const status = await inspectCodegraph(root);
  await seedCurrentReceipt(root, status);
  const originalReadFile = filesystem.readFile;
  let raced = false;
  t.mock.method(filesystem, 'readFile', async (...args) => {
    const value = await originalReadFile(...args);
    if (!raced && String(args[0]).endsWith('latchkit-source.sha256')) {
      raced = true;
      await fs.writeFile(
        path.join(root, 'app.ts'),
        'export function answer(): number { return 100; }\n',
      );
    }
    return value;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await syncCodegraph(root);
  assert.equal(raced, true);
  assert.equal(result.result, 'fallback');
  assert.match(result.reason, /source changed during sync/i);
});
