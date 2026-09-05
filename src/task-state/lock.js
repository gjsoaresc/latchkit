import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { readOptional, removeFile, safePath } from '../storage.js';

export const TASK_STATE_LOCK_PATH = '.latchkit/tasks/lock';
const WAIT_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function validate(value, raw) {
  const fields = ['schemaVersion', 'lockId', 'pid', 'startedAt', 'hostname', 'port', 'publicKey'];
  let key;
  try {
    key = createPublicKey({
      key: Buffer.from(value?.publicKey ?? '', 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    /* Invalid metadata is intentionally left for manual inspection. */
  }
  const valid =
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field)) &&
    value.schemaVersion === 1 &&
    typeof value.lockId === 'string' &&
    UUID_PATTERN.test(value.lockId) &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === 'string' &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    typeof value.hostname === 'string' &&
    value.hostname.length > 0 &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65535 &&
    typeof value.publicKey === 'string' &&
    key;
  return valid
    ? { state: 'unknown', raw, metadata: value, key }
    : {
        state: 'invalid',
        raw,
        reason: 'Task-state lock metadata is malformed; inspect it before manual removal.',
      };
}

async function challenge(metadata, publicKey) {
  const nonce = randomBytes(32).toString('hex');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: metadata.port });
    let settled = false;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750);
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ lockId: metadata.lockId, nonce })}\n`),
    );
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length > 4096) return finish(false);
      if (!body.includes(10)) return;
      try {
        const response = JSON.parse(body.toString('utf8').trim());
        finish(
          response.lockId === metadata.lockId &&
            verify(
              null,
              Buffer.from(`${metadata.lockId}:${nonce}`),
              publicKey,
              Buffer.from(response.signature, 'base64'),
            ),
        );
      } catch {
        finish(false);
      }
    });
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('end', () => finish(false));
  });
}

export async function inspectTaskStateLock(root) {
  const raw = await readOptional(root, TASK_STATE_LOCK_PATH);
  if (raw === null) return { state: 'none' };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      state: 'invalid',
      raw,
      reason: 'Task-state lock is not valid JSON; inspect it before manual removal.',
    };
  }
  const inspected = validate(value, raw);
  if (inspected.state === 'invalid') return inspected;
  if (await challenge(value, inspected.key)) return { state: 'live', raw, metadata: value };
  await delay(25);
  return {
    state: (await challenge(value, inspected.key)) ? 'live' : 'stale',
    raw,
    metadata: value,
  };
}

async function challengeServer(lockId, privateKey) {
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length > 4096) return socket.destroy();
      if (!body.includes(10)) return;
      try {
        const request = JSON.parse(body.toString('utf8').trim());
        if (request.lockId !== lockId || !/^[a-f0-9]{64}$/.test(request.nonce))
          return socket.destroy();
        const signature = sign(
          null,
          Buffer.from(`${lockId}:${request.nonce}`),
          privateKey,
        ).toString('base64');
        socket.end(`${JSON.stringify({ lockId, signature })}\n`);
      } catch {
        socket.destroy();
      }
    });
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

export async function acquireTaskStateLock(root) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    const lockId = randomUUID();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const server = await challengeServer(lockId, privateKey);
    const metadata = {
      schemaVersion: 1,
      lockId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      port: server.address().port,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    };
    const raw = `${JSON.stringify(metadata, null, 2)}\n`;
    const target = await safePath(root, TASK_STATE_LOCK_PATH);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(raw);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, target);
      await unlink(temporary);
      return {
        metadata,
        async release() {
          try {
            if ((await readOptional(root, TASK_STATE_LOCK_PATH)) === raw)
              await removeFile(root, TASK_STATE_LOCK_PATH);
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
        },
      };
    } catch (error) {
      await handle?.close();
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      }
      await new Promise((resolve) => server.close(resolve));
      if (error.code !== 'EEXIST') throw error;
      const existing = await inspectTaskStateLock(root);
      if (
        existing.state === 'stale' &&
        (await readOptional(root, TASK_STATE_LOCK_PATH)) === existing.raw
      ) {
        await removeFile(root, TASK_STATE_LOCK_PATH);
        continue;
      }
      // A competing writer can release its lock after our exclusive-create attempt
      // reports EEXIST but before inspection reads the file. There is no lock to
      // validate in that case, so retry acquisition instead of reporting invalid
      // metadata.
      if (existing.state === 'none') continue;
      if (existing.state === 'live' && Date.now() < deadline) {
        await delay(20);
        continue;
      }
      const locked = new Error(
        existing.state === 'live'
          ? 'Another task-state writer is still active.'
          : (existing.reason ?? 'Task-state lock could not be safely reclaimed.'),
      );
      locked.code = existing.state === 'live' ? 'TASK_STATE_BUSY' : 'TASK_STATE_LOCK_INVALID';
      locked.lockState = existing.state;
      throw locked;
    }
  }
}

export async function withTaskStateLock(root, operation) {
  const lock = await acquireTaskStateLock(root);
  try {
    return await operation(lock.metadata);
  } finally {
    await lock.release();
  }
}
