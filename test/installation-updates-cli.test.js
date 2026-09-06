import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installBundle } from '../dist/src/installation/manager.js';
import { expectedAssetName } from '../dist/src/installation/updates/release-source.js';

const run = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'src', 'cli.js');
const TARGET = `${process.platform}-${process.arch}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(filename, relative)));
    else if (entry.isFile()) {
      const bytes = await readFile(filename);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}

async function fixtureBundleDirectory(scratch, version) {
  const bundle = path.join(scratch, `bundle-${version}`);
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(
    process.execPath,
    path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const packageFile = path.join(bundle, 'app', 'dist', 'package.json');
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  packageJson.version = version;
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      package: 'latchkit',
      version,
      target: TARGET,
      nodeVersion: process.version,
      files: await inventory(bundle),
    })}\n`,
  );
  return bundle;
}

async function zipDirectory(scratch, sourceDirectory, destinationZip) {
  const script = path.join(scratch, `compress-${randomUUID()}.ps1`);
  await writeFile(
    script,
    'param($Source,$Destination)\n$ErrorActionPreference="Stop"\nCompress-Archive -Path (Join-Path $Source \'*\') -DestinationPath $Destination -Force\n',
  );
  await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', script, sourceDirectory, destinationZip],
    { windowsHide: true, timeout: 60_000 },
  );
}

async function startReleaseFixtureServer({ version, zipBytes, sha256 }) {
  const assetName = expectedAssetName(version, TARGET);
  const server = createServer((req, res) => {
    if (req.url === `/repos/willahealm/latchkit/releases?per_page=30`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            tag_name: `v${version}`,
            draft: false,
            prerelease: false,
            published_at: '2026-01-01T00:00:00Z',
            html_url: `https://example.invalid/releases/v${version}`,
            body: 'Fixture release notes for the CLI exercise.',
            assets: [
              {
                name: assetName,
                browser_download_url: `http://127.0.0.1:${server.address()?.port}/download/${assetName}`,
                size: zipBytes.length,
              },
            ],
          },
        ]),
      );
      return;
    }
    if (req.url === `/download/${assetName}`) {
      res.writeHead(200, { 'content-length': String(zipBytes.length) });
      res.end(zipBytes);
      return;
    }
    if (req.url === `/download/${assetName}.sha256`) {
      res.end(`${sha256}  ${assetName}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

test(
  'the update CLI reports status, checks a fixture release source, previews, stages, and rolls back',
  { skip: process.platform !== 'win32' && 'fixture archive here is .zip (win32 extraction only)' },
  async (t) => {
    const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-cli-')));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const root = path.join(scratch, 'install root é');
    const initialBundle = await fixtureBundleDirectory(scratch, '1.0.0');
    await installBundle({ root, bundle: initialBundle, target: TARGET });

    // --- status: pure read, no network, no fixture server needed ---------
    const status = await run(process.execPath, [cli, 'update', 'status', '--install-root', root]);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.mode, 'manual');
    assert.equal(
      statusReport.installedVersion,
      JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version,
    );
    assert.equal(statusReport.status, 'unavailable');
    assert.equal(statusReport.reason, 'No update check has been performed yet.');

    // --- check / preview / stage against a local fixture release source --
    const nextBundle = await fixtureBundleDirectory(scratch, '1.1.0');
    const zipPath = path.join(scratch, 'release.zip');
    await zipDirectory(scratch, nextBundle, zipPath);
    const zipBytes = await readFile(zipPath);
    const sha256 = hash(zipBytes);
    const server = await startReleaseFixtureServer({ version: '1.1.0', zipBytes, sha256 });
    t.after(() => server.close());
    const { port } = server.address();
    const env = { ...process.env, LATCHKIT_UPDATE_API_BASE_URL: `http://127.0.0.1:${port}` };

    const check = await run(process.execPath, [cli, 'update', 'check', '--install-root', root], {
      env,
    });
    const checkReport = JSON.parse(check.stdout);
    assert.equal(checkReport.outcome, 'update-available');
    assert.equal(checkReport.candidate.version, '1.1.0');

    const preview = await run(
      process.execPath,
      [cli, 'update', 'preview', '--install-root', root],
      {
        env,
      },
    );
    const previewReport = JSON.parse(preview.stdout);
    assert.equal(previewReport.version, '1.1.0');
    assert.equal(previewReport.sha256, sha256);

    const activeBefore = await readFile(path.join(root, 'current'), 'utf8');
    const stage = await run(process.execPath, [cli, 'update', 'stage', '--install-root', root], {
      env,
    });
    const stageReport = JSON.parse(stage.stdout);
    assert.equal(stageReport.status, 'ready');
    assert.equal(stageReport.version, '1.1.0');
    assert.deepEqual(
      await readFile(path.join(root, 'current'), 'utf8'),
      activeBefore,
      'the CLI stage command must never activate the staged update',
    );

    const rolledForward = await run(
      process.execPath,
      [cli, 'update', 'rollback', '--to', '1.1.0', '--install-root', root],
      { env },
    );
    const rolledReport = JSON.parse(rolledForward.stdout);
    assert.equal(rolledReport.active, `1.1.0-${TARGET}`);

    const rolledBack = await run(
      process.execPath,
      [cli, 'update', 'rollback', '--to', '1.0.0', '--install-root', root],
      { env },
    );
    assert.equal(JSON.parse(rolledBack.stdout).active, `1.0.0-${TARGET}`);
  },
);

test('the update CLI validates its own arguments before touching anything', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-cli-args-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(run(process.execPath, [cli, 'update']));
  await assert.rejects(run(process.execPath, [cli, 'update', 'not-a-real-action']));
  await assert.rejects(
    run(process.execPath, [cli, 'update', 'rollback', '--install-root', root]),
    /--to is required/,
  );
  const envWithoutInstallRoot = { ...process.env };
  delete envWithoutInstallRoot.LATCHKIT_INSTALL_ROOT;
  await assert.rejects(
    run(process.execPath, [cli, 'update', 'status'], { env: envWithoutInstallRoot }),
    /--install-root is required/,
  );
  await assert.rejects(
    run(process.execPath, [cli, 'update', 'status', '--install-root', root, '--bundle', 'x']),
    /--bundle is not valid/,
  );
});
