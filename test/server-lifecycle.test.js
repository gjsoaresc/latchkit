import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { initProject } from '../dist/src/core.js';
import { startServer } from '../dist/src/server.js';
import { acquireTaskStateLock } from '../dist/src/task-state/lock.js';
import { createWorkflowController } from '../dist/src/workflows/service.js';

test('shutting down an unused workflow controller does not create project state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-idle-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = createWorkflowController({ root });
  await controller.shutdown();
  assert.deepEqual(await readdir(root), []);
  await controller.shutdown();
  assert.deepEqual(await readdir(root), []);
});

test('server close callback waits for a disconnected request to finish its state access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-request-shutdown-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const lock = await acquireTaskStateLock(root);
  const { server, url, token } = await startServer(root);
  let callbackCalled = false;
  let closed;
  try {
    const received = once(server, 'request');
    const request = http.get(`${new URL(url).origin}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    request.on('error', () => {});
    await received;
    const transportClosed = once(server, 'close');
    closed = new Promise((resolve, reject) => {
      server.close((error) => {
        callbackCalled = true;
        if (error) reject(error);
        else resolve();
      });
    });
    server.closeAllConnections();
    await transportClosed;
    assert.equal(callbackCalled, false, 'state access must drain after transport closure');
  } finally {
    await lock.release();
    await closed;
    // No cleanup retries: a successful close callback must be a safe deletion boundary.
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(callbackCalled, true);
});

test('draining close preserves the server return value, callback receiver, and already-closed error', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-close-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { server } = await startServer(root);
  await new Promise((resolve, reject) => {
    const returned = server.close(function (error) {
      assert.equal(this, server);
      if (error) reject(error);
      else resolve();
    });
    assert.equal(returned, server);
  });
  await new Promise((resolve) => {
    assert.equal(
      server.close((error) => {
        assert.equal(error.code, 'ERR_SERVER_NOT_RUNNING');
        resolve();
      }),
      server,
    );
  });
});
