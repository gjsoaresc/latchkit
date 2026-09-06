import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';

test('delivery approval displays exact content and submits its digests with the observed revision', async ({
  page,
}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-delivery-ui-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url } = await startServer(root);
  const workflow = {
    taskId: 'task_123',
    revision: 7,
    status: 'awaiting-approval',
    phase: 'plan',
    initialPrompt: 'Implement the delivery fixture',
    repairAttempts: 0,
    lastOutcome: { status: 'passed', summary: 'Plan is ready for approval.' },
    requirements: { artifact: 'Preserve all local files.', digest: 'a'.repeat(64) },
    plan: {
      artifact: 'Implement only the requested fixture.',
      digest: 'b'.repeat(64),
      checksDigest: 'c'.repeat(64),
      checks: { schemaVersion: 1, checks: [{ id: 'fixture' }] },
    },
  };
  let approved;
  await page.route('**/api/workflows**', async (route) => {
    if (route.request().method() === 'POST') {
      approved = route.request().postDataJSON();
      await route.fulfill({ json: { apiVersion: 1, workflow } });
    } else await route.fulfill({ json: { apiVersion: 1, workflows: [workflow] } });
  });
  try {
    await page.goto(url);
    // Delivery workflows now render on the Specs & Tasks page (issue #90).
    await page.goto(`${new URL(url).origin}/specs`);
    await expect(page.getByText('Preserve all local files.', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Implement only the requested fixture.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Approve this plan and acceptance checks' }).click();
    expect(approved).toBeUndefined();
    await page.getByLabel('Authorized change scope').fill('Only the delivery fixture');
    await page.getByLabel('Approval reference').fill('Explicit browser approval');
    await page.getByRole('button', { name: 'Approve this plan and acceptance checks' }).click();
    await expect
      .poll(() => approved)
      .toMatchObject({
        taskId: workflow.taskId,
        expectedRevision: 7,
        planDigest: workflow.plan.digest,
        requirementsDigest: workflow.requirements.digest,
        checksDigest: workflow.plan.checksDigest,
        scope: 'Only the delivery fixture',
        reference: 'Explicit browser approval',
      });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
