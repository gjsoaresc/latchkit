import { createHash } from 'node:crypto';
import {
  MAX_RECONCILE_IMPACT_ENTRIES,
  MAX_RECONCILE_TRAVERSAL_NODES,
  type TaskRecord,
} from './records.js';

/**
 * Pure impact-graph and digest logic for task-intent reconciliation (issue #111). This module is
 * deliberately self-contained (only `./records.js`, mirroring that module's own reasoning) so it
 * carries no dependency on `./contracts.js` or `./service.js` and introduces no module cycle:
 * `contracts.ts` imports the persisted `TaskReconciliation` shape from here for validation, and
 * `service.ts` imports the graph/report builders for orchestration, but nothing here imports
 * either of them. See docs/task-state.md#reconciling-changed-intent for the full contract.
 *
 * Latchkit tracks only *declared* links (record/criterion/evidence/memory/source), never semantic
 * or structural code dependencies (that is CodeGraph's territory, issue #96, explicitly out of
 * scope here). The traversal below is therefore always a graph over declared edges: it reports
 * what the graph says, flags what the graph cannot say (missing/stale links, and criteria with no
 * declared record ever pointing at them) as uncertain, and never claims an unlinked item is safe.
 */

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export function canonicalReconcileJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReconcileJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalReconcileJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digestReconcileJson = (value: unknown) => sha256Hex(canonicalReconcileJson(value));

/**
 * A deterministic, syntactically valid `record_<uuid>` derived from `seed` (formatted with a
 * fixed version/variant nibble so it always matches the same ID pattern every other record ID
 * does). Used only to preview a `supersede` op's would-be new record: `previewTaskReconciliation`
 * never persists anything, so it cannot draw a real random ID without breaking "identical
 * input/state produces identical reports" across repeated preview calls. `applyTaskReconciliation`
 * always assigns the real random ID at commit time; this value never reaches storage.
 */
export function deterministicRecordId(seed: string): string {
  const hash = sha256Hex(seed);
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(12, 15)}-8${hash.slice(15, 18)}-${hash.slice(18, 30)}`;
  return `record_${uuid}`;
}

// ---------------------------------------------------------------------------
// Persisted summary (bounded; stored on the task, validated by contracts.ts).
// ---------------------------------------------------------------------------

export type ReconcileOpKind = 'transition' | 'supersede' | 'revise' | 'criterion';

export type ReconciliationOpSummary = {
  op: ReconcileOpKind;
  targetId: string;
  fromRevision: number;
  toRevision: number;
  fromStatus: string | null;
  toStatus: string | null;
};

export type ImpactClassification =
  'directly-affected' | 'declared-dependent' | 'potentially-affected';
export type ImpactOutcome =
  'needs-user-decision' | 'needs-replanning' | 'needs-re-verification' | 'none';
export type ImpactTargetKind = 'record' | 'criterion' | 'check' | 'evidence';

export type ImpactEntry = {
  kind: ImpactTargetKind;
  id: string;
  classification: ImpactClassification;
  outcome: ImpactOutcome;
  reasonCode: string;
  /** Root-first chain of tagged node keys (e.g. `record:<id>`, `criterion:<id>`) explaining why
   * this entry was reached. A single-element path means the item was named directly by the patch. */
  path: string[];
};

export type ReconciliationUncertainty = {
  kind: ImpactTargetKind;
  id: string;
  reasonCode: 'link-stale' | 'link-missing' | 'link-unknown' | 'uncovered-dependency';
  detail: string;
};

export type TaskReconciliation = {
  id: string;
  mutationId: string;
  patchDigest: string;
  previewDigest: string;
  ops: ReconciliationOpSummary[];
  impactSummary: {
    directlyAffected: number;
    declaredDependent: number;
    potentiallyAffected: number;
    unchanged: number;
  };
  impact: ImpactEntry[];
  impactTruncated: boolean;
  uncertainties: ReconciliationUncertainty[];
  authorizationIds: string[];
  workflowAcknowledged: boolean;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Report (returned by preview/apply; not persisted verbatim — see TaskReconciliation above).
// ---------------------------------------------------------------------------

export type ReconciliationRecordSnapshot = {
  id: string;
  kind: string;
  revision: number;
  status: string;
  text: string;
};
export type ReconciliationCriterionSnapshot = {
  id: string;
  revision: number;
  description: string;
  required: boolean;
  approvalRequired: boolean;
};

export type ReconciliationReport = {
  taskId: string;
  taskRevision: number;
  workflowExists: boolean;
  workflowRevision: number | null;
  ops: ReconciliationOpSummary[];
  patchDigest: string;
  digest: string;
  source: { revision: string | null; dirtyFingerprint: string | null };
  before: {
    records: ReconciliationRecordSnapshot[];
    criteria: ReconciliationCriterionSnapshot[];
  };
  after: {
    records: ReconciliationRecordSnapshot[];
    criteria: ReconciliationCriterionSnapshot[];
  };
  impact: ImpactEntry[];
  impactSummary: {
    directlyAffected: number;
    declaredDependent: number;
    potentiallyAffected: number;
    unchanged: number;
  };
  impactTruncated: boolean;
  uncertainties: ReconciliationUncertainty[];
  approval: { currentlyValid: boolean | null; remainsValidAfterPatch: boolean | null };
  generatedAt: string;
};

// ---------------------------------------------------------------------------
// Impact graph.
// ---------------------------------------------------------------------------

type GraphView = {
  records: readonly TaskRecord[];
  criteria: readonly { id: string; revision: number }[];
  evidence: readonly { id: string; criterionId: string; criterionRevision: number }[];
  checks: readonly { id: string; criterionId: string }[];
};

const recordKey = (recordId: string) => `record:${recordId}`;
const criterionKey = (criterionId: string) => `criterion:${criterionId}`;

const RECORD_OUTCOME: Readonly<Record<string, ImpactOutcome>> = Object.freeze({
  'decision:proposed': 'needs-user-decision',
  'decision:accepted': 'needs-replanning',
  'decision:retracted': 'none',
  'decision:superseded': 'none',
  'assumption:tentative': 'needs-user-decision',
  'assumption:confirmed': 'needs-replanning',
  'assumption:contradicted': 'needs-user-decision',
  'assumption:retracted': 'none',
  'assumption:superseded': 'none',
  'observation:unverified': 'needs-re-verification',
  'observation:verified': 'needs-re-verification',
  'observation:stale': 'needs-re-verification',
  'observation:retracted': 'none',
  'observation:superseded': 'none',
  'question:open': 'needs-user-decision',
  'question:answered': 'needs-replanning',
  'question:withdrawn': 'none',
  'question:superseded': 'none',
});

function recordOutcome(kind: string, status: string): ImpactOutcome {
  return RECORD_OUTCOME[`${kind}:${status}`] ?? 'needs-user-decision';
}

/**
 * Bounded breadth-first traversal over the *undirected* graph of declared record/criterion links
 * (record<->record via `supersedes`/`supersededBy`/`record`-type links, record<->criterion via
 * `criterion`-type links). Links are treated as undirected relatedness for impact-propagation
 * purposes: a declared link between A and B means a change to either is worth surfacing at the
 * other, regardless of which end originally pointed at which. Evidence and enhanced checks are not
 * graph nodes; they are attached to whichever criteria the traversal actually reaches. Traversal
 * stops at `MAX_RECONCILE_TRAVERSAL_NODES` and reports `truncated: true` rather than silently
 * continuing or omitting the remainder.
 */
export function buildImpactGraph(
  view: GraphView,
  directRecordIds: ReadonlySet<string>,
  directCriterionIds: ReadonlySet<string>,
): {
  entries: ImpactEntry[];
  truncated: boolean;
  visitedRecordIds: Set<string>;
  visitedCriterionIds: Set<string>;
} {
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  for (const record of view.records) {
    const from = recordKey(record.id);
    if (record.supersedes) addEdge(from, recordKey(record.supersedes));
    if (record.supersededBy) addEdge(from, recordKey(record.supersededBy));
    for (const link of record.links) {
      if (link.type === 'record') addEdge(from, recordKey(link.recordId));
      else if (link.type === 'criterion') addEdge(from, criterionKey(link.criterionId));
    }
  }
  const startKeys = [
    ...[...directRecordIds].sort().map(recordKey),
    ...[...directCriterionIds].sort().map(criterionKey),
  ];
  const visited = new Map<string, string[]>();
  const queue: string[] = [];
  for (const key of startKeys) {
    if (!visited.has(key)) {
      visited.set(key, [key]);
      queue.push(key);
    }
  }
  let truncated = false;
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined) continue;
    const path = visited.get(current)!;
    for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) {
      if (visited.has(neighbor)) continue;
      if (visited.size >= MAX_RECONCILE_TRAVERSAL_NODES) {
        truncated = true;
        break;
      }
      visited.set(neighbor, [...path, neighbor]);
      queue.push(neighbor);
    }
  }

  const recordsById = new Map(view.records.map((item) => [item.id, item]));
  const criteriaById = new Map(view.criteria.map((item) => [item.id, item]));
  const visitedRecordIds = new Set<string>();
  const visitedCriterionIds = new Set<string>();
  const entries: ImpactEntry[] = [];

  for (const [key, path] of visited) {
    const classification: ImpactClassification =
      (key.startsWith('record:') && directRecordIds.has(key.slice('record:'.length))) ||
      (key.startsWith('criterion:') && directCriterionIds.has(key.slice('criterion:'.length)))
        ? 'directly-affected'
        : 'declared-dependent';
    if (key.startsWith('record:')) {
      const recordId = key.slice('record:'.length);
      const record = recordsById.get(recordId);
      if (!record) continue; // A link can point at a record from a stale prior graph state.
      visitedRecordIds.add(recordId);
      entries.push({
        kind: 'record',
        id: recordId,
        classification,
        outcome: recordOutcome(record.kind, record.status),
        reasonCode: classification === 'directly-affected' ? 'patched' : 'declared-record-link',
        path,
      });
    } else {
      const criterionId = key.slice('criterion:'.length);
      if (!criteriaById.has(criterionId)) continue;
      visitedCriterionIds.add(criterionId);
      entries.push({
        kind: 'criterion',
        id: criterionId,
        classification,
        outcome: 'needs-re-verification',
        reasonCode: classification === 'directly-affected' ? 'patched' : 'declared-criterion-link',
        path,
      });
      for (const check of view.checks.filter((item) => item.criterionId === criterionId)) {
        entries.push({
          kind: 'check',
          id: check.id,
          classification,
          outcome: 'needs-re-verification',
          reasonCode: 'criterion-changed',
          path: [...path, `check:${check.id}`],
        });
      }
      for (const evidence of view.evidence.filter((item) => item.criterionId === criterionId)) {
        entries.push({
          kind: 'evidence',
          id: evidence.id,
          classification,
          outcome: 'needs-re-verification',
          reasonCode: 'criterion-revision-advanced',
          path: [...path, `evidence:${evidence.id}`],
        });
      }
    }
  }

  entries.sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  );
  const bounded = entries.slice(0, MAX_RECONCILE_IMPACT_ENTRIES);
  return {
    entries: bounded,
    truncated: truncated || bounded.length < entries.length,
    visitedRecordIds,
    visitedCriterionIds,
  };
}

/**
 * Required criteria that no declared record link, task-wide, ever points at. These are invisible
 * to the impact graph by construction: Latchkit has no semantic dependency inference, so it cannot
 * tell whether such a criterion actually depends on the changed intent. They are reported as an
 * explicit uncertainty — never silently folded into "unchanged" — whenever the patch changes an
 * authoritative (accepted/confirmed) record, matching "absence of a link never proves independence".
 */
export function uncoveredRequiredCriteria(
  view: GraphView,
  criteria: readonly { id: string; required: boolean }[],
): string[] {
  const linked = new Set<string>();
  for (const record of view.records)
    for (const link of record.links) if (link.type === 'criterion') linked.add(link.criterionId);
  return criteria.filter((item) => item.required && !linked.has(item.id)).map((item) => item.id);
}
