import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';
import { createTask } from '../../dist/src/task-state/service.js';

test('workbench renders persisted task state and supports keyboard-safe local memory deletion', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-workbench-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await createTask(root, {
    title: 'Awaiting approval fixture',
    criteria: [{ description: 'Approval must be explicit' }],
  });
  const { server, url } = await startServer(root);
  try {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Tasks, recovery, and proof.' })).toBeVisible();
    await expect(page.getByText('Awaiting approval fixture')).toBeVisible();
    await page.getByLabel('Title').fill('Keyboard memory');
    await page.getByLabel('Record', { exact: true }).fill('This record is local and inspectable.');
    await page.getByRole('button', { name: 'Add memory' }).press('Enter');
    await expect(page.getByText('Keyboard memory')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).press('Enter');
    await expect(page.getByText('No local memory has been captured.')).toBeVisible();
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(
      page.getByRole('heading', { name: 'Keep only what helps recovery.' }),
    ).toBeVisible();
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
