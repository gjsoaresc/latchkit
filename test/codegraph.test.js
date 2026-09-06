import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inspectCodegraph,
  exploreCodegraph,
  saveCodegraphSettings,
} from '../dist/src/integrations/codegraph/service.js';

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
  await fs.writeFile(
    path.join(first, '.codegraph', 'latchkit-source.sha256'),
    before.sourceFingerprint + '\n',
  );
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
