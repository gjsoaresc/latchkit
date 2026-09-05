import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject, readConfig } from '../src/core.js';
import { startServer } from '../src/server.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-api-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url, token } = await startServer(root);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  const origin = new URL(url).origin;
  const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
  return { root, origin, headers, server };
}

test('console binds to loopback and all API data requires a session token', async t => {
  const { origin, headers, server } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const denied = await fetch(`${origin}/api/state`);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const state = await fetch(`${origin}/api/state`, { headers });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).config.skills[0], 'spec');
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
});

test('configuration and sync API persist the selected skills with a read-only preview', async t => {
  const { root, origin, headers } = await fixture(t);
  const config = { schemaVersion: 1, providers: ['codex'], skills: ['fix', 'review'] };
  const save = await fetch(`${origin}/api/config`, { method: 'PUT', headers, body: JSON.stringify(config) });
  assert.equal(save.status, 200);
  assert.deepEqual(await readConfig(root), config);
  const preview = await (await fetch(`${origin}/api/plan`, { headers })).json();
  assert.equal(preview.changes.filter(c => c.action === 'create').length, 2);
  await assert.rejects(readFile(path.join(root, '.agents/skills/latchkit-fix/SKILL.md')), { code: 'ENOENT' });
  const synced = await fetch(`${origin}/api/sync`, { method: 'POST', headers, body: '{}' });
  assert.equal(synced.status, 200);
  assert.match(await readFile(path.join(root, '.agents/skills/latchkit-fix/SKILL.md'), 'utf8'), /name: latchkit-fix/);
  const repeated = await (await fetch(`${origin}/api/plan`, { headers })).json();
  assert.ok(repeated.changes.every(c => c.action === 'unchanged'));
});

test('configuration migration API previews without writing and preserves a v1 backup', async t => {
  const { root, origin, headers } = await fixture(t);
  const configPath = path.join(root, '.latchkit', 'config.json');
  const original = '{\n  "schemaVersion": 1,\n  "providers": ["codex"],\n  "skills": ["spec"]\n}\n';
  await writeFile(configPath, original);

  const stateResponse = await fetch(`${origin}/api/state`, { headers });
  assert.equal(stateResponse.status, 200);
  assert.deepEqual((await stateResponse.json()).config, JSON.parse(original));

  const previewResponse = await fetch(`${origin}/api/config/migration?to=2`, { headers });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.status, 'ready');
  assert.equal(await readFile(configPath, 'utf8'), original);

  const applyResponse = await fetch(`${origin}/api/config/migration`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ toVersion: 2 }),
  });
  assert.equal(applyResponse.status, 200);
  const applied = await applyResponse.json();
  assert.equal(applied.status, 'migrated');
  assert.equal(await readFile(path.join(root, ...applied.backupPath.split('/')), 'utf8'), original);
  assert.equal((await readConfig(root)).schemaVersion, 2);
});

test('foreign origins, missing origins, invalid config and oversized requests cannot mutate configuration', async t => {
  const { root, origin, headers } = await fixture(t);
  const original = await readConfig(root);
  const body = JSON.stringify({ schemaVersion: 1, providers: [], skills: [] });
  for (const requestOrigin of ['https://example.com', undefined]) {
    const requestHeaders = { ...headers };
    if (requestOrigin) requestHeaders.Origin = requestOrigin;
    else delete requestHeaders.Origin;
    const response = await fetch(`${origin}/api/config`, { method: 'PUT', headers: requestHeaders, body });
    assert.equal(response.status, 403);
  }
  const invalid = await fetch(`${origin}/api/config`, { method: 'PUT', headers, body: '{"schemaVersion":2}' });
  assert.equal(invalid.status, 400);
  const large = await fetch(`${origin}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ value: 'x'.repeat(70_000) }) });
  assert.equal(large.status, 413);
  assert.deepEqual(await readConfig(root), original);
});

test('configuration API exposes field-specific validation diagnostics', async t => {
  const { origin, headers } = await fixture(t);
  const response = await fetch(`${origin}/api/config`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ schemaVersion: 2, providers: ['missing'], skills: [], providerSettings: {} }),
  });
  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.code, 'CONFIG_INVALID');
  assert.equal(error.path, '$.providers[0]');
});

test('untrusted host headers are rejected before serving the console', async t => {
  const { origin } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(origin, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 403);
});

test('server cannot serve arbitrary project files', async t => {
  const { origin, headers } = await fixture(t);
  const response = await fetch(`${origin}/.latchkit/config.json`, { headers });
  assert.equal(response.status, 404);
});
