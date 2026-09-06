import { readOptional, writeAtomic } from '../storage.js';
import { withTaskStateLock } from '../task-state/lock.js';
import {
  SPEC_DECISION_SCHEMA_VERSION,
  SPEC_DECISION_STATE_PATH,
  SpecDecisionError,
  assertSpecDecisionRecord,
  type SpecDecisionRecord,
} from './spec-decision-contracts.js';

export { SPEC_DECISION_STATE_PATH } from './spec-decision-contracts.js';

type SpecDecisionState = { schemaVersion: 1; decisions: SpecDecisionRecord[] };

async function readUnlocked(root: string): Promise<SpecDecisionState> {
  const raw = (await readOptional(root, SPEC_DECISION_STATE_PATH)) as unknown as string | null;
  if (raw === null) return { schemaVersion: SPEC_DECISION_SCHEMA_VERSION, decisions: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SpecDecisionError(
      'Spec decision state is invalid JSON.',
      'SPEC_DECISION_STATE_INVALID',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SpecDecisionError(
      'Spec decision state has an unsupported shape.',
      'SPEC_DECISION_STATE_INVALID',
    );
  const state = value as Partial<SpecDecisionState>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.decisions))
    throw new SpecDecisionError(
      'Spec decision state has an unsupported shape.',
      'SPEC_DECISION_STATE_INVALID',
    );
  for (const decision of state.decisions) assertSpecDecisionRecord(decision);
  if (
    new Set(state.decisions.map((item) => item.decisionId)).size !== state.decisions.length ||
    new Set(state.decisions.map((item) => item.taskId)).size !== state.decisions.length
  )
    throw new SpecDecisionError(
      'Spec decision IDs and task IDs must be unique.',
      'SPEC_DECISION_STATE_INVALID',
    );
  return state as SpecDecisionState;
}

async function writeUnlocked(root: string, state: SpecDecisionState): Promise<void> {
  await writeAtomic(root, SPEC_DECISION_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function readSpecDecision(
  root: string,
  taskId: string,
): Promise<SpecDecisionRecord | null> {
  return withTaskStateLock(root, async () => {
    const state = await readUnlocked(root);
    return structuredClone(state.decisions.find((item) => item.taskId === taskId) ?? null);
  });
}

export async function listSpecDecisions(root: string): Promise<SpecDecisionRecord[]> {
  return withTaskStateLock(root, async () => structuredClone((await readUnlocked(root)).decisions));
}

export type SpecDecisionMutationResult = {
  /** The record to hand back to the caller. */
  record: SpecDecisionRecord;
  /**
   * Whether `record` differs from what is already persisted. `false` is used
   * for idempotent replays (a repeated completion/decision event with an
   * already-seen mutation ID) so the store never bumps the revision or
   * rewrites the file for a request that was already committed.
   */
  persist: boolean;
};

/**
 * Create-or-mutate helper shared by every spec-decision service operation.
 * `operation` receives the existing record for `taskId` (or `null` when this
 * is the first decision for that task) inside the same lock acquisition used
 * to persist the result, so a concurrent idempotency check-and-write stays
 * atomic.
 */
export async function upsertSpecDecision(
  root: string,
  taskId: string,
  operation: (existing: SpecDecisionRecord | null) => SpecDecisionMutationResult,
): Promise<SpecDecisionRecord> {
  return withTaskStateLock(root, async () => {
    const state = await readUnlocked(root);
    const existing = state.decisions.find((item) => item.taskId === taskId) ?? null;
    const { record: next, persist } = operation(existing ? structuredClone(existing) : null);
    assertSpecDecisionRecord(next);
    if (!persist) return structuredClone(next);
    if (existing) {
      const index = state.decisions.findIndex((item) => item.taskId === taskId);
      state.decisions[index] = next;
    } else {
      state.decisions.push(next);
    }
    await writeUnlocked(root, state);
    return structuredClone(next);
  });
}
