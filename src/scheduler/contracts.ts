import { errorMessage } from '../types.js';

export const SCHEDULE_PATH = '.latchkit/schedules/state-v1.json';
export const SCHEDULE_SCHEMA_VERSION = 1;
export type ScheduleRun = {
  id: string;
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
  result: { status: string; exitCode: number | null; outputBytes: number } | null;
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
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new SchedulerError('Expected an ISO date-time.', 'SCHEDULER_INVALID', path);
};
const text = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !value.trim())
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
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new SchedulerError('Expected a positive integer.', 'SCHEDULER_INVALID', path);
}
function validateRun(run: ScheduleRun, path: string) {
  fields(run, ['id', 'state', 'startedAt', 'endedAt', 'reason', 'result'], path);
  text(run.id, `${path}.id`);
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
  if (run.endedAt !== null) iso(run.endedAt, `${path}.endedAt`);
  if (run.reason !== null) text(run.reason, `${path}.reason`);
  if (run.result !== null) {
    fields(run.result, ['status', 'exitCode', 'outputBytes'], `${path}.result`);
    text(run.result.status, `${path}.result.status`);
    if (run.result.exitCode !== null && !Number.isInteger(run.result.exitCode))
      throw new SchedulerError(
        'Expected exit code or null.',
        'SCHEDULER_INVALID',
        `${path}.result.exitCode`,
      );
    if (!Number.isInteger(run.result.outputBytes) || run.result.outputBytes < 0)
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
    'limits',
    'overlap',
    'missedRun',
    'runs',
    'createdAt',
    'updatedAt',
  ];
  fields(schedule, names, path);
  text(schedule.id, `${path}.id`);
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
  if (schedule.overlap !== 'skip' || schedule.missedRun !== 'skip')
    throw new SchedulerError(
      'Only skip overlap and missed-run policies are supported.',
      'SCHEDULER_INVALID',
      path,
    );
  if (!Array.isArray(schedule.runs) || schedule.runs.length > 100)
    throw new SchedulerError('Expected at most 100 runs.', 'SCHEDULER_INVALID', `${path}.runs`);
  schedule.runs.forEach((run, index) => validateRun(run, `${path}.runs[${index}]`));
  iso(schedule.createdAt, `${path}.createdAt`);
  iso(schedule.updatedAt, `${path}.updatedAt`);
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
  if (!Number.isInteger(state.revision) || state.revision < 0)
    throw new SchedulerError('Expected non-negative revision.', 'SCHEDULER_INVALID', '$.revision');
  if (!Array.isArray(state.schedules))
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
    return validateSchedulerState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(`Invalid JSON (${errorMessage(error)}).`, 'SCHEDULER_INVALID_JSON');
  }
}
