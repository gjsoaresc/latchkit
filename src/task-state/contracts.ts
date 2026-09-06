import { errorMessage } from '../types.js';
import { isVerificationMode, type VerificationMode } from '../verification/contracts.js';
import {
  buildRecordDependencyEdges,
  detectRecordDependencyCycle,
  MAX_RECONCILE_IMPACT_ENTRIES,
  MAX_RECONCILE_PATCH_OPS,
  MAX_RECONCILIATIONS_PER_TASK,
  MAX_RECORD_HISTORY,
  MAX_RECORD_LINKS,
  MAX_RECORD_REASON_BYTES,
  MAX_RECORD_REFERENCE_BYTES,
  MAX_RECORD_TEXT_BYTES,
  MAX_RECORDS_PER_TASK,
  RECORD_KINDS,
  RECORD_PROVENANCE_KINDS,
  RECORD_STATUSES,
  type RecordLink,
  type TaskRecord,
} from './records.js';
import type {
  ImpactEntry,
  ImpactTargetKind,
  ReconcileOpKind,
  ReconciliationOpSummary,
  ReconciliationUncertainty,
  TaskReconciliation,
} from './reconcile.js';

export type { VerificationMode };
export type {
  RecordKind,
  RecordLink,
  RecordProvenanceKind,
  TaskRecord,
  TaskRecordHistoryEntry,
  TaskRecordProvenance,
} from './records.js';
export {
  allowedRecordTransitions,
  DEFAULT_RECORD_LIST_LIMIT,
  isRecordAuthoritativeStatus,
  isRecordStatusTerminal,
  isRecordTransitionValid,
  MAX_RECORD_HISTORY,
  MAX_RECORD_LINKS,
  MAX_RECORD_LIST_LIMIT,
  MAX_RECORD_REASON_BYTES,
  MAX_RECORD_REFERENCE_BYTES,
  MAX_RECORD_TEXT_BYTES,
  MAX_RECORDS_PER_TASK,
  RECORD_INITIAL_STATUS,
  RECORD_KINDS,
  RECORD_PROVENANCE_KINDS,
  RECORD_STATUSES,
  RECORD_TERMINAL_STATUSES,
  recordTransitionRequiresAuthority,
  reconcileSourceLinkStatus,
} from './records.js';
export type { RecordLinkStatus } from './records.js';
export { computeIntentDigest } from './records.js';
export type {
  ImpactClassification,
  ImpactEntry,
  ImpactOutcome,
  ImpactTargetKind,
  ReconcileOpKind,
  ReconciliationCriterionSnapshot,
  ReconciliationOpSummary,
  ReconciliationRecordSnapshot,
  ReconciliationReport,
  ReconciliationUncertainty,
  TaskReconciliation,
} from './reconcile.js';

export type SourceSnapshot = { revision: string | null; dirtyFingerprint: string | null };
export type Authorization = {
  id: string;
  source: 'user';
  scope: string;
  provenance: { kind: 'direct-request' | 'explicit-cli'; reference: string };
  grantedAt: string;
};
export type Criterion = {
  id: string;
  revision: number;
  description: string;
  required: boolean;
  approvalRequired: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ProcessIdentity = { pid: number; hostname: string; platform: string; runtime: string };
export type TaskRun = {
  id: string;
  ownerId: string;
  state: string;
  startedAt: string;
  endedAt: string | null;
  process: ProcessIdentity;
  source: SourceSnapshot;
};
export type TaskCheckpoint = {
  id: string;
  runId: string;
  taskRevision: number;
  summary: string;
  source: SourceSnapshot;
  createdAt: string;
};
export type TaskEnvironment = {
  platform: string;
  runtime: string;
  node: string;
  cwd: string;
  details: string | null;
};
export type TaskEvidence = {
  id: string;
  criterionId: string;
  criterionRevision: number;
  runId: string;
  kind: string;
  command: string | null;
  environment: TaskEnvironment;
  outcome: string;
  artifact: string | null;
  source: SourceSnapshot;
  authorizationId: string | null;
  createdAt: string;
  enhanced?: { workflowRevision: number; definitionSha256: string };
};
export type TaskEvent = {
  id: string;
  type: string;
  requestHash: string;
  taskRevision: number;
  runId: string | null;
  createdAt: string;
};
export type TaskOwner = { runId: string; ownerId: string; revision: number; acquiredAt: string };
export type TaskImport = { path: string; sha256: string; importedAt: string };
export type EnhancedArtifact = {
  path: string;
  sha256: string;
  templateVersion: number;
};
export type EnhancedCheck = {
  id: string;
  criterionId: string;
  type: 'cli' | 'http' | 'browser' | 'manual';
  definitionSha256: string;
  definition?: Record<string, unknown>;
};
export type EnhancedWorkflow = {
  schemaVersion: 1;
  revision: number;
  enrolledAt: string;
  updatedAt: string;
  artifacts: { prd: EnhancedArtifact; technicalPlan: EnhancedArtifact };
  checks: EnhancedCheck[];
};
export type Task = {
  id: string;
  title: string;
  state: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  authorizationRequired: boolean;
  authorizations: Authorization[];
  owner: TaskOwner | null;
  criteria: Criterion[];
  runs: TaskRun[];
  checkpoints: TaskCheckpoint[];
  evidence: TaskEvidence[];
  events: TaskEvent[];
  import: TaskImport | null;
  enhancedWorkflow?: EnhancedWorkflow | null;
  /** Present from task-state schema version 3. Bounded, change-focused fast
   * verification versus the full standard path; persisted so resume never
   * silently changes an existing task's verification behavior. */
  verificationMode?: VerificationMode;
  /** Present from task-state schema version 4. Discriminated decision/assumption/observation/
   * question knowledge records with explicit provenance. See docs/task-state.md. */
  records?: TaskRecord[];
  /** Present from task-state schema version 5. Bounded summaries of applied intent
   * reconciliations (see docs/task-state.md#reconciling-changed-intent); each entry preserves the
   * digests and impact reasons for one `reconcile-apply` mutation. */
  reconciliations?: TaskReconciliation[];
};
export type TaskState = {
  schemaVersion: number;
  project: { id: string; createdAt: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
};

export const TASK_STATE_SCHEMA_VERSION = 5;
export const SUPPORTED_TASK_STATE_SCHEMA_VERSIONS = Object.freeze([1, 2, 3, 4, 5]);

export const TASK_STATES = Object.freeze([
  'planned',
  'running',
  'awaiting-decision',
  'blocked',
  'cancelled',
  'completed',
  'verified',
]);

export const RUN_STATES = Object.freeze(['running', 'interrupted', 'cancelled', 'completed']);
export const EVIDENCE_OUTCOMES = Object.freeze([
  'passed',
  'failed',
  'timed-out',
  'cancelled',
  'skipped',
  'unsupported',
  'missing',
]);

const ID_PATTERN =
  /^(project|task|run|criterion|checkpoint|evidence|authorization|owner|event|record|reconciliation)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_ID_PATTERN =
  /^memory_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Durable plans (PRDs and technical plans) default to collision-safe filenames under
 * `docs/plans/`. Reads continue to accept the legacy `.latchkit/notes/` location so existing
 * registered artifacts remain valid without an implicit migration. See docs/task-state.md.
 */
export const PLAN_ARTIFACT_PATH_PATTERN = /^(?:docs\/plans|\.latchkit\/notes)\/.+\.md$/;

export class TaskStateError extends Error {
  code: string;
  path: string;
  expectedRevision?: number;
  actualRevision?: number;
  failures?: { criterionId: string; reason: string }[];
  constructor(message: string, code = 'TASK_STATE_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'TaskStateError';
    this.code = code;
    this.path = path;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: unknown, allowed: string[], required: string[], path: string) {
  if (!record(value)) throw new TaskStateError('Expected an object.', 'TASK_STATE_INVALID', path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new TaskStateError(`Unknown field "${key}".`, 'TASK_STATE_INVALID', `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new TaskStateError(
        'Required field is missing.',
        'TASK_STATE_INVALID',
        `${path}.${key}`,
      );
  }
}

function string(value: unknown, path: string, { empty = false } = {}): string {
  if (typeof value !== 'string' || (!empty && !value.trim()))
    throw new TaskStateError('Expected a non-empty string.', 'TASK_STATE_INVALID', path);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value !== null && typeof value !== 'string')
    throw new TaskStateError('Expected a string or null.', 'TASK_STATE_INVALID', path);
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum)
    throw new TaskStateError(`Expected an integer >= ${minimum}.`, 'TASK_STATE_INVALID', path);
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new TaskStateError('Expected an ISO date-time.', 'TASK_STATE_INVALID', path);
  return value;
}

function id(value: unknown, path: string, prefix: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || !value.startsWith(`${prefix}_`)) {
    throw new TaskStateError(`Expected a stable ${prefix} ID.`, 'TASK_STATE_INVALID', path);
  }
  return value;
}

function hash(value: unknown, path: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HASH_PATTERN.test(value))
    throw new TaskStateError('Expected a lowercase SHA-256 digest.', 'TASK_STATE_INVALID', path);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean')
    throw new TaskStateError('Expected a boolean.', 'TASK_STATE_INVALID', path);
  return value;
}

function unique(items: { id: string }[], key: 'id', path: string) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (seen.has(item[key]))
      throw new TaskStateError(
        `Duplicate ${key} "${item[key]}".`,
        'TASK_STATE_INVALID',
        `${path}[${index}].${key}`,
      );
    seen.add(item[key]);
  }
}

function validateSource(value: SourceSnapshot, path: string) {
  keys(value, ['revision', 'dirtyFingerprint'], ['revision', 'dirtyFingerprint'], path);
  nullableString(value.revision, `${path}.revision`);
  hash(value.dirtyFingerprint, `${path}.dirtyFingerprint`, true);
  return value;
}

function validateAuthorization(value: Authorization, path: string) {
  keys(
    value,
    ['id', 'source', 'scope', 'provenance', 'grantedAt'],
    ['id', 'source', 'scope', 'provenance', 'grantedAt'],
    path,
  );
  id(value.id, `${path}.id`, 'authorization');
  if (value.source !== 'user')
    throw new TaskStateError(
      'Only an explicit user may grant workflow authorization.',
      'TASK_AUTHORIZATION_INVALID',
      `${path}.source`,
    );
  string(value.scope, `${path}.scope`);
  keys(value.provenance, ['kind', 'reference'], ['kind', 'reference'], `${path}.provenance`);
  if (!['direct-request', 'explicit-cli'].includes(value.provenance.kind)) {
    throw new TaskStateError(
      'Repository text and another task are not authorization provenance.',
      'TASK_AUTHORIZATION_INVALID',
      `${path}.provenance.kind`,
    );
  }
  string(value.provenance.reference, `${path}.provenance.reference`);
  timestamp(value.grantedAt, `${path}.grantedAt`);
  return value;
}

function validateCriterion(value: Criterion, path: string) {
  keys(
    value,
    ['id', 'revision', 'description', 'required', 'approvalRequired', 'createdAt', 'updatedAt'],
    ['id', 'revision', 'description', 'required', 'approvalRequired', 'createdAt', 'updatedAt'],
    path,
  );
  id(value.id, `${path}.id`, 'criterion');
  integer(value.revision, `${path}.revision`, 1);
  string(value.description, `${path}.description`);
  boolean(value.required, `${path}.required`);
  boolean(value.approvalRequired, `${path}.approvalRequired`);
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
  return value;
}

function validateProcess(value: ProcessIdentity, path: string) {
  keys(
    value,
    ['pid', 'hostname', 'platform', 'runtime'],
    ['pid', 'hostname', 'platform', 'runtime'],
    path,
  );
  integer(value.pid, `${path}.pid`, 1);
  string(value.hostname, `${path}.hostname`);
  string(value.platform, `${path}.platform`);
  string(value.runtime, `${path}.runtime`);
  return value;
}

function validateRun(value: TaskRun, path: string) {
  keys(
    value,
    ['id', 'ownerId', 'state', 'startedAt', 'endedAt', 'process', 'source'],
    ['id', 'ownerId', 'state', 'startedAt', 'endedAt', 'process', 'source'],
    path,
  );
  id(value.id, `${path}.id`, 'run');
  id(value.ownerId, `${path}.ownerId`, 'owner');
  if (!RUN_STATES.includes(value.state))
    throw new TaskStateError('Unknown run state.', 'TASK_STATE_INVALID', `${path}.state`);
  timestamp(value.startedAt, `${path}.startedAt`);
  if (value.endedAt !== null) timestamp(value.endedAt, `${path}.endedAt`);
  validateProcess(value.process, `${path}.process`);
  validateSource(value.source, `${path}.source`);
  return value;
}

function validateCheckpoint(value: TaskCheckpoint, path: string) {
  keys(
    value,
    ['id', 'runId', 'taskRevision', 'summary', 'source', 'createdAt'],
    ['id', 'runId', 'taskRevision', 'summary', 'source', 'createdAt'],
    path,
  );
  id(value.id, `${path}.id`, 'checkpoint');
  id(value.runId, `${path}.runId`, 'run');
  integer(value.taskRevision, `${path}.taskRevision`, 1);
  string(value.summary, `${path}.summary`);
  validateSource(value.source, `${path}.source`);
  timestamp(value.createdAt, `${path}.createdAt`);
  return value;
}

function validateEnvironment(value: TaskEnvironment, path: string) {
  keys(
    value,
    ['platform', 'runtime', 'node', 'cwd', 'details'],
    ['platform', 'runtime', 'node', 'cwd', 'details'],
    path,
  );
  string(value.platform, `${path}.platform`);
  string(value.runtime, `${path}.runtime`);
  string(value.node, `${path}.node`);
  string(value.cwd, `${path}.cwd`);
  nullableString(value.details, `${path}.details`);
  return value;
}

function validateEvidence(value: TaskEvidence, path: string) {
  keys(
    value,
    [
      'id',
      'criterionId',
      'criterionRevision',
      'runId',
      'kind',
      'command',
      'environment',
      'outcome',
      'artifact',
      'source',
      'authorizationId',
      'createdAt',
      'enhanced',
    ],
    [
      'id',
      'criterionId',
      'criterionRevision',
      'runId',
      'kind',
      'command',
      'environment',
      'outcome',
      'artifact',
      'source',
      'authorizationId',
      'createdAt',
    ],
    path,
  );
  id(value.id, `${path}.id`, 'evidence');
  id(value.criterionId, `${path}.criterionId`, 'criterion');
  integer(value.criterionRevision, `${path}.criterionRevision`, 1);
  id(value.runId, `${path}.runId`, 'run');
  if (
    !['check', 'approval'].includes(value.kind) &&
    !/^enhanced-check:[a-z0-9][a-z0-9._-]{0,127}$/.test(value.kind)
  )
    throw new TaskStateError(
      'Expected check, approval, or enhanced-check evidence.',
      'TASK_STATE_INVALID',
      `${path}.kind`,
    );
  nullableString(value.command, `${path}.command`);
  validateEnvironment(value.environment, `${path}.environment`);
  if (!EVIDENCE_OUTCOMES.includes(value.outcome))
    throw new TaskStateError('Unknown evidence outcome.', 'TASK_STATE_INVALID', `${path}.outcome`);
  nullableString(value.artifact, `${path}.artifact`);
  validateSource(value.source, `${path}.source`);
  if (value.authorizationId !== null)
    id(value.authorizationId, `${path}.authorizationId`, 'authorization');
  timestamp(value.createdAt, `${path}.createdAt`);
  if (value.enhanced !== undefined) {
    keys(
      value.enhanced,
      ['workflowRevision', 'definitionSha256'],
      ['workflowRevision', 'definitionSha256'],
      `${path}.enhanced`,
    );
    integer(value.enhanced.workflowRevision, `${path}.enhanced.workflowRevision`, 1);
    hash(value.enhanced.definitionSha256, `${path}.enhanced.definitionSha256`);
  }
  return value;
}

function validateEvent(value: TaskEvent, path: string) {
  keys(
    value,
    ['id', 'type', 'requestHash', 'taskRevision', 'runId', 'createdAt'],
    ['id', 'type', 'requestHash', 'taskRevision', 'runId', 'createdAt'],
    path,
  );
  id(value.id, `${path}.id`, 'event');
  string(value.type, `${path}.type`);
  hash(value.requestHash, `${path}.requestHash`);
  integer(value.taskRevision, `${path}.taskRevision`, 1);
  if (value.runId !== null) id(value.runId, `${path}.runId`, 'run');
  timestamp(value.createdAt, `${path}.createdAt`);
  return value;
}

function validateOwner(value: TaskOwner | null, path: string) {
  if (value === null) return null;
  keys(
    value,
    ['runId', 'ownerId', 'revision', 'acquiredAt'],
    ['runId', 'ownerId', 'revision', 'acquiredAt'],
    path,
  );
  id(value.runId, `${path}.runId`, 'run');
  id(value.ownerId, `${path}.ownerId`, 'owner');
  integer(value.revision, `${path}.revision`, 1);
  timestamp(value.acquiredAt, `${path}.acquiredAt`);
  return value;
}

function validateImport(value: TaskImport | null, path: string) {
  if (value === null) return null;
  keys(value, ['path', 'sha256', 'importedAt'], ['path', 'sha256', 'importedAt'], path);
  string(value.path, `${path}.path`);
  hash(value.sha256, `${path}.sha256`);
  timestamp(value.importedAt, `${path}.importedAt`);
  return value;
}

function validateEnhancedArtifact(value: EnhancedArtifact, path: string) {
  keys(value, ['path', 'sha256', 'templateVersion'], ['path', 'sha256', 'templateVersion'], path);
  const artifactPath = string(value.path, `${path}.path`);
  if (!PLAN_ARTIFACT_PATH_PATTERN.test(artifactPath))
    throw new TaskStateError(
      'Enhanced artifacts must be Markdown plans under docs/plans/ or the legacy .latchkit/notes/.',
      'TASK_STATE_INVALID',
      `${path}.path`,
    );
  hash(value.sha256, `${path}.sha256`);
  integer(value.templateVersion, `${path}.templateVersion`, 1);
}

function validateEnhancedWorkflow(value: EnhancedWorkflow | null, task: Task, path: string) {
  if (value === null) return;
  keys(
    value,
    ['schemaVersion', 'revision', 'enrolledAt', 'updatedAt', 'artifacts', 'checks'],
    ['schemaVersion', 'revision', 'enrolledAt', 'updatedAt', 'artifacts', 'checks'],
    path,
  );
  if (value.schemaVersion !== 1)
    throw new TaskStateError('Unsupported enhanced workflow schema.', 'TASK_STATE_INVALID', path);
  integer(value.revision, `${path}.revision`, 1);
  timestamp(value.enrolledAt, `${path}.enrolledAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
  keys(value.artifacts, ['prd', 'technicalPlan'], ['prd', 'technicalPlan'], `${path}.artifacts`);
  validateEnhancedArtifact(value.artifacts.prd, `${path}.artifacts.prd`);
  validateEnhancedArtifact(value.artifacts.technicalPlan, `${path}.artifacts.technicalPlan`);
  if (!Array.isArray(value.checks) || value.checks.length === 0)
    throw new TaskStateError(
      'Enhanced workflows require at least one check.',
      'TASK_STATE_INVALID',
      `${path}.checks`,
    );
  const criterionIds = new Set(task.criteria.map((criterion) => criterion.id));
  const checkIds = new Set<string>();
  for (const [index, check] of value.checks.entries()) {
    const at = `${path}.checks[${index}]`;
    keys(
      check,
      ['id', 'criterionId', 'type', 'definitionSha256', 'definition'],
      ['id', 'criterionId', 'type', 'definitionSha256'],
      at,
    );
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(check.id))
      throw new TaskStateError('Invalid enhanced check ID.', 'TASK_STATE_INVALID', `${at}.id`);
    if (checkIds.has(check.id))
      throw new TaskStateError('Enhanced check IDs must be unique.', 'TASK_STATE_INVALID', at);
    checkIds.add(check.id);
    id(check.criterionId, `${at}.criterionId`, 'criterion');
    if (!criterionIds.has(check.criterionId))
      throw new TaskStateError(
        'Enhanced check references an unknown criterion.',
        'TASK_STATE_INVALID',
        at,
      );
    if (!['cli', 'http', 'browser', 'manual'].includes(check.type))
      throw new TaskStateError('Unknown enhanced check type.', 'TASK_STATE_INVALID', `${at}.type`);
    hash(check.definitionSha256, `${at}.definitionSha256`);
    if (
      check.definition !== undefined &&
      (check.definition === null ||
        typeof check.definition !== 'object' ||
        Array.isArray(check.definition))
    )
      throw new TaskStateError(
        'Enhanced check definition must be an object.',
        'TASK_STATE_INVALID',
        `${at}.definition`,
      );
  }
  for (const criterion of task.criteria.filter((item) => item.required)) {
    if (!value.checks.some((check) => check.criterionId === criterion.id))
      throw new TaskStateError(
        'Every required criterion must map to at least one check.',
        'TASK_STATE_INVALID',
        `${path}.checks`,
      );
  }
}

function boundedText(value: unknown, path: string, maxBytes: number): string {
  const text = string(value, path);
  if (Buffer.byteLength(text, 'utf8') > maxBytes)
    throw new TaskStateError('Text exceeds the maximum size.', 'TASK_RECORD_TEXT_TOO_LARGE', path);
  return text;
}

function validateRecordLink(value: RecordLink, path: string, task: Task, records: TaskRecord[]) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TaskStateError('Expected a link object.', 'TASK_STATE_INVALID', path);
  if (value.type === 'record') {
    keys(
      value,
      ['type', 'recordId', 'recordRevision'],
      ['type', 'recordId', 'recordRevision'],
      path,
    );
    id(value.recordId, `${path}.recordId`, 'record');
    integer(value.recordRevision, `${path}.recordRevision`, 1);
    const target = records.find((item) => item.id === value.recordId);
    if (!target)
      throw new TaskStateError(
        'Record link references an unknown record.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.recordId`,
      );
    if (value.recordRevision > target.revision)
      throw new TaskStateError(
        'Record link references an unknown revision.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.recordRevision`,
      );
  } else if (value.type === 'criterion') {
    keys(
      value,
      ['type', 'criterionId', 'criterionRevision'],
      ['type', 'criterionId', 'criterionRevision'],
      path,
    );
    id(value.criterionId, `${path}.criterionId`, 'criterion');
    integer(value.criterionRevision, `${path}.criterionRevision`, 1);
    const criterion = task.criteria.find((item) => item.id === value.criterionId);
    if (!criterion)
      throw new TaskStateError(
        'Record link references an unknown criterion.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.criterionId`,
      );
    if (value.criterionRevision > criterion.revision)
      throw new TaskStateError(
        'Record link references an unknown criterion revision.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.criterionRevision`,
      );
  } else if (value.type === 'evidence') {
    keys(value, ['type', 'evidenceId'], ['type', 'evidenceId'], path);
    id(value.evidenceId, `${path}.evidenceId`, 'evidence');
    if (!task.evidence.some((item) => item.id === value.evidenceId))
      throw new TaskStateError(
        'Record link references unknown evidence.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.evidenceId`,
      );
  } else if (value.type === 'memory') {
    keys(
      value,
      ['type', 'memoryId', 'memoryRevision'],
      ['type', 'memoryId', 'memoryRevision'],
      path,
    );
    if (typeof value.memoryId !== 'string' || !MEMORY_ID_PATTERN.test(value.memoryId))
      throw new TaskStateError(
        'Expected a stable memory ID.',
        'TASK_STATE_INVALID',
        `${path}.memoryId`,
      );
    integer(value.memoryRevision, `${path}.memoryRevision`, 1);
  } else if (value.type === 'source') {
    keys(
      value,
      ['type', 'path', 'digest', 'observedAt'],
      ['type', 'path', 'digest', 'observedAt'],
      path,
    );
    const sourcePath = string(value.path, `${path}.path`);
    if (
      sourcePath.includes('\\') ||
      sourcePath.startsWith('/') ||
      sourcePath.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new TaskStateError(
        'Expected a repository-relative path.',
        'TASK_STATE_INVALID',
        `${path}.path`,
      );
    hash(value.digest, `${path}.digest`, true);
    timestamp(value.observedAt, `${path}.observedAt`);
  } else {
    throw new TaskStateError('Unknown record link type.', 'TASK_STATE_INVALID', `${path}.type`);
  }
}

function validateRecordHistoryEntry(value: TaskRecord['history'][number], path: string) {
  keys(
    value,
    ['revision', 'status', 'text', 'action', 'reason', 'authorizationId', 'createdAt'],
    ['revision', 'status', 'text', 'action', 'reason', 'authorizationId', 'createdAt'],
    path,
  );
  integer(value.revision, `${path}.revision`, 1);
  string(value.status, `${path}.status`);
  boundedText(value.text, `${path}.text`, MAX_RECORD_TEXT_BYTES);
  if (!['created', 'revised', 'transitioned'].includes(value.action))
    throw new TaskStateError(
      'Unknown record history action.',
      'TASK_STATE_INVALID',
      `${path}.action`,
    );
  nullableString(value.reason, `${path}.reason`);
  if (value.reason !== null && Buffer.byteLength(value.reason, 'utf8') > MAX_RECORD_REASON_BYTES)
    throw new TaskStateError(
      'Text exceeds the maximum size.',
      'TASK_RECORD_TEXT_TOO_LARGE',
      `${path}.reason`,
    );
  if (value.authorizationId !== null)
    id(value.authorizationId, `${path}.authorizationId`, 'authorization');
  timestamp(value.createdAt, `${path}.createdAt`);
}

function validateTaskRecord(value: TaskRecord, path: string, task: Task, allRecords: TaskRecord[]) {
  keys(
    value,
    [
      'id',
      'kind',
      'revision',
      'status',
      'text',
      'provenance',
      'links',
      'supersedes',
      'supersededBy',
      'history',
      'createdAt',
      'updatedAt',
    ],
    [
      'id',
      'kind',
      'revision',
      'status',
      'text',
      'provenance',
      'links',
      'supersedes',
      'supersededBy',
      'history',
      'createdAt',
      'updatedAt',
    ],
    path,
  );
  id(value.id, `${path}.id`, 'record');
  if (!(RECORD_KINDS as readonly string[]).includes(value.kind))
    throw new TaskStateError('Unknown record kind.', 'TASK_STATE_INVALID', `${path}.kind`);
  integer(value.revision, `${path}.revision`, 1);
  if (!RECORD_STATUSES[value.kind].includes(value.status))
    throw new TaskStateError(
      'Status is not valid for this record kind.',
      'TASK_STATE_INVALID',
      `${path}.status`,
    );
  boundedText(value.text, `${path}.text`, MAX_RECORD_TEXT_BYTES);
  keys(value.provenance, ['kind', 'reference'], ['kind', 'reference'], `${path}.provenance`);
  if (!(RECORD_PROVENANCE_KINDS as readonly string[]).includes(value.provenance.kind))
    throw new TaskStateError(
      'Unknown record provenance kind.',
      'TASK_STATE_INVALID',
      `${path}.provenance.kind`,
    );
  boundedText(
    value.provenance.reference,
    `${path}.provenance.reference`,
    MAX_RECORD_REFERENCE_BYTES,
  );
  if (!Array.isArray(value.links))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', `${path}.links`);
  if (value.links.length > MAX_RECORD_LINKS)
    throw new TaskStateError(
      'Record has too many declared links.',
      'TASK_RECORD_LIMIT_EXCEEDED',
      `${path}.links`,
    );
  value.links.forEach((link, index) =>
    validateRecordLink(link, `${path}.links[${index}]`, task, allRecords),
  );
  if (value.supersedes !== null) id(value.supersedes, `${path}.supersedes`, 'record');
  if (value.supersededBy !== null) id(value.supersededBy, `${path}.supersededBy`, 'record');
  if (!Array.isArray(value.history) || value.history.length < 1)
    throw new TaskStateError(
      'A record must retain at least its creation history entry.',
      'TASK_STATE_INVALID',
      `${path}.history`,
    );
  if (value.history.length > MAX_RECORD_HISTORY)
    throw new TaskStateError(
      'Record has too many history entries.',
      'TASK_RECORD_LIMIT_EXCEEDED',
      `${path}.history`,
    );
  value.history.forEach((entry, index) => {
    validateRecordHistoryEntry(entry, `${path}.history[${index}]`);
    if (entry.revision !== index + 1)
      throw new TaskStateError(
        'Record history must form a contiguous revision sequence.',
        'TASK_STATE_INVALID',
        `${path}.history[${index}].revision`,
      );
  });
  const last = value.history[value.history.length - 1];
  if (
    !last ||
    last.revision !== value.revision ||
    last.status !== value.status ||
    last.text !== value.text
  )
    throw new TaskStateError(
      'Record history must end with the current record snapshot.',
      'TASK_STATE_INVALID',
      `${path}.history`,
    );
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
}

function validateTaskRecords(records: TaskRecord[], task: Task, path: string) {
  if (!Array.isArray(records))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', path);
  if (records.length > MAX_RECORDS_PER_TASK)
    throw new TaskStateError('Task has too many records.', 'TASK_RECORD_LIMIT_EXCEEDED', path);
  records.forEach((item, index) => validateTaskRecord(item, `${path}[${index}]`, task, records));
  unique(records, 'id', path);
  const byId = new Map(records.map((item) => [item.id, item]));
  for (const item of records) {
    if (item.supersedes) {
      const target = byId.get(item.supersedes);
      if (!target)
        throw new TaskStateError(
          'Record supersedes an unknown record.',
          'TASK_RECORD_LINK_INVALID',
          path,
        );
      if (target.kind !== item.kind)
        throw new TaskStateError(
          'A record can only supersede a record of the same kind.',
          'TASK_STATE_INVALID',
          path,
        );
      if (target.status !== 'superseded' || target.supersededBy !== item.id)
        throw new TaskStateError(
          'A superseded record must carry the superseded status and point back to its successor.',
          'TASK_STATE_INVALID',
          path,
        );
    }
    if (
      item.supersededBy &&
      (!byId.has(item.supersededBy) || byId.get(item.supersededBy)?.supersedes !== item.id)
    )
      throw new TaskStateError(
        'supersededBy must reference the record that supersedes this one.',
        'TASK_STATE_INVALID',
        path,
      );
  }
  const cycle = detectRecordDependencyCycle(buildRecordDependencyEdges(records));
  if (cycle)
    throw new TaskStateError(
      `Cyclic record dependency: ${cycle.join(' -> ')}.`,
      'TASK_RECORD_CYCLE',
      path,
    );
}

const RECONCILE_OP_KINDS: readonly ReconcileOpKind[] = Object.freeze([
  'transition',
  'supersede',
  'revise',
  'criterion',
]);
const IMPACT_TARGET_KINDS: readonly ImpactTargetKind[] = Object.freeze([
  'record',
  'criterion',
  'check',
  'evidence',
]);
const IMPACT_CLASSIFICATIONS = Object.freeze([
  'directly-affected',
  'declared-dependent',
  'potentially-affected',
]);
const IMPACT_OUTCOMES = Object.freeze([
  'needs-user-decision',
  'needs-replanning',
  'needs-re-verification',
  'none',
]);
const UNCERTAINTY_REASONS = Object.freeze([
  'link-stale',
  'link-missing',
  'link-unknown',
  'uncovered-dependency',
]);

function validateReconcileOpSummary(value: ReconciliationOpSummary, path: string) {
  keys(
    value,
    ['op', 'targetId', 'fromRevision', 'toRevision', 'fromStatus', 'toStatus'],
    ['op', 'targetId', 'fromRevision', 'toRevision', 'fromStatus', 'toStatus'],
    path,
  );
  if (!(RECONCILE_OP_KINDS as readonly string[]).includes(value.op))
    throw new TaskStateError('Unknown reconciliation op kind.', 'TASK_STATE_INVALID', `${path}.op`);
  string(value.targetId, `${path}.targetId`);
  integer(value.fromRevision, `${path}.fromRevision`, 1);
  integer(value.toRevision, `${path}.toRevision`, 1);
  if (value.fromStatus !== null) string(value.fromStatus, `${path}.fromStatus`);
  if (value.toStatus !== null) string(value.toStatus, `${path}.toStatus`);
}

function validateImpactEntry(value: ImpactEntry, path: string) {
  keys(
    value,
    ['kind', 'id', 'classification', 'outcome', 'reasonCode', 'path'],
    ['kind', 'id', 'classification', 'outcome', 'reasonCode', 'path'],
    path,
  );
  if (!(IMPACT_TARGET_KINDS as readonly string[]).includes(value.kind))
    throw new TaskStateError('Unknown impact target kind.', 'TASK_STATE_INVALID', `${path}.kind`);
  string(value.id, `${path}.id`);
  if (!IMPACT_CLASSIFICATIONS.includes(value.classification))
    throw new TaskStateError(
      'Unknown impact classification.',
      'TASK_STATE_INVALID',
      `${path}.classification`,
    );
  if (!IMPACT_OUTCOMES.includes(value.outcome))
    throw new TaskStateError('Unknown impact outcome.', 'TASK_STATE_INVALID', `${path}.outcome`);
  string(value.reasonCode, `${path}.reasonCode`);
  if (
    !Array.isArray(value.path) ||
    value.path.length === 0 ||
    !value.path.every((item) => typeof item === 'string')
  )
    throw new TaskStateError(
      'Expected a non-empty string path.',
      'TASK_STATE_INVALID',
      `${path}.path`,
    );
}

function validateUncertainty(value: ReconciliationUncertainty, path: string) {
  keys(value, ['kind', 'id', 'reasonCode', 'detail'], ['kind', 'id', 'reasonCode', 'detail'], path);
  if (!(IMPACT_TARGET_KINDS as readonly string[]).includes(value.kind))
    throw new TaskStateError('Unknown impact target kind.', 'TASK_STATE_INVALID', `${path}.kind`);
  string(value.id, `${path}.id`);
  if (!UNCERTAINTY_REASONS.includes(value.reasonCode))
    throw new TaskStateError(
      'Unknown uncertainty reason.',
      'TASK_STATE_INVALID',
      `${path}.reasonCode`,
    );
  string(value.detail, `${path}.detail`, { empty: true });
}

function validateTaskReconciliation(value: TaskReconciliation, path: string) {
  keys(
    value,
    [
      'id',
      'mutationId',
      'patchDigest',
      'previewDigest',
      'ops',
      'impactSummary',
      'impact',
      'impactTruncated',
      'uncertainties',
      'authorizationIds',
      'workflowAcknowledged',
      'createdAt',
    ],
    [
      'id',
      'mutationId',
      'patchDigest',
      'previewDigest',
      'ops',
      'impactSummary',
      'impact',
      'impactTruncated',
      'uncertainties',
      'authorizationIds',
      'workflowAcknowledged',
      'createdAt',
    ],
    path,
  );
  id(value.id, `${path}.id`, 'reconciliation');
  id(value.mutationId, `${path}.mutationId`, 'event');
  hash(value.patchDigest, `${path}.patchDigest`);
  hash(value.previewDigest, `${path}.previewDigest`);
  if (!Array.isArray(value.ops) || value.ops.length === 0)
    throw new TaskStateError(
      'A reconciliation must apply at least one op.',
      'TASK_STATE_INVALID',
      `${path}.ops`,
    );
  if (value.ops.length > MAX_RECONCILE_PATCH_OPS)
    throw new TaskStateError(
      'Reconciliation has too many ops.',
      'TASK_RECORD_LIMIT_EXCEEDED',
      `${path}.ops`,
    );
  value.ops.forEach((item, index) => validateReconcileOpSummary(item, `${path}.ops[${index}]`));
  keys(
    value.impactSummary,
    ['directlyAffected', 'declaredDependent', 'potentiallyAffected', 'unchanged'],
    ['directlyAffected', 'declaredDependent', 'potentiallyAffected', 'unchanged'],
    `${path}.impactSummary`,
  );
  integer(value.impactSummary.directlyAffected, `${path}.impactSummary.directlyAffected`);
  integer(value.impactSummary.declaredDependent, `${path}.impactSummary.declaredDependent`);
  integer(value.impactSummary.potentiallyAffected, `${path}.impactSummary.potentiallyAffected`);
  integer(value.impactSummary.unchanged, `${path}.impactSummary.unchanged`);
  if (!Array.isArray(value.impact))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', `${path}.impact`);
  if (value.impact.length > MAX_RECONCILE_IMPACT_ENTRIES)
    throw new TaskStateError(
      'Reconciliation retains too many impact entries.',
      'TASK_RECORD_LIMIT_EXCEEDED',
      `${path}.impact`,
    );
  value.impact.forEach((item, index) => validateImpactEntry(item, `${path}.impact[${index}]`));
  boolean(value.impactTruncated, `${path}.impactTruncated`);
  if (!Array.isArray(value.uncertainties))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', `${path}.uncertainties`);
  value.uncertainties.forEach((item, index) =>
    validateUncertainty(item, `${path}.uncertainties[${index}]`),
  );
  if (
    !Array.isArray(value.authorizationIds) ||
    value.authorizationIds.some((item) => typeof item !== 'string')
  )
    throw new TaskStateError(
      'Expected an array of authorization IDs.',
      'TASK_STATE_INVALID',
      `${path}.authorizationIds`,
    );
  value.authorizationIds.forEach((item, index) =>
    id(item, `${path}.authorizationIds[${index}]`, 'authorization'),
  );
  boolean(value.workflowAcknowledged, `${path}.workflowAcknowledged`);
  timestamp(value.createdAt, `${path}.createdAt`);
}

function validateTaskReconciliations(value: TaskReconciliation[], path: string) {
  if (!Array.isArray(value))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', path);
  if (value.length > MAX_RECONCILIATIONS_PER_TASK)
    throw new TaskStateError(
      'Task has too many reconciliations.',
      'TASK_RECORD_LIMIT_EXCEEDED',
      path,
    );
  value.forEach((item, index) => validateTaskReconciliation(item, `${path}[${index}]`));
  unique(value, 'id', path);
}

function validateTask(value: Task, path: string, schemaVersion: number) {
  const fields = [
    'id',
    'title',
    'state',
    'revision',
    'createdAt',
    'updatedAt',
    'authorizationRequired',
    'authorizations',
    'owner',
    'criteria',
    'runs',
    'checkpoints',
    'evidence',
    'events',
    'import',
  ];
  if (schemaVersion >= 2) fields.push('enhancedWorkflow');
  if (schemaVersion >= 3) fields.push('verificationMode');
  if (schemaVersion >= 4) fields.push('records');
  if (schemaVersion >= 5) fields.push('reconciliations');
  keys(value, fields, fields, path);
  id(value.id, `${path}.id`, 'task');
  string(value.title, `${path}.title`);
  if (!TASK_STATES.includes(value.state))
    throw new TaskStateError('Unknown task state.', 'TASK_STATE_INVALID', `${path}.state`);
  integer(value.revision, `${path}.revision`, 1);
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
  boolean(value.authorizationRequired, `${path}.authorizationRequired`);
  for (const field of [
    'authorizations',
    'criteria',
    'runs',
    'checkpoints',
    'evidence',
    'events',
  ] as const) {
    if (!Array.isArray(value[field]))
      throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', `${path}.${field}`);
  }
  value.authorizations.forEach((item, index) =>
    validateAuthorization(item, `${path}.authorizations[${index}]`),
  );
  value.criteria.forEach((item, index) => validateCriterion(item, `${path}.criteria[${index}]`));
  value.runs.forEach((item, index) => validateRun(item, `${path}.runs[${index}]`));
  value.checkpoints.forEach((item, index) =>
    validateCheckpoint(item, `${path}.checkpoints[${index}]`),
  );
  value.evidence.forEach((item, index) => validateEvidence(item, `${path}.evidence[${index}]`));
  if (schemaVersion === 1) {
    const enhancedIndex = value.evidence.findIndex((item) =>
      item.kind.startsWith('enhanced-check:'),
    );
    if (enhancedIndex !== -1)
      throw new TaskStateError(
        'Enhanced check evidence requires task-state schema version 2.',
        'TASK_STATE_INVALID',
        `${path}.evidence[${enhancedIndex}].kind`,
      );
  }
  value.events.forEach((item, index) => validateEvent(item, `${path}.events[${index}]`));
  for (const field of [
    'authorizations',
    'criteria',
    'runs',
    'checkpoints',
    'evidence',
    'events',
  ] as const)
    unique(value[field], 'id', `${path}.${field}`);
  validateOwner(value.owner, `${path}.owner`);
  validateImport(value.import, `${path}.import`);
  if (schemaVersion >= 2)
    validateEnhancedWorkflow(value.enhancedWorkflow ?? null, value, `${path}.enhancedWorkflow`);
  if (schemaVersion >= 3 && !isVerificationMode(value.verificationMode))
    throw new TaskStateError(
      'verificationMode must be fast or standard.',
      'TASK_STATE_INVALID',
      `${path}.verificationMode`,
    );
  if (schemaVersion >= 4) validateTaskRecords(value.records ?? [], value, `${path}.records`);
  if (schemaVersion >= 5)
    validateTaskReconciliations(value.reconciliations ?? [], `${path}.reconciliations`);
  const runs = new Map(value.runs.map((item) => [item.id, item]));
  const criteria = new Map(value.criteria.map((item) => [item.id, item]));
  const authorizations = new Set(value.authorizations.map((item) => item.id));
  const running = value.runs.filter((item) => item.state === 'running');
  if (
    (value.state === 'running') !== (value.owner !== null) ||
    running.length !== (value.owner ? 1 : 0)
  ) {
    throw new TaskStateError(
      'Running state, ownership, and active run must agree.',
      'TASK_STATE_INVALID',
      `${path}.owner`,
    );
  }
  if (value.owner) {
    const run = runs.get(value.owner.runId);
    if (
      !run ||
      run.ownerId !== value.owner.ownerId ||
      run.state !== 'running' ||
      value.owner.revision > value.revision
    ) {
      throw new TaskStateError(
        'Owner must reference the active run and a committed task revision.',
        'TASK_STATE_INVALID',
        `${path}.owner`,
      );
    }
  }
  value.checkpoints.forEach((item, index) => {
    if (!runs.has(item.runId) || item.taskRevision > value.revision) {
      throw new TaskStateError(
        'Checkpoint references an unknown run or future revision.',
        'TASK_STATE_INVALID',
        `${path}.checkpoints[${index}]`,
      );
    }
  });
  value.evidence.forEach((item, index) => {
    const criterion = criteria.get(item.criterionId);
    if (
      !runs.has(item.runId) ||
      !criterion ||
      item.criterionRevision > criterion.revision ||
      (item.authorizationId !== null && !authorizations.has(item.authorizationId))
    ) {
      throw new TaskStateError(
        'Evidence contains an unknown or future reference.',
        'TASK_STATE_INVALID',
        `${path}.evidence[${index}]`,
      );
    }
    if ((item.kind === 'approval') !== (item.authorizationId !== null)) {
      throw new TaskStateError(
        'Only approval evidence may reference authorization.',
        'TASK_STATE_INVALID',
        `${path}.evidence[${index}].authorizationId`,
      );
    }
  });
  value.events.forEach((event, index) => {
    if (event.taskRevision !== index + 1 || (event.runId !== null && !runs.has(event.runId))) {
      throw new TaskStateError(
        'Events must form a contiguous revision history with valid run references.',
        'TASK_STATE_INVALID',
        `${path}.events[${index}]`,
      );
    }
  });
  if (value.events.length !== value.revision) {
    throw new TaskStateError(
      'Task revision must equal its committed event count.',
      'TASK_STATE_INVALID',
      `${path}.revision`,
    );
  }
  if (schemaVersion >= 5) {
    const eventIds = new Set(value.events.map((item) => item.id));
    (value.reconciliations ?? []).forEach((item, index) => {
      if (!eventIds.has(item.mutationId))
        throw new TaskStateError(
          'Reconciliation must reference a committed task event.',
          'TASK_STATE_INVALID',
          `${path}.reconciliations[${index}].mutationId`,
        );
      for (const authorizationId of item.authorizationIds) {
        if (!authorizations.has(authorizationId))
          throw new TaskStateError(
            'Reconciliation references an unknown authorization.',
            'TASK_STATE_INVALID',
            `${path}.reconciliations[${index}].authorizationIds`,
          );
      }
    });
  }
  return value;
}

export function validateTaskState(input: unknown): TaskState {
  keys(
    input,
    ['schemaVersion', 'project', 'revision', 'createdAt', 'updatedAt', 'tasks'],
    ['schemaVersion', 'project', 'revision', 'createdAt', 'updatedAt', 'tasks'],
    '$',
  );
  // Treat fields as candidates while every field and relationship is checked below.
  // The document leaves this boundary only after the complete runtime validation.
  const value = input as TaskState;
  if (!SUPPORTED_TASK_STATE_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    throw new TaskStateError(
      `Unsupported task-state schema version ${value.schemaVersion}.`,
      'TASK_STATE_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  }
  keys(value.project, ['id', 'createdAt'], ['id', 'createdAt'], '$.project');
  id(value.project.id, '$.project.id', 'project');
  timestamp(value.project.createdAt, '$.project.createdAt');
  integer(value.revision, '$.revision', 0);
  timestamp(value.createdAt, '$.createdAt');
  timestamp(value.updatedAt, '$.updatedAt');
  if (!Array.isArray(value.tasks))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', '$.tasks');
  value.tasks.forEach((task, index) =>
    validateTask(task, `$.tasks[${index}]`, value.schemaVersion),
  );
  unique(value.tasks, 'id', '$.tasks');
  if (value.revision !== value.tasks.reduce((total, task) => total + task.revision, 0)) {
    throw new TaskStateError(
      'Store revision must equal the committed task revisions.',
      'TASK_STATE_INVALID',
      '$.revision',
    );
  }
  return value;
}

export function parseTaskState(raw: string): TaskState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new TaskStateError(`Invalid JSON (${errorMessage(error)}).`, 'TASK_STATE_INVALID_JSON');
  }
  return validateTaskState(value);
}

export function validateStableId(value: unknown, prefix: string, path = '$.id') {
  return id(value, path, prefix);
}
