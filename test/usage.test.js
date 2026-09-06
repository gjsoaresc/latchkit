import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configureUsage,
  deleteUsage,
  exportUsage,
  inspectUsage,
  recordProviderUsage,
  parseProviderUsage,
} from '../dist/src/usage/service.js';
import { USAGE_PATH } from '../dist/src/usage/store.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-usage-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
const observedClaude = (overrides = {}) => ({
  provider: 'claude',
  providerVersion: '2.1.258',
  model: 'claude-haiku-4-5-20251001',
  observedAt: '2026-09-06T13:38:54.333Z',
  usage: {
    input_tokens: 172,
    cache_creation_input_tokens: 30653,
    cache_read_input_tokens: 787835,
    output_tokens: 7153,
    output_tokens_details: { thinking_tokens: 2701 },
  },
  ...overrides,
});

test('timestamp-free Codex turns retain their identities across re-imports', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  const output = [10, 20]
    .map((input_tokens) =>
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens, output_tokens: 4 } }),
    )
    .join('\n');
  const input = { provider: 'codex', providerVersion: '0.42.1', sessionId: 'thread_one', output };
  await recordProviderUsage(root, input);
  await recordProviderUsage(root, input, { clock: () => new Date(Date.now() + 1000) });
  const usage = await inspectUsage(root);
  assert.equal(usage.records.length, 2);
  assert.equal(usage.summary.tokens.input, 30);
  assert.equal(usage.summary.tokens.cacheRead, null);
  assert.equal(usage.summary.estimatedPublicApiListPriceUsd, null);
});

test('partial, empty, and unsafe observations cannot become measured zero usage', async (t) => {
  const root = await fixture(t);
  const empty = await inspectUsage(root);
  assert.equal(empty.summary.tokens.input, null);
  assert.equal(empty.summary.estimatedPublicApiListPriceUsd, null);
  const records = parseProviderUsage({
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'token=private',
    output: {
      type: 'result',
      modelUsage: { 'claude-haiku-4-5': {} },
      usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 3 },
    },
  });
  assert.equal(records[0].tokens.input, null);
  assert.equal(records[0].taskId, null);
  assert.equal(records[0].model, 'claude-haiku-4-5');
  assert.throws(
    () => parseProviderUsage({ provider: 'codex', output: 'x'.repeat(1024 * 1024 + 1) }),
    { code: 'USAGE_TOO_LARGE' },
  );
});

test('usage is opt-in and imports the sanitized Claude observation without retaining output', async (t) => {
  const root = await fixture(t);
  const disabled = await recordProviderUsage(root, {
    provider: 'claude',
    output: observedClaude(),
  });
  assert.equal(disabled.status, 'disabled');
  await assert.rejects(access(path.join(root, USAGE_PATH)));
  await configureUsage(root, { enabled: true });
  const recorded = await recordProviderUsage(root, {
    provider: 'claude',
    taskId: 'task_one',
    sessionId: 'session_one',
    output: observedClaude(),
  });
  assert.equal(recorded.records[0].status, 'measured');
  assert.equal(recorded.records[0].tokens.cacheRead, 787835);
  const stored = await readFile(path.join(root, USAGE_PATH), 'utf8');
  assert.doesNotMatch(stored, /prompt|transcript|bearer|api_key/i);
});

test('deduplicates imports, replaces corrections, and preserves partial/unknown states instead of zero', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  const input = {
    provider: 'claude',
    taskId: 'task_one',
    sessionId: 'session_one',
    observedAt: '2026-09-06T13:38:54.333Z',
    output: observedClaude(),
  };
  await recordProviderUsage(root, input);
  await recordProviderUsage(root, input);
  await recordProviderUsage(root, {
    ...input,
    observedAt: '2026-09-06T14:00:00.000Z',
    output: observedClaude({
      observedAt: '2026-09-06T13:38:54.333Z',
      usage: { input_tokens: 200, output_tokens: 10 },
    }),
  });
  const partial = await recordProviderUsage(root, {
    provider: 'codex',
    providerVersion: '0.42.1',
    taskId: 'task_two',
    sessionId: 'thread_two',
    output: JSON.stringify({
      type: 'turn.completed',
      timestamp: '2026-09-07T00:00:00.000Z',
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
  });
  assert.equal(partial.records[0].status, 'partial');
  assert.equal(partial.records[0].tokens.cacheRead, null);
  const unavailable = await recordProviderUsage(root, {
    provider: 'codex',
    output: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 99 } }),
  });
  assert.equal(unavailable.records[0].status, 'unavailable');
  assert.match(unavailable.records[0].unavailableReason, /version/i);
  const usage = await inspectUsage(root);
  assert.equal(usage.records.length, 3);
  assert.equal(usage.records.find((item) => item.taskId === 'task_one').tokens.input, 200);
});

test('list-price estimates carry their source and never become subscription billing', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    output: observedClaude(),
    price: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.1,
      cacheCreationUsdPerMillion: 1.25,
      sourceUrl: 'https://example.test/pricing',
      sourceVersion: '2026-09',
      asOf: '2026-09-06T00:00:00.000Z',
      assumptions: 'Published list prices for this model.',
    },
  });
  const usage = await inspectUsage(root);
  assert.equal(usage.billing.status, 'unknown');
  assert.equal(usage.records[0].estimate.basis, 'public-api-list-price');
  assert.match(usage.records[0].estimate.assumptions, /subscription billing is unknown/i);
});

test('export, retention, and deletion are bounded to one selected project', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await configureUsage(first, { enabled: true, retentionDays: 1 });
  await configureUsage(second, { enabled: true });
  await recordProviderUsage(first, {
    provider: 'claude',
    output: observedClaude({ observedAt: '2020-01-01T00:00:00.000Z' }),
  });
  await recordProviderUsage(second, { provider: 'claude', output: observedClaude() });
  const exported = await exportUsage(first, { clock: () => new Date('2026-09-08T00:00:00.000Z') });
  assert.equal(exported.records.length, 0);
  await deleteUsage(first);
  assert.equal((await inspectUsage(first)).records.length, 0);
  assert.equal((await inspectUsage(second)).records.length, 1);
});
