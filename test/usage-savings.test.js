import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeSavings } from '../dist/src/usage/savings.js';
import { SavingsBaselineError } from '../dist/src/usage/baseline-contracts.js';
import {
  createSavingsBaseline,
  deleteSavingsBaseline,
  exportSavingsBaselines,
  listSavingsBaselines,
  updateSavingsBaseline,
} from '../dist/src/usage/baseline-service.js';
import { inspectSavings } from '../dist/src/usage/overview-service.js';
import { configureUsage, recordProviderUsage } from '../dist/src/usage/service.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-savings-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
const claudeOutput = (usage, overrides = {}) => ({
  type: 'result',
  model: 'claude-haiku-4-5-20251001',
  timestamp: '2026-09-06T13:00:00.000Z',
  usage: {
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 },
    ...usage,
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
const pairedInput = (overrides = {}) => ({
  label: 'Manual baseline for task_one',
  kind: 'paired',
  source: 'Manual timing of an equivalent manual run.',
  scope: { taskIds: ['task_one'], description: 'The manual run paired with task_one.' },
  units: 'usd',
  amount: 10,
  currency: 'USD',
  assumptions: 'Manually timed and priced against the same public list price.',
  ...overrides,
});

test('savings baseline CRUD validates shape, persists, and round-trips through export', async (t) => {
  const root = await fixture(t);
  await assert.rejects(createSavingsBaseline(root, { ...pairedInput(), kind: 'not-a-kind' }), {
    name: 'SavingsBaselineError',
  });
  await assert.rejects(
    createSavingsBaseline(root, { ...pairedInput(), scope: { description: 'no period or tasks' } }),
    { code: 'SAVINGS_BASELINE_INVALID' },
  );
  const created = await createSavingsBaseline(root, pairedInput());
  assert.ok(created.id.startsWith('baseline_'));
  const listed = await listSavingsBaselines(root);
  assert.equal(listed.baselines.length, 1);
  const updated = await updateSavingsBaseline(root, created.id, pairedInput({ amount: 20 }));
  assert.equal(updated.amount, 20);
  assert.equal(updated.id, created.id);
  await assert.rejects(updateSavingsBaseline(root, 'baseline_missing', pairedInput()), {
    code: 'SAVINGS_BASELINE_NOT_FOUND',
  });
  const exported = await exportSavingsBaselines(root);
  assert.equal(exported.baselines.length, 1);
  assert.equal(exported.baselines[0].amount, 20);
  await deleteSavingsBaseline(root, created.id);
  assert.equal((await listSavingsBaselines(root)).baselines.length, 0);
  await assert.rejects(deleteSavingsBaseline(root, created.id), {
    code: 'SAVINGS_BASELINE_NOT_FOUND',
  });
});

test('a missing or unmatched baseline produces an explanation instead of invented savings', () => {
  const result = computeSavings(null, []);
  assert.equal(result.status, 'missing-baseline');
  assert.match(result.reason, /no savings baseline/i);
});

test('a zero denominator produces an explanation rather than an infinite or invented percentage', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: claudeOutput({ input_tokens: 100, output_tokens: 20 }),
    price,
  });
  const baseline = await createSavingsBaseline(root, pairedInput({ amount: 0 }));
  const result = await inspectSavings([root], baseline.id);
  assert.equal(result.status, 'zero-denominator');
  assert.ok(result.actualAmount > 0);
  assert.match(result.reason, /zero/i);
});

test('missing prices are reported explicitly rather than silently totalled as zero', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  // No `price` supplied: the record has no monetary estimate.
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: claudeOutput({ input_tokens: 100, output_tokens: 20 }),
  });
  const baseline = await createSavingsBaseline(root, pairedInput());
  const result = await inspectSavings([root], baseline.id);
  assert.equal(result.status, 'missing-prices');
  assert.equal(result.knownActualAmount, null);
  assert.equal(result.match.recordCount, 1);
});

test('partial price coverage across matched records is flagged, not averaged away', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: claudeOutput({ input_tokens: 100, output_tokens: 20 }),
    price,
  });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    sourceEventId: 'second-invocation',
    output: claudeOutput({ input_tokens: 40, output_tokens: 10 }),
  });
  const baseline = await createSavingsBaseline(root, pairedInput());
  const result = await inspectSavings([root], baseline.id);
  assert.equal(result.status, 'missing-prices');
  assert.equal(result.match.recordCount, 2);
  assert.ok(result.knownActualAmount > 0);
});

test('an unavailable-only match is incomplete rather than a fabricated zero', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'codex',
    taskId: 'task_one',
    output: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5 } }),
  });
  const baseline = await createSavingsBaseline(root, pairedInput());
  const result = await inspectSavings([root], baseline.id);
  assert.equal(result.status, 'incomplete-comparison');
  assert.match(result.reason, /unavailable/i);
});

test('no matching usage in scope is an explained incomplete comparison', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_two',
    output: claudeOutput({ input_tokens: 100, output_tokens: 20 }),
    price,
  });
  const baseline = await createSavingsBaseline(root, pairedInput());
  const result = await inspectSavings([root], baseline.id);
  assert.equal(result.status, 'incomplete-comparison');
  assert.equal(result.match.recordCount, 0);
});

test('positive, negative, and zero outcomes are reported with matching absolute/percent signs', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: claudeOutput({ input_tokens: 1_000_000, output_tokens: 0 }),
    price,
  });
  // estimatedUsd for this single record = 1_000_000 * $1/million = $1.00
  const cheaper = await createSavingsBaseline(root, pairedInput({ amount: 5 }));
  const savings = await inspectSavings([root], cheaper.id);
  assert.equal(savings.status, 'ok');
  assert.equal(savings.direction, 'savings');
  assert.ok(savings.absoluteDifference > 0);
  assert.ok(savings.percentDifference > 0);

  const pricier = await createSavingsBaseline(root, pairedInput({ amount: 0.5 }));
  const loss = await inspectSavings([root], pricier.id);
  assert.equal(loss.status, 'ok');
  assert.equal(loss.direction, 'loss');
  assert.ok(loss.absoluteDifference < 0);
  assert.ok(loss.percentDifference < 0);

  const equal = await createSavingsBaseline(root, pairedInput({ amount: 1 }));
  const unchanged = await inspectSavings([root], equal.id);
  assert.equal(unchanged.status, 'ok');
  assert.equal(unchanged.direction, 'unchanged');
  assert.equal(unchanged.absoluteDifference, 0);
  assert.equal(unchanged.percentDifference, 0);
});

test('paired and historical baselines compute the same way but stay labeled and separable', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: claudeOutput({ input_tokens: 100, output_tokens: 20 }),
    price,
  });
  const paired = await createSavingsBaseline(root, pairedInput({ label: 'Paired manual run' }));
  const historical = await createSavingsBaseline(
    root,
    pairedInput({
      label: 'Historical quarterly average',
      kind: 'historical',
      scope: {
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
        description: 'September average.',
      },
      source: 'Average of the last quarter of manual sessions.',
    }),
  );
  const pairedResult = await inspectSavings([root], paired.id);
  const historicalResult = await inspectSavings([root], historical.id);
  assert.equal(pairedResult.kind, 'paired');
  assert.equal(historicalResult.kind, 'historical');
  const listed = await listSavingsBaselines(root);
  assert.deepEqual(listed.baselines.map((item) => item.kind).sort(), ['historical', 'paired']);
});

test('a token-unit baseline compares a chosen token field instead of dollars', async (t) => {
  const root = await fixture(t);
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: claudeOutput({ input_tokens: 300, output_tokens: 20 }),
  });
  const baseline = await createSavingsBaseline(
    root,
    pairedInput({ units: 'tokens', tokenField: 'input', amount: 500, currency: undefined }),
  );
  const result = await inspectSavings([root], baseline.id);
  assert.equal(result.status, 'ok');
  assert.equal(result.units, 'tokens');
  assert.equal(result.actualAmount, 300);
  assert.equal(result.absoluteDifference, 200);
  assert.equal(result.direction, 'savings');
});

test('SavingsBaselineError is thrown for redacted or unsafe pricing metadata', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    createSavingsBaseline(
      root,
      pairedInput({
        pricing: {
          sourceUrl: 'https://example.test?token=abc',
          sourceVersion: '1',
          asOf: '2026-09-06T00:00:00.000Z',
        },
      }),
    ),
    (error) => error instanceof SavingsBaselineError || error.code === 'SAVINGS_BASELINE_INVALID',
  );
});
