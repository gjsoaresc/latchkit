import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';

let root;
let server;
let url;

test.beforeEach(async () => {
  root = await fsTemp('latchkit-browser-');
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  ({ server, url } = await startServer(root));
});

test.afterEach(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
});

async function fsTemp(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function open(page) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Meet your agents.' })).toBeVisible();
}

test('saves, previews, applies, reloads, and removes skills through the filesystem-backed console', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel(/Reproduce & fix/).check();
  await page.getByRole('button', { name: /Save configuration/ }).click();
  await expect(page.getByRole('status')).toContainText('Configuration saved');
  await page.getByRole('button', { name: /Preview sync/ }).click();
  await expect(page.getByRole('heading', { name: 'File changes' })).toBeVisible();
  await page.getByRole('button', { name: /Apply sync/ }).click();
  await expect(page.getByRole('status')).toContainText('Skills synced');
  await expect(
    readFile(path.join(root, '.agents', 'skills', 'latchkit-fix', 'SKILL.md'), 'utf8'),
  ).resolves.toContain('name: latchkit-fix');

  await page.reload();
  await expect(page.getByLabel(/Reproduce & fix/)).toBeChecked();
  await page.getByLabel(/Reproduce & fix/).uncheck();
  await page.getByRole('button', { name: /Save configuration/ }).click();
  await page.getByRole('button', { name: /Preview sync/ }).click();
  await page.getByRole('button', { name: /Apply sync/ }).click();
  await expect(page.getByRole('status')).toContainText('Skills synced');
  await expect(
    readFile(path.join(root, '.agents', 'skills', 'latchkit-fix', 'SKILL.md')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('supports keyboard completion, accessible names, empty selections, and narrow layouts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByRole('group')).toHaveCount(2);
  await expect(page.getByLabel(/Codex/)).toHaveAccessibleName(/Codex/);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await page.getByLabel(/specification/i).uncheck();
  await page.getByRole('button', { name: /Save configuration/ }).click();
  await expect(page.getByRole('status')).toContainText('empty selection');
  await page.getByRole('button', { name: /Preview sync/ }).click();
  await expect(page.getByRole('status')).toContainText('preview is ready');
});

test('keeps pending edits and gives recovery guidance after a concurrent save', async ({
  browser,
}) => {
  const first = await browser.newPage();
  const second = await browser.newPage();
  await open(first);
  await open(second);
  await first.getByLabel(/Reproduce & fix/).check();
  await second.getByLabel(/Review changes/).check();
  await second.getByRole('button', { name: /Save configuration/ }).click();
  await first.getByRole('button', { name: /Save configuration/ }).click();
  await expect(first.getByRole('alert')).toContainText('Your edits were kept');
  await expect(first.getByLabel(/Reproduce & fix/)).toBeChecked();
  await first.close();
  await second.close();
});

test('treats equivalent selection ordering as saved', async ({ page }) => {
  await open(page);
  const state = await page.evaluate(async () => {
    const token = sessionStorage.getItem(`latchkit-session:${location.host}`);
    const response = await fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } });
    return response.json();
  });
  await page.evaluate(
    async ({ revision }) => {
      const token = sessionStorage.getItem(`latchkit-session:${location.host}`);
      await fetch('/api/config', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: location.origin,
          'Content-Type': 'application/json',
          'If-Match': revision,
        },
        body: JSON.stringify({ schemaVersion: 1, providers: ['codex'], skills: ['fix', 'spec'] }),
      });
      location.reload();
    },
    { revision: state.configRevision },
  );
  await expect(page.getByRole('button', { name: /Save configuration/ })).toBeDisabled();
  await expect(page.locator('#selection-status')).toContainText('Configuration saved');
});

test('shows a useful message when the session token is missing', async ({ page }) => {
  await page.goto(url.replace(/#.*$/, ''));
  await expect(page.getByRole('alert')).toContainText('complete session URL');
  await expect(page.getByRole('button', { name: /Save configuration/ })).toBeDisabled();
});

test('shows a useful message when the session token expires', async ({ page }) => {
  await page.route('**/api/state', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ apiVersion: 1, error: 'expired', code: 'AUTH_REQUIRED' }),
    }),
  );
  await page.goto(url);
  await expect(page.getByRole('alert')).toContainText('session key has expired');
});

test('persists an accessible dark theme choice', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Theme: system' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Theme: dark' })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

test('local usage stays opt-in and renders unknown totals without suggesting zero spend', async ({
  page,
}) => {
  await open(page);
  const usage = page.getByRole('region', { name: 'Understand each session.' });
  await expect(usage.getByText('Collection disabled', { exact: true })).toBeVisible();
  await expect(usage.getByText('Unknown', { exact: true })).toHaveCount(2);
  await usage.getByRole('button', { name: 'Enable local collection' }).click();
  await expect(usage.getByText('Collection enabled', { exact: true })).toBeVisible();
  await usage.getByLabel('Retention days').fill('7');
  await usage.getByRole('button', { name: 'Save retention' }).click();
  await page.reload();
  await expect(usage.getByLabel('Retention days')).toHaveValue('7');
  const state = JSON.parse(
    await readFile(path.join(root, '.latchkit/usage/state-v1.json'), 'utf8'),
  );
  expect(state.settings).toEqual({ enabled: true, retentionDays: 7 });
  expect(state.records).toEqual([]);
});

test('keeps optional FCC controls bounded to explicit inspection and lifecycle actions', async ({
  page,
}) => {
  const absent = {
    apiVersion: 1,
    tool: { version: '5.22.8' },
    state: 'absent',
    active: null,
    lifecycle: null,
  };
  const managed = { ...absent, state: 'managed' };
  let inspections = 0;
  await page.route('**/api/tools/fcc**', async (route) => {
    const request = route.request();
    if (request.url().endsWith('/start')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          apiVersion: 1,
          action: 'started',
          active: { state: 'running', adminUrl: 'http://127.0.0.1:8082/admin' },
        }),
      });
      return;
    }
    if (request.url().endsWith('/stop')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ apiVersion: 1, action: 'stopped' }),
      });
      return;
    }
    inspections += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(inspections === 1 ? absent : managed),
    });
  });
  await open(page);
  const tool = page.getByRole('region', { name: 'Free Claude Code.' });
  await expect(tool).toContainText('FCC is not installed');
  await expect(tool.getByRole('button', { name: 'Start server' })).toBeDisabled();
  await tool.getByRole('button', { name: 'Refresh' }).click();
  await expect(tool).toContainText('Ready to start');
  await expect(tool.getByRole('button', { name: 'Start server' })).toBeEnabled();
  await tool.getByRole('button', { name: 'Start server' }).click();
  await expect(tool).toContainText('Running and ready');
  await expect(tool.getByRole('link', { name: /Open Admin/ })).toHaveAttribute(
    'href',
    'http://127.0.0.1:8082/admin',
  );
  await tool.getByRole('button', { name: 'Stop server' }).click();
  await expect(tool).toContainText('Ready to start');
  expect(inspections).toBe(2);
});

test('has no automated accessibility violations in the configured console', async ({ page }) => {
  await open(page);
  const report = await new AxeBuilder({ page }).analyze();
  expect(report.violations).toEqual([]);
});
