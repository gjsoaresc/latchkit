import { randomUUID } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import {
  parseUsageState,
  USAGE_PATH,
  USAGE_SCHEMA_VERSION,
  validateUsageState,
} from './contracts.js';
import type { UsageState } from './contracts.js';

const now = (clock: () => Date) => clock().toISOString();
export { USAGE_PATH };
export function emptyUsageState(clock = () => new Date()): UsageState {
  const createdAt = now(clock);
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}` },
    revision: 0,
    settings: { enabled: false, retentionDays: 30 },
    createdAt,
    updatedAt: createdAt,
    records: [],
  };
}
export async function readUsageState(root: string, { clock }: { clock?: () => Date } = {}) {
  const raw = await readOptional(root, USAGE_PATH);
  return raw === null ? emptyUsageState(clock) : parseUsageState(raw);
}
export async function writeUsageState(root: string, state: UsageState) {
  validateUsageState(state);
  await writeAtomic(root, USAGE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
