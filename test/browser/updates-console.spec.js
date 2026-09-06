import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../dist/src/core.js';
import { startServer } from '../../dist/src/server.js';
import { installBundle } from '../../dist/src/installation/manager.js';
import { expectedAssetName } from '../../dist/src/installation/updates/release-source.js';

// Issue #139 slice 2: the Settings -> Updates section (web/updates.tsx). Establishes the
// session at the root URL before visiting /settings, matching every other Settings browser
// spec's two-step navigation (the session token lives in sessionStorage, not the URL path).

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = `${process.platform}-${process.arch}`;

let root;
let server;
let url;
let releaseServer;

async function open(page) {
  await page.goto(url);
  await page.goto(`${new URL(url).origin}/settings`);
  await expect(page.getByRole('heading', { name: 'Updates.' })).toBeVisible();
}

test.afterEach(async () => {
  if (server)
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  if (releaseServer) await new Promise((resolve) => releaseServer.close(resolve));
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.LATCHKIT_UPDATE_API_BASE_URL;
  server = undefined;
  releaseServer = undefined;
  root = undefined;
});

test('shows the source-development limitation and disables Check for updates by default', async ({
  page,
}) => {
  root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-updates-console-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  ({ server, url } = await startServer(root));

  await open(page);
  const section = page.getByRole('region', { name: 'Updates.' });
  await expect(section).toContainText('source-development');
  await expect(section.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Install and restart' })).toHaveCount(0);
});

test('a self-managed installation can check for updates and renders release notes as plain text', async ({
  page,
}) => {
  const scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-updates-console-selfmanaged-')),
  );
  const installRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-updates-console-installroot-')),
  );
  const bundle = path.join(scratch, 'bundle');
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(
    process.execPath,
    path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const baseVersion = JSON.parse(
    await readFile(path.join(repository, 'package.json'), 'utf8'),
  ).version;
  async function inventory(directory, prefix = '') {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await inventory(filename, relative)));
      else if (entry.isFile()) {
        const bytes = await readFile(filename);
        files.push({
          path: relative,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
    return files;
  }
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      package: 'latchkit',
      version: baseVersion,
      target: TARGET,
      nodeVersion: process.version,
      files: await inventory(bundle),
    })}\n`,
  );
  await installBundle({ root: installRoot, bundle, version: baseVersion, target: TARGET });

  const candidateVersion = '99.0.0';
  const untrustedNotes = 'Fixture release.\n<script>window.__xss = true;</script> & "quotes"';
  releaseServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        {
          tag_name: `v${candidateVersion}`,
          draft: false,
          prerelease: false,
          published_at: new Date().toISOString(),
          html_url: 'https://example.invalid/releases/v99.0.0',
          body: untrustedNotes,
          assets: [
            {
              name: expectedAssetName(candidateVersion, TARGET),
              browser_download_url: `https://example.invalid/download/${expectedAssetName(candidateVersion, TARGET)}`,
              size: 1024,
            },
          ],
        },
      ]),
    );
  });
  await new Promise((resolve, reject) => {
    releaseServer.once('error', reject);
    releaseServer.listen(0, '127.0.0.1', () => {
      releaseServer.off('error', reject);
      resolve();
    });
  });
  process.env.LATCHKIT_UPDATE_API_BASE_URL = `http://127.0.0.1:${releaseServer.address().port}`;

  root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-updates-console-project-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  ({ server, url } = await startServer(root, {
    installRoot,
    runningFromInstallRoot: installRoot,
  }));

  await open(page);
  const section = page.getByRole('region', { name: 'Updates.' });
  await expect(section).toContainText('self-managed');
  const checkButton = section.getByRole('button', { name: 'Check for updates' });
  await expect(checkButton).toBeEnabled();
  await checkButton.click();
  await expect(section).toContainText(`Update available: ${candidateVersion}`);
  await expect(section.getByRole('button', { name: 'Install and restart' })).toBeVisible();

  // Untrusted release-body text renders as literal text, never interpreted HTML/markdown.
  await expect(section).toContainText('<script>window.__xss = true;</script>');
  const xssRan = await page.evaluate(() => window.__xss);
  expect(xssRan).toBeUndefined();

  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
