import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../dist/src/core.js';
import { exportSupportBundle, previewSupportBundle } from '../dist/src/diagnostics/bundle.js';
import { operationalError } from '../dist/src/diagnostics/errors.js';
import {
  appendEvent,
  clearDiagnostics,
  readEvents,
  MAX_LOG_BYTES,
  MAX_LOG_EVENTS,
} from '../dist/src/diagnostics/logger.js';
import { redact, redactPath } from '../dist/src/diagnostics/redact.js';

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-diagnostics-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('redaction removes seeded credentials, URLs, nested values, and sensitive path segments', () => {
  const value = redact(
    {
      authorization: 'Bearer bearer-token',
      nested: { apiKey: 'key-123' },
      url: 'https://x.test/?token=url-token',
      message: 'secret-value',
    },
    ['secret-value'],
  );
  assert.equal(value.authorization, '[REDACTED]');
  assert.equal(value.nested.apiKey, '[REDACTED]');
  assert.match(value.url, /token=\[REDACTED\]/);
  assert.equal(value.message, '[REDACTED]');
  assert.equal(redactPath('C:/work/.env/proj'), 'C:/work/[REDACTED]/proj');
});

test('diagnostic events are redacted before disk and bounded by count and bytes', async (t) => {
  const root = await project(t);
  for (let index = 0; index < MAX_LOG_EVENTS + 20; index += 1)
    await appendEvent(
      root,
      operationalError(new Error(`Bearer token-${index} ${'x'.repeat(900)}`), {
        operation: 'test',
      }),
      { secrets: [`token-${index}`] },
    );
  const events = await readEvents(root);
  const raw = await readFile(path.join(root, '.latchkit/diagnostics/events.ndjson'), 'utf8');
  assert.ok(events.length <= MAX_LOG_EVENTS);
  assert.ok(Buffer.byteLength(raw) <= MAX_LOG_BYTES);
  assert.doesNotMatch(raw, /Bearer token-/);
});

test('support bundle preview and export use an allowlist and deletion is independent', async (t) => {
  const root = await project(t);
  await writeFile(path.join(root, '.latchkit', 'credentials.txt'), 'do-not-export');
  await appendEvent(root, {
    schemaVersion: 1,
    operationId: 'id',
    operation: 'test',
    stage: 'x',
    timestamp: new Date().toISOString(),
    code: 'TEST_ERROR',
    message: 'safe',
  });
  const preview = await previewSupportBundle(root);
  assert.deepEqual(preview.files, ['metadata.json', 'events.ndjson', 'recovery.json']);
  assert.doesNotMatch(JSON.stringify(preview), /do-not-export/);
  const exported = await exportSupportBundle(root);
  const bytes = await readFile(path.join(root, ...exported.output.split('/')), 'utf8');
  assert.doesNotMatch(bytes, /do-not-export|credentials\.txt/);
  await clearDiagnostics(root);
  assert.deepEqual(await readEvents(root), []);
  assert.equal(
    (await import('../dist/src/core.js'))
      .readConfig(root)
      .then((config) => config.schemaVersion) instanceof Promise,
    true,
  );
});
