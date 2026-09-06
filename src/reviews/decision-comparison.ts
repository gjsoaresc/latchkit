import { resolveProjectRoot } from '../storage.js';
import { inspectTask } from '../task-state/service.js';
import type {
  Criterion,
  SourceSnapshot,
  Task,
  TaskEvidence,
  TaskRecord,
} from '../task-state/contracts.js';
import {
  computeIntentDigest,
  isRecordStatusTerminal,
  reconcileSourceLinkStatus,
  type RecordKind,
  type RecordLinkStatus,
  type TaskRecordHistoryEntry,
  type TaskRecordProvenance,
} from '../task-state/records.js';
import {
  buildImpactGraph,
  uncoveredRequiredCriteria,
  type ImpactEntry,
} from '../task-state/reconcile.js';
import {
  inspectResultDecision,
  type ResultDecisionRecord,
} from '../workflows/result-decision-service.js';
import {
  inspectSpecDecision,
  type SpecDecisionRecord,
} from '../workflows/spec-decision-service.js';
import { readWorkflow } from '../workflows/store.js';
import { digestJson, type WorkflowRecord } from '../workflows/contracts.js';
import { inspectTaskWorkspace } from '../workspaces/git.js';
import { errorCode, errorMessage } from '../types.js';

/**
 * Read-only decision-comparison view (issue #113): what changed among a task's recorded
 * `decision` records since a comparison baseline, their declared consequences, and separate
 * implementation/check/evidence/acceptance status — reusing #110's task records, #111's impact
 * graph, and #97/#101's decision machinery rather than introducing a parallel completion record,
 * a semantic dependency graph, or an independent approval store. Nothing in this module mutates
 * task state, workflow state, spec/result decisions, or triggers any provider or evidence-refresh
 * execution: every exported function here only reads already-persisted state.
 *
 * Baseline resolution (see docs/task-state.md#task-records for the retained per-record `history`
 * this relies on): every task-record mutation and its triggering `commitEvent` share one clock
 * reading per mutation, so a record's `history[].createdAt` is always at-or-before the task
 * `events[].createdAt` for the very same mutation. That lets a target task revision (from an
 * explicit `baselineRevision`, or derived from the latest recorded spec/result review action) be
 * turned into a timestamp cutoff, and each record's state "as of" that cutoff reconstructed from
 * its own retained history — without a second snapshot store.
 */

export class DecisionComparisonError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'DECISION_COMPARISON_INVALID', pathName = '$') {
    super(`${pathName}: ${message}`);
    this.name = 'DecisionComparisonError';
    this.code = code;
    this.path = pathName;
  }
}

export type DecisionBaselineKind = 'initial' | 'previous-review' | 'explicit-revision';

export type DecisionComparisonBaseline = {
  kind: DecisionBaselineKind;
  /** The task revision the baseline snapshot corresponds to, or null for an initial review. */
  taskRevision: number | null;
  /** The timestamp cutoff used to reconstruct each record's baseline state, or null. */
  at: string | null;
};

export type DecisionChangeKind = 'added' | 'changed' | 'removed' | 'unchanged';

export type DecisionRecordSnapshot = {
  revision: number;
  status: string;
  text: string;
};

export type DecisionSourceLink = {
  path: string;
  /** The digest declared at link time, or null when explicitly declared unavailable. */
  declaredDigest: string | null;
  status: RecordLinkStatus;
};

export type DecisionComparisonEntry = {
  recordId: string;
  kind: RecordKind;
  changeKind: DecisionChangeKind;
  provenance: TaskRecordProvenance;
  /** True when this record's own text is an agent inference rather than direct-user/imported/
   * execution-observed content; the comparison never upgrades this to a stronger claim. */
  interpretation: boolean;
  before: DecisionRecordSnapshot | null;
  after: DecisionRecordSnapshot | null;
  supersedes: string | null;
  supersededBy: string | null;
  /** Transition/revision reasons recorded strictly after the baseline cutoff, in order. */
  reasons: string[];
  sourceLinks: DecisionSourceLink[];
};

export type CriterionEvidenceStatus =
  'current-pass' | 'current-fail' | 'stale' | 'historical' | 'missing' | 'unknown-outcome';

export type CriterionEvidenceView = {
  criterionId: string;
  criterionRevision: number;
  description: string;
  required: boolean;
  approvalRequired: boolean;
  checkIds: string[];
  status: CriterionEvidenceStatus;
  /** The raw recorded outcome of the most relevant evidence entry, when any exists. */
  outcome: string | null;
  /** A concrete, non-color reason for the status, e.g. why a pass is only historical. */
  reason: string | null;
  evidenceId: string | null;
  recordedAt: string | null;
};

export type ApprovalCoverage = {
  present: boolean;
  /** null only when `present` is false (there is nothing to evaluate). */
  valid: boolean | null;
  status: string | null;
  digest: string | null;
  scope: string | null;
  reference: string | null;
  approvedAt: string | null;
  /** Concrete reasons an approval no longer covers current state; empty when valid or absent. */
  staleReasons: string[];
};

export type SourceDiffAvailability = { available: boolean; reason: string | null };

export type DecisionComparisonReport = {
  taskId: string;
  taskTitle: string;
  taskState: string;
  taskRevision: number;
  generatedAt: string;
  baseline: DecisionComparisonBaseline;
  hasDecisionRecords: boolean;
  /** Explains decision-coverage limits, e.g. no structured records at all (fall back to the
   * ordinary source diff) — never claims complete decision coverage when records are absent. */
  coverageNote: string;
  decisions: DecisionComparisonEntry[];
  unchangedCount: number;
  /** Required criteria no declared record link, task-wide, ever points at (see
   * docs/task-state.md#reconciling-changed-intent) — an explicit uncertainty, never proof of
   * independence. */
  uncoveredRequiredCriteria: string[];
  /** The declared record/criterion/check/evidence impact graph reached from every changed
   * decision, reusing #111's exact traversal (`buildImpactGraph`) — never inferred from filenames
   * or any other artifact heuristic. */
  impact: ImpactEntry[];
  impactTruncated: boolean;
  evidence: CriterionEvidenceView[];
  verification: { verifiable: boolean; failures: { criterionId: string; reason: string }[] };
  approvals: {
    workflow: ApprovalCoverage | null;
    specDecision: ApprovalCoverage | null;
    resultDecision: ApprovalCoverage | null;
  };
  resultDecision: ResultDecisionRecord | null;
  specDecision: SpecDecisionRecord | null;
  sourceDiff: SourceDiffAvailability;
};

export type InspectDecisionComparisonInput = {
  taskId: string;
  /** An explicitly selected retained task revision to compare against, in place of the derived
   * previously-reviewed snapshot. */
  baselineRevision?: number;
};

function taskRevisionTimestamp(task: Task, targetRevision: number): string | null {
  return task.events.find((event) => event.taskRevision === targetRevision)?.createdAt ?? null;
}

/** The record's own retained state at or before `atOrBefore`, or null when it did not exist yet. */
function recordStateAsOf(record: TaskRecord, atOrBefore: string): DecisionRecordSnapshot | null {
  let chosen: TaskRecordHistoryEntry | null = null;
  for (const entry of record.history) {
    if (entry.createdAt <= atOrBefore && (!chosen || entry.revision > chosen.revision)) {
      chosen = entry;
    }
  }
  return chosen ? { revision: chosen.revision, status: chosen.status, text: chosen.text } : null;
}

/**
 * The comparison baseline: an explicit revision when supplied, else the task revision as of the
 * most recent explicit review action already recorded by the existing #97/#101 decision
 * machinery (an approval or a notes submission), else an initial review. This never introduces a
 * new "last viewed" store — it derives the baseline entirely from state those existing services
 * already persist.
 */
async function resolveBaseline(
  task: Task,
  resultDecision: ResultDecisionRecord | null,
  specDecision: SpecDecisionRecord | null,
  baselineRevision: number | undefined,
): Promise<DecisionComparisonBaseline> {
  if (baselineRevision !== undefined) {
    if (
      !Number.isInteger(baselineRevision) ||
      baselineRevision < 1 ||
      baselineRevision > task.revision
    )
      throw new DecisionComparisonError(
        `baselineRevision must be between 1 and the current task revision (${task.revision}).`,
        'DECISION_COMPARISON_BASELINE_INVALID',
        '$.baselineRevision',
      );
    const at = taskRevisionTimestamp(task, baselineRevision);
    if (at === null)
      throw new DecisionComparisonError(
        'That task revision has no retained event to anchor a comparison.',
        'DECISION_COMPARISON_BASELINE_UNAVAILABLE',
        '$.baselineRevision',
      );
    return { kind: 'explicit-revision', taskRevision: baselineRevision, at };
  }
  const reviewTimestamps: string[] = [];
  for (const decision of [resultDecision, specDecision]) {
    if (!decision) continue;
    for (const event of decision.events) {
      if (event.type === 'approved' || event.type === 'notes-added') {
        reviewTimestamps.push(event.createdAt);
      }
    }
  }
  if (!reviewTimestamps.length) return { kind: 'initial', taskRevision: null, at: null };
  const latest = reviewTimestamps.sort().at(-1)!;
  let revision: number | null = null;
  let at: string | null = null;
  for (const event of task.events) {
    if (event.createdAt <= latest && (revision === null || event.taskRevision > revision)) {
      revision = event.taskRevision;
      at = event.createdAt;
    }
  }
  if (revision === null) return { kind: 'initial', taskRevision: null, at: null };
  return { kind: 'previous-review', taskRevision: revision, at };
}

function classifyChange(
  before: DecisionRecordSnapshot | null,
  current: DecisionRecordSnapshot,
): DecisionChangeKind {
  if (!before) return 'added';
  if (!isRecordStatusTerminal(before.status) && isRecordStatusTerminal(current.status))
    return 'removed';
  if (before.revision !== current.revision) return 'changed';
  return 'unchanged';
}

async function decisionEntries(
  root: string,
  task: Task,
  baseline: DecisionComparisonBaseline,
): Promise<{ entries: DecisionComparisonEntry[]; unchangedCount: number }> {
  const records = (task.records ?? []).filter((item) => item.kind === 'decision');
  let unchangedCount = 0;
  const entries = await Promise.all(
    records.map(async (record): Promise<DecisionComparisonEntry> => {
      const before = baseline.at === null ? null : recordStateAsOf(record, baseline.at);
      const current: DecisionRecordSnapshot = {
        revision: record.revision,
        status: record.status,
        text: record.text,
      };
      const changeKind = classifyChange(before, current);
      if (changeKind === 'unchanged') unchangedCount += 1;
      const cutoff = baseline.at;
      const reasons = record.history
        .filter((entry) => cutoff === null || entry.createdAt > cutoff)
        .map((entry) => entry.reason)
        .filter((reason): reason is string => Boolean(reason));
      const sourceLinks = await Promise.all(
        record.links
          .filter(
            (link): link is Extract<typeof link, { type: 'source' }> => link.type === 'source',
          )
          .map(async (link): Promise<DecisionSourceLink> => ({
            path: link.path,
            declaredDigest: link.digest,
            status: await reconcileSourceLinkStatus(root, link),
          })),
      );
      return {
        recordId: record.id,
        kind: record.kind,
        changeKind,
        provenance: record.provenance,
        interpretation: record.provenance.kind === 'agent-inferred',
        before,
        after: current,
        supersedes: record.supersedes,
        supersededBy: record.supersededBy,
        reasons,
        sourceLinks,
      };
    }),
  );
  return { entries, unchangedCount };
}

function criterionEvidenceView(
  criterion: Criterion,
  evidence: readonly TaskEvidence[],
  currentSource: SourceSnapshot,
  checkIds: string[],
): CriterionEvidenceView {
  const sameSource = (left: SourceSnapshot) =>
    left.revision === currentSource.revision &&
    left.dirtyFingerprint === currentSource.dirtyFingerprint;
  const matchingRevision = evidence.filter(
    (item) => item.criterionId === criterion.id && item.criterionRevision === criterion.revision,
  );
  const current = matchingRevision.findLast((item) => sameSource(item.source));
  if (current) {
    return {
      criterionId: criterion.id,
      criterionRevision: criterion.revision,
      description: criterion.description,
      required: criterion.required,
      approvalRequired: criterion.approvalRequired,
      checkIds,
      status: current.outcome === 'passed' ? 'current-pass' : 'current-fail',
      outcome: current.outcome,
      reason: current.outcome === 'passed' ? null : `Recorded outcome: ${current.outcome}.`,
      evidenceId: current.id,
      recordedAt: current.createdAt,
    };
  }
  const latestForRevision = matchingRevision.at(-1);
  if (latestForRevision) {
    return {
      criterionId: criterion.id,
      criterionRevision: criterion.revision,
      description: criterion.description,
      required: criterion.required,
      approvalRequired: criterion.approvalRequired,
      checkIds,
      status: 'stale',
      outcome: latestForRevision.outcome,
      reason: 'The working-tree source changed since this evidence was recorded.',
      evidenceId: latestForRevision.id,
      recordedAt: latestForRevision.createdAt,
    };
  }
  const priorEvidence = evidence
    .filter((item) => item.criterionId === criterion.id)
    .sort((left, right) => left.criterionRevision - right.criterionRevision)
    .at(-1);
  if (priorEvidence) {
    return {
      criterionId: criterion.id,
      criterionRevision: criterion.revision,
      description: criterion.description,
      required: criterion.required,
      approvalRequired: criterion.approvalRequired,
      checkIds,
      status: 'historical',
      outcome: priorEvidence.outcome,
      reason: `Recorded against criterion revision ${priorEvidence.criterionRevision}; the criterion is now at revision ${criterion.revision}.`,
      evidenceId: priorEvidence.id,
      recordedAt: priorEvidence.createdAt,
    };
  }
  return {
    criterionId: criterion.id,
    criterionRevision: criterion.revision,
    description: criterion.description,
    required: criterion.required,
    approvalRequired: criterion.approvalRequired,
    checkIds,
    status: 'missing',
    outcome: null,
    reason: 'No evidence has ever been recorded for this criterion.',
    evidenceId: null,
    recordedAt: null,
  };
}

function criteriaDigestOf(task: Task): string {
  return digestJson(
    task.criteria.map(({ id, revision, description, required, approvalRequired }) => ({
      id,
      revision,
      description,
      required,
      approvalRequired,
    })),
  );
}

/**
 * Reproduces `workflows/service.ts`'s private `approvalValid` check exactly (same field
 * comparisons, same digest primitives) without importing or modifying that module — see
 * docs/workflows.md and docs/task-state.md#reconciling-changed-intent. Returns the concrete
 * mismatched aspects too, so a stale approval's coverage explanation is never a bare boolean.
 */
function workflowApprovalCoverage(record: WorkflowRecord, task: Task): ApprovalCoverage {
  if (!record.approval)
    return {
      present: false,
      valid: null,
      status: record.status,
      digest: null,
      scope: null,
      reference: null,
      approvedAt: null,
      staleReasons: [],
    };
  const approval = record.approval;
  const staleReasons: string[] = [];
  if (!record.requirements || approval.requirementsDigest !== record.requirements.digest)
    staleReasons.push('Requirements changed since this approval.');
  if (!record.plan || approval.planDigest !== record.plan.digest)
    staleReasons.push('The plan changed since this approval.');
  if (!record.plan || approval.checksDigest !== record.plan.checksDigest)
    staleReasons.push('Acceptance checks changed since this approval.');
  if (approval.criteriaDigest !== criteriaDigestOf(task))
    staleReasons.push('Acceptance criteria changed since this approval.');
  if (
    (approval.intentDigest ?? computeIntentDigest([])) !== computeIntentDigest(task.records ?? [])
  )
    staleReasons.push('Accepted decisions or confirmed assumptions changed since this approval.');
  return {
    present: true,
    valid: staleReasons.length === 0,
    status: record.status,
    digest: approval.planDigest,
    scope: approval.scope,
    reference: approval.reference,
    approvedAt: approval.approvedAt,
    staleReasons,
  };
}

function specDecisionCoverage(decision: SpecDecisionRecord | null): ApprovalCoverage | null {
  if (!decision) return null;
  if (!decision.approval)
    return {
      present: false,
      valid: null,
      status: decision.status,
      digest: null,
      scope: null,
      reference: null,
      approvedAt: null,
      staleReasons: decision.status === 'pending' ? [] : [],
    };
  return {
    present: true,
    valid: decision.status === 'approved',
    status: decision.status,
    digest: decision.approval.planDigest,
    scope: decision.approval.scope,
    reference: decision.approval.reference,
    approvedAt: decision.approval.approvedAt,
    staleReasons:
      decision.status === 'approved'
        ? []
        : ['The plan changed since this approval; a fresh approval is required.'],
  };
}

function resultDecisionCoverage(decision: ResultDecisionRecord | null): ApprovalCoverage | null {
  if (!decision) return null;
  if (!decision.approval)
    return {
      present: false,
      valid: null,
      status: decision.status,
      digest: null,
      scope: null,
      reference: null,
      approvedAt: null,
      staleReasons: [],
    };
  return {
    present: true,
    valid: decision.status === 'approved',
    status: decision.status,
    digest: decision.approval.resultDigest,
    scope: null,
    reference: decision.approval.note || null,
    approvedAt: decision.approval.approvedAt,
    staleReasons:
      decision.status === 'approved'
        ? []
        : ['The reviewed result changed since this approval; a fresh approval is required.'],
  };
}

async function sourceDiffAvailability(
  root: string,
  taskId: string,
): Promise<SourceDiffAvailability> {
  try {
    const workspace = await inspectTaskWorkspace(root, taskId);
    if (!('path' in workspace) || typeof workspace.path !== 'string' || !workspace.path)
      return { available: false, reason: 'Task has no available owned worktree.' };
    return { available: true, reason: null };
  } catch (error) {
    return { available: false, reason: errorCode(error) ?? errorMessage(error) };
  }
}

/**
 * The full read-only decision-comparison report for one task. Never mutates task, workflow,
 * spec-decision, or result-decision state, and never invokes a provider or evidence-refresh
 * execution — only already-persisted state is read.
 */
export async function inspectDecisionComparison(
  root: string,
  input: InspectDecisionComparisonInput,
): Promise<DecisionComparisonReport> {
  const projectRoot = await resolveProjectRoot(root);
  const inspected = await inspectTask(projectRoot, input.taskId);
  const task = inspected.task;
  const [resultDecision, specDecision, workflowRecord] = await Promise.all([
    inspectResultDecision(projectRoot, task.id),
    inspectSpecDecision(projectRoot, task.id),
    readWorkflow(projectRoot, task.id),
  ]);
  const baseline = await resolveBaseline(
    task,
    resultDecision,
    specDecision,
    input.baselineRevision,
  );
  const { entries, unchangedCount } = await decisionEntries(projectRoot, task, baseline);
  const changedRecordIds = new Set(
    entries.filter((entry) => entry.changeKind !== 'unchanged').map((entry) => entry.recordId),
  );
  const graphView = {
    records: task.records ?? [],
    criteria: task.criteria.map((item) => ({ id: item.id, revision: item.revision })),
    evidence: task.evidence.map((item) => ({
      id: item.id,
      criterionId: item.criterionId,
      criterionRevision: item.criterionRevision,
    })),
    checks: (task.enhancedWorkflow?.checks ?? []).map((item) => ({
      id: item.id,
      criterionId: item.criterionId,
    })),
  };
  const { entries: impact, truncated: impactTruncated } = buildImpactGraph(
    graphView,
    changedRecordIds,
    new Set(),
  );
  const evidence = task.criteria.map((criterion) =>
    criterionEvidenceView(
      criterion,
      task.evidence,
      inspected.reconciliation.currentSource,
      (task.enhancedWorkflow?.checks ?? [])
        .filter((check) => check.criterionId === criterion.id)
        .map((check) => check.id),
    ),
  );
  const hasDecisionRecords = (task.records ?? []).some((item) => item.kind === 'decision');
  return {
    taskId: task.id,
    taskTitle: task.title,
    taskState: task.state,
    taskRevision: task.revision,
    generatedAt: new Date().toISOString(),
    baseline,
    hasDecisionRecords,
    coverageNote: hasDecisionRecords
      ? 'Decision coverage reflects explicitly recorded task records; unrecorded prose changes are not represented here.'
      : 'No structured decision records exist for this task. This falls back to the ordinary source diff (see sourceDiff) without claiming decision coverage.',
    decisions: entries,
    unchangedCount,
    uncoveredRequiredCriteria: uncoveredRequiredCriteria(graphView, task.criteria),
    impact,
    impactTruncated,
    evidence,
    verification: {
      verifiable: inspected.reconciliation.verifiable,
      failures: inspected.reconciliation.verificationFailures,
    },
    approvals: {
      workflow: workflowRecord ? workflowApprovalCoverage(workflowRecord, task) : null,
      specDecision: specDecisionCoverage(specDecision),
      resultDecision: resultDecisionCoverage(resultDecision),
    },
    resultDecision,
    specDecision,
    sourceDiff: await sourceDiffAvailability(projectRoot, task.id),
  };
}

function approvalCoverageLine(label: string, coverage: ApprovalCoverage | null): string {
  if (!coverage) return `${label}: none recorded.`;
  const valid = coverage.valid === null ? 'n/a' : coverage.valid ? 'valid' : 'stale';
  const reasons = coverage.staleReasons.length ? ` — ${coverage.staleReasons.join(' ')}` : '';
  return `${label}: status=${coverage.status ?? 'n/a'} coverage=${valid}${reasons}`;
}

/** A concise, deterministic text rendering of a comparison report for the CLI and non-UI callers
 * (issue #113 acceptance criterion: a read-only textual/JSON comparison for users without the
 * UI). Every value here is read verbatim from the report; nothing is re-derived. */
export function formatDecisionComparisonText(report: DecisionComparisonReport): string {
  const lines: string[] = [];
  lines.push(
    `Task ${report.taskId} — ${report.taskTitle} (state: ${report.taskState}, revision ${report.taskRevision})`,
  );
  lines.push(
    report.baseline.kind === 'initial'
      ? 'Baseline: initial review (no prior reviewed snapshot).'
      : `Baseline: ${report.baseline.kind === 'previous-review' ? 'previously reviewed snapshot' : 'explicitly selected revision'} at task revision ${report.baseline.taskRevision}.`,
  );
  lines.push(
    report.hasDecisionRecords
      ? `Decisions: ${report.decisions.length} recorded (${report.unchangedCount} unchanged).`
      : report.coverageNote,
  );
  for (const entry of report.decisions.filter((item) => item.changeKind !== 'unchanged')) {
    lines.push(
      `  [${entry.changeKind.toUpperCase()}] ${entry.recordId}${entry.interpretation ? ' [interpretation: agent-inferred]' : ''}`,
    );
    if (entry.before)
      lines.push(
        `    before (rev ${entry.before.revision}, ${entry.before.status}): ${entry.before.text}`,
      );
    if (entry.after)
      lines.push(
        `    after  (rev ${entry.after.revision}, ${entry.after.status}): ${entry.after.text}`,
      );
    for (const reason of entry.reasons) lines.push(`    reason: ${reason}`);
    for (const link of entry.sourceLinks) lines.push(`    source: ${link.path} [${link.status}]`);
  }
  if (report.uncoveredRequiredCriteria.length)
    lines.push(
      `Uncovered required criteria (no declared decision link — absence never proves independence): ${report.uncoveredRequiredCriteria.join(', ')}`,
    );
  const consequences = report.impact.filter((item) => item.classification === 'declared-dependent');
  if (consequences.length) {
    lines.push(`Declared consequences${report.impactTruncated ? ' (truncated)' : ''}:`);
    for (const item of consequences)
      lines.push(
        `  ${item.kind}:${item.id} — ${item.outcome} (${item.reasonCode}; via ${item.path.join(' -> ')})`,
      );
  }
  lines.push('Evidence:');
  for (const item of report.evidence)
    lines.push(
      `  ${item.criterionId} (rev ${item.criterionRevision}${item.required ? ', required' : ''}): ${item.status}${item.outcome ? ` [${item.outcome}]` : ''}${item.reason ? ` — ${item.reason}` : ''}`,
    );
  lines.push(
    `Verification: ${report.verification.verifiable ? 'verifiable' : 'not verifiable'}${
      report.verification.failures.length
        ? ` (${report.verification.failures.map((item) => `${item.criterionId}:${item.reason}`).join(', ')})`
        : ''
    }`,
  );
  lines.push(approvalCoverageLine('Workflow plan approval', report.approvals.workflow));
  lines.push(approvalCoverageLine('Spec decision', report.approvals.specDecision));
  lines.push(approvalCoverageLine('Result decision', report.approvals.resultDecision));
  lines.push(
    report.sourceDiff.available
      ? 'Source diff: available via GET /api/diff?taskId=... (or latchkit diff inspect --task ...).'
      : `Source diff: unavailable (${report.sourceDiff.reason ?? 'unknown reason'}).`,
  );
  return lines.join('\n');
}
