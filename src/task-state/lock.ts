import net from 'node:net';
import type { AddressInfo } from 'node:net';
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
import type { KeyObject } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { readOptional, removeFile, safePath } from '../storage.js';

export const TASK_STATE_LOCK_PATH = '.latchkit/tasks/lock';
const WAIT_TIMEOUT_MS = 5_000;
const WINDOWS_READ_RETRY_MS = 250;
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

type TaskLockInspection =
  | { state: 'none' }
  | { state: 'invalid'; raw: string; reason: string }
  | { state: 'live' | 'stale'; raw: string; metadata: LockMetadata }
  | { state: 'unknown'; raw: string; metadata: LockMetadata; reason?: string };

type ValidatedTaskLock =
  | { state: 'invalid'; raw: string; reason: string }
  | { state: 'unknown'; raw: string; metadata: LockMetadata; key: KeyObject };

class TaskStateLockError extends Error {
  code: 'TASK_STATE_BUSY' | 'TASK_STATE_LOCK_AMBIGUOUS' | 'TASK_STATE_LOCK_INVALID';
  lockState: TaskLockInspection['state'];

  constructor(
    message: string,
    code: 'TASK_STATE_BUSY' | 'TASK_STATE_LOCK_AMBIGUOUS' | 'TASK_STATE_LOCK_INVALID',
    lockState: TaskLockInspection['state'],
  ) {
    super(message);
    this.code = code;
    this.lockState = lockState;
  }
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function readLockOptional(root: string, retryUntil = 0): Promise<string | null> {
  while (true) {
    try {
      return await readOptional(root, TASK_STATE_LOCK_PATH);
    } catch (error) {
      // Windows can transiently reject an open while another contender unlinks or
      // publishes the hard-linked lock. Persistent permission errors still escape.
      if (process.platform !== 'win32' || errorCode(error) !== 'EPERM' || Date.now() >= retryUntil)
        throw error;
      await delay(10);
    }
  }
}

function validate(value: unknown, raw: string): ValidatedTaskLock {
  const metadata = value as Partial<LockMetadata> | null;
  const fields = ['schemaVersion', 'lockId', 'pid', 'startedAt', 'hostname', 'port', 'publicKey'];
  let key;
  try {
    key = createPublicKey({
      key: Buffer.from(metadata?.publicKey ?? '', 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    /* Invalid metadata is intentionally left for manual inspection. */
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
    key;
  return valid
    ? { state: 'unknown', raw, metadata: metadata as LockMetadata, key: key as KeyObject }
    : {
        state: 'invalid',
        raw,
        reason: 'Task-state lock metadata is malformed; inspect it before manual removal.',
      };
}

async function challenge(
  metadata: LockMetadata,
  publicKey: KeyObject,
): Promise<'live' | 'stale' | 'unknown'> {
  const nonce = randomBytes(32).toString('hex');
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: metadata.port });
    let settled = false;
    let connected = false;
    const chunks: Buffer[] = [];
    const finish = (result: 'live' | 'stale' | 'unknown') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750);
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ lockId: metadata.lockId, nonce })}\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length > 4096) return finish('unknown');
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

export async function inspectTaskStateLock(
  root: string,
  retryUntil = Date.now() + (process.platform === 'win32' ? WINDOWS_READ_RETRY_MS : 0),
): Promise<TaskLockInspection> {
  const raw = await readLockOptional(root, retryUntil);
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
  const first = await challenge(value, inspected.key);
  if (first === 'live') return { state: 'live', raw, metadata: inspected.metadata };
  await delay(25);
  const second = await challenge(value, inspected.key);
  if (second === 'live') return { state: 'live', raw, metadata: inspected.metadata };
  return {
    state: first === 'stale' && second === 'stale' ? 'stale' : 'unknown',
    raw,
    metadata: inspected.metadata,
    ...(first === 'stale' && second === 'stale'
      ? {}
      : {
          reason:
            'Task-state lock ownership could not be proven; the endpoint did not consistently refuse connection.',
        }),
  };
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  await closed;
}

const serverSockets = new WeakMap<net.Server, Set<net.Socket>>();

async function challengeServer(lockId: string, privateKey: KeyObject): Promise<net.Server> {
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

export async function acquireTaskStateLock(root: string) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    const lockId = randomUUID();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const server = await challengeServer(lockId, privateKey);
    const metadata: LockMetadata = {
      schemaVersion: 1,
      lockId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      port: (server.address() as AddressInfo).port,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    };
    const raw = `${JSON.stringify(metadata, null, 2)}\n`;
    let temporary: string | undefined;
    let handle: FileHandle | undefined;
    try {
      const target = await safePath(root, TASK_STATE_LOCK_PATH);
      temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(target), { recursive: true });
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
            if ((await readLockOptional(root, Date.now() + WINDOWS_READ_RETRY_MS)) === raw)
              await removeFile(root, TASK_STATE_LOCK_PATH);
          } finally {
            await closeServer(server);
          }
        },
      };
    } catch (error) {
      let cleanupError;
      try {
        await handle?.close();
        if (temporary) await unlink(temporary);
      } catch (caught) {
        if (errorCode(caught) !== 'ENOENT') cleanupError = caught;
      }
      try {
        await closeServer(server);
      } catch (caught) {
        cleanupError ??= caught;
      }
      if (cleanupError) throw cleanupError;
      if (errorCode(error) !== 'EEXIST') throw error;
      let existing = await inspectTaskStateLock(root, deadline);
      // Windows can briefly expose a just-published hard link with stale metadata
      // to a concurrent reader. Only retry inspection when those bytes change;
      // a stable malformed lock remains protected and is never reclaimed.
      if (existing.state === 'invalid') {
        const firstRaw = existing.raw;
        await delay(25);
        const refreshed = await inspectTaskStateLock(root, deadline);
        if (refreshed.state !== 'invalid' || refreshed.raw !== firstRaw) existing = refreshed;
      }
      if (existing.state === 'stale') {
        const current = await readLockOptional(root, deadline);
        // The prior owner may remove the lock between our stale classification
        // and this compare. That is successful release, so retry acquisition.
        if (current === null) continue;
        if (current === existing.raw) {
          await removeFile(root, TASK_STATE_LOCK_PATH);
          continue;
        }
        // A different owner published a new lock. Never remove it; retry the
        // exclusive create and challenge that owner while the wait budget lasts.
        if (Date.now() < deadline) {
          await delay(20);
          continue;
        }
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
      if (existing.state === 'unknown') {
        const current = await readLockOptional(root, deadline);
        // An endpoint can disappear while its owner is closing. A timeout or
        // malformed connected response is never proof of staleness, but changed
        // or removed metadata means this inspection no longer describes the
        // current lock and acquisition must start over.
        if (current === null || current !== existing.raw) continue;
        if (Date.now() < deadline) {
          await delay(20);
          continue;
        }
      }
      const code =
        existing.state === 'live'
          ? 'TASK_STATE_BUSY'
          : existing.state === 'unknown'
            ? 'TASK_STATE_LOCK_AMBIGUOUS'
            : 'TASK_STATE_LOCK_INVALID';
      throw new TaskStateLockError(
        existing.state === 'live'
          ? 'Another task-state writer is still active.'
          : ((existing.state === 'invalid' || existing.state === 'unknown'
              ? existing.reason
              : undefined) ?? 'Task-state lock could not be safely reclaimed.'),
        code,
        existing.state,
      );
    }
  }
}

export async function withTaskStateLock<T>(
  root: string,
  operation: (metadata: LockMetadata) => Promise<T> | T,
): Promise<T> {
  const lock = await acquireTaskStateLock(root);
  try {
    return await operation(lock.metadata);
  } finally {
    await lock.release();
  }
}
