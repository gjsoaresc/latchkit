import { createHash } from 'node:crypto';
import type { RecordKind, RecordProvenanceKind } from '../task-state/records.js';

/**
 * Issue #112: a versioned, deterministic context projection over existing task and workflow
 * records, so a resumed agent session can receive current intent and a bounded change-since-last
 * summary instead of stale memory or a replayed transcript. This module is the pure shape
 * (types, bounds, canonical digesting) that `./service.ts` assembles and both `src/cli.ts` and
 * `src/workflows/service.ts` consume; it deliberately holds no dependency on task-state or
 * workflow *services* (only the already-pure `RecordKind`/`RecordProvenanceKind` types from
 * `task-state/records.ts`), mirroring how `task-state/reconcile.ts` and `workflows/contracts.ts`
 * stay self-contained. See docs/task-state.md#context-briefs.
 *
 * A brief is read-only and never grants execution scope by itself: producing or inspecting one
 * performs no task migration, file rewrite, tool installation, inference, or provider execution.
 * Project-memory excerpts referenced from it remain historical, untrusted context — embedded
 * instructions in record text, imported text, or memory text can never acquire task authority
 * through this projection (see `docs/task-state.md#task-records`).
 */

export const CONTEXT_BRIEF_SCHEMA_VERSION = 1;

/** Deterministic minimum/default/ceiling for the explicit byte budget (AC #3). The default keeps
 * a brief genuinely compact; the ceiling matches the existing project-memory recovery budget cap
 * (`src/project-memory/service.ts`) so no caller can request an unbounded projection. */
export const MIN_CONTEXT_BRIEF_BYTES = 512;
export const DEFAULT_CONTEXT_BRIEF_BYTES = 16 * 1024;
export const MAX_CONTEXT_BRIEF_BYTES = 256 * 1024;

/** A conservative, clearly-labeled heuristic only — never a provider-measured token count. */
export const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 4;
export const TOKEN_ESTIMATE_DISCLAIMER =
  'Heuristic estimate (bytes / 4), never a provider-measured token count.';

export const DELIVERY_NOTE =
  'A context brief is bound only at the start of a new provider invocation (a fresh dispatch); ' +
  'it never rewrites the context of an already-running provider session. Latchkit cannot inject ' +
  'context into a live conversation — the provider still owns the running session.';

export class ContextBriefError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'CONTEXT_BRIEF_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'ContextBriefError';
    this.code = code;
    this.path = path;
  }
}

export type LinkStatus = 'current' | 'stale' | 'missing' | 'unknown';

export type RecordLinkSummary = {
  type: 'record' | 'criterion' | 'evidence' | 'memory' | 'source';
  targetId: string;
  status: LinkStatus | null;
};

/** A decision/assumption/observation/question projected for the brief. `provenance` is always
 * included so a reader can tell direct-user statements apart from agent inference, imported text,
 * or an execution observation at a glance — acceptance is never implied by kind or provenance. */
export type IntentRecordSummary = {
  id: string;
  kind: RecordKind;
  status: string;
  revision: number;
  text: string;
  provenance: { kind: RecordProvenanceKind; reference: string };
  links: RecordLinkSummary[];
};

export type CriterionSummary = {
  id: string;
  revision: number;
  description: string;
  required: boolean;
  approvalRequired: boolean;
};

export type AuthorizationSummary = { id: string; scope: string; grantedAt: string };

export type ReconciliationOutcomeSummary = {
  id: string;
  createdAt: string;
  patchDigest: string;
  /** The task revision committed by this reconciliation's mutation, when it can still be
   * resolved from the current event log; `null` if the record predates that lookup (never
   * fabricated). */
  taskRevisionAfter: number | null;
  ops: {
    op: string;
    targetId: string;
    fromStatus: string | null;
    toStatus: string | null;
  }[];
  impactSummary: {
    directlyAffected: number;
    declaredDependent: number;
    potentiallyAffected: number;
    unchanged: number;
  };
  impactTruncated: boolean;
  uncertaintiesCount: number;
};

export type PlanReferenceSummary = {
  kind:
    | 'imported-note'
    | 'enhanced-prd'
    | 'enhanced-technical-plan'
    | 'workflow-requirements'
    | 'workflow-plan';
  sourceRef: string;
  digest: string;
};

export type NextActionKind =
  | 'continue'
  | 'await-approval'
  | 'await-input'
  | 'blocked'
  | 'interrupted-pending'
  | 'cancelled'
  | 'complete'
  | 'ordinary-task';

/** A read of the existing workflow's *current* status/phase/approval-freshness, never a
 * re-invocation of the delivery-workflow policy engine (`src/workflows/policy.ts` remains the
 * sole owner of that decision) and never provider execution. */
export type NextActionSummary = {
  kind: NextActionKind;
  phase: string | null;
  description: string;
};

export type UnreconciledChangeSummary = {
  criteriaDigestChanged: boolean;
  intentDigestChanged: boolean;
  note: string | null;
};

export type WorkNeedingAttentionEntry = {
  kind: 'record' | 'criterion' | 'check' | 'evidence';
  id: string;
  outcome: string;
  reasonCode: string;
};

export type CompletedWorkEntry = {
  criterionId: string;
  description: string;
  evidenceId: string;
};

export type MissingDependencyLink = {
  recordId: string;
  linkType: string;
  targetId: string;
  status: 'missing' | 'unknown';
};

export type ChangeSinceLastRunReason = 'ok' | 'no-prior-dispatch' | 'digest-mismatch';

/** Compact, bound to the *last dispatched* context digest only (never a full transcript or
 * history archive). "Missing dependency links are reported as unknown" and "unchanged work never
 * implies reusable evidence" both hold here: `completedWorkRemaining` is populated from current,
 * passing evidence — never from the mere absence of a reconciliation. */
export type ChangeSinceLastRun = {
  available: boolean;
  reason: ChangeSinceLastRunReason;
  sinceDigest: string | null;
  boundAt: string | null;
  reconciliationsSince: ReconciliationOutcomeSummary[];
  reconciliationsSinceTruncated: boolean;
  unreconciledChange: UnreconciledChangeSummary | null;
  workNeedingAttention: WorkNeedingAttentionEntry[];
  completedWorkRemaining: CompletedWorkEntry[];
  missingDependencyLinks: MissingDependencyLink[];
};

export type OmittedItem = { section: string; id: string; sourceRef: string };

export type ContextBriefBudget = {
  requestedBytes: number;
  effectiveBytes: number;
  mandatoryBytes: number;
  usedBytes: number;
  estimatedTokens: number;
  estimateDisclaimer: string;
};

export type ContextBrief = {
  schemaVersion: 1;
  taskId: string;
  taskRevision: number;
  taskState: string;
  intentDigest: string;
  criteriaDigest: string;
  source: { revision: string | null; dirtyFingerprint: string | null };
  workflow: {
    exists: boolean;
    workflowId: string | null;
    revision: number | null;
    phase: string | null;
    status: string | null;
  };
  authorizations: AuthorizationSummary[];
  acceptedDecisions: IntentRecordSummary[];
  confirmedAssumptions: IntentRecordSummary[];
  pendingDecisions: IntentRecordSummary[];
  openAssumptions: IntentRecordSummary[];
  openQuestions: IntentRecordSummary[];
  historicalObservations: IntentRecordSummary[];
  criteria: CriterionSummary[];
  reconciliationOutcomes: ReconciliationOutcomeSummary[];
  reconciliationOutcomesTruncated: boolean;
  planReferences: PlanReferenceSummary[];
  nextAction: NextActionSummary;
  changeSinceLastRun: ChangeSinceLastRun;
  omitted: OmittedItem[];
  budget: ContextBriefBudget;
  deliveryNote: string;
  resumeGuidance: string;
  digest: string;
  generatedAt: string;
};

/** The binding recorded on the existing workflow dispatch journal (`WorkflowRecord`) each time a
 * brief is actually delivered at the start of a new invocation. See
 * `src/workflows/contracts.ts#WorkflowDispatchedContext` for the persisted shape; this is a plain
 * duplicate export so `context-brief/service.ts` does not need to import workflow types back. */
export type ContextBriefBinding = {
  digest: string;
  briefSchemaVersion: number;
  taskRevision: number;
  workflowRevision: number;
  criteriaDigest: string;
  intentDigest: string;
  source: { revision: string | null; dirtyFingerprint: string | null };
  artifactHashes: { path: string; digest: string | null }[];
  deliveredAt: string;
};

export function canonicalBriefJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBriefJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalBriefJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
export const digestBriefJson = (value: unknown) => sha256Hex(canonicalBriefJson(value));

export function assertByteBudget(value: unknown, path = '$.byteBudget'): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_CONTEXT_BRIEF_BYTES ||
    value > MAX_CONTEXT_BRIEF_BYTES
  )
    throw new ContextBriefError(
      `Byte budget must be an integer between ${MIN_CONTEXT_BRIEF_BYTES} and ${MAX_CONTEXT_BRIEF_BYTES}.`,
      'CONTEXT_BRIEF_INVALID',
      path,
    );
  return value;
}

const HEX_64 = /^[a-f0-9]{64}$/;
export function assertOptionalDigest(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !HEX_64.test(value))
    throw new ContextBriefError(
      'Expected a lowercase SHA-256 digest.',
      'CONTEXT_BRIEF_INVALID',
      path,
    );
  return value;
}
