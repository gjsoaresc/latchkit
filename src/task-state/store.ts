import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { parseTaskState, TASK_STATE_SCHEMA_VERSION, validateTaskState } from './contracts.js';
import type { TaskState } from './contracts.js';
import { readOptional, removeFile, safePath, statIfExists, writeAtomic } from '../storage.js';

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

export async function writeTaskState(
  root: string,
  state: TaskState,
  options: StateWriteOptions = {},
) {
  validateTaskState(state);
  await writeAtomic(root, TASK_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600, options);
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
