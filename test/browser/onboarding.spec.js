import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';

test('the onboarding console drives project, agents, workspace, verification, usage, preview, and completion', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-console-'));
  // Matches what `latchkit ui` itself does before serving the console
  // (`initProject(root)` in src/cli.ts's `ui` branch): the project already
  // exists by the time a browser ever reaches this page.
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url } = await startServer(root);
  try {
    await page.goto(url);
    const onboarding = page.locator('#onboarding');
    await expect(onboarding.getByRole('heading', { name: 'Finish setting up.' })).toBeVisible();
    await expect(onboarding.getByText('Project is initialized at', { exact: false })).toBeVisible();

    // 1. Project — already initialized by the fixture; confirm it.
    await onboarding.getByRole('button', { name: 'Confirm project' }).click();
    await expect(onboarding.getByText('Project confirmed.')).toBeVisible();

    // 2. Agents & skills — codex/spec are already selected from init; keep them checked and save.
    await onboarding.getByRole('checkbox', { name: 'Codex' }).check();
    await onboarding.getByRole('checkbox', { name: /Write a specification/ }).check();
    await onboarding.getByRole('button', { name: 'Save agents & skills' }).click();
    await expect(onboarding.getByText('Agents and skills saved.')).toBeVisible();

    // 3. Task workspace — switch execution preference and save.
    await onboarding
      .locator('label', { hasText: 'Execution preference' })
      .locator('select')
      .selectOption('always-worktree');
    await onboarding.getByRole('button', { name: 'Save workspace preference' }).click();
    await expect(onboarding.getByText('Workspace preference saved.')).toBeVisible();

    // 4. Verification — switch to fast mode and save.
    await onboarding
      .locator('label', { hasText: 'Default mode' })
      .locator('select')
      .selectOption('fast');
    await onboarding.getByRole('button', { name: 'Save verification mode' }).click();
    await expect(onboarding.getByText('Verification preference saved.')).toBeVisible();

    // 5. Usage collection — decline (leave unchecked) and save; billing stays unknown, not zero.
    await onboarding.getByRole('button', { name: 'Save usage choice' }).click();
    await expect(onboarding.getByText('Usage collection stays disabled.')).toBeVisible();

    // 6. Preview & apply — reuses the sync dry-run/apply flow.
    await onboarding.getByRole('button', { name: 'Preview changes' }).click();
    await expect(onboarding.getByText('Preview ready.')).toBeVisible();
    await onboarding.getByRole('button', { name: 'Apply setup' }).click();
    await expect(onboarding.getByText('Setup applied.')).toBeVisible();

    // Finish.
    await onboarding.getByRole('button', { name: 'Finish onboarding' }).click();
    await expect(onboarding.getByText('COMPLETED')).toBeVisible();

    const report = await new AxeBuilder({ page })
      .include('#onboarding')
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
