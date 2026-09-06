import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { safePath } from '../storage.js';
import { errorCode } from '../types.js';

/**
 * Task-state schema version 4 adds discriminated knowledge records to every task: `decision`,
 * `assumption`, `observation`, and `question`. This module holds the pure, self-contained shape
 * (types, bounds, status-transition table, dependency-cycle detection, and link-freshness
 * reconciliation) that both `contracts.ts` (structural validation on every read/write) and
 * `service.ts` (mutation orchestration) reuse. It intentionally does not import `TaskStateError`
 * or `Task`/`TaskState` from `./contracts.js` to avoid a module cycle; callers translate these
 * pure results into `TaskStateError` at the call site, the same way `spec-decision-contracts.ts`
 * and `result-decision-contracts.ts` keep their own self-contained shape modules.
 *
 * Acceptance is always a separate, explicit, authority-bearing action: every record starts in its
 * kind's non-authoritative status regardless of provenance (imported text, agent inference, direct
 * user input, or an execution observation), so the record kind or its source alone never implies
 * user acceptance. See docs/task-state.md for the full contract.
 */

export const RECORD_KINDS = Object.freeze([
  'decision',
  'assumption',
  'observation',
  'question',
] as const);
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_PROVENANCE_KINDS = Object.freeze([
  'direct-user',
  'agent-inferred',
  'imported',
  'execution-observed',
] as const);
export type RecordProvenanceKind = (typeof RECORD_PROVENANCE_KINDS)[number];

export type TaskRecordProvenance = { kind: RecordProvenanceKind; reference: string };

export type RecordLink =
  | { type: 'record'; recordId: string; recordRevision: number }
  | { type: 'criterion'; criterionId: string; criterionRevision: number }
  | { type: 'evidence'; evidenceId: string }
  | { type: 'memory'; memoryId: string; memoryRevision: number }
  | { type: 'source'; path: string; digest: string | null; observedAt: string };

export type TaskRecordHistoryAction = 'created' | 'revised' | 'transitioned';
export type TaskRecordHistoryEntry = {
  revision: number;
  status: string;
  text: string;
  action: TaskRecordHistoryAction;
  reason: string | null;
  /** Set only when this entry granted or reversed authority-bearing intent. */
  authorizationId: string | null;
  createdAt: string;
};

export type TaskRecord = {
  id: string;
  kind: RecordKind;
  revision: number;
  status: string;
  text: string;
  provenance: TaskRecordProvenance;
  links: RecordLink[];
  /** ID of a prior same-kind record this one explicitly supersedes, or null. */
  supersedes: string | null;
  /** ID of the record that supersedes this one, set only once superseded. */
  supersededBy: string | null;
  history: TaskRecordHistoryEntry[];
  createdAt: string;
  updatedAt: string;
};

export const RECORD_STATUSES: Readonly<Record<RecordKind, readonly string[]>> = Object.freeze({
  decision: Object.freeze(['proposed', 'accepted', 'retracted', 'superseded']),
  assumption: Object.freeze(['tentative', 'confirmed', 'contradicted', 'retracted', 'superseded']),
  observation: Object.freeze(['unverified', 'verified', 'stale', 'retracted', 'superseded']),
  question: Object.freeze(['open', 'answered', 'withdrawn', 'superseded']),
});

export const RECORD_INITIAL_STATUS: Readonly<Record<RecordKind, string>> = Object.freeze({
  decision: 'proposed',
  assumption: 'tentative',
  observation: 'unverified',
  question: 'open',
});

/** The single status per kind that represents explicit, authority-bearing acceptance. */
const AUTHORITATIVE_STATUS: Readonly<Record<RecordKind, string | null>> = Object.freeze({
  decision: 'accepted',
  assumption: 'confirmed',
  observation: null,
  question: 'answered',
});

export const RECORD_TERMINAL_STATUSES: ReadonlySet<string> = Object.freeze(
  new Set(['retracted', 'superseded']),
);

const TRANSITIONS: Readonly<Record<RecordKind, Readonly<Record<string, readonly string[]>>>> =
  Object.freeze({
    decision: Object.freeze({
      proposed: Object.freeze(['accepted', 'retracted', 'superseded']),
      accepted: Object.freeze(['retracted', 'superseded']),
    }),
    assumption: Object.freeze({
      tentative: Object.freeze(['confirmed', 'contradicted', 'retracted', 'superseded']),
      confirmed: Object.freeze(['contradicted', 'retracted', 'superseded']),
      contradicted: Object.freeze(['retracted', 'superseded']),
    }),
    observation: Object.freeze({
      unverified: Object.freeze(['verified', 'stale', 'retracted', 'superseded']),
      verified: Object.freeze(['stale', 'retracted', 'superseded']),
      stale: Object.freeze(['verified', 'retracted', 'superseded']),
    }),
    question: Object.freeze({
      open: Object.freeze(['answered', 'withdrawn', 'superseded']),
      answered: Object.freeze(['withdrawn', 'superseded']),
    }),
  });

export function allowedRecordTransitions(kind: RecordKind, from: string): readonly string[] {
  return TRANSITIONS[kind][from] ?? [];
}

export function isRecordTransitionValid(kind: RecordKind, from: string, to: string): boolean {
  return allowedRecordTransitions(kind, from).includes(to);
}

export function isRecordStatusTerminal(status: string): boolean {
  return RECORD_TERMINAL_STATUSES.has(status);
}

export function isRecordAuthoritativeStatus(kind: RecordKind, status: string): boolean {
  return AUTHORITATIVE_STATUS[kind] === status;
}

/**
 * True when moving from `from` to `to` grants or reverses user-authorized intent for this record
 * kind, and therefore must reference the task's existing direct-user authorization mechanism
 * rather than happening as a side effect of parsing, import, or an execution observation.
 * Observation has no authoritative status: `verified` instead requires linked, current, passing
 * evidence (checked separately), never authorization.
 */
export function recordTransitionRequiresAuthority(
  kind: RecordKind,
  from: string,
  to: string,
): boolean {
  const authoritative = AUTHORITATIVE_STATUS[kind];
  if (!authoritative) return false;
  return from === authoritative || to === authoritative;
}

export const MAX_RECORD_TEXT_BYTES = 4 * 1024;
export const MAX_RECORD_REASON_BYTES = 2 * 1024;
export const MAX_RECORD_REFERENCE_BYTES = 1 * 1024;
export const MAX_RECORD_LINKS = 32;
export const MAX_RECORD_HISTORY = 40;
export const MAX_RECORDS_PER_TASK = 500;
export const MAX_RECORD_LIST_LIMIT = 200;
export const DEFAULT_RECORD_LIST_LIMIT = 50;

/** recordId -> set of recordIds it declares a dependency on (supersedes plus `record`-type links). */
export function buildRecordDependencyEdges(
  records: readonly Pick<TaskRecord, 'id' | 'supersedes' | 'links'>[],
): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const item of records) {
    const targets = new Set<string>();
    if (item.supersedes) targets.add(item.supersedes);
    for (const link of item.links) if (link.type === 'record') targets.add(link.recordId);
    edges.set(item.id, targets);
  }
  return edges;
}

/** Returns a cycle path (record IDs) if the dependency graph contains one, else null. */
export function detectRecordDependencyCycle(edges: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  function visit(node: string): string[] | null {
    const status = state.get(node);
    if (status === 'done') return null;
    if (status === 'visiting') {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  }
  for (const node of edges.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

export type RecordLinkStatus = 'current' | 'stale' | 'missing' | 'unknown';

/** Recomputed at read time; never persisted. A missing/changed source is exposed here, never
 * silently rewritten into the stored link. */
export async function reconcileSourceLinkStatus(
  root: string,
  link: { path: string; digest: string | null },
): Promise<RecordLinkStatus> {
  if (link.digest === null) return 'unknown';
  let bytes: Buffer;
  try {
    bytes = await readFile(await safePath(root, link.path));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  return createHash('sha256').update(bytes).digest('hex') === link.digest ? 'current' : 'stale';
}
