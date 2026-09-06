import { errorMessage } from '../types.js';

// A savings baseline is stored separately from the usage ledger
// (`.latchkit/usage/state-v1.json`) so this additive feature never changes
// the shape or validation of `UsageRecord`/`UsageState` in `./contracts.js`.
// Parallel usage-observation work can extend that ledger independently.
export const SAVINGS_BASELINE_SCHEMA_VERSION = 1;
export const SAVINGS_BASELINE_EXPORT_SCHEMA_VERSION = 1;
export const SAVINGS_BASELINES_PATH = '.latchkit/usage/baselines-v1.json';

export const SAVINGS_BASELINE_KINDS = Object.freeze(['paired', 'historical']);
export const SAVINGS_UNITS = Object.freeze(['usd', 'tokens']);
export const SAVINGS_TOKEN_FIELDS = Object.freeze([
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'thinking',
  'total',
]);

export type SavingsBaselineKind = 'paired' | 'historical';
export type SavingsUnits = 'usd' | 'tokens';
export type SavingsTokenField =
  'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'thinking' | 'total';

export type SavingsBaselineScope = {
  from: string | null;
  to: string | null;
  taskIds: string[];
  description: string;
};
export type SavingsProviderSettings = {
  provider: string | null;
  model: string | null;
  notes: string;
};
export type SavingsPricingProvenance = { sourceUrl: string; sourceVersion: string; asOf: string };
export type SavingsBaseline = {
  id: string;
  schemaVersion: 1;
  label: string;
  kind: SavingsBaselineKind;
  source: string;
  scope: SavingsBaselineScope;
  providerSettings: SavingsProviderSettings;
  units: SavingsUnits;
  tokenField: SavingsTokenField | null;
  amount: number;
  currency: 'USD' | null;
  assumptions: string;
  pricing: SavingsPricingProvenance | null;
  createdAt: string;
  updatedAt: string;
};
export type SavingsBaselineState = {
  schemaVersion: 1;
  project: { id: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  baselines: SavingsBaseline[];
};
export type SavingsBaselineExport = {
  schemaVersion: 1;
  exportedAt: string;
  project: { id: string };
  baselines: SavingsBaseline[];
};

export class SavingsBaselineError extends Error {
  code: string;
  path: string;
  status?: number;
  constructor(message: string, code = 'SAVINGS_BASELINE_INVALID', path = '$', status?: number) {
    super(`${path}: ${message}`);
    this.name = 'SavingsBaselineError';
    this.code = code;
    this.path = path;
    if (status !== undefined) this.status = status;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new SavingsBaselineError('Expected an ISO date-time.', 'SAVINGS_BASELINE_INVALID', path);
};
const nonempty = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !value.trim())
    throw new SavingsBaselineError(
      'Expected a non-empty string.',
      'SAVINGS_BASELINE_INVALID',
      path,
    );
};
function fields(value: unknown, names: string[], path: string) {
  if (!record(value))
    throw new SavingsBaselineError('Expected an object.', 'SAVINGS_BASELINE_INVALID', path);
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new SavingsBaselineError(
        `Unknown field "${key}".`,
        'SAVINGS_BASELINE_INVALID',
        `${path}.${key}`,
      );
  for (const key of names)
    if (!Object.hasOwn(value, key))
      throw new SavingsBaselineError(
        'Required field is missing.',
        'SAVINGS_BASELINE_INVALID',
        `${path}.${key}`,
      );
}
export const SAVINGS_SECRET_PATTERN =
  /(?:authorization|bearer|token|secret|password|api[_-]?key)\s*[=:]|\b(?:nvapi-|sk-)[A-Za-z0-9_-]{12,}/i;
export const SAVINGS_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:/-]{1,200}$/;

export function validateSavingsBaseline(item: SavingsBaseline, path: string) {
  fields(
    item,
    [
      'id',
      'schemaVersion',
      'label',
      'kind',
      'source',
      'scope',
      'providerSettings',
      'units',
      'tokenField',
      'amount',
      'currency',
      'assumptions',
      'pricing',
      'createdAt',
      'updatedAt',
    ],
    path,
  );
  nonempty(item.id, `${path}.id`);
  if (item.schemaVersion !== SAVINGS_BASELINE_SCHEMA_VERSION)
    throw new SavingsBaselineError(
      'Unsupported savings baseline schema version.',
      'SAVINGS_BASELINE_UNSUPPORTED_VERSION',
      `${path}.schemaVersion`,
    );
  nonempty(item.label, `${path}.label`);
  if (!SAVINGS_BASELINE_KINDS.includes(item.kind))
    throw new SavingsBaselineError(
      'Unknown baseline kind.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.kind`,
    );
  nonempty(item.source, `${path}.source`);
  fields(item.scope, ['from', 'to', 'taskIds', 'description'], `${path}.scope`);
  for (const [name, value] of Object.entries({ from: item.scope.from, to: item.scope.to }))
    if (value !== null) iso(value, `${path}.scope.${name}`);
  if (item.scope.from && item.scope.to && Date.parse(item.scope.from) > Date.parse(item.scope.to))
    throw new SavingsBaselineError(
      'The scope start must not be after its end.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.scope.from`,
    );
  if (!Array.isArray(item.scope.taskIds))
    throw new SavingsBaselineError(
      'Expected an array of task IDs.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.scope.taskIds`,
    );
  item.scope.taskIds.forEach((taskId, index) => {
    if (
      typeof taskId !== 'string' ||
      !SAVINGS_IDENTIFIER_PATTERN.test(taskId) ||
      SAVINGS_SECRET_PATTERN.test(taskId)
    )
      throw new SavingsBaselineError(
        'Expected a safe task identifier.',
        'SAVINGS_BASELINE_INVALID',
        `${path}.scope.taskIds[${index}]`,
      );
  });
  nonempty(item.scope.description, `${path}.scope.description`);
  if (!item.scope.taskIds.length && !(item.scope.from && item.scope.to))
    throw new SavingsBaselineError(
      'A baseline requires an explicit comparison period or a task scope.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.scope`,
    );
  fields(item.providerSettings, ['provider', 'model', 'notes'], `${path}.providerSettings`);
  for (const [name, value] of Object.entries({
    provider: item.providerSettings.provider,
    model: item.providerSettings.model,
  }))
    if (value !== null && typeof value !== 'string')
      throw new SavingsBaselineError(
        'Expected a string or null.',
        'SAVINGS_BASELINE_INVALID',
        `${path}.providerSettings.${name}`,
      );
  if (typeof item.providerSettings.notes !== 'string')
    throw new SavingsBaselineError(
      'Expected a string.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.providerSettings.notes`,
    );
  if (!SAVINGS_UNITS.includes(item.units))
    throw new SavingsBaselineError('Unknown units.', 'SAVINGS_BASELINE_INVALID', `${path}.units`);
  if (item.units === 'tokens') {
    if (typeof item.tokenField !== 'string' || !SAVINGS_TOKEN_FIELDS.includes(item.tokenField))
      throw new SavingsBaselineError(
        'A token-unit baseline requires a known token field.',
        'SAVINGS_BASELINE_INVALID',
        `${path}.tokenField`,
      );
  } else if (item.tokenField !== null)
    throw new SavingsBaselineError(
      'tokenField must be null for a monetary baseline.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.tokenField`,
    );
  if (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0)
    throw new SavingsBaselineError(
      'Expected a non-negative amount.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.amount`,
    );
  if (item.units === 'usd') {
    if (item.currency !== 'USD')
      throw new SavingsBaselineError(
        'A monetary baseline requires currency "USD".',
        'SAVINGS_BASELINE_INVALID',
        `${path}.currency`,
      );
  } else if (item.currency !== null)
    throw new SavingsBaselineError(
      'currency must be null for a token-unit baseline.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.currency`,
    );
  nonempty(item.assumptions, `${path}.assumptions`);
  if (item.pricing !== null) {
    fields(item.pricing, ['sourceUrl', 'sourceVersion', 'asOf'], `${path}.pricing`);
    nonempty(item.pricing.sourceUrl, `${path}.pricing.sourceUrl`);
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(item.pricing.sourceUrl);
    } catch {
      throw new SavingsBaselineError(
        'Expected a valid pricing source URL.',
        'SAVINGS_BASELINE_INVALID',
        `${path}.pricing.sourceUrl`,
      );
    }
    if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password)
      throw new SavingsBaselineError(
        'Pricing source must be a public HTTPS URL without credentials.',
        'SAVINGS_BASELINE_REDACTED',
        `${path}.pricing.sourceUrl`,
      );
    nonempty(item.pricing.sourceVersion, `${path}.pricing.sourceVersion`);
    iso(item.pricing.asOf, `${path}.pricing.asOf`);
    if (SAVINGS_SECRET_PATTERN.test(`${item.pricing.sourceUrl} ${item.pricing.sourceVersion}`))
      throw new SavingsBaselineError(
        'Pricing metadata must not contain credential material.',
        'SAVINGS_BASELINE_REDACTED',
        `${path}.pricing`,
      );
  }
  iso(item.createdAt, `${path}.createdAt`);
  iso(item.updatedAt, `${path}.updatedAt`);
}
export function validateSavingsBaselineState(input: unknown): SavingsBaselineState {
  const state = input as SavingsBaselineState;
  fields(
    state,
    ['schemaVersion', 'project', 'revision', 'createdAt', 'updatedAt', 'baselines'],
    '$',
  );
  if (state.schemaVersion !== SAVINGS_BASELINE_SCHEMA_VERSION)
    throw new SavingsBaselineError(
      'Unsupported savings baseline schema version.',
      'SAVINGS_BASELINE_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  fields(state.project, ['id'], '$.project');
  nonempty(state.project.id, '$.project.id');
  if (!Number.isInteger(state.revision) || state.revision < 0)
    throw new SavingsBaselineError(
      'Expected a non-negative revision.',
      'SAVINGS_BASELINE_INVALID',
      '$.revision',
    );
  iso(state.createdAt, '$.createdAt');
  iso(state.updatedAt, '$.updatedAt');
  if (!Array.isArray(state.baselines))
    throw new SavingsBaselineError(
      'Expected a baselines array.',
      'SAVINGS_BASELINE_INVALID',
      '$.baselines',
    );
  const ids = new Set<string>();
  state.baselines.forEach((item, index) => {
    validateSavingsBaseline(item, `$.baselines[${index}]`);
    if (ids.has(item.id))
      throw new SavingsBaselineError(
        'Duplicate baseline ID.',
        'SAVINGS_BASELINE_INVALID',
        `$.baselines[${index}].id`,
      );
    ids.add(item.id);
  });
  return state;
}
export function parseSavingsBaselineState(raw: string) {
  try {
    return validateSavingsBaselineState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SavingsBaselineError) throw error;
    throw new SavingsBaselineError(
      `Invalid JSON (${errorMessage(error)}).`,
      'SAVINGS_BASELINE_INVALID_JSON',
    );
  }
}
export function validateSavingsBaselineExport(input: unknown): SavingsBaselineExport {
  const value = input as SavingsBaselineExport;
  fields(value, ['schemaVersion', 'exportedAt', 'project', 'baselines'], '$');
  if (value.schemaVersion !== SAVINGS_BASELINE_EXPORT_SCHEMA_VERSION)
    throw new SavingsBaselineError(
      'Unsupported savings baseline export schema version.',
      'SAVINGS_BASELINE_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  validateSavingsBaselineState({
    schemaVersion: value.schemaVersion,
    project: value.project,
    revision: 0,
    createdAt: value.exportedAt,
    updatedAt: value.exportedAt,
    baselines: value.baselines,
  });
  return value;
}
