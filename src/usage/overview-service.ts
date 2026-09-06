// Composes the pure aggregation/savings models with the existing opt-in
// usage ledger. Callers pass a list of project roots so a future project
// registry (issue #94) can widen this beyond the single fixed project the
// local server serves today; `src/server.ts` currently wires exactly one
// root (the running project) into every call here.
import { aggregateUsage } from './aggregate.js';
import type { UsageAggregate, UsageSource } from './aggregate.js';
import { readSavingsBaselineState } from './baseline-store.js';
import type { SavingsBaseline } from './baseline-contracts.js';
import { computeSavings } from './savings.js';
import type { SavingsResult } from './savings.js';
import { readUsageState } from './store.js';

type ClockOptions = { clock?: () => Date };
export type UsageOverviewOptions = { from?: string; to?: string } & ClockOptions;

async function usageSources(
  roots: string[],
  { clock = () => new Date() }: ClockOptions = {},
): Promise<UsageSource[]> {
  return Promise.all(
    roots.map(async (root) => {
      const state = await readUsageState(root, { clock });
      // Mirrors the retention cutoff in ./service.js's `retain()` so this
      // read-only aggregation path stays uncoupled from the ledger's mutation
      // path (which parallel usage-observation work may still be changing).
      const cutoff = clock().getTime() - state.settings.retentionDays * 86_400_000;
      const records = state.records.filter((record) => Date.parse(record.occurredAt) >= cutoff);
      return { projectId: state.project.id, records };
    }),
  );
}

export async function inspectUsageOverview(
  roots: string[],
  options: UsageOverviewOptions = {},
): Promise<UsageAggregate> {
  const sources = await usageSources(roots, options);
  return aggregateUsage(sources, { from: options.from, to: options.to });
}

async function findBaseline(roots: string[], baselineId: string): Promise<SavingsBaseline | null> {
  for (const root of roots) {
    const state = await readSavingsBaselineState(root);
    const found = state.baselines.find((item) => item.id === baselineId);
    if (found) return found;
  }
  return null;
}

export async function inspectSavings(
  roots: string[],
  baselineId: string,
  options: UsageOverviewOptions = {},
): Promise<SavingsResult> {
  const [sources, baseline] = await Promise.all([
    usageSources(roots, options),
    findBaseline(roots, baselineId),
  ]);
  return computeSavings(baseline, sources);
}
