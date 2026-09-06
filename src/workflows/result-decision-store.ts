import { readOptional, writeAtomic } from '../storage.js';
import { withTaskStateLock } from '../task-state/lock.js';
import {
  RESULT_DECISION_SCHEMA_VERSION,
  RESULT_DECISION_STATE_PATH,
  ResultDecisionError,
  assertResultDecisionRecord,
  type ResultDecisionRecord,
} from './result-decision-contracts.js';

export { RESULT_DECISION_STATE_PATH } from './result-decision-contracts.js';

type ResultDecisionState = { schemaVersion: 1; decisions: ResultDecisionRecord[] };

async function readUnlocked(root: string): Promise<ResultDecisionState> {
  const raw = (await readOptional(root, RESULT_DECISION_STATE_PATH)) as unknown as string | null;
  if (raw === null) return { schemaVersion: RESULT_DECISION_SCHEMA_VERSION, decisions: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResultDecisionError(
      'Result decision state is invalid JSON.',
      'RESULT_DECISION_STATE_INVALID',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ResultDecisionError(
      'Result decision state has an unsupported shape.',
      'RESULT_DECISION_STATE_INVALID',
    );
  const state = value as Partial<ResultDecisionState>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.decisions))
    throw new ResultDecisionError(
      'Result decision state has an unsupported shape.',
      'RESULT_DECISION_STATE_INVALID',
    );
  for (const decision of state.decisions) assertResultDecisionRecord(decision);
  if (
    new Set(state.decisions.map((item) => item.decisionId)).size !== state.decisions.length ||
    new Set(state.decisions.map((item) => item.taskId)).size !== state.decisions.length
  )
    throw new ResultDecisionError(
      'Result decision IDs and task IDs must be unique.',
      'RESULT_DECISION_STATE_INVALID',
    );
  return state as ResultDecisionState;
}

async function writeUnlocked(root: string, state: ResultDecisionState): Promise<void> {
  await writeAtomic(root, RESULT_DECISION_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function readResultDecision(
  root: string,
  taskId: string,
): Promise<ResultDecisionRecord | null> {
  return withTaskStateLock(root, async () => {
    const state = await readUnlocked(root);
    return structuredClone(state.decisions.find((item) => item.taskId === taskId) ?? null);
  });
}

export async function listResultDecisions(root: string): Promise<ResultDecisionRecord[]> {
  return withTaskStateLock(root, async () => structuredClone((await readUnlocked(root)).decisions));
}

export type ResultDecisionMutationResult = {
  /** The record to hand back to the caller. */
  record: ResultDecisionRecord;
  /**
   * Whether `record` differs from what is already persisted. `false` is used
   * for idempotent replays (a repeated completion/decision event with an
   * already-seen mutation ID) so the store never bumps the revision or
   * rewrites the file for a request that was already committed.
   */
  persist: boolean;
};

/**
 * Create-or-mutate helper shared by every result-decision service operation.
 * `operation` receives the existing record for `taskId` (or `null` when this
 * is the first decision for that task) inside the same lock acquisition used
 * to persist the result, so a concurrent idempotency check-and-write stays
 * atomic.
 */
export async function upsertResultDecision(
  root: string,
  taskId: string,
  operation: (existing: ResultDecisionRecord | null) => ResultDecisionMutationResult,
): Promise<ResultDecisionRecord> {
  return withTaskStateLock(root, async () => {
    const state = await readUnlocked(root);
    const existing = state.decisions.find((item) => item.taskId === taskId) ?? null;
    const { record: next, persist } = operation(existing ? structuredClone(existing) : null);
    assertResultDecisionRecord(next);
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
