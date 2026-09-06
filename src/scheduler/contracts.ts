import { createHash } from 'node:crypto';

export const SCHEDULE_PATH = '.latchkit/schedules/state-v1.json';
export const SCHEDULE_SCHEMA_VERSION = 1;
export const MAX_SCHEDULE_BYTES = 4 * 1024 * 1024;
export const SCHEDULE_FAILURE_CODES = [
  'EPERM',
  'EACCES',
  'ENOENT',
  'ENOTEMPTY',
  'EBUSY',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'TASK_STATE_BUSY',
  'TASK_STATE_LOCK_AMBIGUOUS',
  'TASK_STATE_LOCK_INVALID',
  'TASK_REVISION_CONFLICT',
  'TASK_OWNERSHIP_CONFLICT',
  'TASK_EXECUTION_BUSY',
  'TASK_AUTHORIZATION_REQUIRED',
  'TASK_TRANSITION_INVALID',
  'TASK_NOT_FOUND',
  'PROVIDER_UNAVAILABLE',
  'CAPABILITY_UNAVAILABLE',
  'EXECUTION_PROFILE_UNAVAILABLE',
  'EXECUTION_AUTHORIZATION_REQUIRED',
  'PROVIDER_CONTRACT_INVALID',
  'SCHEDULE_EXECUTION_FAILED',
] as const;
type ScheduleFailureCode = (typeof SCHEDULE_FAILURE_CODES)[number];
export function scheduleFailureCode(error: unknown): ScheduleFailureCode {
  const code = (error as { code?: unknown } | null)?.code;
  return SCHEDULE_FAILURE_CODES.find((allowed) => allowed === code) ?? 'SCHEDULE_EXECUTION_FAILED';
}
export type ScheduleRun = {
  id: string;
  taskId: string | null;
  cancelRequestedAt: string | null;
  state:
    | 'running'
    | 'completed'
    | 'failed'
    | 'timed-out'
    | 'cancelled'
    | 'blocked'
    | 'interrupted'
    | 'skipped';
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  result: {
    status: string;
    exitCode: number | null;
    outputBytes: number;
    code?: ScheduleFailureCode;
  } | null;
};
export type Schedule = {
  id: string;
  revision: number;
  enabled: boolean;
  timezone: string;
  everyMinutes: number;
  nextRunAt: string;
  targetProject: string;
  providerId: string;
  instructions: string;
  authorization: { scope: string; reference: string; executionAuthorized: boolean };
  authorizedDefinitionSha256: string;
  limits: { timeoutMs: number; outputLimitBytes: number; maxRuns: number };
  overlap: 'skip';
  missedRun: 'skip';
  runs: ScheduleRun[];
  createdAt: string;
  updatedAt: string;
};
export type SchedulerState = {
  schemaVersion: 1;
  project: { id: string };
  revision: number;
  schedules: Schedule[];
  createdAt: string;
  updatedAt: string;
};
export class SchedulerError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'SCHEDULER_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'SchedulerError';
    this.code = code;
    this.path = path;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value: unknown, path: string) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new SchedulerError('Expected an ISO date-time.', 'SCHEDULER_INVALID', path);
};
const text = (value: unknown, path: string) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 16 * 1024 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    })
  )
    throw new SchedulerError('Expected a non-empty string.', 'SCHEDULER_INVALID', path);
};
const secret = /(?:authorization|bearer|token|secret|password|api[_-]?key)\s*[=:]/i;
function fields(value: unknown, names: string[], path: string) {
  if (!record(value)) throw new SchedulerError('Expected an object.', 'SCHEDULER_INVALID', path);
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new SchedulerError(`Unknown field "${key}".`, 'SCHEDULER_INVALID', `${path}.${key}`);
  for (const key of names)
    if (!Object.hasOwn(value, key))
      throw new SchedulerError('Required field is missing.', 'SCHEDULER_INVALID', `${path}.${key}`);
}
function positive(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new SchedulerError('Expected a positive integer.', 'SCHEDULER_INVALID', path);
}
function validateRun(run: ScheduleRun, path: string) {
  fields(
    run,
    ['id', 'taskId', 'cancelRequestedAt', 'state', 'startedAt', 'endedAt', 'reason', 'result'],
    path,
  );
  text(run.id, `${path}.id`);
  if (!/^schedule_run_[0-9a-f-]{36}$/.test(run.id)) throw new SchedulerError('Invalid run ID.');
  if (run.taskId !== null && !/^task_[0-9a-f-]{36}$/.test(run.taskId))
    throw new SchedulerError('Invalid task ID.');
  if (run.cancelRequestedAt !== null) iso(run.cancelRequestedAt, `${path}.cancelRequestedAt`);
  if (
    ![
      'running',
      'completed',
      'failed',
      'timed-out',
      'cancelled',
      'blocked',
      'interrupted',
      'skipped',
    ].includes(run.state)
  )
    throw new SchedulerError('Unknown run state.', 'SCHEDULER_INVALID', `${path}.state`);
  iso(run.startedAt, `${path}.startedAt`);
  if ((run.state === 'running') !== (run.endedAt === null))
    throw new SchedulerError('Run terminal timestamp does not match its state.');
  if (run.endedAt !== null) iso(run.endedAt, `${path}.endedAt`);
  if (run.reason !== null) text(run.reason, `${path}.reason`);
  if (run.result !== null) {
    fields(
      run.result,
      ['status', 'exitCode', 'outputBytes', ...(Object.hasOwn(run.result, 'code') ? ['code'] : [])],
      `${path}.result`,
    );
    if (Object.hasOwn(run.result, 'code') && !SCHEDULE_FAILURE_CODES.includes(run.result.code!))
      throw new SchedulerError(
        'Unknown execution failure code.',
        'SCHEDULER_INVALID',
        `${path}.result.code`,
      );
    text(run.result.status, `${path}.result.status`);
    if (run.result.exitCode !== null && !Number.isSafeInteger(run.result.exitCode))
      throw new SchedulerError(
        'Expected exit code or null.',
        'SCHEDULER_INVALID',
        `${path}.result.exitCode`,
      );
    if (!Number.isSafeInteger(run.result.outputBytes) || run.result.outputBytes < 0)
      throw new SchedulerError(
        'Expected output byte count.',
        'SCHEDULER_INVALID',
        `${path}.result.outputBytes`,
      );
  }
}
function validateSchedule(schedule: Schedule, path: string) {
  const names = [
    'id',
    'revision',
    'enabled',
    'timezone',
    'everyMinutes',
    'nextRunAt',
    'targetProject',
    'providerId',
    'instructions',
    'authorization',
    'authorizedDefinitionSha256',
    'limits',
    'overlap',
    'missedRun',
    'runs',
    'createdAt',
    'updatedAt',
  ];
  fields(schedule, names, path);
  text(schedule.id, `${path}.id`);
  if (!/^schedule_[0-9a-f-]{36}$/.test(schedule.id))
    throw new SchedulerError('Invalid schedule ID.');
  positive(schedule.revision, `${path}.revision`);
  if (typeof schedule.enabled !== 'boolean')
    throw new SchedulerError('Expected boolean.', 'SCHEDULER_INVALID', `${path}.enabled`);
  text(schedule.timezone, `${path}.timezone`);
  try {
    Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone });
  } catch {
    throw new SchedulerError('Unknown IANA timezone.', 'SCHEDULER_INVALID', `${path}.timezone`);
  }
  positive(schedule.everyMinutes, `${path}.everyMinutes`);
  if (schedule.everyMinutes > 10080)
    throw new SchedulerError(
      'Recurrence exceeds one week.',
      'SCHEDULER_INVALID',
      `${path}.everyMinutes`,
    );
  iso(schedule.nextRunAt, `${path}.nextRunAt`);
  text(schedule.targetProject, `${path}.targetProject`);
  text(schedule.providerId, `${path}.providerId`);
  text(schedule.instructions, `${path}.instructions`);
  if (secret.test(schedule.instructions))
    throw new SchedulerError(
      'Instructions must not contain credential material.',
      'SCHEDULER_REDACTED',
      `${path}.instructions`,
    );
  if (schedule.instructions.length > 16 * 1024)
    throw new SchedulerError(
      'Instructions exceed 16 KiB.',
      'SCHEDULER_INVALID',
      `${path}.instructions`,
    );
  fields(
    schedule.authorization,
    ['scope', 'reference', 'executionAuthorized'],
    `${path}.authorization`,
  );
  text(schedule.authorization.scope, `${path}.authorization.scope`);
  text(schedule.authorization.reference, `${path}.authorization.reference`);
  if (secret.test(`${schedule.authorization.scope}\n${schedule.authorization.reference}`))
    throw new SchedulerError(
      'Authorization metadata must not contain credential material.',
      'SCHEDULER_REDACTED',
      `${path}.authorization`,
    );
  if (typeof schedule.authorization.executionAuthorized !== 'boolean')
    throw new SchedulerError(
      'Expected explicit execution authorization.',
      'SCHEDULER_INVALID',
      `${path}.authorization.executionAuthorized`,
    );
  fields(schedule.limits, ['timeoutMs', 'outputLimitBytes', 'maxRuns'], `${path}.limits`);
  positive(schedule.limits.timeoutMs, `${path}.limits.timeoutMs`);
  positive(schedule.limits.outputLimitBytes, `${path}.limits.outputLimitBytes`);
  positive(schedule.limits.maxRuns, `${path}.limits.maxRuns`);
  if (
    schedule.limits.timeoutMs > 86_400_000 ||
    schedule.limits.outputLimitBytes > 16 * 1024 * 1024 ||
    schedule.limits.maxRuns > 100
  )
    throw new SchedulerError(
      'Limits exceed 24 hours, 16 MiB output, or 100 retained runs.',
      'SCHEDULER_INVALID',
      `${path}.limits`,
    );
  if (schedule.authorizedDefinitionSha256 !== scheduleDefinitionDigest(schedule))
    throw new SchedulerError(
      'Execution definition no longer matches its explicit authorization record. Restore the inspected record before changing it through an explicit schedule edit.',
      'SCHEDULE_SCOPE_CHANGED',
    );
  if (schedule.overlap !== 'skip' || schedule.missedRun !== 'skip')
    throw new SchedulerError(
      'Only skip overlap and missed-run policies are supported.',
      'SCHEDULER_INVALID',
      path,
    );
  if (!Array.isArray(schedule.runs) || schedule.runs.length > 100)
    throw new SchedulerError('Expected at most 100 runs.', 'SCHEDULER_INVALID', `${path}.runs`);
  schedule.runs.forEach((run, index) => validateRun(run, `${path}.runs[${index}]`));
  if (
    new Set(schedule.runs.map((run) => run.id)).size !== schedule.runs.length ||
    schedule.runs.filter((run) => run.state === 'running').length > 1
  )
    throw new SchedulerError('Duplicate run identity or overlapping persisted runs.');
  iso(schedule.createdAt, `${path}.createdAt`);
  iso(schedule.updatedAt, `${path}.updatedAt`);
}
export function scheduleDefinitionDigest(schedule: Schedule): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        schedule.targetProject,
        schedule.providerId,
        schedule.timezone,
        schedule.everyMinutes,
        schedule.instructions,
        schedule.authorization.scope,
        schedule.authorization.reference,
        schedule.authorization.executionAuthorized,
        schedule.limits.timeoutMs,
        schedule.limits.outputLimitBytes,
        schedule.limits.maxRuns,
      ]),
    )
    .digest('hex');
}
export function validateSchedulerState(input: unknown): SchedulerState {
  const state = input as SchedulerState;
  fields(
    state,
    ['schemaVersion', 'project', 'revision', 'schedules', 'createdAt', 'updatedAt'],
    '$',
  );
  if (state.schemaVersion !== SCHEDULE_SCHEMA_VERSION)
    throw new SchedulerError(
      'Unsupported schedule schema version.',
      'SCHEDULER_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  fields(state.project, ['id'], '$.project');
  text(state.project.id, '$.project.id');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0)
    throw new SchedulerError('Expected non-negative revision.', 'SCHEDULER_INVALID', '$.revision');
  if (!Array.isArray(state.schedules) || state.schedules.length > 100)
    throw new SchedulerError('Expected schedules.', 'SCHEDULER_INVALID', '$.schedules');
  const ids = new Set<string>();
  state.schedules.forEach((schedule, index) => {
    validateSchedule(schedule, `$.schedules[${index}]`);
    if (ids.has(schedule.id))
      throw new SchedulerError(
        'Duplicate schedule ID.',
        'SCHEDULER_INVALID',
        `$.schedules[${index}].id`,
      );
    ids.add(schedule.id);
  });
  iso(state.createdAt, '$.createdAt');
  iso(state.updatedAt, '$.updatedAt');
  return state;
}
export function parseSchedulerState(raw: string) {
  try {
    if (Buffer.byteLength(raw) > MAX_SCHEDULE_BYTES)
      throw new SchedulerError('Schedule state exceeds 4 MiB.');
    return validateSchedulerState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('Schedule state is invalid JSON.', 'SCHEDULER_INVALID_JSON');
  }
}
