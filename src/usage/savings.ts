// Pure comparison of a user-authored savings baseline (./baseline-contracts.js)
// against already-collected usage records. Never invents a number: every
// outcome other than 'ok' carries an explicit reason, and 'ok' itself keeps
// percentDifference explanatory when the baseline denominator is zero.
import type { SavingsBaseline, SavingsTokenField } from './baseline-contracts.js';
import type { TokenTotals, UsageRecord } from './contracts.js';
import type { UsageSource } from './aggregate.js';

export type SavingsMatch = {
  recordIds: string[];
  recordCount: number;
  measuredCount: number;
  partialCount: number;
  unavailableCount: number;
};
export type SavingsResult =
  | { status: 'missing-baseline'; reason: string }
  | { status: 'incomplete-comparison'; reason: string; match: SavingsMatch }
  | {
      status: 'missing-prices';
      reason: string;
      match: SavingsMatch;
      knownActualAmount: number | null;
    }
  | {
      status: 'zero-denominator';
      reason: string;
      units: SavingsBaseline['units'];
      baselineAmount: 0;
      actualAmount: number;
      match: SavingsMatch;
    }
  | {
      status: 'ok';
      kind: SavingsBaseline['kind'];
      units: SavingsBaseline['units'];
      baselineAmount: number;
      actualAmount: number;
      absoluteDifference: number;
      percentDifference: number;
      direction: 'savings' | 'loss' | 'unchanged';
      match: SavingsMatch;
    };

function matchesScope(record: UsageRecord, baseline: SavingsBaseline): boolean {
  const { scope } = baseline;
  if (scope.taskIds.length && !(record.taskId && scope.taskIds.includes(record.taskId)))
    return false;
  const at = Date.parse(record.occurredAt);
  if (scope.from && at < Date.parse(scope.from)) return false;
  if (scope.to && at > Date.parse(scope.to)) return false;
  return true;
}
function toMatch(records: UsageRecord[]): SavingsMatch {
  return {
    recordIds: records.map((item) => item.id),
    recordCount: records.length,
    measuredCount: records.filter((item) => item.status === 'measured').length,
    partialCount: records.filter((item) => item.status === 'partial').length,
    unavailableCount: records.filter((item) => item.status === 'unavailable').length,
  };
}
function tokenAmount(record: UsageRecord, field: SavingsTokenField): number | null {
  if (field === 'total') {
    const fields: Array<keyof TokenTotals> = [
      'input',
      'output',
      'cacheRead',
      'cacheCreation',
      'thinking',
    ];
    let total = 0;
    for (const key of fields) {
      const value = record.tokens[key];
      if (value === null) return null;
      total += value;
    }
    return total;
  }
  return record.tokens[field];
}
function direction(absoluteDifference: number): 'savings' | 'loss' | 'unchanged' {
  if (absoluteDifference > 0) return 'savings';
  if (absoluteDifference < 0) return 'loss';
  return 'unchanged';
}

export function computeSavings(
  baseline: SavingsBaseline | null,
  sources: UsageSource[],
): SavingsResult {
  if (!baseline)
    return {
      status: 'missing-baseline',
      reason: 'No savings baseline is selected, or the requested baseline was not found.',
    };
  const matched = sources.flatMap((source) =>
    source.records.filter((record) => matchesScope(record, baseline)),
  );
  const match = toMatch(matched);
  if (!matched.length)
    return {
      status: 'incomplete-comparison',
      reason: 'No recorded usage matched the baseline scope (comparison period or task IDs).',
      match,
    };
  const known = matched.filter((item) => item.status !== 'unavailable');
  // Every matched invocation failed to report usage. Reporting 0 here would
  // present missing usage as zero, which is never allowed.
  if (!known.length)
    return {
      status: 'incomplete-comparison',
      reason:
        'Every matched usage record is unavailable; no actual usage is known for this comparison.',
      match,
    };

  if (baseline.units === 'usd') {
    const priced = known.filter((item) => item.estimate !== null);
    const knownActualAmount = priced.length
      ? priced.reduce((sum, item) => sum + (item.estimate?.amount ?? 0), 0)
      : null;
    if (priced.length !== known.length)
      return {
        status: 'missing-prices',
        reason: `${known.length - priced.length} of ${known.length} matched usage record(s) have no priced estimate; a complete monetary comparison is not available.`,
        match,
        knownActualAmount,
      };
    return finalize(baseline, knownActualAmount ?? 0, match);
  }
  const field = baseline.tokenField ?? 'total';
  const amounts = known.map((item) => tokenAmount(item, field));
  const knownAmounts = amounts.filter((value): value is number => value !== null);
  if (knownAmounts.length !== known.length)
    return {
      status: 'incomplete-comparison',
      reason: `${known.length - knownAmounts.length} of ${known.length} matched usage record(s) have an unknown "${field}" token count; a complete comparison is not available.`,
      match,
    };
  const actualAmount = knownAmounts.reduce((sum, value) => sum + value, 0);
  return finalize(baseline, actualAmount, match);
}

function finalize(
  baseline: SavingsBaseline,
  actualAmount: number,
  match: SavingsMatch,
): SavingsResult {
  if (baseline.amount === 0)
    return {
      status: 'zero-denominator',
      reason:
        'The baseline amount is zero, so a percentage difference cannot be computed. The absolute usage is reported instead.',
      units: baseline.units,
      baselineAmount: 0,
      actualAmount,
      match,
    };
  const absoluteDifference = baseline.amount - actualAmount;
  const percentDifference = (absoluteDifference / baseline.amount) * 100;
  return {
    status: 'ok',
    kind: baseline.kind,
    units: baseline.units,
    baselineAmount: baseline.amount,
    actualAmount,
    absoluteDifference,
    percentDifference,
    direction: direction(absoluteDifference),
    match,
  };
}
