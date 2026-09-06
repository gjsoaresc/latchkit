import { expect, test } from '@playwright/test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';
import { createAcceptanceVerifier } from '../../dist/src/acceptance/service.js';
import { createTask, resumeTask } from '../../dist/src/task-state/service.js';

const execFile = promisify(execFileCallback);

async function initializeFixtureRepository(root) {
  await execFile('git', ['init', root]);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Latchkit Tests']);
  await execFile('git', ['-C', root, 'config', 'user.email', 'tests@latchkit.local']);
  await execFile('git', ['-C', root, 'add', 'source.txt']);
  await execFile('git', ['-C', root, 'commit', '-m', 'fixture source']);
}

test('real browser driver records observable assertions and bounded opt-in fixture capture', async ({
  browserName,
  page,
}) => {
  const root = path.resolve('test-results', `acceptance-${browserName}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await writeFile(path.join(root, 'source.txt'), 'source\n');
  await initializeFixtureRepository(root);
  const { server, url } = await startServer(root);
  // Issue #90 moved the "Meet your agents." configuration section (and its #providers-heading
  // id) onto the directly addressable Settings page; point the acceptance verifier's own real
  // browser check there instead of the root URL, keeping the original selector unchanged.
  const settingsUrl = `${new URL(url).origin}/settings${new URL(url).hash}`;
  try {
    let task = await createTask(root, {
      title: 'Browser acceptance',
      authorization: { source: 'user', scope: 'browser fixture', reference: 'Playwright CI' },
      criteria: [{ description: 'Console is visible' }],
    });
    task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
    const result = await createAcceptanceVerifier({ root }).verify({
      taskId: task.id,
      executionAuthorized: true,
      document: {
        schemaVersion: 1,
        checks: [
          {
            id: 'console',
            criterionId: task.criteria[0].id,
            label: 'console heading',
            type: 'browser',
            browser: browserName,
            target: settingsUrl,
            captureScreenshot: true,
            assertions: [
              { kind: 'visible', selector: '#providers-heading' },
              { kind: 'title', includes: 'Latchkit' },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('passed');
    const artifactText = await readFile(
      path.join(root, result.results[0].artifact.location),
      'utf8',
    );
    const artifact = JSON.parse(artifactText);
    expect(artifact.provenance.driver).toBe('playwright');
    expect(artifact.result.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.result.privacy).toBe('explicit-opt-in-capture');
    expect(artifactText).not.toContain(new URL(url).hash.slice(1));
    await page.goto(url);
    // Acceptance evidence now renders on the Specs & Tasks page (issue #90).
    await page.goto(`${new URL(url).origin}/specs`);
    await expect(page.getByRole('heading', { name: 'What the product proved.' })).toBeVisible();
    await expect(page.locator('.evidence-outcome')).toHaveText('passed');
    await expect(page.locator('.evidence-location')).toContainText(
      '.latchkit/tasks/acceptance-evidence/',
    );
    await writeFile(path.join(root, 'source.txt'), 'changed after evidence\n');
    await page.reload();
    await expect(page.locator('.evidence-outcome')).toHaveText('stale');
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});

test('a deliberately closed page produces distinct browser-crashed evidence', async ({
  browserName,
}) => {
  const root = path.resolve('test-results', `browser-crash-${browserName}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await writeFile(path.join(root, 'source.txt'), 'source\n');
  await initializeFixtureRepository(root);
  const { server, url } = await startServer(root);
  // Issue #90 moved #providers-heading onto the directly addressable Settings page; keep the
  // original selector unchanged and point the check there instead of the root URL.
  const settingsUrl = `${new URL(url).origin}/settings${new URL(url).hash}`;
  try {
    let task = await createTask(root, {
      title: 'Browser crash evidence',
      authorization: { source: 'user', scope: 'browser fixture', reference: 'Playwright CI' },
      criteria: [
        { description: 'Wrong UI is not accepted' },
        { description: 'Closed browser is not accepted' },
      ],
    });
    task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
    const result = await createAcceptanceVerifier({ root }).verify({
      taskId: task.id,
      executionAuthorized: true,
      document: {
        schemaVersion: 1,
        checks: [
          {
            id: 'wrong-ui',
            criterionId: task.criteria[0].id,
            label: 'wrong heading',
            type: 'browser',
            browser: browserName,
            target: settingsUrl,
            assertions: [
              { kind: 'text', selector: '#providers-heading', equals: 'Broken heading' },
            ],
          },
          {
            id: 'browser-crash',
            criterionId: task.criteria[1].id,
            label: 'closed page',
            type: 'browser',
            browser: browserName,
            target: url,
            actions: [{ kind: 'close' }],
            assertions: [{ kind: 'title', includes: 'Latchkit' }],
          },
        ],
      },
    });
    expect(result.results.map((item) => item.status)).toEqual([
      'assertions-failed',
      'browser-crashed',
    ]);
    expect(result.results.every((item) => item.outcome === 'failed')).toBe(true);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});
