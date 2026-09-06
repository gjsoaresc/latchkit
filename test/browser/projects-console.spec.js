import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';
import { registerProject } from '../../dist/src/projects/service.js';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
}

async function gitProject(base, name) {
  const root = path.join(base, name);
  await mkdir(root, { recursive: true });
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Latchkit test']);
  await writeFile(path.join(root, 'file.txt'), 'hello\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  return root;
}

test('multi-project overview lists grouped worktrees, opens a project, adds and removes one, and flags an unavailable root', async ({
  page,
}) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'latchkit-projects-console-'));
  const registry = path.join(base, 'registry');
  const currentProject = path.join(base, 'current-project');
  await mkdir(currentProject, { recursive: true });
  await initProject(currentProject, { providers: ['codex'], skills: ['spec'] });

  // A second, isolated project with a linked worktree, both registered explicitly: the grid
  // must show one grouped card, not two, while the worktree stays inspectable on its own.
  const gitRoot = await gitProject(base, 'git-project');
  const worktreePath = path.join(base, 'git-project-worktree');
  await git(gitRoot, ['worktree', 'add', '-b', 'feature', worktreePath]);
  const mainRecord = await registerProject(registry, { root: gitRoot, source: 'manual' });
  await registerProject(registry, { root: worktreePath, source: 'manual' });

  // A registered project whose root has since disappeared.
  const missingRoot = path.join(base, 'missing-project');
  await mkdir(missingRoot, { recursive: true });
  const missingRecord = await registerProject(registry, { root: missingRoot, source: 'manual' });
  await rm(missingRoot, { recursive: true, force: true });

  const previousOverride = process.env.LATCHKIT_PROJECTS_ROOT;
  process.env.LATCHKIT_PROJECTS_ROOT = registry;
  const { server, url } = await startServer(currentProject);
  try {
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(url);
    await page.goto(`${new URL(url).origin}/projects`);

    const grid = page.locator('#workspace');
    await expect(grid.getByRole('heading', { name: 'Your projects, at a glance.' })).toBeVisible();

    // The current server's own project was registered on ui-start.
    await expect(grid.getByText(path.basename(currentProject)).first()).toBeVisible();
    // The Git project is shown once (grouped), naming it as the main checkout.
    const gitCard = grid.locator('.project-card', { hasText: path.basename(gitRoot) });
    await expect(gitCard).toBeVisible();
    await expect(gitCard.getByText('Main checkout')).toBeVisible();
    await expect(gitCard.getByText('1 other registered worktree(s) grouped here')).toBeVisible();
    await expect(grid.locator('.project-card', { hasText: 'git-project-worktree' })).toHaveCount(0);
    // The unavailable project is listed with its status, not hidden or shown as idle.
    const missingCard = grid.locator('.project-card', { hasText: path.basename(missingRoot) });
    await expect(missingCard).toBeVisible();
    await expect(missingCard.locator('.state-badge')).toHaveText(/unavailable/);

    // Add a project explicitly through the form.
    const addedRoot = path.join(base, 'added-project');
    await mkdir(addedRoot, { recursive: true });
    await grid.getByLabel('Project path').fill(addedRoot);
    await grid.getByRole('button', { name: 'Add existing project' }).click();
    await expect(grid.locator('.project-card', { hasText: 'added-project' })).toBeVisible();

    // A concurrent registration from outside the browser (simulating a CLI run while the page
    // is open) is picked up after an explicit refresh, not silently.
    const concurrentRoot = path.join(base, 'concurrent-project');
    await mkdir(concurrentRoot, { recursive: true });
    await registerProject(registry, { root: concurrentRoot, source: 'task-run' });
    await expect(grid.locator('.project-card', { hasText: 'concurrent-project' })).toHaveCount(0);
    await grid.getByRole('button', { name: 'Refresh' }).click();
    await expect(grid.locator('.project-card', { hasText: 'concurrent-project' })).toBeVisible();

    // Open the Git project's detail view and confirm its own group/worktree/spec/task sections.
    await gitCard.getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(`project=${mainRecord.id}$`));
    const detail = page.locator('#workspace');
    await expect(detail.getByRole('heading', { name: 'Relevant worktrees' })).toBeVisible();
    await expect(detail.getByText('linked')).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Usage overview' })).toBeVisible();

    // A direct navigation to an unavailable project's own detail page explains, rather than
    // silently showing zeros.
    await page.goto(`${new URL(url).origin}/projects?project=${missingRecord.id}`);
    await expect(
      page.getByText("This project's location is unavailable", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('Usage is unavailable', { exact: false })).toBeVisible();

    // Removing a project only drops it from the overview.
    await page.goto(`${new URL(url).origin}/projects`);
    const addedCard = page.locator('.project-card', { hasText: 'added-project' });
    await addedCard.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('.project-card', { hasText: 'added-project' })).toHaveCount(0);
    const info = await stat(addedRoot);
    expect(info.isDirectory()).toBe(true);

    const report = await new AxeBuilder({ page })
      .include('#workspace')
      .disableRules(['color-contrast'])
      .analyze();
    expect(report.violations).toEqual([]);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    if (previousOverride === undefined) delete process.env.LATCHKIT_PROJECTS_ROOT;
    else process.env.LATCHKIT_PROJECTS_ROOT = previousOverride;
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
