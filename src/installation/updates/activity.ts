/**
 * Cross-process activity heartbeat registry (issue #139 slice 2, acceptance
 * criterion 3).
 *
 * Installation-wide quiescence must see "an unsaved console edit" and "an
 * admitted mutating request" from *other* server processes serving other
 * projects under the same installation, not only from the server handling
 * the activation request itself. Persisted task/workflow/review state alone
 * cannot carry that signal — it is ephemeral browser/session state that only
 * exists in a live process's memory. Each `startServer` instance writes one
 * heartbeat file under `<installRoot>/activity/<serverId>.json`, refreshes
 * it while alive, and removes it on a clean shutdown; a reader discards any
 * entry that is stale (by `updatedAt`) or whose `pid` is no longer alive so
 * a crashed process can never wedge the installation-wide check.
 */
import { readdir, unlink } from 'node:fs/promises';
import { readOptional, safePath, writeAtomic } from '../../storage.js';
import { errorCode } from '../../types.js';
import { requireFields, UpdateContractError } from './contracts.js';
import type { ActivityHeartbeat } from './contracts.js';

const ACTIVITY_DIR = 'activity';
/** Bounds how long a heartbeat is trusted without a fresh write. Servers
 * refresh well inside this window (see `startHeartbeat` below); a value
 * older than this is either a crashed process or one that will be caught by
 * the `pid` liveness check anyway. */
export const HEARTBEAT_STALE_MS = 20_000;
export const HEARTBEAT_REFRESH_MS = 5_000;

function validateHeartbeat(value: unknown): ActivityHeartbeat {
  requireFields(
    value,
    ['schemaVersion', 'serverId', 'root', 'pid', 'startedAt', 'updatedAt', 'dirty', 'mutating'],
    'activity heartbeat',
  );
  if (value.schemaVersion !== 1)
    throw new UpdateContractError(
      `Unsupported activity heartbeat schema version ${String(value.schemaVersion)}.`,
    );
  if (typeof value.serverId !== 'string' || !value.serverId)
    throw new UpdateContractError('serverId must be a non-empty string.');
  if (typeof value.root !== 'string' || !value.root)
    throw new UpdateContractError('root must be a non-empty string.');
  if (!Number.isInteger(value.pid) || (value.pid as number) < 0)
    throw new UpdateContractError('pid must be a non-negative integer.');
  if (typeof value.dirty !== 'boolean') throw new UpdateContractError('dirty must be a boolean.');
  if (!Number.isInteger(value.mutating) || (value.mutating as number) < 0)
    throw new UpdateContractError('mutating must be a non-negative integer.');
  return {
    schemaVersion: 1,
    serverId: value.serverId,
    root: value.root,
    pid: value.pid as number,
    startedAt: String(value.startedAt),
    updatedAt: String(value.updatedAt),
    dirty: value.dirty,
    mutating: value.mutating as number,
  };
}

function heartbeatPath(serverId: string): string {
  return `${ACTIVITY_DIR}/${serverId}.json`;
}

export async function writeHeartbeat(
  installRoot: string,
  heartbeat: ActivityHeartbeat,
): Promise<void> {
  validateHeartbeat(heartbeat);
  await writeAtomic(
    installRoot,
    heartbeatPath(heartbeat.serverId),
    `${JSON.stringify(heartbeat, null, 2)}\n`,
    0o600,
  );
}

export async function removeHeartbeat(installRoot: string, serverId: string): Promise<void> {
  try {
    const target = await safePath(installRoot, heartbeatPath(serverId));
    await unlink(target);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function pidIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // `process.kill(pid, 0)` sends no signal; it only probes existence and
    // permission. Node implements this on Windows too (via OpenProcess),
    // not just POSIX. Any thrown error (ESRCH, EPERM, or otherwise) is
    // treated conservatively as "cannot confirm alive" only for ESRCH; an
    // EPERM (a process we cannot signal but that clearly exists) still
    // counts as alive.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live (non-stale, alive-`pid`) heartbeats, oldest filtering applied. A
 * corrupt or unreadable individual heartbeat file is skipped rather than
 * failing the whole scan — one bad file must never block every console
 * sharing this installation from ever being able to update. */
export async function listLiveHeartbeats(
  installRoot: string,
  { now = new Date(), staleMs = HEARTBEAT_STALE_MS }: { now?: Date; staleMs?: number } = {},
): Promise<ActivityHeartbeat[]> {
  let directory: string;
  try {
    directory = await safePath(installRoot, ACTIVITY_DIR, 'directory');
  } catch {
    return [];
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const live: ActivityHeartbeat[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const serverId = entry.name.slice(0, -'.json'.length);
    const raw = await readOptional(installRoot, heartbeatPath(serverId)).catch(() => null);
    if (raw === null) continue;
    let heartbeat: ActivityHeartbeat;
    try {
      heartbeat = validateHeartbeat(JSON.parse(raw));
    } catch {
      continue;
    }
    if (now.getTime() - Date.parse(heartbeat.updatedAt) > staleMs) continue;
    if (!pidIsAlive(heartbeat.pid)) continue;
    live.push(heartbeat);
  }
  return live;
}

export interface HeartbeatHandle {
  setDirty(dirty: boolean): void;
  setMutating(count: number): void;
  /** This server's own current dirty state, for the quiescence check this
   * same process performs when it is the one initiating activation (see
   * `routes.ts`'s activate/rollback handlers). */
  isDirty(): boolean;
  stop(): Promise<void>;
}

/**
 * Start (and periodically refresh) this server process's own heartbeat.
 * Callers own the returned handle's lifecycle: update `dirty`/`mutating` as
 * local state changes, and call `stop()` during shutdown to remove the file
 * promptly rather than waiting for `HEARTBEAT_STALE_MS` to elapse.
 */
export function startHeartbeat(
  installRoot: string,
  {
    serverId,
    root,
    clock = () => new Date(),
  }: { serverId: string; root: string; clock?: () => Date },
): HeartbeatHandle {
  const startedAt = clock().toISOString();
  let dirty = false;
  let mutating = 0;
  let stopped = false;
  const flush = () => {
    if (stopped) return;
    void writeHeartbeat(installRoot, {
      schemaVersion: 1,
      serverId,
      root,
      pid: process.pid,
      startedAt,
      updatedAt: clock().toISOString(),
      dirty,
      mutating,
    }).catch(() => {
      /* Best-effort only: a failed heartbeat write never blocks the console
       * this server actually serves. */
    });
  };
  flush();
  const timer = setInterval(flush, HEARTBEAT_REFRESH_MS);
  timer.unref?.();
  return {
    setDirty(next: boolean) {
      if (next === dirty) return;
      dirty = next;
      flush();
    },
    setMutating(count: number) {
      mutating = count;
      flush();
    },
    isDirty() {
      return dirty;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await removeHeartbeat(installRoot, serverId).catch(() => {});
    },
  };
}
