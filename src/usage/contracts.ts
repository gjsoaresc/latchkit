import { errorMessage } from '../types.js';

export const USAGE_SCHEMA_VERSION = 1;
export const USAGE_EXPORT_SCHEMA_VERSION = 1;
export const USAGE_PATH = '.latchkit/usage/state-v1.json';
export const USAGE_PROVIDERS = Object.freeze(['claude', 'codex']);

export type TokenTotals = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  thinking: number | null;
};
export type UsageEstimate = {
  amount: number;
  currency: 'USD';
  basis: 'public-api-list-price';
  sourceUrl: string;
  sourceVersion: string;
  asOf: string;
  assumptions: string;
};
export type UsageRecord = {
  id: string;
  deduplicationKey: string;
  provider: 'claude' | 'codex';
  providerVersion: string;
  model: string | null;
  taskId: string | null;
  sessionId: string | null;
  occurredAt: string;
  observedAt: string;
  status: 'measured' | 'partial' | 'unavailable';
  confidence: 'measured' | 'partial' | 'unavailable';
  unavailableReason: string | null;
  source: 'claude-result-json' | 'claude-observation-json' | 'codex-jsonl-turn-completed';
  tokens: TokenTotals;
  estimate: UsageEstimate | null;
  createdAt: string;
  updatedAt: string;
};
export type UsageSettings = { enabled: boolean; retentionDays: number };
export type UsageState = {
  schemaVersion: 1;
  project: { id: string };
  revision: number;
  settings: UsageSettings;
  createdAt: string;
  updatedAt: string;
  records: UsageRecord[];
};
export type UsageExport = {
  schemaVersion: 1;
  exportedAt: string;
  project: { id: string };
  settings: UsageSettings;
  records: UsageRecord[];
};

export class UsageError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'USAGE_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'UsageError';
    this.code = code;
    this.path = path;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new UsageError('Expected an ISO date-time.', 'USAGE_INVALID', path);
};
const nonempty = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !value.trim())
    throw new UsageError('Expected a non-empty string.', 'USAGE_INVALID', path);
};
function fields(value: unknown, names: string[], path: string) {
  if (!record(value)) throw new UsageError('Expected an object.', 'USAGE_INVALID', path);
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new UsageError(`Unknown field "${key}".`, 'USAGE_INVALID', `${path}.${key}`);
  for (const key of names)
    if (!Object.hasOwn(value, key))
      throw new UsageError('Required field is missing.', 'USAGE_INVALID', `${path}.${key}`);
}
function token(value: unknown, path: string) {
  if (value !== null && (!Number.isInteger(value) || (value as number) < 0))
    throw new UsageError('Expected a non-negative integer or null.', 'USAGE_INVALID', path);
}
function validateRecord(item: UsageRecord, path: string) {
  const names = [
    'id',
    'deduplicationKey',
    'provider',
    'providerVersion',
    'model',
    'taskId',
    'sessionId',
    'occurredAt',
    'observedAt',
    'status',
    'confidence',
    'unavailableReason',
    'source',
    'tokens',
    'estimate',
    'createdAt',
    'updatedAt',
  ];
  fields(item, names, path);
  nonempty(item.id, `${path}.id`);
  nonempty(item.deduplicationKey, `${path}.deduplicationKey`);
  if (!USAGE_PROVIDERS.includes(item.provider))
    throw new UsageError('Unknown provider.', 'USAGE_INVALID', `${path}.provider`);
  nonempty(item.providerVersion, `${path}.providerVersion`);
  for (const [name, value] of Object.entries({
    model: item.model,
    taskId: item.taskId,
    sessionId: item.sessionId,
    unavailableReason: item.unavailableReason,
  }))
    if (value !== null && typeof value !== 'string')
      throw new UsageError('Expected a string or null.', 'USAGE_INVALID', `${path}.${name}`);
  iso(item.occurredAt, `${path}.occurredAt`);
  iso(item.observedAt, `${path}.observedAt`);
  iso(item.createdAt, `${path}.createdAt`);
  iso(item.updatedAt, `${path}.updatedAt`);
  if (!['measured', 'partial', 'unavailable'].includes(item.status))
    throw new UsageError('Unknown usage status.', 'USAGE_INVALID', `${path}.status`);
  if (item.confidence !== item.status)
    throw new UsageError(
      'Confidence must match normalized usage status.',
      'USAGE_INVALID',
      `${path}.confidence`,
    );
  if (
    !['claude-result-json', 'claude-observation-json', 'codex-jsonl-turn-completed'].includes(
      item.source,
    )
  )
    throw new UsageError('Unknown source.', 'USAGE_INVALID', `${path}.source`);
  fields(
    item.tokens,
    ['input', 'output', 'cacheRead', 'cacheCreation', 'thinking'],
    `${path}.tokens`,
  );
  for (const [name, value] of Object.entries(item.tokens)) token(value, `${path}.tokens.${name}`);
  if (item.status === 'unavailable' && !item.unavailableReason)
    throw new UsageError(
      'Unavailable records require a reason.',
      'USAGE_INVALID',
      `${path}.unavailableReason`,
    );
  if (item.estimate !== null) {
    fields(
      item.estimate,
      ['amount', 'currency', 'basis', 'sourceUrl', 'sourceVersion', 'asOf', 'assumptions'],
      `${path}.estimate`,
    );
    if (
      typeof item.estimate.amount !== 'number' ||
      !Number.isFinite(item.estimate.amount) ||
      item.estimate.amount < 0
    )
      throw new UsageError(
        'Expected a non-negative estimate.',
        'USAGE_INVALID',
        `${path}.estimate.amount`,
      );
    if (item.estimate.currency !== 'USD' || item.estimate.basis !== 'public-api-list-price')
      throw new UsageError('Unsupported estimate basis.', 'USAGE_INVALID', `${path}.estimate`);
    nonempty(item.estimate.sourceUrl, `${path}.estimate.sourceUrl`);
    nonempty(item.estimate.sourceVersion, `${path}.estimate.sourceVersion`);
    nonempty(item.estimate.assumptions, `${path}.estimate.assumptions`);
    iso(item.estimate.asOf, `${path}.estimate.asOf`);
  }
}
export function validateUsageState(input: unknown): UsageState {
  const state = input as UsageState;
  fields(
    state,
    ['schemaVersion', 'project', 'revision', 'settings', 'createdAt', 'updatedAt', 'records'],
    '$',
  );
  if (state.schemaVersion !== USAGE_SCHEMA_VERSION)
    throw new UsageError(
      'Unsupported usage schema version.',
      'USAGE_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  fields(state.project, ['id'], '$.project');
  nonempty(state.project.id, '$.project.id');
  if (!Number.isInteger(state.revision) || state.revision < 0)
    throw new UsageError('Expected a non-negative revision.', 'USAGE_INVALID', '$.revision');
  fields(state.settings, ['enabled', 'retentionDays'], '$.settings');
  if (
    typeof state.settings.enabled !== 'boolean' ||
    !Number.isInteger(state.settings.retentionDays) ||
    state.settings.retentionDays < 1 ||
    state.settings.retentionDays > 365
  )
    throw new UsageError('Invalid local usage settings.', 'USAGE_INVALID', '$.settings');
  iso(state.createdAt, '$.createdAt');
  iso(state.updatedAt, '$.updatedAt');
  if (!Array.isArray(state.records))
    throw new UsageError('Expected records array.', 'USAGE_INVALID', '$.records');
  const keys = new Set<string>();
  state.records.forEach((item, index) => {
    validateRecord(item, `$.records[${index}]`);
    if (keys.has(item.deduplicationKey))
      throw new UsageError(
        'Duplicate deduplication key.',
        'USAGE_INVALID',
        `$.records[${index}].deduplicationKey`,
      );
    keys.add(item.deduplicationKey);
  });
  return state;
}
export function parseUsageState(raw: string) {
  try {
    return validateUsageState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid JSON (${errorMessage(error)}).`, 'USAGE_INVALID_JSON');
  }
}
export function validateUsageExport(input: unknown): UsageExport {
  const value = input as UsageExport;
  fields(value, ['schemaVersion', 'exportedAt', 'project', 'settings', 'records'], '$');
  if (value.schemaVersion !== USAGE_EXPORT_SCHEMA_VERSION)
    throw new UsageError(
      'Unsupported usage export schema version.',
      'USAGE_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  validateUsageState({
    schemaVersion: value.schemaVersion,
    project: value.project,
    revision: 0,
    settings: value.settings,
    createdAt: value.exportedAt,
    updatedAt: value.exportedAt,
    records: value.records,
  });
  return value;
}
