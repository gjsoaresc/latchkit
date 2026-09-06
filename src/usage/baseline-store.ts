import { randomUUID } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import {
  parseSavingsBaselineState,
  SAVINGS_BASELINE_SCHEMA_VERSION,
  SAVINGS_BASELINES_PATH,
  validateSavingsBaselineState,
} from './baseline-contracts.js';
import type { SavingsBaselineState } from './baseline-contracts.js';

const now = (clock: () => Date) => clock().toISOString();
export { SAVINGS_BASELINES_PATH };
export function emptySavingsBaselineState(clock = () => new Date()): SavingsBaselineState {
  const createdAt = now(clock);
  return {
    schemaVersion: SAVINGS_BASELINE_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}` },
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    baselines: [],
  };
}
export async function readSavingsBaselineState(
  root: string,
  { clock }: { clock?: () => Date } = {},
) {
  const raw = await readOptional(root, SAVINGS_BASELINES_PATH);
  return raw === null ? emptySavingsBaselineState(clock) : parseSavingsBaselineState(raw);
}
export async function writeSavingsBaselineState(root: string, state: SavingsBaselineState) {
  validateSavingsBaselineState(state);
  await writeAtomic(root, SAVINGS_BASELINES_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
