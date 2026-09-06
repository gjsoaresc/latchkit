import { errorMessage } from '../types.js';

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
};
export type TaskState = {
  schemaVersion: number;
  project: { id: string; createdAt: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
};

export const TASK_STATE_SCHEMA_VERSION = 2;
export const SUPPORTED_TASK_STATE_SCHEMA_VERSIONS = Object.freeze([1, 2]);

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
  /^(project|task|run|criterion|checkpoint|evidence|authorization|owner|event)_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
      ['id', 'criterionId', 'type', 'definitionSha256'],
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
