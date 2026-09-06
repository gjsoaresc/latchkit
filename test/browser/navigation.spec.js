import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';

// Issue #90: the console is split into focused, directly addressable pages (Overview, Projects,
// Specs & Tasks, Memory, Usage, Settings). These specs cover the routing scheme itself — a direct
// load, a refresh, and browser back/forward must each resolve the right page — and give every
// page (that another spec file does not already scan) an axe pass in both themes. The
// multi-project overview's own navigation is exercised in projects-console.spec.js.

let root;
let server;
let url;

test.beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-navigation-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  ({ server, url } = await startServer(root));
});

test.afterEach(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('in-app navigation, a refresh, and browser back/forward keep the active page clear (Overview and Settings)', async ({
  page,
}) => {
  // Overview and the "find your way around" section both link to Settings by name, so scope to
  // the sidebar's own primary navigation landmark for an unambiguous click target.
  const primaryNav = page.getByRole('navigation', { name: 'Primary' });

  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: /Your agents/ })).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText(/Overview/);

  await primaryNav.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole('heading', { level: 1, name: /Configuration, agents/ }),
  ).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText(/Settings/);

  // A refresh on Settings resolves the same page (not the Overview default).
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: /Configuration, agents/ }),
  ).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText(/Settings/);

  await primaryNav.getByRole('link', { name: 'Specs & Tasks', exact: true }).click();
  await expect(page).toHaveURL(/\/specs$/);
  await expect(
    page.getByRole('heading', { level: 1, name: /Plans, tasks, and proof/ }),
  ).toBeVisible();

  // Browser back returns to Settings, then to Overview; forward replays the same order.
  await page.goBack();
  await expect(
    page.getByRole('heading', { level: 1, name: /Configuration, agents/ }),
  ).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText(/Settings/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: /Your agents/ })).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText(/Overview/);
  await page.goForward();
  await expect(
    page.getByRole('heading', { level: 1, name: /Configuration, agents/ }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole('heading', { level: 1, name: /Plans, tasks, and proof/ }),
  ).toBeVisible();
});

test('a direct load and a refresh resolve Memory and Usage without visiting Overview first', async ({
  page,
}) => {
  // Establish the session at the root URL Latchkit prints, then load a page directly by URL —
  // not by clicking through the app — exercising the server's own ASSETS routing for each path.
  await page.goto(url);

  await page.goto(`${new URL(url).origin}/memory`);
  await expect(
    page.getByRole('heading', { level: 1, name: /Keep only what helps recovery/ }),
  ).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText(/Memory/);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: /Keep only what helps recovery/ }),
  ).toBeVisible();

  await page.goto(`${new URL(url).origin}/usage`);
  await expect(
    page.getByRole('heading', { level: 1, name: /Understand every session/ }),
  ).toBeVisible();
  await expect(page.locator('.nav-item.active')).toHaveText(/Usage/);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: /Understand every session/ }),
  ).toBeVisible();
});

test('reaching #onboarding from a page other than Settings redirects to Settings', async ({
  page,
}) => {
  await page.goto(url);
  await page.goto(`${new URL(url).origin}/specs#onboarding`);
  await expect(page).toHaveURL(/\/settings#onboarding$/);
  const onboarding = page.locator('#onboarding');
  await expect(onboarding.getByRole('heading', { name: 'Finish setting up.' })).toBeVisible();
});

const AXE_PAGES = [
  { path: '/', label: 'Overview' },
  { path: '/specs', label: 'Specs & Tasks' },
  { path: '/memory', label: 'Memory' },
];

for (const { path: pagePath, label } of AXE_PAGES) {
  test(`the ${label} page has no automated accessibility violations in light or dark mode`, async ({
    page,
  }) => {
    await page.goto(url);
    await page.goto(`${new URL(url).origin}${pagePath}`);
    await expect(page.locator('main#workspace')).toBeVisible();
    const light = await new AxeBuilder({ page }).analyze();
    expect(light.violations).toEqual([]);

    await page.getByRole('button', { name: 'Theme: system' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const dark = await new AxeBuilder({ page }).analyze();
    expect(dark.violations).toEqual([]);
  });
}
