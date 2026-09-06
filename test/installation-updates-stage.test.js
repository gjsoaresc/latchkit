import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  activateStagedUpdate,
  DownloadCancelledError,
  stageUpdate,
  UpdateServiceError,
} from '../dist/src/installation/updates/service.js';
import {
  readStagedUpdateRecord,
  readUpdateSettingsState,
} from '../dist/src/installation/updates/store.js';
import { expectedAssetName } from '../dist/src/installation/updates/release-source.js';

const run = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = `${process.platform}-${process.arch}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const onlyWindowsZip = process.platform !== 'win32'; // Fixture archives here are always .zip.

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

/** Zip a directory with the exact tool `extractArchive` uses to unzip it
 * (PowerShell's Compress-Archive/Expand-Archive pair), so the fixture round
 * trips through the same real mechanism the service uses in production. */
async function zipDirectory(scratch, sourceDirectory, destinationZip) {
  const script = path.join(scratch, `compress-${randomUUID()}.ps1`);
  await writeFile(
    script,
    'param($Source,$Destination)\n$ErrorActionPreference="Stop"\nCompress-Archive -Path (Join-Path $Source \'*\') -DestinationPath $Destination -Force\n',
  );
  await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', script, sourceDirectory, destinationZip],
    {
      windowsHide: true,
      timeout: 60_000,
    },
  );
}

function countActivations(t, root) {
  const original = filesystem.rename;
  const activePath = path.join(root, 'current');
  let count = 0;
  t.mock.method(filesystem, 'rename', async (from, to) => {
    if (to === activePath) count += 1;
    return original(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return () => count;
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function servingBuffer(buffer, { contentLength = true, truncateAt } = {}) {
  return (req, res) => {
    if (contentLength) res.writeHead(200, { 'content-length': String(buffer.length) });
    else res.writeHead(200);
    if (truncateAt !== undefined) {
      res.write(buffer.subarray(0, truncateAt));
      // Abruptly end the underlying socket mid-response rather than closing
      // the chunked stream cleanly, simulating an interrupted download.
      res.destroy();
      return;
    }
    res.end(buffer);
  };
}

async function buildFixture(t, { version = '9.9.9-stage-test' } = {}) {
  const scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-stage-fixture-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const bundle = await fixtureBundleDirectory(scratch, version);
  const zipPath = path.join(scratch, 'fixture.zip');
  await zipDirectory(scratch, bundle, zipPath);
  const zipBytes = await readFile(zipPath);
  const sha256 = hash(zipBytes);
  return { scratch, version, zipBytes, sha256 };
}

function previewFor({ version, sha256, assetUrl }) {
  return {
    schemaVersion: 1,
    previewId: randomUUID(),
    createdAt: new Date().toISOString(),
    currentVersion: '0.0.1',
    target: TARGET,
    version,
    tag: `v${version}`,
    assetName: expectedAssetName(version, TARGET),
    assetUrl,
    sha256,
    majorUpdate: false,
    notes: 'Fixture release notes.',
  };
}

test(
  'stageUpdate downloads, verifies, extracts, and stages without activating; retry is idempotent',
  { skip: onlyWindowsZip && 'fixture archives in this test are .zip (win32 extraction only)' },
  async (t) => {
    const fixture = await buildFixture(t);
    const { server, baseUrl } = await startServer((req, res) => {
      if (req.url?.endsWith('.sha256')) return res.end(`${fixture.sha256}  fixture.zip\n`);
      return servingBuffer(fixture.zipBytes)(req, res);
    });
    t.after(() => server.close());
    const root = path.join(fixture.scratch, 'install root with spaces é');
    const activations = countActivations(t, root);
    const preview = previewFor({
      version: fixture.version,
      sha256: fixture.sha256,
      assetUrl: `${baseUrl}/download/fixture.zip`,
    });
    const progressEvents = [];

    const staged = await stageUpdate(root, preview, {
      scratchParent: fixture.scratch,
      onProgress: (status) => progressEvents.push(status),
    });
    assert.equal(staged.status, 'ready');
    assert.equal(staged.version, fixture.version);
    assert.equal(staged.sha256, fixture.sha256);
    assert.deepEqual(progressEvents, ['downloading', 'verifying']);
    assert.equal(activations(), 0, 'staging an update must never activate it');
    await assert.rejects(readFile(path.join(root, 'current')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(path.join(root, 'versions')), [staged.key]);

    // The scratch directory this call owned must be fully cleaned up, win or fail.
    const leftovers = (await readdir(fixture.scratch)).filter((name) =>
      name.startsWith('latchkit-update-stage-'),
    );
    assert.deepEqual(leftovers, []);

    const restaged = await stageUpdate(root, preview, { scratchParent: fixture.scratch });
    assert.equal(restaged.key, staged.key);
    assert.equal(activations(), 0);
    assert.deepEqual(await readdir(path.join(root, 'versions')), [staged.key]);

    const persisted = await readStagedUpdateRecord(root);
    assert.equal(persisted.key, staged.key);
    assert.equal(persisted.status, 'ready');

    const activated = await activateStagedUpdate(root);
    assert.equal(activated.active, staged.key);
    assert.equal(activations(), 1);
    assert.equal(await readStagedUpdateRecord(root), null, 'activation clears the staged record');
  },
);

test(
  'a checksum mismatch is rejected, recorded as a failed staged record, and never activates',
  { skip: onlyWindowsZip && 'fixture archives in this test are .zip (win32 extraction only)' },
  async (t) => {
    const fixture = await buildFixture(t, { version: '9.9.9-checksum-mismatch' });
    const { server, baseUrl } = await startServer(servingBuffer(fixture.zipBytes));
    t.after(() => server.close());
    const root = path.join(fixture.scratch, 'root');
    const activations = countActivations(t, root);
    const preview = previewFor({
      version: fixture.version,
      sha256: 'f'.repeat(64), // Deliberately wrong.
      assetUrl: `${baseUrl}/download/fixture.zip`,
    });

    await assert.rejects(
      () => stageUpdate(root, preview, { scratchParent: fixture.scratch }),
      (error) => error instanceof UpdateServiceError && error.code === 'UPDATE_CHECKSUM_MISMATCH',
    );
    assert.equal(activations(), 0);
    const staged = await readStagedUpdateRecord(root);
    assert.equal(staged.status, 'failed');
    assert.match(staged.failureReason, /checksum/i);
  },
);

test(
  'a corrupt (invalid) archive whose bytes still match the bound checksum fails extraction, not activation',
  { skip: onlyWindowsZip && 'archive extraction here is the Windows PowerShell path' },
  async (t) => {
    const scratch = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-stage-corrupt-')),
    );
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const garbage = Buffer.from('this is not a zip archive, just garbage bytes');
    const sha256 = hash(garbage);
    const { server, baseUrl } = await startServer(servingBuffer(garbage));
    t.after(() => server.close());
    const root = path.join(scratch, 'root');
    const activations = countActivations(t, root);
    const preview = previewFor({
      version: '9.9.9-corrupt',
      sha256,
      assetUrl: `${baseUrl}/download/fixture.zip`,
    });

    await assert.rejects(() => stageUpdate(root, preview, { scratchParent: scratch }));
    assert.equal(activations(), 0);
    const staged = await readStagedUpdateRecord(root);
    assert.equal(staged.status, 'failed');
    assert.ok(staged.failureReason);
  },
);

test('an interrupted download (connection closed mid-transfer) is rejected and preserves the current installation', async (t) => {
  const scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-stage-interrupted-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const payload = Buffer.alloc(200_000, 7);
  const { server, baseUrl } = await startServer(servingBuffer(payload, { truncateAt: 1000 }));
  t.after(() => server.close());
  const root = path.join(scratch, 'root');
  const activations = countActivations(t, root);
  const preview = previewFor({
    version: '9.9.9-interrupted',
    sha256: hash(payload),
    assetUrl: `${baseUrl}/download/fixture.zip`,
  });

  await assert.rejects(() => stageUpdate(root, preview, { scratchParent: scratch, maxRetries: 0 }));
  assert.equal(activations(), 0);
  const staged = await readStagedUpdateRecord(root);
  assert.equal(staged.status, 'failed');
  // The failed download's own scratch temp directory must still be cleaned up.
  const leftovers = (await readdir(scratch)).filter((name) =>
    name.startsWith('latchkit-update-stage-'),
  );
  assert.deepEqual(leftovers, []);
});

test('a download exceeding the declared content-length bound is rejected before streaming completes', async (t) => {
  const scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-stage-toolarge-declared-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const payload = Buffer.alloc(50_000, 3);
  const { server, baseUrl } = await startServer(servingBuffer(payload));
  t.after(() => server.close());
  const root = path.join(scratch, 'root');
  const preview = previewFor({
    version: '9.9.9-toolarge',
    sha256: hash(payload),
    assetUrl: `${baseUrl}/download/fixture.zip`,
  });
  await assert.rejects(
    () => stageUpdate(root, preview, { scratchParent: scratch, maxDownloadBytes: 1000 }),
    /exceeds the allowed bound/,
  );
});

test('a download exceeding the byte bound with no declared content-length is still rejected mid-stream', async (t) => {
  const scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-stage-toolarge-stream-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const payload = Buffer.alloc(50_000, 5);
  const { server, baseUrl } = await startServer(servingBuffer(payload, { contentLength: false }));
  t.after(() => server.close());
  const root = path.join(scratch, 'root');
  const preview = previewFor({
    version: '9.9.9-toolarge-stream',
    sha256: hash(payload),
    assetUrl: `${baseUrl}/download/fixture.zip`,
  });
  await assert.rejects(
    () => stageUpdate(root, preview, { scratchParent: scratch, maxDownloadBytes: 1000 }),
    /exceeded the allowed bound/,
  );
});

test(
  'extracted content exceeding the configured bound is rejected and removed',
  { skip: onlyWindowsZip && 'fixture archives in this test are .zip (win32 extraction only)' },
  async (t) => {
    const fixture = await buildFixture(t, { version: '9.9.9-extract-bound' });
    const { server, baseUrl } = await startServer(servingBuffer(fixture.zipBytes));
    t.after(() => server.close());
    const root = path.join(fixture.scratch, 'root');
    const activations = countActivations(t, root);
    const preview = previewFor({
      version: fixture.version,
      sha256: fixture.sha256,
      assetUrl: `${baseUrl}/download/fixture.zip`,
    });
    await assert.rejects(
      () =>
        stageUpdate(root, preview, {
          scratchParent: fixture.scratch,
          extract: { maxTotalBytes: 10 },
        }),
      /exceeded the allowed bound/,
    );
    assert.equal(activations(), 0);
    const staged = await readStagedUpdateRecord(root);
    assert.equal(staged.status, 'failed');
  },
);

test('activateStagedUpdate refuses to activate when nothing is staged', async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-activate-none-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => activateStagedUpdate(root),
    (error) => error instanceof UpdateServiceError && error.code === 'UPDATE_NOT_STAGED',
  );
});

// Issue #139 slice 2: cancelling a download must never activate a different release or change
// the persisted update preference (see the console's "Cancel" control, wired through
// src/installation/updates/routes.ts's `/api/updates/stage` handler to this same `signal`).
test('cancelling a download mid-transfer is distinguishable from a failure, activates nothing, and never touches the persisted mode', async (t) => {
  const scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-update-stage-cancel-')),
  );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const payload = Buffer.alloc(2_000_000, 9); // large enough to still be streaming when aborted
  let firstChunkSent;
  const firstChunkSentPromise = new Promise((resolve) => {
    firstChunkSent = resolve;
  });
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'content-length': String(payload.length) });
    res.write(payload.subarray(0, 1000));
    firstChunkSent();
    // Hold the connection open (never call res.end()) so the client observes an in-progress
    // stream to cancel rather than a response that already finished on its own.
  });
  t.after(() => server.close());
  const root = path.join(scratch, 'root');
  const activations = countActivations(t, root);
  const preview = previewFor({
    version: '9.9.9-cancel',
    sha256: hash(payload),
    assetUrl: `${baseUrl}/download/fixture.zip`,
  });

  const controller = new AbortController();
  const staging = stageUpdate(root, preview, { scratchParent: scratch, signal: controller.signal });
  await firstChunkSentPromise;
  controller.abort();

  await assert.rejects(
    staging,
    (error) => error instanceof DownloadCancelledError || /cancelled/i.test(error.message),
  );
  assert.equal(activations(), 0, 'cancelling a download must never activate any release');
  const staged = await readStagedUpdateRecord(root);
  assert.equal(staged.status, 'failed');
  // Never lose or change the update preference: no settings file was ever written by staging.
  const settings = await readUpdateSettingsState(root);
  assert.equal(settings.mode, 'manual');
  assert.equal(settings.revision, 0);
});
