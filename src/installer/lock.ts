import net from 'node:net';
import type { AddressInfo } from 'node:net';
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
import type { KeyObject } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readOptional, removeFile, safePath } from '../storage.js';

export const LOCK_PATH = '.latchkit/lock';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LockMetadata = {
  schemaVersion: 1;
  lockId: string;
  pid: number;
  startedAt: string;
  hostname: string;
  port: number;
  publicKey: string;
};

export type ProjectLockInspection =
  | { state: 'none' }
  | { state: 'invalid'; raw: string; reason: string }
  | { state: 'live' | 'stale'; raw: string; metadata: LockMetadata }
  | { state: 'unknown'; raw: string; metadata: LockMetadata; reason?: string };

type ValidatedLock =
  | { state: 'invalid'; raw: string; reason: string }
  | { state: 'unknown'; raw: string; metadata: LockMetadata };

class ProjectLockedError extends Error {
  code = 'PROJECT_LOCKED';
  lockState: ProjectLockInspection['state'];

  constructor(message: string, lockState: ProjectLockInspection['state']) {
    super(message);
    this.lockState = lockState;
  }
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function validateMetadata(value: unknown, raw: string): ValidatedLock {
  const metadata = value as Partial<LockMetadata> | null;
  const fields = ['schemaVersion', 'lockId', 'pid', 'startedAt', 'hostname', 'port', 'publicKey'];
  let publicKeyValid = false;
  try {
    createPublicKey({
      key: Buffer.from(metadata?.publicKey ?? '', 'base64'),
      format: 'der',
      type: 'spki',
    });
    publicKeyValid = true;
  } catch {
    /* Invalid keys are ambiguous locks and are never reclaimed automatically. */
  }
  const valid =
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.keys(metadata).length === fields.length &&
    fields.every((field) => Object.hasOwn(metadata, field)) &&
    metadata.schemaVersion === 1 &&
    typeof metadata.lockId === 'string' &&
    UUID_PATTERN.test(metadata.lockId) &&
    Number.isInteger(metadata.pid) &&
    (metadata.pid ?? 0) > 0 &&
    typeof metadata.startedAt === 'string' &&
    Number.isFinite(Date.parse(metadata.startedAt)) &&
    typeof metadata.hostname === 'string' &&
    metadata.hostname.length > 0 &&
    Number.isInteger(metadata.port) &&
    (metadata.port ?? 0) > 0 &&
    (metadata.port ?? 0) <= 65535 &&
    typeof metadata.publicKey === 'string' &&
    publicKeyValid;
  if (!valid)
    return {
      state: 'invalid',
      raw,
      reason: 'Lock metadata is malformed; inspect it before manual removal.',
    };
  return { state: 'unknown', raw, metadata: metadata as LockMetadata };
}

async function challenge(metadata: LockMetadata): Promise<'live' | 'stale' | 'unknown'> {
  const nonce = randomBytes(32).toString('hex');
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const finish = (result: 'live' | 'stale' | 'unknown') => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    const socket = net.createConnection({ host: '127.0.0.1', port: metadata.port });
    const chunks: Buffer[] = [];
    socket.setTimeout(750);
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ lockId: metadata.lockId, nonce })}\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 4096) return finish('unknown');
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
            )
            ? 'live'
            : 'unknown',
        );
      } catch {
        finish('unknown');
      }
    });
    socket.once('timeout', () => finish('unknown'));
    socket.once('error', (error) =>
      finish(!connected && errorCode(error) === 'ECONNREFUSED' ? 'stale' : 'unknown'),
    );
    socket.once('end', () => finish('unknown'));
  });
}

export async function inspectProjectLock(root: string): Promise<ProjectLockInspection> {
  const raw = (await readOptional(root, LOCK_PATH)) as unknown as string | null;
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
  const state = await challenge(parsed);
  return {
    ...inspected,
    state,
    ...(state === 'unknown'
      ? { reason: 'Lock ownership could not be proven; the endpoint did not refuse connection.' }
      : {}),
  };
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  await closed;
}

const serverSockets = new WeakMap<net.Server, Set<net.Socket>>();

async function startChallengeServer(lockId: string, privateKey: KeyObject): Promise<net.Server> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const chunks: Buffer[] = [];
    socket.setTimeout(750, () => socket.destroy());
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
  serverSockets.set(server, sockets);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

export async function acquireProjectLock(root: string) {
  const lockId = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const server = await startChallengeServer(lockId, privateKey);
  const metadata: LockMetadata = {
    schemaVersion: 1,
    lockId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
    port: (server.address() as AddressInfo).port,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
  let handle: FileHandle | undefined;
  try {
    const target = await safePath(root, LOCK_PATH);
    await mkdir(path.dirname(target), { recursive: true });
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    let cleanupError;
    try {
      await handle?.close();
    } catch (caught) {
      cleanupError = caught;
    }
    try {
      await closeServer(server);
    } catch (caught) {
      cleanupError ??= caught;
    }
    if (cleanupError) throw cleanupError;
    if (errorCode(error) === 'EEXIST') {
      const existing = await inspectProjectLock(root);
      throw new ProjectLockedError(
        existing.state === 'live'
          ? 'Another live Latchkit operation holds .latchkit/lock.'
          : 'A stale or invalid Latchkit lock requires latchkit recover before mutation.',
        existing.state,
      );
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
        if (((await readOptional(root, LOCK_PATH)) as unknown as string | null) === raw)
          await removeFile(root, LOCK_PATH);
      } finally {
        await closeServer(server);
      }
    },
  };
}

export async function withProjectLock<T>(
  root: string,
  operation: (metadata: LockMetadata) => Promise<T> | T,
): Promise<T> {
  const lock = await acquireProjectLock(root);
  try {
    return await operation(lock.metadata);
  } finally {
    await lock.release();
  }
}

export async function removeProvenStaleLock(
  root: string,
  inspection: ProjectLockInspection,
): Promise<void> {
  if (inspection.state !== 'stale')
    throw new Error('Only a proven stale lock can be removed automatically.');
  if (((await readOptional(root, LOCK_PATH)) as unknown as string | null) !== inspection.raw)
    throw new Error('Project lock changed during recovery; retry inspection.');
  await removeFile(root, LOCK_PATH);
}
