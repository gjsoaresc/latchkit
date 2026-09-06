import { randomUUID } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import {
  SCHEDULE_PATH,
  SCHEDULE_SCHEMA_VERSION,
  parseSchedulerState,
  validateSchedulerState,
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
  const raw = await readOptional(root, SCHEDULE_PATH);
  return raw === null ? emptySchedulerState(clock) : parseSchedulerState(raw);
}
export async function writeSchedulerState(root: string, state: SchedulerState) {
  validateSchedulerState(state);
  await writeAtomic(root, SCHEDULE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
