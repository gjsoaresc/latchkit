import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  createPublicKey,
} from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { readOptional, removeFile, safePath } from '../storage.js';

export const LOCK_PATH = '.latchkit/lock';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateMetadata(value, raw) {
  const fields = ['schemaVersion', 'lockId', 'pid', 'startedAt', 'hostname', 'port', 'publicKey'];
  let publicKeyValid = false;
  try {
    createPublicKey({
      key: Buffer.from(value?.publicKey ?? '', 'base64'),
      format: 'der',
      type: 'spki',
    });
    publicKeyValid = true;
  } catch {
    /* Invalid keys are ambiguous locks and are never reclaimed automatically. */
  }
  const valid =
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field)) &&
    value.schemaVersion === 1 &&
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
    publicKeyValid;
  if (!valid)
    return {
      state: 'invalid',
      raw,
      reason: 'Lock metadata is malformed; inspect it before manual removal.',
    };
  return { state: 'unknown', raw, metadata: value };
}

async function challenge(metadata) {
  const nonce = randomBytes(32).toString('hex');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    const socket = net.createConnection({ host: '127.0.0.1', port: metadata.port });
    const chunks = [];
    socket.setTimeout(750);
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ lockId: metadata.lockId, nonce })}\n`),
    );
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 4096) return finish(false);
      if (!Buffer.concat(chunks).includes(10)) return;
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        const publicKey = createPublicKey({
          key: Buffer.from(metadata.publicKey, 'base64'),
          format: 'der',
          type: 'spki',
        });
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

export async function inspectProjectLock(root) {
  const raw = await readOptional(root, LOCK_PATH);
  if (raw === null) return { state: 'none' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: 'invalid',
      raw,
      reason: 'Lock metadata is not valid JSON; inspect it before manual removal.',
    };
  }
  const inspected = validateMetadata(parsed, raw);
  if (inspected.state === 'invalid') return inspected;
  return { ...inspected, state: (await challenge(parsed)) ? 'live' : 'stale' };
}

async function startChallengeServer(lockId, privateKey) {
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

export async function acquireProjectLock(root) {
  const lockId = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const server = await startChallengeServer(lockId, privateKey);
  const metadata = {
    schemaVersion: 1,
    lockId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
    port: server.address().port,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  const target = await safePath(root, LOCK_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    await handle?.close();
    server.close();
    if (error.code === 'EEXIST') {
      const existing = await inspectProjectLock(root);
      const locked = new Error(
        existing.state === 'live'
          ? 'Another live Latchkit operation holds .latchkit/lock.'
          : 'A stale or invalid Latchkit lock requires latchkit recover before mutation.',
      );
      locked.code = 'PROJECT_LOCKED';
      locked.lockState = existing.state;
      throw locked;
    }
    throw error;
  } finally {
    await handle?.close();
  }
  const raw = `${JSON.stringify(metadata, null, 2)}\n`;
  return {
    metadata,
    async release() {
      try {
        if ((await readOptional(root, LOCK_PATH)) === raw) await removeFile(root, LOCK_PATH);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

export async function withProjectLock(root, operation) {
  const lock = await acquireProjectLock(root);
  try {
    return await operation(lock.metadata);
  } finally {
    await lock.release();
  }
}

export async function removeProvenStaleLock(root, inspection) {
  if (inspection.state !== 'stale')
    throw new Error('Only a proven stale lock can be removed automatically.');
  if ((await readOptional(root, LOCK_PATH)) !== inspection.raw)
    throw new Error('Project lock changed during recovery; retry inspection.');
  await removeFile(root, LOCK_PATH);
}
