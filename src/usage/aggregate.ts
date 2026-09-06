// Pure aggregation over already-collected usage records. This module reads
// `UsageRecord[]` produced by the existing opt-in ledger (`./service.js`,
// `./store.js`) and never mutates or re-derives usage data itself, so it
// stays free of any coupling to the usage-recording format. It accepts a
// list of per-project sources so a future project registry (issue #94) can
// widen the `roots` passed into `./overview-service.js` without any change
// here; only the current project is wired in today.
import type { TokenTotals, UsageRecord } from './contracts.js';

export type UsageSource = { projectId: string; records: UsageRecord[] };

export type UsageBucketTotals = {
  recordCount: number;
  measuredCount: number;
  partialCount: number;
  unavailableCount: number;
  /** Null per field when any contributing record has an unknown count for it. */
  tokens: TokenTotals;
  /** Sum of known counts per field, ignoring records where that field is unknown. */
  knownTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    thinking: number;
  };
  /** Sum of estimates only when every record in the bucket carries a priced estimate. */
  estimatedUsd: number | null;
  /** Sum of the estimates that do exist, even when the bucket is incomplete. */
  knownEstimatedUsd: number | null;
  /** Measured/partial records that have no monetary estimate (missing price/tokens). */
  priceMissingCount: number;
  recordIds: string[];
};
export type UsageDateBucket = UsageBucketTotals & { date: string };
export type UsageProjectBucket = UsageBucketTotals & { projectId: string };
export type UsageProviderBucket = UsageBucketTotals & { provider: string };
export type UsageModelBucket = UsageBucketTotals & { provider: string; model: string | null };
export type UsageRoleBucket = UsageBucketTotals & { role: 'unknown'; note: string };
export type UsageAggregate = {
  range: { from: string | null; to: string | null };
  totals: UsageBucketTotals;
  byDate: UsageDateBucket[];
  byProject: UsageProjectBucket[];
  byProvider: UsageProviderBucket[];
  byModel: UsageModelBucket[];
  byRole: UsageRoleBucket[];
  billing: { status: 'unknown'; reason: string };
};

const TOKEN_FIELDS: Array<keyof TokenTotals> = [
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'thinking',
];
const ROLE_COVERAGE_NOTE =
  'Stored usage records do not yet carry a coordinator/worker/planning/verification/tool-model role. This bucket reports every in-scope record under "unknown" role coverage rather than omitting the breakdown.';
const BILLING_REASON =
  'Provider subscriptions and actual charges are not collected or inferred. Account-wide provider limits remain unavailable unless a supported source supplies them.';

export function summarizeUsage(records: UsageRecord[]): UsageBucketTotals {
  const tokens: TokenTotals = {
    input: null,
    output: null,
    cacheRead: null,
    cacheCreation: null,
    thinking: null,
  };
  const knownTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0 };
  for (const field of TOKEN_FIELDS) {
    knownTokens[field] = records.reduce((sum, item) => sum + (item.tokens[field] ?? 0), 0);
    if (records.length && records.every((item) => item.tokens[field] !== null))
      tokens[field] = knownTokens[field];
  }
  const estimated = records.filter((item) => item.estimate !== null);
  const priceMissingCount = records.filter(
    (item) => item.status !== 'unavailable' && item.estimate === null,
  ).length;
  return {
    recordCount: records.length,
    measuredCount: records.filter((item) => item.status === 'measured').length,
    partialCount: records.filter((item) => item.status === 'partial').length,
    unavailableCount: records.filter((item) => item.status === 'unavailable').length,
    tokens,
    knownTokens,
    estimatedUsd:
      records.length && estimated.length === records.length
        ? estimated.reduce((sum, item) => sum + (item.estimate?.amount ?? 0), 0)
        : null,
    knownEstimatedUsd: estimated.length
      ? estimated.reduce((sum, item) => sum + (item.estimate?.amount ?? 0), 0)
      : null,
    priceMissingCount,
    recordIds: records.map((item) => item.id),
  };
}

function inRange(record: UsageRecord, from: string | undefined, to: string | undefined): boolean {
  const at = Date.parse(record.occurredAt);
  if (from && at < Date.parse(from)) return false;
  if (to && at > Date.parse(to)) return false;
  return true;
}
function dateKey(record: UsageRecord): string {
  return new Date(record.occurredAt).toISOString().slice(0, 10);
}
function groupBy(items: Array<{ record: UsageRecord; key: string }>): Map<string, UsageRecord[]> {
  const groups = new Map<string, UsageRecord[]>();
  for (const { record, key } of items) {
    const existing = groups.get(key);
    if (existing) existing.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

export function aggregateUsage(
  sources: UsageSource[],
  { from, to }: { from?: string; to?: string } = {},
): UsageAggregate {
  type Tagged = { record: UsageRecord; projectId: string };
  const tagged: Tagged[] = sources.flatMap((source) =>
    source.records
      .filter((record) => inRange(record, from, to))
      .map((record) => ({ record, projectId: source.projectId })),
  );
  const all = tagged.map((item) => item.record);

  const byDateGroups = groupBy(
    tagged.map((item) => ({ record: item.record, key: dateKey(item.record) })),
  );
  const byDate: UsageDateBucket[] = [...byDateGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, records]) => ({ date, ...summarizeUsage(records) }));

  const byProjectGroups = groupBy(
    tagged.map((item) => ({ record: item.record, key: item.projectId })),
  );
  const byProject: UsageProjectBucket[] = [...byProjectGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectId, records]) => ({ projectId, ...summarizeUsage(records) }));

  const byProviderGroups = groupBy(
    tagged.map((item) => ({ record: item.record, key: item.record.provider })),
  );
  const byProvider: UsageProviderBucket[] = [...byProviderGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, records]) => ({ provider, ...summarizeUsage(records) }));

  const byModelGroups = groupBy(
    tagged.map((item) => ({
      record: item.record,
      // JSON-encode the pair so provider/model values containing spaces
      // cannot collide with another pair when grouped by string key.
      key: JSON.stringify([item.record.provider, item.record.model]),
    })),
  );
  const byModel: UsageModelBucket[] = [...byModelGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, records]) => {
      const [provider, model] = JSON.parse(key) as [string, string | null];
      return { provider, model, ...summarizeUsage(records) };
    });

  const byRole: UsageRoleBucket[] = all.length
    ? [{ role: 'unknown', note: ROLE_COVERAGE_NOTE, ...summarizeUsage(all) }]
    : [];

  return {
    range: { from: from ?? null, to: to ?? null },
    totals: summarizeUsage(all),
    byDate,
    byProject,
    byProvider,
    byModel,
    byRole,
    billing: { status: 'unknown', reason: BILLING_REASON },
  };
}
