import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';
import { configureUsage, recordProviderUsage } from '../../dist/src/usage/service.js';

test('usage console renders trends, coverage, and an explicit-baseline savings comparison', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-usage-console-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await configureUsage(root, { enabled: true });
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_one',
    output: {
      type: 'result',
      model: 'claude-haiku-4-5-20251001',
      timestamp: new Date().toISOString(),
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 0 },
      },
    },
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
  const { server, url } = await startServer(root);
  try {
    await page.goto(url);
    // Usage (#92) now lives on its own directly addressable page (issue #90); the session token
    // established at the root URL carries over via sessionStorage.
    await page.goto(`${new URL(url).origin}/usage`);
    const usage = page.locator('#usage');
    await expect(usage.getByRole('heading', { name: 'Understand each session.' })).toBeVisible();

    // Totals and trends load automatically and distinguish coverage.
    await expect(usage.getByRole('heading', { name: 'Totals and trends' })).toBeVisible();
    await expect(usage.getByText('SESSIONS IN RANGE')).toBeVisible();
    await expect(
      usage.getByText('claude-haiku-4-5-20251001', { exact: false }).first(),
    ).toBeVisible();

    // Record a reproducible, explicit paired baseline for task_one.
    await usage.getByLabel('Label').fill('Manual run for task_one');
    await usage.getByLabel('Kind').selectOption('paired');
    await usage.getByLabel('Source', { exact: true }).fill('Manually timed equivalent run.');
    await usage.getByLabel('Task IDs (comma-separated, optional)').fill('task_one');
    await usage.getByLabel('Scope description').fill('The manual run paired with task_one.');
    await usage.getByLabel('Baseline amount (USD)').fill('5');
    await usage
      .getByLabel('Assumptions')
      .fill('Manually timed and priced against the same public list price.');
    await usage.getByRole('button', { name: 'Add baseline' }).click();
    await expect(usage.locator('summary', { hasText: 'Manual run for task_one' })).toBeVisible();

    // The single recorded baseline is selected by default; compute savings against it.
    await usage.getByRole('button', { name: 'Compute savings' }).click();
    await expect(usage.getByText(/Savings of \$4\.0000/)).toBeVisible();
    await expect(usage.getByText('paired comparison', { exact: true })).toBeVisible();

    const report = await new AxeBuilder({ page }).include('#usage').analyze();
    expect(report.violations).toEqual([]);

    await page.getByRole('button', { name: 'Theme: system' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const darkReport = await new AxeBuilder({ page }).include('#usage').analyze();
    expect(darkReport.violations).toEqual([]);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('usage console distinguishes mixed providers and missing prices, and does not double count an out-of-order correction', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-usage-console-mixed-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await configureUsage(root, { enabled: true });
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
  // A fully priced, fully measured Claude record.
  await recordProviderUsage(root, {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_a',
    output: {
      type: 'result',
      model: 'claude-haiku-4-5-20251001',
      timestamp: '2026-09-06T12:00:00.000Z',
      usage: {
        input_tokens: 500,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 0 },
      },
    },
    price,
  });
  // A different provider (Codex) with no price attached: a mixed-provider,
  // missing-price record. Cache/reasoning fields are also left unreported,
  // so it lands as 'partial' rather than an invented complete count.
  await recordProviderUsage(root, {
    provider: 'codex',
    providerVersion: '0.42.1',
    taskId: 'task_b',
    output: JSON.stringify({
      type: 'turn.completed',
      timestamp: '2026-09-06T12:05:00.000Z',
      usage: { input_tokens: 30, output_tokens: 10 },
    }),
  });
  // Out-of-order correction: the same invocation is observed three times.
  // The corrected count (observed later) must win, and a stale replay of
  // the original observation (observed earlier than the correction) must
  // not resurrect the original count or add a second record.
  const correctable = {
    provider: 'claude',
    providerVersion: '2.1.258',
    taskId: 'task_c',
    sessionId: 'session_c',
    sourceEventId: 'invocation_c',
    price,
  };
  const originalOutput = {
    type: 'result',
    model: 'claude-haiku-4-5-20251001',
    timestamp: '2026-09-06T13:00:00.000Z',
    usage: {
      input_tokens: 111,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens_details: { thinking_tokens: 0 },
    },
  };
  await recordProviderUsage(root, {
    ...correctable,
    observedAt: '2026-09-06T13:00:00.000Z',
    output: originalOutput,
  });
  await recordProviderUsage(root, {
    ...correctable,
    observedAt: '2026-09-06T14:00:00.000Z',
    output: {
      ...originalOutput,
      usage: { ...originalOutput.usage, input_tokens: 222, output_tokens: 2 },
    },
  });
  // Stale replay: same original observation, observed before the correction.
  await recordProviderUsage(root, {
    ...correctable,
    observedAt: '2026-09-06T13:00:00.000Z',
    output: originalOutput,
  });

  const { server, url } = await startServer(root);
  try {
    await page.goto(url);
    // The session token is established at the root URL and carries over to /usage (issue #90).
    await page.goto(`${new URL(url).origin}/usage`);
    const usage = page.locator('#usage');
    await expect(usage.getByRole('heading', { name: 'Understand each session.' })).toBeVisible();
    await expect(usage.getByRole('heading', { name: 'Totals and trends' })).toBeVisible();

    // Three distinct records: task_a, task_b, and the corrected task_c. The
    // stale replay must not have added a fourth record.
    const sessionsCard = usage.locator('.summary-card').filter({ hasText: 'SESSIONS IN RANGE' });
    await expect(sessionsCard.locator('strong')).toHaveText('3');

    // Known totals sum the corrected (not the stale) task_c count: 500 + 30 +
    // 222 input, 0 + 10 + 2 output. A double count would show 611/13 or more.
    const inputCard = usage.locator('.summary-card').filter({ hasText: 'KNOWN INPUT TOKENS' });
    await expect(inputCard.locator('strong')).toHaveText('752');
    const outputCard = usage.locator('.summary-card').filter({ hasText: 'KNOWN OUTPUT TOKENS' });
    await expect(outputCard.locator('strong')).toHaveText('12');

    // The estimated-cost card exposes exactly one record missing a price
    // (task_b, Codex) rather than silently omitting it or showing zero cost.
    const costCard = usage.locator('.summary-card').filter({ hasText: 'ESTIMATED COST' });
    await expect(costCard).toContainText('1 missing a price');

    // Mixed providers are broken out distinctly, not merged into one bucket.
    const byProvider = usage.locator('ul[aria-label="Usage by provider"]');
    await expect(byProvider.getByText('claude · 2 sessions', { exact: false })).toBeVisible();
    await expect(byProvider.getByText('codex · 1 session', { exact: false })).toBeVisible();

    const report = await new AxeBuilder({ page })
      .include('#usage')
      .disableRules(['color-contrast'])
      .analyze();
    expect(report.violations).toEqual([]);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
