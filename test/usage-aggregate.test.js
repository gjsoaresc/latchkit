import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeUsage } from '../dist/src/usage/aggregate.js';
import { inspectUsageOverview } from '../dist/src/usage/overview-service.js';
import { configureUsage, recordProviderUsage } from '../dist/src/usage/service.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-usage-overview-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
const claudeOutput = (overrides = {}) => ({
  type: 'result',
  model: 'claude-haiku-4-5-20251001',
  timestamp: '2026-09-06T13:00:00.000Z',
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 },
  },
  ...overrides,
});
const price = {
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 5,
  cacheReadUsdPerMillion: 0.1,
  cacheCreationUsdPerMillion: 1.25,
  sourceUrl: 'https://example.test/pricing',
  sourceVersion: '2026-09',
  asOf: '2026-09-06T00:00:00.000Z',
  assumptions: 'Published list prices for this model.',
};

test('a bucket with no records has no coverage claims and does not appear as zero usage', () => {
  const totals = summarizeUsage([]);
  assert.equal(totals.tokens.input, null);
  assert.equal(totals.knownTokens.input, 0);
  assert.equal(totals.estimatedUsd, null);
  assert.equal(totals.recordCount, 0);
});

test('aggregateUsage groups by date, provider, model, and project with drill-down record IDs', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await configureUsage(first, { enabled: true });
  await configureUsage(second, { enabled: true });
  const dayOne = await recordProviderUsage(first, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: claudeOutput({ timestamp: '2026-09-06T13:00:00.000Z' }),
    price,
  });
  const dayTwo = await recordProviderUsage(first, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_two',
    output: claudeOutput({
      timestamp: '2026-09-07T13:00:00.000Z',
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 40,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
    price,
  });
  const otherProject = await recordProviderUsage(second, {
    provider: 'codex',
    providerVersion: '0.42.1',
    output: JSON.stringify({
      type: 'turn.completed',
      timestamp: '2026-09-06T15:00:00.000Z',
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
  });

  const overview = await inspectUsageOverview([first, second]);
  assert.equal(overview.totals.recordCount, 3);
  assert.equal(overview.byDate.length, 2);
  assert.deepEqual(
    overview.byDate.map((bucket) => bucket.date),
    ['2026-09-06', '2026-09-07'],
  );
  assert.equal(overview.byProject.length, 2);
  const providers = overview.byProvider.map((bucket) => bucket.provider).sort();
  assert.deepEqual(providers, ['claude', 'codex']);
  const models = overview.byModel.map((bucket) => bucket.model).sort();
  assert.deepEqual(models, ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', null].sort());

  const dayOneBucket = overview.byDate.find((bucket) => bucket.date === '2026-09-06');
  const drillDownIds = [dayOne.records[0].id, otherProject.records[0].id].sort();
  assert.deepEqual(dayOneBucket.recordIds.sort(), drillDownIds);
  assert.ok(dayTwo.records[0].id);
});

test('date-range filtering narrows totals and trends without discarding unfiltered data', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    output: claudeOutput({ timestamp: '2026-09-01T00:00:00.000Z' }),
  });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    output: claudeOutput({ timestamp: '2026-09-10T00:00:00.000Z' }),
  });
  const filtered = await inspectUsageOverview([root], {
    from: '2026-09-05T00:00:00.000Z',
    to: '2026-09-15T00:00:00.000Z',
  });
  assert.equal(filtered.totals.recordCount, 1);
  const unfiltered = await inspectUsageOverview([root]);
  assert.equal(unfiltered.totals.recordCount, 2);
});

test('mixed measured/partial/unavailable coverage is distinguished, never shown as zero', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    output: claudeOutput(),
  });
  await recordProviderUsage(root, {
    provider: 'codex',
    providerVersion: '0.42.1',
    output: JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
  });
  await recordProviderUsage(root, {
    provider: 'codex',
    output: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
  });
  const overview = await inspectUsageOverview([root]);
  assert.equal(overview.totals.recordCount, 3);
  assert.equal(overview.totals.measuredCount, 1);
  assert.equal(overview.totals.partialCount, 1);
  assert.equal(overview.totals.unavailableCount, 1);
  // At least one record's cacheRead is unknown, so the strict total stays null
  // even though a per-record breakdown (knownTokens) is available.
  assert.equal(overview.totals.tokens.cacheRead, null);
  assert.ok(overview.totals.knownTokens.input > 0);
  assert.equal(overview.totals.estimatedUsd, null);
});

test('estimated cost is only totalled when every contributing record is priced', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    output: claudeOutput({ timestamp: '2026-09-06T00:00:00.000Z' }),
    price,
  });
  const overview = await inspectUsageOverview([root]);
  assert.ok(overview.totals.estimatedUsd > 0);
  assert.equal(overview.totals.priceMissingCount, 0);

  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    output: claudeOutput({ timestamp: '2026-09-07T00:00:00.000Z' }),
  });
  const mixed = await inspectUsageOverview([root]);
  assert.equal(mixed.totals.estimatedUsd, null);
  assert.equal(mixed.totals.priceMissingCount, 1);
  assert.ok(mixed.totals.knownEstimatedUsd > 0);
});

test('role/overhead coverage is shown as explicitly unmeasured rather than silently excluded', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    output: claudeOutput(),
  });
  const overview = await inspectUsageOverview([root]);
  assert.equal(overview.byRole.length, 1);
  assert.equal(overview.byRole[0].role, 'unknown');
  assert.equal(overview.byRole[0].recordCount, overview.totals.recordCount);
  assert.match(overview.byRole[0].note, /coordinator/i);

  const empty = await inspectUsageOverview([await fixture(t)]);
  assert.deepEqual(empty.byRole, []);
});

test('corrections and out-of-order replays are not double-counted in the aggregate', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  const input = {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    sessionId: 'session_one',
    // A stable per-invocation identity (persisted action/assignment ID in the
    // real workflow/reviewer callers) is what lets a later replay correct
    // an existing record instead of being treated as a new invocation.
    sourceEventId: 'invocation_one',
    observedAt: '2026-09-06T13:00:00.000Z',
    output: claudeOutput({
      usage: {
        input_tokens: 50,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  };
  await recordProviderUsage(root, input);
  // Out-of-order replay of the same invocation with a corrected count.
  await recordProviderUsage(root, {
    ...input,
    observedAt: '2026-09-06T14:00:00.000Z',
    output: claudeOutput({
      usage: {
        input_tokens: 500,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
  });
  // A stale replay (earlier observedAt) must not overwrite the correction.
  await recordProviderUsage(root, input);
  const overview = await inspectUsageOverview([root]);
  assert.equal(overview.totals.recordCount, 1);
  assert.equal(overview.totals.knownTokens.input, 500);
});

test('billing is always reported as unknown rather than inferred', async (t) => {
  const root = await fixture(t);
  const overview = await inspectUsageOverview([root]);
  assert.equal(overview.billing.status, 'unknown');
  assert.match(overview.billing.reason, /not collected or inferred/i);
});
