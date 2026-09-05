import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core.js';
import { redact, redactString } from '../src/diagnostics/redact.js';
import { startServer } from '../src/server.js';

test('every local API boundary rejects unauthenticated reads and mutations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-security-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url } = await startServer(root);
  const origin = new URL(url).origin;
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });

  for (const request of [
    fetch(`${origin}/api/state`),
    fetch(`${origin}/api/tasks`),
    fetch(`${origin}/api/annotations?taskId=task_invalid`),
    fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 3,
        providers: [],
        skills: [],
        providerSettings: {},
        packs: [],
      }),
    }),
  ]) {
    const response = await request;
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('redaction removes secret values from nested records and text while preserving safe evidence', () => {
  const value = redact({
    authorization: 'Bearer ghp_super_secret',
    nested: {
      apiKey: 'token-value',
      location: '.latchkit/tasks/acceptance-evidence/task_x/artifact.json',
    },
    message: 'request failed?token=query-secret',
  });
  assert.equal(value.authorization, '[REDACTED]');
  assert.equal(value.nested.apiKey, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(value), /super_secret|token-value|query-secret/);
  assert.match(value.nested.location, /acceptance-evidence/);
  assert.doesNotMatch(
    redactString('Authorization: Bearer another-secret?token=hidden'),
    /another-secret|hidden/,
  );
});
