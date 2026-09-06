import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FCC,
  inspectFcc,
  installFcc,
  previewFccInstall,
  recoverFcc,
  removeFcc,
  startFcc,
  stopFcc,
  validateFccArchive,
} from '../dist/src/managed-tools/fcc.js';
import {
  controllerStatus,
  launchController,
  localRequest,
  runBounded,
  stopController,
  systemEnvironment,
} from '../dist/src/managed-tools/fcc-process.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
} from '../dist/src/installer/transactions.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function temp(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'latchkit-fcc-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, root: path.join(home, 'tool') };
}
async function records(root, values) {
  await mkdir(path.join(root, '.latchkit'), { recursive: true });
  const resources = {};
  for (const [name, value] of Object.entries(values)) {
    const bytes = `${JSON.stringify(value)}\n`;
    await writeFile(path.join(root, name), bytes);
    resources[name] = hash(bytes);
  }
  await writeFile(
    path.join(root, '.latchkit', 'manifest.json'),
    JSON.stringify({ schemaVersion: 2, tool: 'fcc', resources }),
  );
}
function state(overrides = {}) {
  const installId = randomUUID();
  return {
    schemaVersion: 2,
    tool: 'fcc',
    version: FCC.version,
    commit: FCC.commit,
    installedAt: new Date().toISOString(),
    installId,
    sourceArchiveSha256: FCC.archiveSha256,
    python: process.execPath,
    pythonVersion: '3.14.7',
    uvVersion: '0.12.10',
    runtimeDirectory: `runtime-${FCC.commit}-${installId}`,
    profileDirectory: 'profile',
    ownsFccHome: false,
    ...overrides,
  };
}
function zip(names, edit) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const name of names) {
    const encoded = Buffer.from(name);
    const local = Buffer.alloc(30 + encoded.length);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(encoded.length, 26);
    encoded.copy(local, 30);
    const record = Buffer.alloc(46 + encoded.length);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(encoded.length, 28);
    record.writeUInt32LE(offset, 42);
    encoded.copy(record, 46);
    edit?.(record, local);
    locals.push(local);
    central.push(record);
    offset += local.length;
  }
  const middle = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(middle.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, middle, end]);
}
test('FCC archive verifies pin and rejects traversal, Windows aliases, links, types, duplicates and oversize members', () => {
  assert.throws(() => validateFccArchive(zip(['fcc/readme'])), /SHA-256/);
  for (const names of [
    ['fcc/../../escape'],
    ['fcc/C:escape'],
    ['fcc/NUL.txt'],
    ['fcc/file.'],
    ['fcc/a', 'fcc/A'],
    ['fcc/a', 'fcc/a/b'],
    ['fcc/a', 'other/b'],
  ]) {
    const archive = zip(names);
    assert.throws(() => validateFccArchive(archive, hash(archive)));
  }
  for (const edit of [
    (r) => r.writeUInt32LE(0xa0000000, 38),
    (r) => r.writeUInt32LE(0x10000000, 38),
    (r) => r.writeUInt32LE(33 * 1024 * 1024, 24),
  ]) {
    const archive = zip(['fcc/a'], edit);
    assert.throws(() => validateFccArchive(archive, hash(archive)), /links|special|size limit/);
  }
  const valid = zip(['fcc/', 'fcc/readme']);
  assert.deepEqual(validateFccArchive(valid, hash(valid)).members, ['readme']);
});

test('external FCC home is preserved and attach is truthfully unsupported', async (t) => {
  const options = await temp(t);
  await mkdir(path.join(options.home, '.fcc'));
  await writeFile(path.join(options.home, '.fcc', 'keep'), 'user');
  const result = await inspectFcc(options);
  assert.equal(result.existingFccHome, true);
  assert.match(result.capabilities.attach, /unsupported/);
  assert.equal((await previewFccInstall(options)).action, 'blocked');
  assert.equal(await readFile(path.join(options.home, '.fcc', 'keep'), 'utf8'), 'user');
});

test('existing files are insufficient runtime version evidence', async (t) => {
  const result = await inspectFcc({
    ...(await temp(t)),
    python: process.execPath,
    uv: process.execPath,
  });
  assert.equal(result.python.state, 'unavailable');
  assert.equal(result.uv.state, 'unavailable');
});

test('state traversal and forged persisted PIDs never delete files or signal processes', async (t) => {
  const options = await temp(t);
  await writeFile(path.join(options.home, 'keep'), 'user');
  await records(options.root, { 'fcc-state.json': state({ runtimeDirectory: '../' }) });
  await assert.rejects(removeFcc(options), /malformed/);
  assert.equal(await readFile(path.join(options.home, 'keep'), 'utf8'), 'user');
  await records(options.root, { 'fcc-state.json': state(), 'active.json': { pid: process.pid } });
  await assert.rejects(stopFcc(options), /malformed/);
  const owned = state();
  await records(options.root, {
    'fcc-state.json': owned,
    'active.json': {
      schemaVersion: 2,
      installId: owned.installId,
      controllerPid: process.pid,
      controlPort: await port(),
      controlToken: '0'.repeat(64),
      port: 8082,
      startedAt: new Date().toISOString(),
    },
  });
  await assert.rejects(stopFcc(options), /ownership/);
  await assert.rejects(recoverFcc(options), /PID still exists/);
  assert.equal(process.kill(process.pid, 0), true);
});

test('edited metadata blocks mutations and conservative removal preserves runtime edits and profile', async (t) => {
  const options = await temp(t);
  const owned = state();
  await records(options.root, { 'fcc-state.json': owned });
  await writeFile(
    path.join(options.root, 'fcc-state.json'),
    JSON.stringify({ ...owned, python: '/edited' }),
  );
  await assert.rejects(removeFcc(options), /edited/);
  await records(options.root, { 'fcc-state.json': owned });
  await mkdir(path.join(options.root, owned.runtimeDirectory));
  await writeFile(path.join(options.root, owned.runtimeDirectory, 'local-edit'), 'keep');
  await mkdir(path.join(options.root, 'profile', '.fcc'), { recursive: true });
  await writeFile(path.join(options.root, 'profile', '.fcc', '.env'), 'secret=private');
  const removed = await removeFcc(options);
  assert.equal(removed.action, 'deregistered');
  assert.equal(await readFile(path.join(removed.preservedRuntime, 'local-edit'), 'utf8'), 'keep');
  assert.equal(
    await readFile(path.join(removed.preservedProfile, '.fcc', '.env'), 'utf8'),
    'secret=private',
  );
});

function installerFixture(options, fail = false) {
  return {
    archive: async () => [
      { name: 'uv.lock', bytes: Buffer.from('fixture-lock') },
      { name: 'pyproject.toml', bytes: Buffer.from('fixture-project') },
    ],
    run: async (_command, args, cwd, env, timeout) => {
      if (args[0] === '--version') return 'uv 0.12.10';
      if (args[0] === 'sync') {
        const lifecycle = JSON.parse(await readFile(path.join(options.root, 'fcc-lifecycle.json')));
        assert.equal(lifecycle.phase, 'building');
        assert.equal(cwd, path.join(options.root, lifecycle.runtimeDirectory));
        assert.equal(env.UV_PROJECT_ENVIRONMENT, path.join(cwd, 'venv'));
        assert.ok(args.includes('--frozen'));
        assert.ok(args.includes('--no-editable'));
        assert.ok(args.includes('--no-python-downloads'));
        assert.equal(timeout, 600_000);
        if (fail) throw new Error('fixture dependency install failed');
        const bin = path.join(cwd, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
        await mkdir(bin, { recursive: true });
        await writeFile(
          path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python'),
          'fixture',
        );
        return '';
      }
      if (args.some((arg) => arg.includes('importlib.metadata'))) return FCC.version;
      return '3.14.7';
    },
  };
}
test('failed installation retains registered lifecycle and recovers to a new permanent runtime path', async (t) => {
  const options = {
    ...(await temp(t)),
    python: process.execPath,
    uv: process.execPath,
    archive: 'fixture',
  };
  await assert.rejects(installFcc(options, installerFixture(options, true)), /did not activate/);
  const interrupted = await inspectFcc(options);
  assert.equal(interrupted.managed, null);
  assert.equal(interrupted.lifecycle.phase, 'failed');
  const retained = path.join(options.root, interrupted.lifecycle.runtimeDirectory);
  await writeFile(path.join(retained, 'user-edit'), 'retain');
  assert.equal((await recoverFcc(options)).action, 'recovered');
  const installed = await installFcc(options, installerFixture(options));
  assert.equal(installed.action, 'installed');
  assert.notEqual(installed.managed.runtimeDirectory, interrupted.lifecycle.runtimeDirectory);
  assert.equal(await readFile(path.join(retained, 'user-edit'), 'utf8'), 'retain');
  const config = await readFile(path.join(options.root, 'profile', '.fcc', '.env'), 'utf8');
  const token = /ANTHROPIC_AUTH_TOKEN=([a-f0-9]{64})/.exec(config)[1];
  assert.ok(!JSON.stringify(installed).includes(token));
  const receipt = JSON.parse(await readFile(path.join(options.root, 'fcc-runtime-files.json')));
  assert.ok(
    Object.keys(receipt.files).every((name) =>
      name.startsWith(installed.managed.runtimeDirectory + '/'),
    ),
  );
  await writeFile(path.join(options.root, installed.managed.runtimeDirectory, 'uv.lock'), 'edited');
  await assert.rejects(startFcc(options), /files were edited/);
});

test('interrupted registered transaction blocks mutation and recovery preserves external edits', async (t) => {
  const options = await temp(t);
  const owned = state();
  await records(options.root, { 'fcc-state.json': owned });
  await assert.rejects(
    applyRegisteredTransaction(options.root, {
      operation: 'fixture',
      registry: createResourceRegistry([{ id: 'fcc-state.json', path: 'fcc-state.json' }]),
      changes: [{ resourceId: 'fcc-state.json', bytes: null }],
      manifest: '{}',
      faultBoundary: () => {
        throw new Error('interruption');
      },
    }),
    /interruption/,
  );
  await assert.rejects(removeFcc(options), /interrupted transaction/);
  await writeFile(path.join(options.root, 'fcc-state.json'), 'user edit');
  await assert.rejects(recoverFcc(options), /changed outside/);
  assert.equal(await readFile(path.join(options.root, 'fcc-state.json'), 'utf8'), 'user edit');
});

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
async function plan(behavior = 'ready') {
  const selected = await port();
  const token = randomBytes(32).toString('hex');
  return {
    command: process.execPath,
    args: [path.resolve('test/fixtures/fcc-server.js'), String(selected), token, behavior],
    cwd: process.cwd(),
    env: systemEnvironment(),
    proxyToken: token,
    port: selected,
    timeoutMs: 1000,
    installId: randomUUID(),
  };
}
test('owned controller waits for authenticated readiness and stops only its own child', async (t) => {
  const selected = await plan();
  const started = await launchController(selected);
  t.after(async () => {
    if (await controllerStatus(started.record)) await stopController(started.record);
  });
  assert.equal((await localRequest(selected.port, '/v1/messages', 'HEAD')).status, 401);
  assert.equal(
    (
      await localRequest(selected.port, '/v1/messages', 'HEAD', {
        authorization: `Bearer ${selected.proxyToken}`,
      })
    ).status,
    204,
  );
  await started.commit();
  assert.equal(await controllerStatus(started.record), true);
  assert.equal(await controllerStatus({ ...started.record, controlToken: '0'.repeat(64) }), false);
  assert.equal((await localRequest(started.record.controlPort, '/stop', 'POST')).status, 401);
  await stopController(started.record);
  assert.equal(await controllerStatus(started.record), false);
  await assert.rejects(localRequest(selected.port, '/health'));
});

test('controller rejects unauthenticated servers, early exits, missing executables, hangs and occupied ports', async () => {
  for (const behavior of ['no-auth', 'exit', 'hang'])
    await assert.rejects(launchController(await plan(behavior)), /readiness|controller/);
  await assert.rejects(
    launchController({ ...(await plan()), requiredAssets: ['/missing-admin-asset.js'] }),
    /Admin assets/,
  );
  await assert.rejects(
    launchController({
      ...(await plan()),
      command: path.join(os.tmpdir(), `missing-${randomUUID()}`),
    }),
    /could not start|controller/,
  );
  const unrelated = createServer((_req, res) => res.end('unrelated'));
  await new Promise((resolve) => unrelated.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      launchController({ ...(await plan()), port: unrelated.address().port }),
      /controller/,
    );
    assert.equal((await localRequest(unrelated.address().port, '/health')).body, 'unrelated');
    await assert.rejects(
      stopController({
        schemaVersion: 2,
        installId: randomUUID(),
        controlPort: unrelated.address().port,
        controlToken: '0'.repeat(64),
      }),
      /ownership/,
    );
  } finally {
    await new Promise((resolve) => unrelated.close(resolve));
  }
});

test('aborted activation shuts down an uncommitted owned child', async () => {
  const selected = await plan();
  const started = await launchController(selected);
  await started.abort();
  await assert.rejects(localRequest(selected.port, '/health'));
});

test('controller crash closes its child owner pipe', async () => {
  const selected = await plan();
  const started = await launchController(selected);
  await started.commit();
  // The PID is from this test's live IPC handshake, never a persisted file.
  process.kill(started.record.controllerPid, 'SIGKILL');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await localRequest(selected.port, '/health');
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Fixture child survived owner pipe closure.');
});

test('local HTTP probes enforce total deadlines even for dribbling responses', async () => {
  const server = createServer((_req, res) => {
    const interval = setInterval(() => res.write('x'), 10);
    res.once('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(localRequest(server.address().port, '/', 'GET', {}, 100), /deadline/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('subprocess execution has deadlines, spawn errors and bounded secret-safe failure output', async () => {
  await assert.rejects(
    runBounded(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      systemEnvironment(),
      100,
    ),
    /timed out/,
  );
  await assert.rejects(
    runBounded(path.join(os.tmpdir(), 'no-fcc-executable'), [], process.cwd(), systemEnvironment()),
    /could not start/,
  );
  await assert.rejects(
    runBounded(
      process.execPath,
      ['-e', 'process.stderr.write("secret-value"); process.exit(7)'],
      process.cwd(),
      systemEnvironment(),
    ),
    (error) => /exited 7/.test(error.message) && !error.message.includes('secret-value'),
  );
});
