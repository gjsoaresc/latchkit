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
