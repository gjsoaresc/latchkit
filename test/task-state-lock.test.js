import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  acquireTaskStateLock,
  inspectTaskStateLock,
  withTaskStateLock,
} from '../dist/src/task-state/lock.js';

test('same-process contenders retry when the prior owner releases between inspection and compare', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-task-lock-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let active = 0;
  let peak = 0;
  const completed = [];
  const contenderCount = 8;
  await Promise.all(
    Array.from({ length: contenderCount }, (_, index) =>
      withTaskStateLock(root, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        completed.push(index);
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 1);
  assert.equal(completed.length, contenderCount);
});

test('an unproven response from a connected task lock remains ambiguous', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-task-lock-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await mkdir(path.join(root, '.latchkit', 'tasks'), { recursive: true });
  const endpointSockets = new Set();
  const endpoint = net.createServer((socket) => {
    endpointSockets.add(socket);
    socket.once('close', () => endpointSockets.delete(socket));
    socket.end('{"lockId":"wrong"}\n');
  });
  await new Promise((resolve, reject) => {
    endpoint.once('error', reject);
    endpoint.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        endpoint.close(resolve);
        for (const socket of endpointSockets) socket.destroy();
      }),
  );
  const { publicKey } = generateKeyPairSync('ed25519');
  const metadata = {
    schemaVersion: 1,
    lockId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
    port: endpoint.address().port,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  await writeFile(path.join(root, '.latchkit', 'tasks', 'lock'), `${JSON.stringify(metadata)}\n`);
  assert.equal((await inspectTaskStateLock(root)).state, 'unknown');
});

test('task-state lock server closes after setup errors and accepted idle clients', async (t) => {
  const malformedRoot = await mkdtemp(path.join(os.tmpdir(), 'latchkit-task-lock-'));
  t.after(() => rm(malformedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await writeFile(path.join(malformedRoot, '.latchkit'), 'not a directory');
  await assert.rejects(acquireTaskStateLock(malformedRoot), /Expected directory/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-task-lock-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const lock = await acquireTaskStateLock(root);
  const idle = net.createConnection({ host: '127.0.0.1', port: lock.metadata.port });
  await new Promise((resolve, reject) => {
    idle.once('connect', resolve);
    idle.once('error', reject);
  });
  const idleClosed = new Promise((resolve) => idle.once('close', resolve));
  await lock.release();
  await idleClosed;
  assert.equal(idle.destroyed, true);
});
