import { readOptional, writeAtomic } from '../storage.js';
import { withTaskStateLock } from '../task-state/lock.js';
import {
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STATE_PATH,
  WorkflowError,
  assertWorkflowRecord,
  type WorkflowRecord,
} from './contracts.js';
import { assertNoExecutionFenceUnlocked } from '../runtime/execution-fence.js';

export { WORKFLOW_STATE_PATH } from './contracts.js';

type WorkflowState = { schemaVersion: 1; workflows: WorkflowRecord[] };

async function readUnlocked(root: string): Promise<WorkflowState> {
  const raw = (await readOptional(root, WORKFLOW_STATE_PATH)) as unknown as string | null;
  if (raw === null) return { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflows: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkflowError('Workflow state is invalid JSON.', 'WORKFLOW_STATE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowError('Workflow state has an unsupported shape.', 'WORKFLOW_STATE_INVALID');
  const state = value as Partial<WorkflowState>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.workflows))
    throw new WorkflowError('Workflow state has an unsupported shape.', 'WORKFLOW_STATE_INVALID');
  for (const workflow of state.workflows) assertWorkflowRecord(workflow);
  if (
    new Set(state.workflows.map((item) => item.workflowId)).size !== state.workflows.length ||
    new Set(state.workflows.map((item) => item.taskId)).size !== state.workflows.length
  )
    throw new WorkflowError('Workflow IDs and task IDs must be unique.', 'WORKFLOW_STATE_INVALID');
  return state as WorkflowState;
}

async function writeUnlocked(root: string, state: WorkflowState): Promise<void> {
  await writeAtomic(root, WORKFLOW_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function readWorkflow(root: string, taskId: string): Promise<WorkflowRecord | null> {
  return withTaskStateLock(root, async () => {
    const state = await readUnlocked(root);
    return structuredClone(state.workflows.find((item) => item.taskId === taskId) ?? null);
  });
}

/**
 * Lock-free read, for a caller that already holds `withTaskStateLock` (workflow-state and
 * task-state share that one lock file — see `../task-state/lock.js`). Re-acquiring the lock from
 * inside an already-locked section would self-deadlock (this process's own challenge server would
 * answer its own liveness probe), so a caller in that position — task-intent reconciliation, see
 * `../task-state/reconcile.js` — must use this instead of `readWorkflow`. Never call this without
 * already holding the lock: nothing here re-acquires it.
 */
export async function readWorkflowUnlocked(
  root: string,
  taskId: string,
): Promise<WorkflowRecord | null> {
  const state = await readUnlocked(root);
  return structuredClone(state.workflows.find((item) => item.taskId === taskId) ?? null);
}

export async function createWorkflow(
  root: string,
  record: WorkflowRecord,
): Promise<WorkflowRecord> {
  const candidate = structuredClone(record);
  assertWorkflowRecord(candidate);
  return withTaskStateLock(root, async () => {
    const state = await readUnlocked(root);
    if (
      state.workflows.some(
        (item) => item.taskId === candidate.taskId || item.workflowId === candidate.workflowId,
      )
    )
      throw new WorkflowError('Task already has a workflow.', 'WORKFLOW_EXISTS');
    state.workflows.push(candidate);
    await writeUnlocked(root, state);
    return structuredClone(candidate);
  });
}

export async function mutateWorkflow(
  root: string,
  taskId: string,
  expectedRevision: number | undefined,
  operation: (record: WorkflowRecord) => boolean | void,
): Promise<WorkflowRecord> {
  return withTaskStateLock(root, async () => {
    const state = await readUnlocked(root);
    const record = state.workflows.find((item) => item.taskId === taskId);
    if (!record) throw new WorkflowError('Workflow was not found.', 'WORKFLOW_NOT_FOUND');
    if (expectedRevision !== undefined && record.revision !== expectedRevision)
      throw new WorkflowError('Workflow revision changed.', 'WORKFLOW_REVISION_CONFLICT', {
        expectedRevision,
        actualRevision: record.revision,
      });
    const result: unknown = operation(record);
    if (result && typeof (result as { then?: unknown }).then === 'function')
      throw new WorkflowError(
        'Workflow state mutations must be synchronous.',
        'WORKFLOW_MUTATION_INVALID',
      );
    if (result === false) return structuredClone(record);
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    assertWorkflowRecord(record);
    await writeUnlocked(root, state);
    return structuredClone(record);
  });
}

/** Lock-free counterpart to `mutateWorkflow`; see `readWorkflowUnlocked` for when this applies. */
export async function mutateWorkflowUnlocked(
  root: string,
  taskId: string,
  expectedRevision: number | undefined,
  operation: (record: WorkflowRecord) => boolean | void,
): Promise<WorkflowRecord> {
  const state = await readUnlocked(root);
  const record = state.workflows.find((item) => item.taskId === taskId);
  if (!record) throw new WorkflowError('Workflow was not found.', 'WORKFLOW_NOT_FOUND');
  if (expectedRevision !== undefined && record.revision !== expectedRevision)
    throw new WorkflowError('Workflow revision changed.', 'WORKFLOW_REVISION_CONFLICT', {
      expectedRevision,
      actualRevision: record.revision,
    });
  const result: unknown = operation(record);
  if (result && typeof (result as { then?: unknown }).then === 'function')
    throw new WorkflowError(
      'Workflow state mutations must be synchronous.',
      'WORKFLOW_MUTATION_INVALID',
    );
  if (result === false) return structuredClone(record);
  record.revision += 1;
  record.updatedAt = new Date().toISOString();
  assertWorkflowRecord(record);
  await writeUnlocked(root, state);
  return structuredClone(record);
}

export async function journalWorkflowAction(
  root: string,
  taskId: string,
  expectedRevision: number,
  operation: (record: WorkflowRecord) => void,
): Promise<WorkflowRecord> {
  return withTaskStateLock(root, async () => {
    await assertNoExecutionFenceUnlocked(root, taskId);
    const state = await readUnlocked(root);
    const record = state.workflows.find((item) => item.taskId === taskId);
    if (!record) throw new WorkflowError('Workflow was not found.', 'WORKFLOW_NOT_FOUND');
    if (record.revision !== expectedRevision)
      throw new WorkflowError('Workflow revision changed.', 'WORKFLOW_REVISION_CONFLICT', {
        expectedRevision,
        actualRevision: record.revision,
      });
    operation(record);
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    assertWorkflowRecord(record);
    await writeUnlocked(root, state);
    return structuredClone(record);
  });
}

export async function listWorkflows(root: string): Promise<WorkflowRecord[]> {
  return withTaskStateLock(root, async () => structuredClone((await readUnlocked(root)).workflows));
}
