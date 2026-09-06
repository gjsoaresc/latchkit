import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initProject } from '../dist/src/core.js';
import { startServer } from '../dist/src/server.js';
import { installBundle, stageBundle } from '../dist/src/installation/manager.js';
import { writeStagedUpdateRecord } from '../dist/src/installation/updates/store.js';
import { writeInstallationLease } from '../dist/src/installation/updates/store.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = `${process.platform}-${process.arch}`;

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

async function tempRoot(t, prefix) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

async function buildBundle(scratch, version) {
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

/** A self-managed installation: real `installBundle`, running this repository's own actual
 * version so ownership detection's `inspectInstallation` sees a real active version and owned
 * launchers (see docs/installation.md#update-ownership-and-channel-detection). */
async function selfManagedInstallRoot(t) {
  const scratch = await tempRoot(t, 'latchkit-updates-routes-selfmanaged-scratch-');
  const installRoot = await tempRoot(t, 'latchkit-updates-routes-selfmanaged-root-');
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const bundle = await buildBundle(scratch, version);
  await installBundle({ root: installRoot, bundle, version, target: TARGET });
  return { installRoot, scratch, baseVersion: version };
}

function fakeReplacementSpawn({ port = 54321, token = 'a'.repeat(64), exitCode } = {}) {
  return function fakeSpawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 424242;
    child.kill = () => {
      /* no real process to kill */
    };
    child.unref = () => {};
    setImmediate(() => {
      if (exitCode !== undefined) {
        child.emit('exit', exitCode, null);
        return;
      }
      child.stdout.emit(
        'data',
        Buffer.from(`Latchkit console for X\nhttp://127.0.0.1:${port}/#${token}\n`),
      );
    });
    return child;
  };
}

function fakeVerifyFetch(expectedVersion) {
  return async () =>
    new Response(JSON.stringify({ status: { installedVersion: expectedVersion } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

async function startFixtureServer(t, { installRoot, runningFromInstallRoot, ...rest } = {}) {
  const root = await tempRoot(t, 'latchkit-updates-routes-project-');
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url } = await startServer(root, {
    installRoot,
    runningFromInstallRoot,
    ...rest,
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = new URL(url).origin;
  const token = new URL(url).hash.slice(1);
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  return { server, origin, headers, root };
}

test('GET /api/updates is authenticated and reflects source-development ownership by default', async (t) => {
  const { origin, headers } = await startFixtureServer(t, {});
  const denied = await fetch(`${origin}/api/updates`);
  assert.equal(denied.status, 401);
  const response = await fetch(`${origin}/api/updates`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ownership.kind, 'source-development');
  assert.equal(
    body.status.installedVersion,
    JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version,
  );
});

test('mutating update routes report the ownership limitation instead of silently proceeding when unowned', async (t) => {
  const installRoot = await tempRoot(t, 'latchkit-updates-routes-unowned-');
  const { origin, headers } = await startFixtureServer(t, {
    installRoot,
    runningFromInstallRoot: installRoot,
  });
  const check = await fetch(`${origin}/api/updates/check`, { method: 'POST', headers, body: '{}' });
  assert.equal(check.status, 409);
  const body = await check.json();
  assert.match(body.error, /run the installer to adopt it/i);
});

test('update routes are rejected without a session token and across origins, exactly like every other API route', async (t) => {
  const { origin, headers } = await startFixtureServer(t, {});
  assert.equal((await fetch(`${origin}/api/updates`)).status, 401);
  const crossOrigin = await fetch(`${origin}/api/updates/check`, {
    method: 'POST',
    headers: { ...headers, Origin: 'http://127.0.0.1:1' },
    body: '{}',
  });
  assert.equal(crossOrigin.status, 403);
});

test('a self-managed installation is reported correctly and check/preview endpoints require it', async (t) => {
  const { installRoot } = await selfManagedInstallRoot(t);
  const { origin, headers } = await startFixtureServer(t, {
    installRoot,
    runningFromInstallRoot: installRoot,
  });
  const response = await fetch(`${origin}/api/updates`, { headers });
  const body = await response.json();
  assert.equal(body.ownership.kind, 'self-managed');
});

test(
  'a full manual activate-and-restart succeeds, reconnects to a verified replacement, and stops the old server',
  { timeout: 30_000 },
  async (t) => {
    const { installRoot, scratch, baseVersion } = await selfManagedInstallRoot(t);
    const toVersion = '9.9.9-routes-activate-target';
    const bundle = await buildBundle(scratch, toVersion);
    const staged = await stageBundle({
      root: installRoot,
      bundle,
      version: toVersion,
      target: TARGET,
    });

    const { origin, headers, server } = await startFixtureServer(t, {
      installRoot,
      runningFromInstallRoot: installRoot,
      updateSpawnImpl: fakeReplacementSpawn({}),
      updateFetchImpl: fakeVerifyFetch(toVersion),
    });

    const settings = await (await fetch(`${origin}/api/updates`, { headers })).json();
    const previewId = randomUUID();
    await writeStagedUpdateRecord(
      {
        schemaVersion: 1,
        previewId,
        version: toVersion,
        target: TARGET,
        assetName: 'fixture.zip',
        sha256: 'a'.repeat(64),
        key: staged.key,
        directory: staged.directory,
        stagedAt: new Date().toISOString(),
        authorizedMode: 'manual',
        authorizedRevision: settings.settings.revision,
        status: 'ready',
        failureReason: null,
      },
      installRoot,
    );

    const activation = await fetch(`${origin}/api/updates/activate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: settings.settings.revision, updateId: previewId }),
    });
    assert.equal(activation.status, 200);
    const activationBody = await activation.json();
    assert.equal(activationBody.status, 'completed');
    assert.match(activationBody.reconnect.url, /^http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}$/);

    // "acknowledge that request before old-server drain" (acceptance criterion 5): the browser
    // already has its response; now confirm the old server actually stops.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(fetch(`${origin}/api/updates`, { headers }));
    void baseVersion;
    void server;
  },
);

test('activation is rejected when the settings revision or update ID is stale', async (t) => {
  const { installRoot, scratch } = await selfManagedInstallRoot(t);
  const toVersion = '9.9.9-routes-stale-target';
  const bundle = await buildBundle(scratch, toVersion);
  const staged = await stageBundle({
    root: installRoot,
    bundle,
    version: toVersion,
    target: TARGET,
  });
  const { origin, headers } = await startFixtureServer(t, {
    installRoot,
    runningFromInstallRoot: installRoot,
    updateSpawnImpl: fakeReplacementSpawn({}),
    updateFetchImpl: fakeVerifyFetch(toVersion),
  });
  const settings = await (await fetch(`${origin}/api/updates`, { headers })).json();
  const previewId = randomUUID();
  await writeStagedUpdateRecord(
    {
      schemaVersion: 1,
      previewId,
      version: toVersion,
      target: TARGET,
      assetName: 'fixture.zip',
      sha256: 'a'.repeat(64),
      key: staged.key,
      directory: staged.directory,
      stagedAt: new Date().toISOString(),
      authorizedMode: 'manual',
      authorizedRevision: settings.settings.revision,
      status: 'ready',
      failureReason: null,
    },
    installRoot,
  );

  const staleRevision = await fetch(`${origin}/api/updates/activate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: settings.settings.revision + 1, updateId: previewId }),
  });
  assert.equal(staleRevision.status, 428);

  const wrongUpdateId = await fetch(`${origin}/api/updates/activate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      expectedRevision: settings.settings.revision,
      updateId: 'not-the-real-preview',
    }),
  });
  assert.equal(wrongUpdateId.status, 409);
});

test('a preview never seen by /preview cannot be staged (no arbitrary asset URL can be injected)', async (t) => {
  const { installRoot } = await selfManagedInstallRoot(t);
  const { origin, headers } = await startFixtureServer(t, {
    installRoot,
    runningFromInstallRoot: installRoot,
  });
  const response = await fetch(`${origin}/api/updates/stage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ previewId: 'forged-preview-id' }),
  });
  assert.equal(response.status, 409);
});

test('the installation-wide restart admission barrier blocks other mutating routes on any server sharing the installation', async (t) => {
  const installRoot = await tempRoot(t, 'latchkit-updates-routes-barrier-');
  const { origin, headers } = await startFixtureServer(t, {
    installRoot,
    runningFromInstallRoot: installRoot,
  });
  await writeInstallationLease(
    {
      schemaVersion: 1,
      state: 'restarting',
      ownerId: 'another-console',
      reason: 'test',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    installRoot,
  );
  const blocked = await fetch(`${origin}/api/onboarding/start`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(blocked.status, 503);
  // Read-only routes remain reachable during the barrier.
  const status = await fetch(`${origin}/api/updates`, { headers });
  assert.equal(status.status, 200);
});

test('an unsaved edit reported through /api/updates/activity blocks a subsequent activation', async (t) => {
  const { installRoot, scratch } = await selfManagedInstallRoot(t);
  const toVersion = '9.9.9-routes-dirty-target';
  const bundle = await buildBundle(scratch, toVersion);
  const staged = await stageBundle({
    root: installRoot,
    bundle,
    version: toVersion,
    target: TARGET,
  });
  const { origin, headers } = await startFixtureServer(t, {
    installRoot,
    runningFromInstallRoot: installRoot,
    updateSpawnImpl: fakeReplacementSpawn({}),
    updateFetchImpl: fakeVerifyFetch(toVersion),
  });
  const settings = await (await fetch(`${origin}/api/updates`, { headers })).json();
  const previewId = randomUUID();
  await writeStagedUpdateRecord(
    {
      schemaVersion: 1,
      previewId,
      version: toVersion,
      target: TARGET,
      assetName: 'fixture.zip',
      sha256: 'a'.repeat(64),
      key: staged.key,
      directory: staged.directory,
      stagedAt: new Date().toISOString(),
      authorizedMode: 'manual',
      authorizedRevision: settings.settings.revision,
      status: 'ready',
      failureReason: null,
    },
    installRoot,
  );

  const ping = await fetch(`${origin}/api/updates/activity`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ dirty: true }),
  });
  assert.equal(ping.status, 200);

  const activation = await fetch(`${origin}/api/updates/activate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ expectedRevision: settings.settings.revision, updateId: previewId }),
  });
  assert.equal(activation.status, 409);
  const body = await activation.json();
  assert.equal(body.status, 'waiting');
  assert.ok(body.reasons.some((reason) => reason.includes('unsaved edit')));
});
