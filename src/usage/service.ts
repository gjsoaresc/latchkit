import { createHash, randomUUID } from 'node:crypto';
import { withTaskStateLock } from '../task-state/lock.js';
import { UsageError, validateUsageExport } from './contracts.js';
import type { TokenTotals, UsageEstimate, UsageRecord, UsageSettings } from './contracts.js';
import { readUsageState, writeUsageState } from './store.js';

type ClockOptions = { clock?: () => Date };
export type UsagePrice = {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
  cacheCreationUsdPerMillion?: number;
  sourceUrl: string;
  sourceVersion: string;
  asOf: string;
  assumptions: string;
};
export type ProviderUsageInput = {
  provider: string;
  providerVersion?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  output: unknown;
  observedAt?: string;
  price?: UsagePrice;
};
const iso = (clock: () => Date) => clock().toISOString();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = /(?:authorization|bearer|token|secret|password|api[_-]?key)\s*[=:]/i;
const nonnegative = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const jsonLines = (value: unknown) =>
  String(value ?? '')
    .split(/\r?\n/)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return asObject(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
function version(value: unknown): string | null {
  return typeof value === 'string' && /^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(value)
    ? value
    : null;
}
function totals(
  input: unknown,
  output: unknown,
  cacheRead: unknown,
  cacheCreation: unknown,
  thinking: unknown,
): TokenTotals {
  return {
    input: nonnegative(input),
    output: nonnegative(output),
    cacheRead: nonnegative(cacheRead),
    cacheCreation: nonnegative(cacheCreation),
    thinking: nonnegative(thinking),
  };
}
function status(tokens: TokenTotals): 'measured' | 'partial' {
  return Object.values(tokens).every((value) => value !== null) ? 'measured' : 'partial';
}
function unavailable(
  input: ProviderUsageInput,
  reason: string,
  source: UsageRecord['source'],
  clock: () => Date,
): UsageRecord {
  const at = input.observedAt ?? iso(clock);
  const provider = input.provider === 'claude' ? 'claude' : 'codex';
  const providerVersion = version(input.providerVersion) ?? 'unknown';
  const key = digest(
    JSON.stringify([
      provider,
      providerVersion,
      input.taskId ?? null,
      input.sessionId ?? null,
      at,
      source,
    ]),
  );
  return {
    id: `usage_${randomUUID()}`,
    deduplicationKey: key,
    provider,
    providerVersion,
    model: null,
    taskId: input.taskId ?? null,
    sessionId: input.sessionId ?? null,
    occurredAt: at,
    observedAt: at,
    status: 'unavailable',
    confidence: 'unavailable',
    unavailableReason: reason,
    source,
    tokens: totals(null, null, null, null, null),
    estimate: null,
    createdAt: at,
    updatedAt: at,
  };
}
function estimate(tokens: TokenTotals, price: UsagePrice | undefined): UsageEstimate | null {
  if (!price) return null;
  if (secret.test(`${price.sourceUrl} ${price.sourceVersion} ${price.assumptions}`))
    throw new UsageError(
      'Pricing metadata must not contain credential material.',
      'USAGE_REDACTED',
      '$.price',
    );
  const rates: Array<[number | null, number | undefined]> = [
    [tokens.input, price.inputUsdPerMillion],
    [tokens.output, price.outputUsdPerMillion],
    [tokens.cacheRead, price.cacheReadUsdPerMillion],
    [tokens.cacheCreation, price.cacheCreationUsdPerMillion],
  ];
  if (
    rates.some(
      ([count, rate]) =>
        count !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0),
    )
  )
    return null;
  const amount = rates.reduce(
    (total, [count, rate]) => total + ((count ?? 0) * (rate ?? 0)) / 1_000_000,
    0,
  );
  return {
    amount,
    currency: 'USD',
    basis: 'public-api-list-price',
    sourceUrl: price.sourceUrl,
    sourceVersion: price.sourceVersion,
    asOf: price.asOf,
    assumptions: `${price.assumptions} This is a public API list-price estimate; actual provider subscription billing is unknown.`,
  };
}
function parsed(
  input: ProviderUsageInput,
  source: UsageRecord['source'],
  model: unknown,
  occurredAt: unknown,
  values: TokenTotals,
  clock: () => Date,
): UsageRecord {
  const at =
    typeof occurredAt === 'string' && Number.isFinite(Date.parse(occurredAt))
      ? occurredAt
      : (input.observedAt ?? iso(clock));
  const providerVersion = version(input.providerVersion);
  if (!providerVersion)
    return unavailable(
      input,
      'Provider version is unknown or unsupported; usage was not inferred.',
      source,
      clock,
    );
  const sessionId = input.sessionId ?? null;
  const taskId = input.taskId ?? null;
  const normalizedModel =
    typeof model === 'string' && model.trim() && !secret.test(model) ? model : null;
  const key = digest(
    JSON.stringify([input.provider, providerVersion, sessionId, taskId, at, source]),
  );
  const resultStatus = status(values);
  return {
    id: `usage_${randomUUID()}`,
    deduplicationKey: key,
    provider: input.provider as 'claude' | 'codex',
    providerVersion,
    model: normalizedModel,
    taskId,
    sessionId,
    occurredAt: at,
    observedAt: input.observedAt ?? iso(clock),
    status: resultStatus,
    confidence: resultStatus,
    unavailableReason: null,
    source,
    tokens: values,
    estimate: estimate(values, input.price),
    createdAt: iso(clock),
    updatedAt: iso(clock),
  };
}
export function parseProviderUsage(
  input: ProviderUsageInput,
  { clock = () => new Date() }: ClockOptions = {},
): UsageRecord[] {
  const object = asObject(input.output);
  if (input.provider === 'claude') {
    const observedUsage = object ? asObject(object.usage) : null;
    if (object?.provider === 'claude' && observedUsage) {
      const usage = observedUsage;
      return [
        parsed(
          {
            ...input,
            providerVersion:
              input.providerVersion ??
              (typeof object.providerVersion === 'string' ? object.providerVersion : null),
          },
          'claude-observation-json',
          object.model,
          object.observedAt,
          totals(
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            asObject(usage.output_tokens_details)?.thinking_tokens,
          ),
          clock,
        ),
      ];
    }
    const result =
      object?.type === 'result'
        ? object
        : jsonLines(input.output).find((item) => item.type === 'result');
    if (!result || !asObject(result.usage))
      return [
        unavailable(
          input,
          'No documented Claude result usage event was present.',
          'claude-result-json',
          clock,
        ),
      ];
    const usage = asObject(result.usage)!;
    return [
      parsed(
        input,
        'claude-result-json',
        result.model,
        result.timestamp,
        totals(
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          asObject(usage.output_tokens_details)?.thinking_tokens,
        ),
        clock,
      ),
    ];
  }
  if (input.provider === 'codex') {
    const result = (object?.type === 'turn.completed' ? [object] : jsonLines(input.output)).filter(
      (item) => item.type === 'turn.completed' && asObject(item.usage),
    );
    if (!result.length)
      return [
        unavailable(
          input,
          'No documented Codex turn.completed usage event was present.',
          'codex-jsonl-turn-completed',
          clock,
        ),
      ];
    return result.map((event) => {
      const usage = event.usage as Record<string, unknown>;
      return parsed(
        input,
        'codex-jsonl-turn-completed',
        event.model,
        event.timestamp,
        totals(
          usage.input_tokens,
          usage.output_tokens,
          usage.cached_input_tokens,
          usage.cache_creation_input_tokens,
          usage.reasoning_output_tokens,
        ),
        clock,
      );
    });
  }
  throw new UsageError(
    'Only Claude and Codex documented usage formats are supported.',
    'USAGE_PROVIDER_UNSUPPORTED',
    '$.provider',
  );
}
async function mutate<T>(
  root: string,
  operation: (state: Awaited<ReturnType<typeof readUsageState>>) => T | Promise<T>,
) {
  return withTaskStateLock(root, async () => {
    const state = await readUsageState(root);
    const result = await operation(state);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    await writeUsageState(root, state);
    return result;
  });
}
function retain(state: Awaited<ReturnType<typeof readUsageState>>, clock: () => Date) {
  const cutoff = clock().getTime() - state.settings.retentionDays * 86_400_000;
  const before = state.records.length;
  state.records = state.records.filter((record) => Date.parse(record.occurredAt) >= cutoff);
  return before - state.records.length;
}
export async function inspectUsage(
  root: string,
  {
    includeUnavailable = true,
    clock = () => new Date(),
  }: { includeUnavailable?: boolean } & ClockOptions = {},
) {
  const state = await readUsageState(root, { clock });
  const records = state.records.filter(
    (item) =>
      Date.parse(item.occurredAt) >=
        clock().getTime() - state.settings.retentionDays * 86_400_000 &&
      (includeUnavailable || item.status !== 'unavailable'),
  );
  const tokens = records.reduce(
    (total, item) => {
      for (const key of Object.keys(total) as Array<keyof TokenTotals>)
        total[key] += item.tokens[key] ?? 0;
      return total;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 },
  );
  return {
    project: state.project,
    revision: state.revision,
    settings: state.settings,
    billing: {
      status: 'unknown',
      reason: 'Provider subscriptions and actual charges are not collected or inferred.',
    },
    records: structuredClone(records),
    summary: {
      records: records.length,
      unavailable: records.filter((item) => item.status === 'unavailable').length,
      tokens,
      estimatedPublicApiListPriceUsd: records.reduce(
        (sum, item) => sum + (item.estimate?.amount ?? 0),
        0,
      ),
      estimates: records.filter((item) => item.estimate !== null).map((item) => item.estimate),
    },
  };
}
export async function configureUsage(
  root: string,
  settings: Partial<UsageSettings>,
  { clock = () => new Date() }: ClockOptions = {},
) {
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean')
    throw new UsageError('enabled must be boolean.', 'USAGE_INVALID', '$.enabled');
  if (
    settings.retentionDays !== undefined &&
    (!Number.isInteger(settings.retentionDays) ||
      settings.retentionDays < 1 ||
      settings.retentionDays > 365)
  )
    throw new UsageError(
      'retentionDays must be between 1 and 365.',
      'USAGE_INVALID',
      '$.retentionDays',
    );
  return mutate(root, (state) => {
    state.settings = { ...state.settings, ...settings };
    const removed = retain(state, clock);
    return { settings: structuredClone(state.settings), removed };
  });
}
export async function recordProviderUsage(
  root: string,
  input: ProviderUsageInput,
  options: ClockOptions = {},
) {
  const current = await readUsageState(root, options);
  if (!current.settings.enabled)
    return { status: 'disabled' as const, records: [] as UsageRecord[] };
  const records = parseProviderUsage(input, options);
  return mutate(root, (state) => {
    if (!state.settings.enabled)
      return { status: 'disabled' as const, records: [] as UsageRecord[] };
    retain(state, options.clock ?? (() => new Date()));
    const stored: UsageRecord[] = [];
    for (const candidate of records) {
      const index = state.records.findIndex(
        (item) => item.deduplicationKey === candidate.deduplicationKey,
      );
      if (index === -1) {
        state.records.push(candidate);
        stored.push(candidate);
      } else if (Date.parse(candidate.observedAt) >= Date.parse(state.records[index]!.observedAt)) {
        candidate.id = state.records[index]!.id;
        candidate.createdAt = state.records[index]!.createdAt;
        state.records[index] = candidate;
        stored.push(candidate);
      } else stored.push(state.records[index]!);
    }
    return { status: 'recorded' as const, records: structuredClone(stored) };
  });
}
export async function exportUsage(root: string, { clock = () => new Date() }: ClockOptions = {}) {
  const state = await readUsageState(root, { clock });
  retain(state, clock);
  return validateUsageExport({
    schemaVersion: 1,
    exportedAt: iso(clock),
    project: state.project,
    settings: state.settings,
    records: state.records,
  });
}
export async function deleteUsage(root: string) {
  return mutate(root, (state) => {
    const deleted = state.records.length;
    state.records = [];
    return { deleted };
  });
}
export async function enforceUsageRetention(
  root: string,
  { clock = () => new Date() }: ClockOptions = {},
) {
  return mutate(root, (state) => ({ removed: retain(state, clock) }));
}
