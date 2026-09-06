import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  createStableLaunchers,
  installBundle,
  inspectInstallation,
  rollbackInstallation,
  uninstallInstallation,
} from '../dist/src/installation/manager.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);

function interceptActivation(t, operation) {
  const original = filesystem.rename;
  t.mock.method(filesystem, 'rename', async (from, to) => {
    if (String(from).endsWith('.staging')) return operation(from, to, original);
    return original(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test(
  'Windows activation retries a transient sharing failure and activates the complete bundle',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-activation-retry-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const version = JSON.parse(
      await readFile(path.join(repository, 'package.json'), 'utf8'),
    ).version;
    const { bundle, target } = await fixtureBundle(scratch, version);
    let attempts = 0;
    interceptActivation(t, async (from, to, rename) => {
      attempts += 1;
      if (attempts < 3)
        throw Object.assign(new Error('Temporary sharing violation'), { code: 'EPERM' });
      return rename(from, to);
    });
    const installed = await installBundle({ root: path.join(scratch, 'root'), bundle, target });
    assert.equal(attempts, 3);
    assert.equal(installed.active, `${version}-${target}`);
    assert.deepEqual(await readdir(path.join(installed.root, 'versions')), [
      `${version}-${target}`,
    ]);
  },
);

test(
  'Windows activation retry exhaustion preserves the active pointer and original error',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-activation-exhaust-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const version = JSON.parse(
      await readFile(path.join(repository, 'package.json'), 'utf8'),
    ).version;
    const { bundle, target } = await fixtureBundle(scratch, version);
    const root = path.join(scratch, 'root');
    await mkdir(root);
    const active = Buffer.from('previous-version-must-remain\r\n');
    await writeFile(path.join(root, 'current'), active);
    const failure = Object.assign(new Error('Persistent sharing violation'), { code: 'EPERM' });
    let attempts = 0;
    interceptActivation(t, async () => {
      attempts += 1;
      throw failure;
    });
    await assert.rejects(
      () => installBundle({ root, bundle, target }),
      (error) => error === failure,
    );
    assert.ok(attempts > 1 && attempts <= 8, `bounded attempts: ${attempts}`);
    assert.deepEqual(await readFile(path.join(root, 'current')), active);
    assert.deepEqual(await readdir(path.join(root, 'versions')), []);
  },
);

test('activation does not retry an unrelated filesystem error', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-activation-error-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const { bundle, target } = await fixtureBundle(scratch, version);
  const failure = Object.assign(new Error('Read-only filesystem'), { code: 'EROFS' });
  let attempts = 0;
  interceptActivation(t, async () => {
    attempts += 1;
    throw failure;
  });
  await assert.rejects(
    () => installBundle({ root: path.join(scratch, 'root'), bundle, target }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

async function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { windowsHide: true });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${code}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}

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

async function fixtureBundle(scratch, version) {
  const bundle = path.join(scratch, `bundle-${version}`);
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(
    process.execPath,
    path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const target = `${process.platform}-${process.arch}`;
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, package: 'latchkit', version, target, nodeVersion: process.version, files: await inventory(bundle) })}\n`,
  );
  return { bundle, target };
}

test('standalone manager stages, activates, rolls back, and retains versions on uninstall', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-installation-'));
  t.after(async () => {
    await (await import('node:fs/promises')).rm(scratch, { recursive: true, force: true });
  });
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const { bundle, target } = await fixtureBundle(scratch, version);
  const root = path.join(scratch, 'root é %');
  const installed = await installBundle({ root, bundle, target });
  assert.equal(installed.active, `${version}-${target}`);
  assert.ok(
    installed.launchers.includes(
      process.platform === 'win32' ? 'latchkit-hook.ps1' : 'latchkit-hook',
    ),
  );
  if (process.platform === 'win32') {
    const command = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(root, 'bin', 'latchkit.ps1'),
      '--version',
    ]);
    assert.equal(command.stdout.trim(), version);
    const hook = await runWithInput(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(root, 'bin', 'latchkit-hook.ps1'),
        '--version',
        `${version}-${target}`,
        '--handler',
        'claude',
        '--event',
        'PreToolUse',
      ],
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        tool_name: 'Bash',
        tool_input: {},
      }),
    );
    assert.match(hook.stdout, /"eventName":"PreToolUse"/);
    assert.match(hook.stdout, /"session_id":"session"/);
  } else {
    const hookFile = path.join(root, 'bin', 'latchkit-hook');
    await run('sh', ['-n', hookFile]);
    const hook = await runWithInput(
      hookFile,
      ['--version', `${version}-${target}`, '--handler', 'claude', '--event', 'PreToolUse'],
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        tool_name: 'Bash',
        tool_input: {},
      }),
    );
    assert.match(hook.stdout, /"eventName":"PreToolUse"/);
    assert.match(hook.stdout, /"session_id":"session"/);
  }
  const upgradedVersion = '1.0.1';
  const upgradedBundle = path.join(scratch, 'bundle-upgrade');
  await cp(bundle, upgradedBundle, { recursive: true });
  await rm(path.join(upgradedBundle, 'bundle-manifest.json'));
  const packageFile = path.join(upgradedBundle, 'app', 'dist', 'package.json');
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  packageJson.version = upgradedVersion;
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(
    path.join(upgradedBundle, 'bundle-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, package: 'latchkit', version: upgradedVersion, target, nodeVersion: process.version, files: await inventory(upgradedBundle) })}\n`,
  );
  const upgraded = await installBundle({ root, bundle: upgradedBundle, target });
  assert.equal(upgraded.active, `${upgradedVersion}-${target}`);
  const conflictRoot = path.join(scratch, 'conflict-root');
  await (
    await import('node:fs/promises')
  ).mkdir(path.join(conflictRoot, 'bin'), { recursive: true });
  await writeFile(
    path.join(conflictRoot, 'bin', process.platform === 'win32' ? 'latchkit.cmd' : 'latchkit'),
    'user launcher',
  );
  await assert.rejects(
    () => installBundle({ root: conflictRoot, bundle: upgradedBundle, target }),
    /unowned launcher/,
  );
  await assert.rejects(() => readFile(path.join(conflictRoot, '.latchkit/tasks/lock')), {
    code: 'ENOENT',
  });
  const repeated = await installBundle({ root, bundle, target });
  assert.equal(repeated.active, `${version}-${target}`);
  await writeFile(path.join(bundle, 'app', 'dist', 'src', 'cli.js'), 'corrupted bundle');
  await assert.rejects(() => installBundle({ root, bundle, target }), /integrity check failed/);
  assert.equal((await inspectInstallation(root)).active, `${version}-${target}`);
  await rollbackInstallation(root, version, target);
  const removed = await uninstallInstallation(root);
  assert.equal(removed.active, null);
  assert.ok(
    removed.launchers.includes(
      process.platform === 'win32' ? 'latchkit-hook.ps1' : 'latchkit-hook',
    ),
  );
  assert.deepEqual(
    (await inspectInstallation(root)).versions,
    [`${upgradedVersion}-${target}`, `${version}-${target}`].sort(),
  );
});

test('standalone launchers never overwrite an unowned command', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-launcher-'));
  t.after(async () => {
    await (await import('node:fs/promises')).rm(root, { recursive: true, force: true });
  });
  await (await import('node:fs/promises')).mkdir(path.join(root, 'bin'), { recursive: true });
  const name = process.platform === 'win32' ? 'latchkit.cmd' : 'latchkit';
  await writeFile(path.join(root, 'bin', name), 'user-owned launcher');
  await assert.rejects(
    () => createStableLaunchers(root, `${process.platform}-${process.arch}`),
    /unowned launcher/,
  );
});

test('standalone manager rejects unsupported targets and rollback traversal', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-target-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    () => createStableLaunchers(root, 'win32-arm64'),
    /Invalid hook|Unsupported|Invalid/,
  );
  await assert.rejects(
    () => rollbackInstallation(root, '../escape', `${process.platform}-${process.arch}`),
    /Invalid rollback/,
  );
});

test(
  'standalone manager rejects a Windows versions junction before staging outside root',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-junction-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const version = JSON.parse(
      await readFile(path.join(repository, 'package.json'), 'utf8'),
    ).version;
    const { bundle, target } = await fixtureBundle(scratch, version);
    const root = path.join(scratch, 'root');
    const outside = path.join(scratch, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await run('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(root, 'versions'), outside]);
    await assert.rejects(() => installBundle({ root, bundle, target }), /symlink|junction/i);
    assert.deepEqual(await readdir(outside), []);
  },
);

test('uninstall rejects a redirected launcher parent without deleting outside content or current', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-uninstall-link-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const { bundle, target } = await fixtureBundle(scratch, version);
  const root = path.join(scratch, 'root');
  const outside = path.join(scratch, 'outside');
  await installBundle({ root, bundle, target });
  const launcherName = process.platform === 'win32' ? 'latchkit.cmd' : 'latchkit';
  const launcher = await readFile(path.join(root, 'bin', launcherName));
  const current = await readFile(path.join(root, 'current'));
  await mkdir(outside);
  await writeFile(path.join(outside, launcherName), launcher);
  await rm(path.join(root, 'bin'), { recursive: true });
  if (process.platform === 'win32')
    await run('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(root, 'bin'), outside]);
  else await symlink(outside, path.join(root, 'bin'), 'dir');
  await assert.rejects(() => uninstallInstallation(root), /symlink|junction/i);
  assert.deepEqual(await readFile(path.join(root, 'current')), current);
  assert.deepEqual(await readFile(path.join(outside, launcherName)), launcher);
});

test('launcher recovery records an already-written launcher after an interrupted ownership update', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-launcher-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = `${process.platform}-${process.arch}`;
  await createStableLaunchers(root, target);
  const relative = process.platform === 'win32' ? 'bin/latchkit.cmd' : 'bin/latchkit';
  const launcher = await readFile(path.join(root, ...relative.split('/')));
  const ownershipFile = path.join(root, '.launchers.json');
  const ownership = JSON.parse(await readFile(ownershipFile, 'utf8'));
  delete ownership.files[relative];
  await writeFile(ownershipFile, `${JSON.stringify(ownership)}\n`);
  await writeFile(
    path.join(root, '.launchers.intent.json'),
    `${JSON.stringify({ schemaVersion: 1, relative, previousHash: null, nextHash: hash(launcher) })}\n`,
  );
  await createStableLaunchers(root, target);
  const recovered = JSON.parse(await readFile(ownershipFile, 'utf8'));
  assert.equal(recovered.files[relative], hash(launcher));
  await assert.rejects(readFile(path.join(root, '.launchers.intent.json')), { code: 'ENOENT' });
});
