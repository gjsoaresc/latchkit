import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initProject,
  inspectRecovery,
  recoverProject,
  saveConfig,
  syncProject,
} from '../src/core.js';
import { applyRegisteredTransaction, createResourceRegistry, inspectTransaction, recoverTransaction } from '../src/installer/transactions.js';
import { inspectProjectLock, removeProvenStaleLock, withProjectLock } from '../src/installer/lock.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const crashHelper = path.join(repositoryRoot, 'scripts', 'test-helpers', 'crash-sync.js');
const resourceCrashHelper = path.join(repositoryRoot, 'scripts', 'test-helpers', 'crash-resource.js');
const cli = path.join(repositoryRoot, 'src', 'cli.js');
const execFileAsync = promisify(execFile);

async function temporaryProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-recovery-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function crashAt(root, operation, boundary) {
  const child = fork(crashHelper, [root, operation, boundary], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Child exited before fault boundary (${code}).`)));
  });
  return child;
}

async function killChild(child) {
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

const skillPath = root => path.join(root, '.agents', 'skills', 'latchkit-spec', 'SKILL.md');

test('a process killed immediately after journal publication leaves resources untouched and recoverable', async t => {
  const root = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const child = await crashAt(root, 'sync', 'journal');
  await killChild(child);
  assert.equal(await exists(skillPath(root)), false);
  assert.equal((await inspectRecovery(root)).transaction.state, 'pending');
  assert.equal((await recoverProject(root)).state, 'rolled-back');
  assert.equal(await exists(skillPath(root)), false);
});

test('a live transaction lock cannot be reclaimed and a killed create rolls back', async t => {
  const root = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const child = await crashAt(root, 'sync', 'resource:0');
  assert.equal((await inspectRecovery(root)).lock.state, 'live');
  await assert.rejects(recoverProject(root), { code: 'RECOVERY_LOCK_BLOCKED' });
  await assert.rejects(syncProject(root), { code: 'PROJECT_LOCKED' });
  await killChild(child);

  const interrupted = await inspectRecovery(root);
  assert.equal(interrupted.lock.state, 'stale');
  assert.equal(interrupted.transaction.state, 'pending');
  const recovered = await recoverProject(root);
  assert.equal(recovered.state, 'rolled-back');
  assert.equal(recovered.cleanedLock, true);
  assert.equal(await exists(skillPath(root)), false);
  assert.equal((await inspectRecovery(root)).transaction.state, 'none');
  assert.equal((await inspectRecovery(root)).lock.state, 'none');
  assert.equal((await recoverProject(root)).state, 'none');
});

test('a crash after manifest commit finalizes without removing installed resources', async t => {
  const root = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const child = await crashAt(root, 'sync', 'manifest');
  await killChild(child);
  assert.equal((await inspectRecovery(root)).transaction.state, 'committed');
  const contents = await fs.readFile(skillPath(root), 'utf8');
  assert.match(contents, /name: latchkit-spec/);
  assert.equal((await recoverProject(root)).state, 'finalized');
  assert.equal(await fs.readFile(skillPath(root), 'utf8'), contents);
});

test('interrupted removal restores exact managed bytes', async t => {
  const root = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await syncProject(root);
  const before = await fs.readFile(skillPath(root));
  const child = await crashAt(root, 'remove', 'resource:0');
  await killChild(child);
  assert.equal(await exists(skillPath(root)), false);
  assert.equal((await recoverProject(root)).state, 'rolled-back');
  assert.deepEqual(await fs.readFile(skillPath(root)), before);
});

test('user edits after interruption are preserved and reported as recovery conflicts', async t => {
  const root = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const child = await crashAt(root, 'sync', 'resource:0');
  await killChild(child);
  await fs.writeFile(skillPath(root), '# user replacement\n');
  await assert.rejects(recoverProject(root), error => {
    assert.equal(error.code, 'RECOVERY_CONFLICT');
    assert.equal(error.conflicts[0].path, '.agents/skills/latchkit-spec/SKILL.md');
    return true;
  });
  assert.equal(await fs.readFile(skillPath(root), 'utf8'), '# user replacement\n');
  assert.equal(await exists(path.join(root, '.latchkit', 'transaction.json')), true);
});

test('malformed lock and journal metadata cannot trigger filesystem mutation', async t => {
  const root = await temporaryProject(t);
  await fs.mkdir(path.join(root, '.latchkit'));
  await fs.writeFile(path.join(root, '.latchkit', 'lock'), '{broken');
  const before = await fs.readFile(path.join(root, '.latchkit', 'lock'), 'utf8');
  assert.equal((await inspectRecovery(root)).lock.state, 'invalid');
  await assert.rejects(recoverProject(root), { code: 'RECOVERY_LOCK_BLOCKED' });
  assert.equal(await fs.readFile(path.join(root, '.latchkit', 'lock'), 'utf8'), before);

  await fs.unlink(path.join(root, '.latchkit', 'lock'));
  await fs.writeFile(path.join(root, '.latchkit', 'transaction.json'), JSON.stringify({ schemaVersion: 1, resources: [{ resourceId: 'x', path: '../../outside' }] }));
  assert.equal((await inspectRecovery(root)).transaction.state, 'invalid');
  await assert.rejects(recoverProject(root));
  assert.equal(await exists(path.join(root, '..', 'outside')), false);
});

test('PID reuse cannot make an unrelated process appear to own a stale lock', async t => {
  const root = await temporaryProject(t);
  await fs.mkdir(path.join(root, '.latchkit'));
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const { publicKey } = generateKeyPairSync('ed25519');
  const metadata = {
    schemaVersion: 1,
    lockId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
    port,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  await fs.writeFile(path.join(root, '.latchkit', 'lock'), `${JSON.stringify(metadata)}\n`);
  assert.equal((await inspectRecovery(root)).lock.state, 'stale');
  const recovered = await recoverProject(root);
  assert.equal(recovered.cleanedLock, true);
  assert.equal((await inspectRecovery(root)).lock.state, 'none');
});

test('a junction introduced after interruption is refused during recovery', async t => {
  const root = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const child = await crashAt(root, 'sync', 'resource:0');
  await killChild(child);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
  await fs.mkdir(outside);
  t.after(async () => fs.rm(outside, { recursive: true, force: true }));
  await fs.rm(path.join(root, '.agents'), { recursive: true, force: true });
  try {
    await fs.symlink(outside, path.join(root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Links unavailable (${error.code})`);
    throw error;
  }
  await assert.rejects(recoverProject(root), /symlink or junction/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('registered provider configuration uses the same bounded recovery engine', async t => {
  const root = await temporaryProject(t);
  const relative = '.provider/settings.json';
  const absolute = path.join(root, '.provider', 'settings.json');
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const original = '{\n  "userSetting": true\n}\n';
  await fs.writeFile(absolute, original);
  const registry = createResourceRegistry([{ id: 'provider:test-settings', path: relative }]);
  const next = '{\n  "userSetting": true,\n  "managedImport": "latchkit"\n}\n';
  await assert.rejects(withProjectLock(root, () => applyRegisteredTransaction(root, {
    operation: 'provider-fixture',
    registry,
    changes: [{ resourceId: 'provider:test-settings', bytes: next }],
    manifest: '{"provider-fixture":"after"}\n',
    faultBoundary: async boundary => { if (boundary === 'resource:0') throw new Error('simulated interruption'); },
  })), /simulated interruption/);
  assert.equal(await fs.readFile(absolute, 'utf8'), original);
  assert.equal((await inspectTransaction(root, registry)).state, 'none');

  await withProjectLock(root, () => applyRegisteredTransaction(root, {
    operation: 'provider-fixture', registry,
    changes: [{ resourceId: 'provider:test-settings', bytes: next }],
    manifest: '{"provider-fixture":"after"}\n',
  }));
  assert.equal(await fs.readFile(absolute, 'utf8'), next);
  assert.equal((await inspectTransaction(root, registry)).state, 'none');
});

test('a killed provider configuration update restores unrelated user settings exactly', async t => {
  const root = await temporaryProject(t);
  const registry = createResourceRegistry([{ id: 'provider:test-settings', path: '.provider/settings.json' }]);
  const settings = path.join(root, '.provider', 'settings.json');
  const manifest = path.join(root, '.latchkit', 'manifest.json');
  await fs.mkdir(path.dirname(settings), { recursive: true });
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  const original = '{\n  "userSetting": true\n}\n';
  await fs.writeFile(settings, original);
  await fs.writeFile(manifest, '{"state":"before"}\n');
  const child = fork(resourceCrashHelper, [root, 'resource:0'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  await killChild(child);
  const lock = await inspectProjectLock(root);
  assert.equal(lock.state, 'stale');
  await removeProvenStaleLock(root, lock);
  const result = await withProjectLock(root, () => recoverTransaction(root, registry));
  assert.equal(result.state, 'rolled-back');
  assert.equal(await fs.readFile(settings, 'utf8'), original);
  assert.equal(await fs.readFile(manifest, 'utf8'), '{"state":"before"}\n');
});

test('configuration saves remain intact across installer recovery', async t => {
  const root = await temporaryProject(t);
  const config = await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await saveConfig(root, { ...config, providerSettings: { codex: { approvalPolicy: 'ask' } } });
  const before = await fs.readFile(path.join(root, '.latchkit', 'config.json'));
  const child = await crashAt(root, 'sync', 'resource:0');
  await killChild(child);
  await recoverProject(root);
  assert.deepEqual(await fs.readFile(path.join(root, '.latchkit', 'config.json')), before);
});

test('CLI recovery preview is read-only and apply cleans interrupted metadata', async t => {
  const root = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const child = await crashAt(root, 'sync', 'resource:0');
  await killChild(child);
  const journal = path.join(root, '.latchkit', 'transaction.json');
  const before = await fs.readFile(journal);
  const preview = JSON.parse((await execFileAsync(process.execPath, [cli, 'recover', '--dry-run', '--project', root])).stdout);
  assert.equal(preview.lock.state, 'stale');
  assert.equal(preview.transaction.state, 'pending');
  assert.deepEqual(await fs.readFile(journal), before);
  const applied = JSON.parse((await execFileAsync(process.execPath, [cli, 'recover', '--project', root])).stdout);
  assert.equal(applied.state, 'rolled-back');
  assert.equal(await exists(journal), false);
});
