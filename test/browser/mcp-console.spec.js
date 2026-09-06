import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';

let root;
let server;
let url;

test.beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-mcp-console-'));
  await initProject(root, { providers: ['claude'], skills: ['spec'] });
  ({ server, url } = await startServer(root));
});
test.afterEach(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
});

test('MCP console keeps review inert and exposes explicit activation only after a clean preview', async ({
  page,
}) => {
  await page.goto(url);
  await page.goto(`${new URL(url).origin}/mcp`);
  await expect(page.getByRole('heading', { name: 'Review before enabling.' })).toBeVisible();
  const json = page.getByLabel('Managed MCP JSON');
  await json.fill(
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture',
      transport: 'http',
      endpoint: 'http://127.0.0.1:8765/mcp',
      providers: ['claude'],
      scope: 'project',
      requiredEnvironment: [],
      enabled: false,
    }),
  );
  await page.getByRole('button', { name: 'Review exact changes' }).click();
  await expect(page.getByRole('heading', { name: /0 file change/ })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Explicitly activate reviewed definition' }),
  ).toBeEnabled();
});
