import { createHash } from 'node:crypto';
import type { WorkflowPhase } from '../baml_sdk/index.js';

export const WORKFLOW_SCHEMA_VERSION = 1;
export const WORKFLOW_STATE_PATH = '.latchkit/workflows/state-v1.json';
export const MAX_WORKFLOW_CONTEXT_BYTES = 64 * 1024;

export type WorkflowStatus =
  | 'running'
  | 'awaiting-input'
  | 'awaiting-approval'
  | 'blocked'
  | 'interrupted'
  | 'cancelled'
  | 'completed'
  | 'verified';

export type SourceIdentity = { revision: string | null; dirtyFingerprint: string | null };

export type WorkflowArtifact = {
  phase: WorkflowPhase;
  artifact: string;
  digest: string;
  summary: string;
  createdAt: string;
};

export type WorkflowApproval = {
  planDigest: string;
  requirementsDigest: string;
  checksDigest: string;
  criteriaDigest: string;
  scope: string;
  reference: string;
  source: SourceIdentity;
  approvedAt: string;
};

export type WorkflowMutation = { id: string; digest: string; revision: number };

export type WorkflowActionJournal = {
  actionId: string;
  kind: 'invoke' | 'verify' | 'review' | 'complete';
  phase: WorkflowPhase;
  inputDigest: string;
  ownerId: string;
  ownerPid: number;
  source: SourceIdentity;
  repair: boolean;
  startedAt: string;
};

export type CompletedWorkflowAction = WorkflowActionJournal & {
  status: 'passed' | 'failed' | 'needs-input' | 'error' | 'abandoned';
  summary: string;
  resultDigest: string;
  sourceAfter: SourceIdentity;
  finishedAt: string;
};

export type WorkflowRecord = {
  schemaVersion: 1;
  workflowId: string;
  taskId: string;
  taskOwnerId: string;
  revision: number;
  status: WorkflowStatus;
  phase: WorkflowPhase;
  providerId: string;
  reviewProviderId: string;
  executionAuthorized: boolean;
  policyVersion: string;
  policyDigest: string;
  promptDigest: string;
  initialPrompt: string;
  inputs: string[];
  proposedChecks: unknown | null;
  requirements: WorkflowArtifact | null;
  plan: (WorkflowArtifact & { checks: unknown; checksDigest: string }) | null;
  approval: WorkflowApproval | null;
  repairAttempts: number;
  retryOfActionId: string | null;
  artifacts: WorkflowArtifact[];
  pendingAction: WorkflowActionJournal | null;
  completedActions: CompletedWorkflowAction[];
  mutations: WorkflowMutation[];
  lastOutcome: { status: 'none' | 'passed' | 'failed' | 'needs-input' | 'error'; summary: string };
  source: SourceIdentity;
  createdAt: string;
  updatedAt: string;
};

export class WorkflowError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code = 'WORKFLOW_INVALID', details?: unknown) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.details = details;
  }
}

export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new WorkflowError('Workflow value is not JSON serializable.', 'WORKFLOW_INPUT_INVALID');
  return serialized;
}

export const digestJson = (value: unknown) => sha256(canonicalJson(value));

export function sourceEqual(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.revision === right.revision && left.dirtyFingerprint === right.dirtyFingerprint;
}

export function boundedContext(value: unknown): string {
  const context = canonicalJson(value);
  if (Buffer.byteLength(context, 'utf8') > MAX_WORKFLOW_CONTEXT_BYTES)
    throw new WorkflowError('Workflow context exceeds 64 KB.', 'WORKFLOW_CONTEXT_TOO_LARGE');
  return context;
}

export function assertWorkflowRecord(value: unknown): asserts value is WorkflowRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowError('Workflow record must be an object.', 'WORKFLOW_STATE_INVALID');
  const item = value as Partial<WorkflowRecord>;
  const phases = new Set([
    'requirements',
    'plan',
    'implementation',
    'verification',
    'review',
    'handoff',
  ]);
  const statuses = new Set([
    'running',
    'awaiting-input',
    'awaiting-approval',
    'blocked',
    'interrupted',
    'cancelled',
    'completed',
    'verified',
  ]);
  const digest = (candidate: unknown) =>
    typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate);
  const text = (candidate: unknown, maximum = 4096) =>
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    Buffer.byteLength(candidate) <= maximum;
  const exactKeys = (candidate: object, expected: readonly string[]) => {
    const actual = Object.keys(candidate).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  };
  const boundedJson = (candidate: unknown) => {
    try {
      return Buffer.byteLength(canonicalJson(candidate)) <= MAX_WORKFLOW_CONTEXT_BYTES;
    } catch {
      return false;
    }
  };
  const source = (candidate: unknown): candidate is SourceIdentity => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const snapshot = candidate as Partial<SourceIdentity>;
    return (
      exactKeys(candidate, ['revision', 'dirtyFingerprint']) &&
      (snapshot.revision === null || text(snapshot.revision, 4096)) &&
      (snapshot.dirtyFingerprint === null || digest(snapshot.dirtyFingerprint))
    );
  };
  const validArtifact = (candidate: unknown): candidate is WorkflowArtifact => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const artifact = candidate as Partial<WorkflowArtifact>;
    return (
      exactKeys(candidate, ['phase', 'artifact', 'digest', 'summary', 'createdAt']) &&
      phases.has(String(artifact.phase)) &&
      text(artifact.artifact, MAX_WORKFLOW_CONTEXT_BYTES) &&
      Buffer.byteLength(artifact.artifact ?? '', 'utf8') <= MAX_WORKFLOW_CONTEXT_BYTES &&
      artifact.digest === sha256(artifact.artifact ?? '') &&
      digest(artifact.digest) &&
      typeof artifact.summary === 'string' &&
      Buffer.byteLength(artifact.summary) <= MAX_WORKFLOW_CONTEXT_BYTES &&
      Number.isFinite(Date.parse(artifact.createdAt ?? ''))
    );
  };
  const validAction = (candidate: unknown): candidate is WorkflowActionJournal => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const action = candidate as Partial<WorkflowActionJournal>;
    return (
      exactKeys(candidate, [
        'actionId',
        'kind',
        'phase',
        'inputDigest',
        'ownerId',
        'ownerPid',
        'source',
        'repair',
        'startedAt',
      ]) &&
      /^action_[0-9a-f-]{36}$/i.test(action.actionId ?? '') &&
      ['invoke', 'verify', 'review', 'complete'].includes(action.kind ?? '') &&
      phases.has(String(action.phase)) &&
      (action.kind !== 'verify' || action.phase === 'verification') &&
      (action.kind !== 'review' || action.phase === 'review') &&
      (action.kind !== 'complete' || action.phase === 'handoff') &&
      (!action.repair || (action.kind === 'invoke' && action.phase === 'implementation')) &&
      digest(action.inputDigest) &&
      /^owner_[0-9a-f-]{36}$/i.test(action.ownerId ?? '') &&
      Number.isInteger(action.ownerPid) &&
      (action.ownerPid ?? 0) > 0 &&
      source(action.source) &&
      typeof action.repair === 'boolean' &&
      Number.isFinite(Date.parse(action.startedAt ?? ''))
    );
  };
  if (
    !exactKeys(value, [
      'schemaVersion',
      'workflowId',
      'taskId',
      'taskOwnerId',
      'revision',
      'status',
      'phase',
      'providerId',
      'reviewProviderId',
      'executionAuthorized',
      'policyVersion',
      'policyDigest',
      'promptDigest',
      'initialPrompt',
      'inputs',
      'proposedChecks',
      'requirements',
      'plan',
      'approval',
      'repairAttempts',
      'retryOfActionId',
      'artifacts',
      'pendingAction',
      'completedActions',
      'mutations',
      'lastOutcome',
      'source',
      'createdAt',
      'updatedAt',
    ]) ||
    item.schemaVersion !== 1 ||
    !/^workflow_[0-9a-f-]{36}$/i.test(item.workflowId ?? '') ||
    !/^task_[0-9a-f-]{36}$/i.test(item.taskId ?? '') ||
    !/^owner_[0-9a-f-]{36}$/i.test(item.taskOwnerId ?? '') ||
    !Number.isInteger(item.revision) ||
    (item.revision ?? 0) < 1 ||
    !phases.has(String(item.phase)) ||
    !statuses.has(String(item.status)) ||
    typeof item.executionAuthorized !== 'boolean' ||
    !text(item.providerId) ||
    !text(item.reviewProviderId) ||
    !text(item.policyVersion) ||
    !digest(item.policyDigest) ||
    !digest(item.promptDigest) ||
    !text(item.initialPrompt, MAX_WORKFLOW_CONTEXT_BYTES) ||
    Buffer.byteLength(item.initialPrompt ?? '', 'utf8') > MAX_WORKFLOW_CONTEXT_BYTES ||
    !Array.isArray(item.inputs) ||
    item.inputs.length > 128 ||
    item.inputs.some((input) => !text(input, MAX_WORKFLOW_CONTEXT_BYTES)) ||
    !boundedJson(item.inputs) ||
    !boundedJson(item.proposedChecks) ||
    !Number.isInteger(item.repairAttempts) ||
    (item.repairAttempts ?? -1) < 0 ||
    (item.repairAttempts ?? 4) > 3 ||
    (item.retryOfActionId !== null &&
      !/^action_[0-9a-f-]{36}$/i.test(item.retryOfActionId ?? '')) ||
    !Array.isArray(item.artifacts) ||
    item.artifacts.length > 32 ||
    !item.artifacts.every(validArtifact) ||
    !Array.isArray(item.completedActions) ||
    item.completedActions.length > 64 ||
    !item.completedActions.every(
      (action) =>
        exactKeys(action, [
          'actionId',
          'kind',
          'phase',
          'inputDigest',
          'ownerId',
          'ownerPid',
          'source',
          'repair',
          'startedAt',
          'status',
          'summary',
          'resultDigest',
          'sourceAfter',
          'finishedAt',
        ]) &&
        validAction({
          actionId: action.actionId,
          kind: action.kind,
          phase: action.phase,
          inputDigest: action.inputDigest,
          ownerId: action.ownerId,
          ownerPid: action.ownerPid,
          source: action.source,
          repair: action.repair,
          startedAt: action.startedAt,
        }) &&
        ['passed', 'failed', 'needs-input', 'error', 'abandoned'].includes(action.status) &&
        typeof action.summary === 'string' &&
        Buffer.byteLength(action.summary) <= MAX_WORKFLOW_CONTEXT_BYTES &&
        digest(action.resultDigest) &&
        source(action.sourceAfter) &&
        Number.isFinite(Date.parse(action.finishedAt)),
    ) ||
    !Array.isArray(item.mutations) ||
    item.mutations.length > 256 ||
    item.mutations.some(
      (mutation) =>
        !exactKeys(mutation, ['id', 'digest', 'revision']) ||
        !/^event_[0-9a-f-]{36}$/i.test(mutation.id) ||
        !digest(mutation.digest) ||
        !Number.isInteger(mutation.revision) ||
        mutation.revision < 1,
    ) ||
    !source(item.source) ||
    item.requirements === undefined ||
    item.plan === undefined ||
    item.approval === undefined ||
    item.pendingAction === undefined ||
    !item.lastOutcome ||
    !exactKeys(item.lastOutcome, ['status', 'summary']) ||
    !['none', 'passed', 'failed', 'needs-input', 'error'].includes(item.lastOutcome.status) ||
    typeof item.lastOutcome.summary !== 'string' ||
    Buffer.byteLength(item.lastOutcome.summary) > MAX_WORKFLOW_CONTEXT_BYTES ||
    !Number.isFinite(Date.parse(item.createdAt ?? '')) ||
    !Number.isFinite(Date.parse(item.updatedAt ?? ''))
  )
    throw new WorkflowError('Workflow record has an unsupported shape.', 'WORKFLOW_STATE_INVALID');
  if (
    item.requirements !== null &&
    (!validArtifact(item.requirements) || item.requirements.phase !== 'requirements')
  )
    throw new WorkflowError('Workflow requirements are invalid.', 'WORKFLOW_STATE_INVALID');
  if (item.plan !== null) {
    const plan = item.plan;
    const base = {
      phase: plan.phase,
      artifact: plan.artifact,
      digest: plan.digest,
      summary: plan.summary,
      createdAt: plan.createdAt,
    };
    if (
      !exactKeys(plan, [
        'phase',
        'artifact',
        'digest',
        'summary',
        'createdAt',
        'checks',
        'checksDigest',
      ]) ||
      !validArtifact(base) ||
      plan.phase !== 'plan' ||
      !digest(plan.checksDigest) ||
      !boundedJson(plan.checks) ||
      plan.checksDigest !== digestJson(plan.checks)
    )
      throw new WorkflowError('Workflow plan is invalid.', 'WORKFLOW_STATE_INVALID');
  }
  if (item.pendingAction !== null && !validAction(item.pendingAction))
    throw new WorkflowError('Pending workflow action is invalid.', 'WORKFLOW_STATE_INVALID');
  if (item.approval) {
    const approval = item.approval;
    if (
      !exactKeys(approval, [
        'planDigest',
        'requirementsDigest',
        'checksDigest',
        'criteriaDigest',
        'scope',
        'reference',
        'source',
        'approvedAt',
      ]) ||
      !digest(approval.planDigest) ||
      !digest(approval.requirementsDigest) ||
      !digest(approval.checksDigest) ||
      !digest(approval.criteriaDigest) ||
      !text(approval.scope) ||
      !text(approval.reference) ||
      !source(approval.source) ||
      !Number.isFinite(Date.parse(approval.approvedAt))
    )
      throw new WorkflowError('Workflow approval is invalid.', 'WORKFLOW_STATE_INVALID');
  }
  const actionIds = [
    ...item.completedActions.map((action) => action.actionId),
    ...(item.pendingAction ? [item.pendingAction.actionId] : []),
  ];
  if (new Set(actionIds).size !== actionIds.length)
    throw new WorkflowError('Workflow action IDs must be unique.', 'WORKFLOW_STATE_INVALID');
  if (
    item.retryOfActionId &&
    !item.completedActions.some(
      (action) => action.actionId === item.retryOfActionId && action.status === 'abandoned',
    )
  )
    throw new WorkflowError('Workflow retry target is invalid.', 'WORKFLOW_STATE_INVALID');
  if (new Set(item.mutations.map((mutation) => mutation.id)).size !== item.mutations.length)
    throw new WorkflowError('Workflow mutation IDs must be unique.', 'WORKFLOW_STATE_INVALID');
  const reservedRepairs =
    item.completedActions.filter((action) => action.repair).length +
    (item.pendingAction?.repair ? 1 : 0);
  if (item.repairAttempts !== reservedRepairs)
    throw new WorkflowError('Workflow repair budget is inconsistent.', 'WORKFLOW_STATE_INVALID');
  if (item.pendingAction && item.pendingAction.phase !== item.phase)
    throw new WorkflowError(
      'Pending action phase must match workflow phase.',
      'WORKFLOW_STATE_INVALID',
    );
  if (
    item.approval &&
    (!item.requirements ||
      !item.plan ||
      item.approval.requirementsDigest !== item.requirements.digest ||
      item.approval.planDigest !== item.plan.digest ||
      item.approval.checksDigest !== item.plan.checksDigest)
  )
    throw new WorkflowError('Workflow approval is stale.', 'WORKFLOW_STATE_INVALID');
  if (item.promptDigest !== sha256(item.initialPrompt ?? ''))
    throw new WorkflowError('Workflow prompt digest is invalid.', 'WORKFLOW_STATE_INVALID');
  if (item.status === 'verified' && item.pendingAction)
    throw new WorkflowError(
      'Verified workflow cannot have a pending action.',
      'WORKFLOW_STATE_INVALID',
    );
  if (item.status === 'awaiting-approval' && (!item.requirements || !item.plan))
    throw new WorkflowError(
      'Approval state requires requirements and a plan.',
      'WORKFLOW_STATE_INVALID',
    );
  if (
    item.status === 'verified' &&
    !item.artifacts.some((artifact) => artifact.phase === 'handoff')
  )
    throw new WorkflowError('Verified workflow requires a handoff.', 'WORKFLOW_STATE_INVALID');
}
