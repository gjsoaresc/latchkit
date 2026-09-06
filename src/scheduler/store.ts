import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolveProjectRoot, safePath, writeAtomic } from '../storage.js';
import {
  SCHEDULE_PATH,
  SCHEDULE_SCHEMA_VERSION,
  parseSchedulerState,
  validateSchedulerState,
  MAX_SCHEDULE_BYTES,
  SchedulerError,
} from './contracts.js';
import type { SchedulerState } from './contracts.js';
export { SCHEDULE_PATH };
export function emptySchedulerState(clock = () => new Date()): SchedulerState {
  const at = clock().toISOString();
  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}` },
    revision: 0,
    schedules: [],
    createdAt: at,
    updatedAt: at,
  };
}
export async function readSchedulerState(root: string, { clock }: { clock?: () => Date } = {}) {
  root = await resolveProjectRoot(root);
  const target = await safePath(root, SCHEDULE_PATH);
  let handle;
  try {
    handle = await open(target, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_SCHEDULE_BYTES)
      throw new SchedulerError('Schedule state must be a regular file of at most 4 MiB.');
    // Cancellation polling normally reads a few KiB. Bound allocation to the
    // opened file instead of allocating the full 4 MiB cap on every poll.
    const bytes = Buffer.alloc(metadata.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > metadata.size) throw new SchedulerError('Schedule state changed during read.');
    const state = parseSchedulerState(bytes.subarray(0, size).toString('utf8'));
    if (state.schedules.some((schedule) => schedule.targetProject !== root))
      throw new SchedulerError(
        'Schedule target no longer matches its canonical project.',
        'SCHEDULE_TARGET_CHANGED',
      );
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySchedulerState(clock);
    throw error;
  } finally {
    await handle?.close();
  }
}
export async function writeSchedulerState(root: string, state: SchedulerState) {
  validateSchedulerState(state);
  const raw = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(raw) > MAX_SCHEDULE_BYTES)
    throw new SchedulerError('Schedule state exceeds 4 MiB.');
  await writeAtomic(root, SCHEDULE_PATH, raw, 0o600);
}
