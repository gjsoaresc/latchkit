import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { parseTaskState, TASK_STATE_SCHEMA_VERSION, validateTaskState } from './contracts.js';
import type { TaskState } from './contracts.js';
import { errorCode } from '../types.js';
import { readOptional, removeFile, safePath, statIfExists } from '../storage.js';

export const TASK_STATE_PATH = '.latchkit/tasks/state-v1.json';

export type StateWriteOptions = {
  faultBoundary?: (
    boundary: string,
    detail: { temporary?: string; target: string },
  ) => Promise<void>;
};
const now = (clock: () => Date) => clock().toISOString();

export function emptyTaskState(clock = () => new Date()): TaskState {
  const createdAt = now(clock);
  return {
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}`, createdAt },
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    tasks: [],
  };
}

export async function readTaskState(
  root: string,
  { allowMissing = true, clock }: { allowMissing?: boolean; clock?: () => Date } = {},
): Promise<TaskState> {
  const raw = await readOptional(root, TASK_STATE_PATH);
  if (raw === null) {
    if (allowMissing) return emptyTaskState(clock);
    const error = Object.assign(new Error('Task-state store does not exist.'), {
      code: 'TASK_STATE_NOT_FOUND',
    });
    throw error;
  }
  return parseTaskState(raw);
}

async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'ENOTSUP'].includes(errorCode(error) ?? ''))
      throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeTaskState(
  root: string,
  state: TaskState,
  { faultBoundary = async () => {} }: StateWriteOptions = {},
) {
  validateTaskState(state);
  const target = await safePath(root, TASK_STATE_PATH);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  await safePath(root, TASK_STATE_PATH);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await faultBoundary('prepared', { temporary, target });
    await rename(temporary, target);
    renamed = true;
    await faultBoundary('committed', { target });
    await syncDirectory(directory);
  } finally {
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }
}

export async function cleanupTaskStateTemps(root: string) {
  const relativeDirectory = '.latchkit/tasks';
  const directory = await safePath(root, relativeDirectory, 'directory');
  if ((await statIfExists(directory)) === null) return [];
  const pattern =
    /^state-v1\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
  const removed = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const relative = `${relativeDirectory}/${entry.name}`;
    await removeFile(root, relative);
    removed.push(relative);
  }
  return removed;
}
