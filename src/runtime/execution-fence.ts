import os from 'node:os';
import { readOptional, writeAtomic } from '../storage.js';
import { withTaskStateLock } from '../task-state/lock.js';
import { WORKFLOW_STATE_PATH, assertWorkflowRecord } from '../workflows/contracts.js';

export const EXECUTION_FENCE_PATH = '.latchkit/tasks/execution-fences-v1.json';

export type ExecutionFence = {
  taskId: string;
  ownerId: string;
  actionId: string;
  kind: 'direct' | 'workflow';
  pid: number;
  hostname: string;
  acquiredAt: string;
};

export class ExecutionFenceError extends Error {
  code: 'TASK_EXECUTION_BUSY' | 'TASK_EXECUTION_FENCE_CONFLICT';
  fence?: ExecutionFence;

  constructor(
    message: string,
    code: 'TASK_EXECUTION_BUSY' | 'TASK_EXECUTION_FENCE_CONFLICT',
    fence?: ExecutionFence,
  ) {
    super(message);
    this.name = 'ExecutionFenceError';
    this.code = code;
    this.fence = fence;
  }
}

type FenceState = { schemaVersion: 1; fences: ExecutionFence[] };

function validFence(value: unknown): value is ExecutionFence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<ExecutionFence>;
  return (
    Object.keys(value).length === 7 &&
    /^task_[0-9a-f-]{36}$/i.test(item.taskId ?? '') &&
    /^owner_[0-9a-f-]{36}$/i.test(item.ownerId ?? '') &&
    /^action_[0-9a-f-]{36}$/i.test(item.actionId ?? '') &&
    (item.kind === 'direct' || item.kind === 'workflow') &&
    Number.isInteger(item.pid) &&
    (item.pid ?? 0) > 0 &&
    typeof item.hostname === 'string' &&
    item.hostname.length > 0 &&
    typeof item.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(item.acquiredAt))
  );
}

async function readState(root: string): Promise<FenceState> {
  const raw = (await readOptional(root, EXECUTION_FENCE_PATH)) as unknown as string | null;
  if (raw === null) return { schemaVersion: 1, fences: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ExecutionFenceError(
      'Execution fence state is invalid JSON.',
      'TASK_EXECUTION_FENCE_CONFLICT',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ExecutionFenceError(
      'Execution fence state has an unsupported shape.',
      'TASK_EXECUTION_FENCE_CONFLICT',
    );
  const state = value as Partial<FenceState>;
  if (
    Object.keys(value).length !== 2 ||
    state.schemaVersion !== 1 ||
    !Array.isArray(state.fences) ||
    !state.fences.every(validFence)
  )
    throw new ExecutionFenceError(
      'Execution fence state has an unsupported shape.',
      'TASK_EXECUTION_FENCE_CONFLICT',
    );
  if (new Set(state.fences.map((item) => item.taskId)).size !== state.fences.length)
    throw new ExecutionFenceError(
      'Execution fence task IDs must be unique.',
      'TASK_EXECUTION_FENCE_CONFLICT',
    );
  return state as FenceState;
}

export async function assertNoExecutionFenceUnlocked(root: string, taskId: string): Promise<void> {
  const state = await readState(root);
  const existing = state.fences.find((item) => item.taskId === taskId);
  if (existing)
    throw new ExecutionFenceError(
      'Another execution path owns this task.',
      'TASK_EXECUTION_BUSY',
      structuredClone(existing),
    );
}

async function assertNoActiveWorkflowUnlocked(root: string, taskId: string): Promise<void> {
  const raw = (await readOptional(root, WORKFLOW_STATE_PATH)) as unknown as string | null;
  if (raw === null) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ExecutionFenceError(
      'Workflow state cannot prove execution is available.',
      'TASK_EXECUTION_FENCE_CONFLICT',
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ExecutionFenceError(
      'Workflow state cannot prove execution is available.',
      'TASK_EXECUTION_FENCE_CONFLICT',
    );
  const workflows = (value as { workflows?: unknown }).workflows;
  if (!Array.isArray(workflows))
    throw new ExecutionFenceError(
      'Workflow state cannot prove execution is available.',
      'TASK_EXECUTION_FENCE_CONFLICT',
    );
  for (const workflow of workflows) assertWorkflowRecord(workflow);
  const active = workflows.find(
    (workflow) =>
      workflow.taskId === taskId &&
      (workflow.pendingAction !== null ||
        (workflow.status !== 'cancelled' && workflow.status !== 'verified')),
  );
  if (active)
    throw new ExecutionFenceError('A durable workflow owns this task.', 'TASK_EXECUTION_BUSY');
}

async function writeState(root: string, state: FenceState): Promise<void> {
  await writeAtomic(root, EXECUTION_FENCE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function claimExecutionFence(
  root: string,
  input: Pick<ExecutionFence, 'taskId' | 'ownerId' | 'actionId' | 'kind'>,
): Promise<ExecutionFence> {
  return withTaskStateLock(root, async () => {
    const state = await readState(root);
    if (input.kind === 'direct') await assertNoActiveWorkflowUnlocked(root, input.taskId);
    const existing = state.fences.find((item) => item.taskId === input.taskId);
    if (existing) {
      if (existing.ownerId === input.ownerId && existing.actionId === input.actionId)
        return structuredClone(existing);
      throw new ExecutionFenceError(
        'Another execution path owns this task.',
        'TASK_EXECUTION_BUSY',
        structuredClone(existing),
      );
    }
    const fence: ExecutionFence = {
      ...input,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    state.fences.push(fence);
    await writeState(root, state);
    return structuredClone(fence);
  });
}

export async function releaseExecutionFence(
  root: string,
  input: Pick<ExecutionFence, 'taskId' | 'ownerId' | 'actionId'>,
): Promise<void> {
  await withTaskStateLock(root, async () => {
    const state = await readState(root);
    const index = state.fences.findIndex((item) => item.taskId === input.taskId);
    if (index < 0) return;
    const existing = state.fences[index]!;
    if (existing.ownerId !== input.ownerId || existing.actionId !== input.actionId)
      throw new ExecutionFenceError(
        'Execution fence ownership changed.',
        'TASK_EXECUTION_FENCE_CONFLICT',
        structuredClone(existing),
      );
    state.fences.splice(index, 1);
    await writeState(root, state);
  });
}

export async function clearExecutionFence(
  root: string,
  input: Pick<ExecutionFence, 'taskId' | 'actionId'>,
): Promise<void> {
  await withTaskStateLock(root, async () => {
    const state = await readState(root);
    const index = state.fences.findIndex((item) => item.taskId === input.taskId);
    if (index < 0) return;
    const existing = state.fences[index]!;
    if (existing.actionId !== input.actionId)
      throw new ExecutionFenceError(
        'Execution fence does not match the resolved action.',
        'TASK_EXECUTION_FENCE_CONFLICT',
        structuredClone(existing),
      );
    state.fences.splice(index, 1);
    await writeState(root, state);
  });
}

export async function inspectExecutionFence(
  root: string,
  taskId: string,
): Promise<ExecutionFence | null> {
  return withTaskStateLock(root, async () => {
    const state = await readState(root);
    return structuredClone(state.fences.find((item) => item.taskId === taskId) ?? null);
  });
}
