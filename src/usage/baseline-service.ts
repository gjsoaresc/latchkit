import { randomUUID } from 'node:crypto';
import { withTaskStateLock } from '../task-state/lock.js';
import { isRecord } from '../types.js';
import {
  SAVINGS_BASELINE_EXPORT_SCHEMA_VERSION,
  SAVINGS_BASELINE_KINDS,
  SAVINGS_BASELINE_SCHEMA_VERSION,
  SAVINGS_IDENTIFIER_PATTERN,
  SAVINGS_SECRET_PATTERN,
  SAVINGS_TOKEN_FIELDS,
  SAVINGS_UNITS,
  SavingsBaselineError,
  validateSavingsBaseline,
  validateSavingsBaselineExport,
} from './baseline-contracts.js';
import type { SavingsBaseline, SavingsBaselineState } from './baseline-contracts.js';
import { readSavingsBaselineState, writeSavingsBaselineState } from './baseline-store.js';

type ClockOptions = { clock?: () => Date };
const iso = (clock: () => Date) => clock().toISOString();

export type SavingsBaselineInput = {
  label?: unknown;
  kind?: unknown;
  source?: unknown;
  scope?: unknown;
  providerSettings?: unknown;
  units?: unknown;
  tokenField?: unknown;
  amount?: unknown;
  currency?: unknown;
  assumptions?: unknown;
  pricing?: unknown;
};

function requiredString(value: unknown, path: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new SavingsBaselineError(
      `Expected a non-empty string of at most ${max} characters.`,
      'SAVINGS_BASELINE_INVALID',
      path,
    );
  return value;
}
function optionalString(value: unknown, path: string, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, path, max);
}
function requiredIso(value: unknown, path: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new SavingsBaselineError('Expected an ISO date-time.', 'SAVINGS_BASELINE_INVALID', path);
  return value;
}
function scope(input: unknown, path: string) {
  if (!isRecord(input))
    throw new SavingsBaselineError('Expected a scope object.', 'SAVINGS_BASELINE_INVALID', path);
  const from =
    input.from === undefined || input.from === null
      ? null
      : requiredIso(input.from, `${path}.from`);
  const to =
    input.to === undefined || input.to === null ? null : requiredIso(input.to, `${path}.to`);
  if (from && to && Date.parse(from) > Date.parse(to))
    throw new SavingsBaselineError(
      'The scope start must not be after its end.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.from`,
    );
  const taskIdsRaw = input.taskIds;
  const taskIds = taskIdsRaw === undefined ? [] : taskIdsRaw;
  if (!Array.isArray(taskIds))
    throw new SavingsBaselineError(
      'Expected an array of task IDs.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.taskIds`,
    );
  const cleanTaskIds = taskIds.map((taskId, index) => {
    if (
      typeof taskId !== 'string' ||
      !SAVINGS_IDENTIFIER_PATTERN.test(taskId) ||
      SAVINGS_SECRET_PATTERN.test(taskId)
    )
      throw new SavingsBaselineError(
        'Expected a safe task identifier.',
        'SAVINGS_BASELINE_INVALID',
        `${path}.taskIds[${index}]`,
      );
    return taskId;
  });
  const description = requiredString(input.description, `${path}.description`, 4000);
  if (!cleanTaskIds.length && !(from && to))
    throw new SavingsBaselineError(
      'A baseline requires an explicit comparison period (from/to) or a task scope (taskIds).',
      'SAVINGS_BASELINE_INVALID',
      path,
    );
  return { from, to, taskIds: cleanTaskIds, description };
}
function providerSettings(input: unknown, path: string) {
  if (input === undefined || input === null) return { provider: null, model: null, notes: '' };
  if (!isRecord(input))
    throw new SavingsBaselineError(
      'Expected a provider settings object.',
      'SAVINGS_BASELINE_INVALID',
      path,
    );
  return {
    provider: optionalString(input.provider, `${path}.provider`, 100),
    model: optionalString(input.model, `${path}.model`, 200),
    notes:
      input.notes === undefined || input.notes === null || input.notes === ''
        ? ''
        : requiredString(input.notes, `${path}.notes`, 4000),
  };
}
function pricing(input: unknown, path: string) {
  if (input === undefined || input === null) return null;
  if (!isRecord(input))
    throw new SavingsBaselineError('Expected a pricing object.', 'SAVINGS_BASELINE_INVALID', path);
  const sourceUrl = requiredString(input.sourceUrl, `${path}.sourceUrl`, 2000);
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new SavingsBaselineError(
      'Expected a valid pricing source URL.',
      'SAVINGS_BASELINE_INVALID',
      `${path}.sourceUrl`,
    );
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new SavingsBaselineError(
      'Pricing source must be a public HTTPS URL without credentials.',
      'SAVINGS_BASELINE_REDACTED',
      `${path}.sourceUrl`,
    );
  const sourceVersion = requiredString(input.sourceVersion, `${path}.sourceVersion`, 200);
  const asOf = requiredIso(input.asOf, `${path}.asOf`);
  if (SAVINGS_SECRET_PATTERN.test(`${sourceUrl} ${sourceVersion}`))
    throw new SavingsBaselineError(
      'Pricing metadata must not contain credential material.',
      'SAVINGS_BASELINE_REDACTED',
      path,
    );
  return { sourceUrl, sourceVersion, asOf };
}
function buildBaseline(
  input: SavingsBaselineInput,
  existing: SavingsBaseline | null,
  clock: () => Date,
): SavingsBaseline {
  const kind = input.kind;
  if (typeof kind !== 'string' || !SAVINGS_BASELINE_KINDS.includes(kind))
    throw new SavingsBaselineError('Unknown baseline kind.', 'SAVINGS_BASELINE_INVALID', '$.kind');
  const units = input.units;
  if (typeof units !== 'string' || !SAVINGS_UNITS.includes(units))
    throw new SavingsBaselineError('Unknown units.', 'SAVINGS_BASELINE_INVALID', '$.units');
  let tokenField: SavingsBaseline['tokenField'] = null;
  if (units === 'tokens') {
    if (typeof input.tokenField !== 'string' || !SAVINGS_TOKEN_FIELDS.includes(input.tokenField))
      throw new SavingsBaselineError(
        'A token-unit baseline requires a known token field.',
        'SAVINGS_BASELINE_INVALID',
        '$.tokenField',
      );
    tokenField = input.tokenField as SavingsBaseline['tokenField'];
  } else if (input.tokenField !== undefined && input.tokenField !== null)
    throw new SavingsBaselineError(
      'tokenField must be omitted for a monetary baseline.',
      'SAVINGS_BASELINE_INVALID',
      '$.tokenField',
    );
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0)
    throw new SavingsBaselineError(
      'Expected a non-negative amount.',
      'SAVINGS_BASELINE_INVALID',
      '$.amount',
    );
  let currency: SavingsBaseline['currency'] = null;
  if (units === 'usd') {
    if (input.currency !== undefined && input.currency !== 'USD')
      throw new SavingsBaselineError(
        'A monetary baseline requires currency "USD".',
        'SAVINGS_BASELINE_INVALID',
        '$.currency',
      );
    currency = 'USD';
  } else if (input.currency !== undefined && input.currency !== null)
    throw new SavingsBaselineError(
      'currency must be omitted for a token-unit baseline.',
      'SAVINGS_BASELINE_INVALID',
      '$.currency',
    );
  const at = iso(clock);
  const baseline: SavingsBaseline = {
    id: existing?.id ?? `baseline_${randomUUID()}`,
    schemaVersion: SAVINGS_BASELINE_SCHEMA_VERSION,
    label: requiredString(input.label, '$.label', 200),
    kind: kind as SavingsBaseline['kind'],
    source: requiredString(input.source, '$.source', 2000),
    scope: scope(input.scope, '$.scope'),
    providerSettings: providerSettings(input.providerSettings, '$.providerSettings'),
    units: units as SavingsBaseline['units'],
    tokenField,
    amount: input.amount,
    currency,
    assumptions: requiredString(input.assumptions, '$.assumptions', 4000),
    pricing: pricing(input.pricing, '$.pricing'),
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  };
  validateSavingsBaseline(baseline, '$');
  return baseline;
}
async function mutate<T>(root: string, operation: (state: SavingsBaselineState) => T | Promise<T>) {
  return withTaskStateLock(root, async () => {
    const state = await readSavingsBaselineState(root);
    const result = await operation(state);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    await writeSavingsBaselineState(root, state);
    return result;
  });
}
export async function listSavingsBaselines(root: string) {
  const state = await readSavingsBaselineState(root);
  return {
    project: state.project,
    revision: state.revision,
    baselines: structuredClone(state.baselines),
  };
}
export async function createSavingsBaseline(
  root: string,
  input: SavingsBaselineInput,
  { clock = () => new Date() }: ClockOptions = {},
) {
  const baseline = buildBaseline(input, null, clock);
  return mutate(root, (state) => {
    state.baselines.push(baseline);
    return structuredClone(baseline);
  });
}
export async function updateSavingsBaseline(
  root: string,
  id: string,
  input: SavingsBaselineInput,
  { clock = () => new Date() }: ClockOptions = {},
) {
  return mutate(root, (state) => {
    const index = state.baselines.findIndex((item) => item.id === id);
    if (index === -1)
      throw new SavingsBaselineError(
        'Savings baseline was not found.',
        'SAVINGS_BASELINE_NOT_FOUND',
        '$.id',
        404,
      );
    const updated = buildBaseline(input, state.baselines[index]!, clock);
    state.baselines[index] = updated;
    return structuredClone(updated);
  });
}
export async function deleteSavingsBaseline(root: string, id: string) {
  return mutate(root, (state) => {
    const before = state.baselines.length;
    state.baselines = state.baselines.filter((item) => item.id !== id);
    if (state.baselines.length === before)
      throw new SavingsBaselineError(
        'Savings baseline was not found.',
        'SAVINGS_BASELINE_NOT_FOUND',
        '$.id',
        404,
      );
    return { deleted: true };
  });
}
export async function exportSavingsBaselines(
  root: string,
  { clock = () => new Date() }: ClockOptions = {},
) {
  const state = await readSavingsBaselineState(root);
  return validateSavingsBaselineExport({
    schemaVersion: SAVINGS_BASELINE_EXPORT_SCHEMA_VERSION,
    exportedAt: iso(clock),
    project: state.project,
    baselines: state.baselines,
  });
}
