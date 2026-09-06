import { resolveProjectRoot } from '../storage.js';
import { inspectTask, inspectTaskRecord } from '../task-state/service.js';
import type { Criterion, Task, TaskEvidence } from '../task-state/contracts.js';
import { computeIntentDigest, type RecordLink, type TaskRecord } from '../task-state/records.js';
import type { TaskReconciliation } from '../task-state/reconcile.js';
import { readWorkflow } from '../workflows/store.js';
import {
  approvalValid,
  criteriaDigest,
  sourceEqual,
  type SourceIdentity,
  type WorkflowRecord,
} from '../workflows/contracts.js';
import {
  assertByteBudget,
  assertOptionalDigest,
  canonicalBriefJson,
  CONTEXT_BRIEF_SCHEMA_VERSION,
  DEFAULT_CONTEXT_BRIEF_BYTES,
  DELIVERY_NOTE,
  digestBriefJson,
  TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  TOKEN_ESTIMATE_DISCLAIMER,
  ContextBriefError,
  type AuthorizationSummary,
  type ChangeSinceLastRun,
  type ChangeSinceLastRunReason,
  type CompletedWorkEntry,
  type ContextBrief,
  type ContextBriefBinding,
  type CriterionSummary,
  type IntentRecordSummary,
  type MissingDependencyLink,
  type NextActionSummary,
  type OmittedItem,
  type PlanReferenceSummary,
  type ReconciliationOutcomeSummary,
  type RecordLinkSummary,
  type UnreconciledChangeSummary,
  type WorkNeedingAttentionEntry,
} from './contracts.js';

/**
 * The read-only assembly for issue #112's context projection. `assembleContextBrief` is the pure
 * core: it takes an already-loaded `task`/`workflow`/`source` and performs no I/O of its own
 * beyond the optional `resolveLinks` callback, so it can be driven either by real, currently
 * committed state (`buildContextBrief`, `bindDispatchContext`) or by a caller that already has its
 * own authoritative task/workflow snapshot in hand — notably
 * `src/workflows/service.ts#invoke`, whose `tasks`/`policy` services are injectable and must never
 * be bypassed by a second, independent read of real storage (that would defeat test doubles and
 * could disagree with the snapshot the rest of the dispatch is using). Nothing here mutates
 * task/workflow state, writes a file, installs anything, or launches a provider. Identical input
 * against identical underlying state always reproduces an identical `digest` (the only field that
 * legitimately varies between otherwise-identical calls is `generatedAt`), mirroring
 * `previewTaskReconciliation`'s determinism contract.
 */

function linkTargetId(link: RecordLink): string {
  if (link.type === 'record') return link.recordId;
  if (link.type === 'criterion') return link.criterionId;
  if (link.type === 'evidence') return link.evidenceId;
  if (link.type === 'memory') return link.memoryId;
  return link.path;
}

function rawLinkSummary(link: RecordLink): RecordLinkSummary {
  return { type: link.type, targetId: linkTargetId(link), status: null };
}

function rawLinkSummaries(record: TaskRecord): RecordLinkSummary[] {
  return record.links.map(rawLinkSummary);
}

/** Real, current link-status resolution via `inspectTaskRecord` — used only when the caller has a
 * real, persisted task (see `defaultLinkResolver`). Never called directly by `assembleContextBrief`
 * itself, so a caller with only an in-memory task snapshot (a test double, or a future adapter)
 * cannot be surprised by an unexpected extra storage read. */
async function resolvedLinkSummaries(
  root: string,
  taskId: string,
  recordId: string,
): Promise<RecordLinkSummary[]> {
  const inspected = await inspectTaskRecord(root, { taskId, recordId });
  return inspected.links.map(({ link, status }) => ({
    type: link.type,
    targetId: linkTargetId(link),
    status: status as RecordLinkSummary['status'],
  }));
}

/** Default `resolveLinks` for a caller that has a real project root: attempt real, current
 * link-status resolution and gracefully degrade to the unresolved (raw) summary if that fails for
 * any reason (including "this task does not actually exist in persisted storage," which is
 * expected when `assembleContextBrief` is driven from an in-memory task snapshot that was never
 * really persisted — see `src/workflows/service.ts#invoke`, which passes its own controller's
 * task rather than trusting a redundant, possibly-disagreeing storage read). Never throws. */
function defaultLinkResolver(root: string, taskId: string) {
  return async (record: TaskRecord): Promise<RecordLinkSummary[]> => {
    try {
      return await resolvedLinkSummaries(root, taskId, record.id);
    } catch {
      return rawLinkSummaries(record);
    }
  };
}

function criterionSummaryOf(criterion: Criterion): CriterionSummary {
  return {
    id: criterion.id,
    revision: criterion.revision,
    description: criterion.description,
    required: criterion.required,
    approvalRequired: criterion.approvalRequired,
  };
}

function intentRecordSummary(record: TaskRecord, links: RecordLinkSummary[]): IntentRecordSummary {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    revision: record.revision,
    text: record.text,
    provenance: record.provenance,
    links,
  };
}

function summarizeReconciliation(
  reconciliation: TaskReconciliation,
  task: Task,
): ReconciliationOutcomeSummary {
  const event = task.events.find((item) => item.id === reconciliation.mutationId);
  return {
    id: reconciliation.id,
    createdAt: reconciliation.createdAt,
    patchDigest: reconciliation.patchDigest,
    taskRevisionAfter: event?.taskRevision ?? null,
    ops: reconciliation.ops.map((op) => ({
      op: op.op,
      targetId: op.targetId,
      fromStatus: op.fromStatus,
      toStatus: op.toStatus,
    })),
    impactSummary: reconciliation.impactSummary,
    impactTruncated: reconciliation.impactTruncated,
    uncertaintiesCount: reconciliation.uncertainties.length,
  };
}

function buildPlanReferences(task: Task, workflow: WorkflowRecord | null): PlanReferenceSummary[] {
  const refs: PlanReferenceSummary[] = [];
  if (workflow?.plan)
    refs.push({
      kind: 'workflow-plan',
      sourceRef: `workflow:${workflow.workflowId}:plan`,
      digest: workflow.plan.digest,
    });
  if (workflow?.requirements)
    refs.push({
      kind: 'workflow-requirements',
      sourceRef: `workflow:${workflow.workflowId}:requirements`,
      digest: workflow.requirements.digest,
    });
  if (task.enhancedWorkflow) {
    refs.push({
      kind: 'enhanced-technical-plan',
      sourceRef: task.enhancedWorkflow.artifacts.technicalPlan.path,
      digest: task.enhancedWorkflow.artifacts.technicalPlan.sha256,
    });
    refs.push({
      kind: 'enhanced-prd',
      sourceRef: task.enhancedWorkflow.artifacts.prd.path,
      digest: task.enhancedWorkflow.artifacts.prd.sha256,
    });
  }
  if (task.import)
    refs.push({ kind: 'imported-note', sourceRef: task.import.path, digest: task.import.sha256 });
  return refs;
}

/**
 * A projection of the existing workflow's *current* status/phase/approval-freshness — never a
 * re-invocation of the delivery-workflow's own TypeScript policy (`src/workflows/policy.ts`
 * remains the sole owner of that decision) and never provider execution. This keeps "the next
 * action allowed by the existing workflow" both accurate (`approvalValid` is the exact live check
 * `src/workflows/service.ts` uses) and safe to compute in a read-only preview.
 */
function deriveNextAction(workflow: WorkflowRecord | null, task: Task): NextActionSummary {
  if (!workflow)
    return {
      kind: 'ordinary-task',
      phase: null,
      description:
        'No delivery workflow is registered for this task; ordinary task operations ' +
        '(resume/checkpoint/complete/verify) apply directly.',
    };
  const phase = workflow.phase;
  switch (workflow.status) {
    case 'awaiting-approval':
      return {
        kind: 'await-approval',
        phase,
        description:
          'Review and approve the exact requirements/plan/checks digests (`workflow inspect`, ' +
          '`workflow approve`), or provide revision notes, before implementation continues.',
      };
    case 'awaiting-input':
      return {
        kind: 'await-input',
        phase,
        description: 'Resume the workflow with an answer to the pending question(s).',
      };
    case 'blocked':
      return {
        kind: 'blocked',
        phase,
        description:
          "Resolve the blocking failure reported in the workflow's last outcome, then resume.",
      };
    case 'interrupted':
      return {
        kind: 'interrupted-pending',
        phase,
        description:
          'A prior action may have produced effects; resolve it (observed/abandon/retry) with ' +
          '`workflow resume` before continuing.',
      };
    case 'cancelled':
      return {
        kind: 'cancelled',
        phase,
        description: 'This workflow was cancelled; start a new task or workflow to continue.',
      };
    case 'verified':
      return {
        kind: 'complete',
        phase,
        description:
          'This workflow reached verified completion; no further action is allowed by the ' +
          'existing workflow.',
      };
    case 'running':
      if (workflow.pendingAction)
        return {
          kind: 'interrupted-pending',
          phase,
          description:
            'An action is currently journaled as pending; `workflow resume` will settle it or ' +
            'ask for an explicit resolution.',
        };
      if (!approvalValid(workflow, task))
        return {
          kind: 'await-approval',
          phase,
          description:
            'Accepted intent or criteria changed since the last approval; resuming will require ' +
            're-approval before implementation continues (see ' +
            'docs/task-state.md#reconciling-changed-intent).',
        };
      return {
        kind: 'continue',
        phase,
        description: `Resuming will invoke the ${phase} phase.`,
      };
    default:
      return {
        kind: 'blocked',
        phase,
        description: 'Unrecognized workflow status; inspect the workflow directly.',
      };
  }
}

function buildResumeGuidance(task: Task): string {
  if (task.owner)
    return (
      'This task currently has an active run/owner. Latchkit cannot inject fresh context into ' +
      'an already-running provider session: checkpoint progress, and this brief applies at the ' +
      'next resume/dispatch (the existing checkpoint/next-session path).'
    );
  return 'This brief applies at the next dispatch (`task resume`, or `workflow run`/`resume`).';
}

/** Every list field starts empty here — including `missingDependencyLinks`, which reflects
 * *current* state and is populated by budget-fitting later regardless of `available` — so none of
 * these bounded lists count against the mandatory-content size before the fit step runs. */
function emptyChangeSinceLastRun(
  reason: ChangeSinceLastRunReason,
  sinceDigest: string | null,
  boundAt: string | null,
): ChangeSinceLastRun {
  return {
    available: reason === 'ok',
    reason,
    sinceDigest,
    boundAt,
    reconciliationsSince: [],
    reconciliationsSinceTruncated: false,
    unreconciledChange: null,
    workNeedingAttention: [],
    completedWorkRemaining: [],
    missingDependencyLinks: [],
  };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(canonicalBriefJson(value), 'utf8');
}

/** Deterministic, priority-ordered, single-pass greedy fill: earlier sections are filled to
 * completion before later ones are attempted, and within a section items are attempted in the
 * order given (already sorted most-important/most-recent first). Every dropped item is recorded
 * in `omitted` with an inspectable source reference — never silently discarded. */
function growList<T>(
  content: Record<string, unknown>,
  items: readonly T[],
  apply: (list: T[]) => void,
  budgetBytes: number,
  sectionName: string,
  idOf: (item: T) => string,
  sourceRefOf: (item: T) => string,
  omitted: OmittedItem[],
): T[] {
  let kept: T[] = [];
  for (const item of items) {
    const candidate = [...kept, item];
    apply(candidate);
    if (bytesOf(content) <= budgetBytes) {
      kept = candidate;
    } else {
      apply(kept);
      omitted.push({ section: sectionName, id: idOf(item), sourceRef: sourceRefOf(item) });
    }
  }
  return kept;
}

/**
 * Matches task-state's own private per-criterion evidence-currency check (see
 * `verificationFailures` in `src/task-state/service.ts`) without needing access to it: current
 * (matching criterion revision and working-tree source), `passed`, and — for an
 * approval-required criterion — backed by approval evidence whose authorization still exists on
 * the task. Reimplemented here (rather than imported) because it is private, and because
 * `assembleContextBrief` must stay usable from an in-memory task snapshot that a real
 * `inspectTask` call could not see (see the module doc comment). This is the same freshness rule
 * everywhere else in this contract — "unchanged work never implies reusable evidence": a criterion
 * is only ever reported as currently satisfied because this check found live, current, passing
 * evidence for it, never because nothing else touched it.
 */
function currentPassingEvidence(
  criterion: Criterion,
  task: Task,
  source: SourceIdentity,
): TaskEvidence | null {
  const candidates = task.evidence.filter(
    (item) => item.criterionId === criterion.id && item.criterionRevision === criterion.revision,
  );
  const evidence = candidates.findLast((item) => sourceEqual(item.source, source));
  if (!evidence || evidence.outcome !== 'passed') return null;
  if (
    criterion.approvalRequired &&
    (evidence.kind !== 'approval' ||
      !task.authorizations.some((item) => item.id === evidence.authorizationId))
  )
    return null;
  return evidence;
}

export type AssembleContextBriefInput = {
  task: Task;
  workflow: WorkflowRecord | null;
  source: SourceIdentity;
  byteBudget: number;
  /** The digest to diff "change since last run" against. Omit (or pass explicit `null`) to force
   * `no-prior-dispatch`/rely on the workflow's own last-dispatched digest — see
   * `ContextBriefInput.sinceDigest` for the same semantics on the public, root-driven entry
   * point. */
  sinceDigest?: string | null;
  clock?: () => Date;
  /** Defaults to always returning the record's declared, unresolved links (`status: null`) —
   * honest and side-effect-free for a caller with no real project root to check against. Callers
   * with a real root should pass `defaultLinkResolver(root, task.id)` instead. */
  resolveLinks?: (record: TaskRecord) => Promise<RecordLinkSummary[]>;
};

export async function assembleContextBrief(
  input: AssembleContextBriefInput,
): Promise<ContextBrief> {
  const clock = input.clock ?? (() => new Date());
  const byteBudget = assertByteBudget(input.byteBudget);
  const resolveLinks =
    input.resolveLinks ?? ((record: TaskRecord) => Promise.resolve(rawLinkSummaries(record)));
  const task = input.task;
  const workflow = input.workflow;
  const source = input.source;

  const intentDigestValue = computeIntentDigest(task.records ?? []);
  const criteriaDigestValue = criteriaDigest(task.criteria);

  const records = task.records ?? [];
  const decisionsAcceptedRaw = records.filter(
    (item) => item.kind === 'decision' && item.status === 'accepted',
  );
  const decisionsProposedRaw = records.filter(
    (item) => item.kind === 'decision' && item.status === 'proposed',
  );
  const assumptionsConfirmedRaw = records.filter(
    (item) => item.kind === 'assumption' && item.status === 'confirmed',
  );
  const assumptionsOpenRaw = records.filter(
    (item) => item.kind === 'assumption' && ['tentative', 'contradicted'].includes(item.status),
  );
  const questionsOpenRaw = records.filter(
    (item) => item.kind === 'question' && item.status === 'open',
  );
  const observationsRaw = [...records.filter((item) => item.kind === 'observation')].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  async function summarize(
    list: TaskRecord[],
    withResolvedLinks: boolean,
  ): Promise<IntentRecordSummary[]> {
    return Promise.all(
      list.map(async (item) =>
        intentRecordSummary(
          item,
          withResolvedLinks ? await resolveLinks(item) : rawLinkSummaries(item),
        ),
      ),
    );
  }

  const acceptedDecisions = await summarize(decisionsAcceptedRaw, true);
  const confirmedAssumptions = await summarize(assumptionsConfirmedRaw, true);
  const pendingDecisions = await summarize(decisionsProposedRaw, false);
  const openAssumptions = await summarize(assumptionsOpenRaw, false);
  const openQuestions = await summarize(questionsOpenRaw, false);
  const historicalObservationsFull = await summarize(observationsRaw, false);

  const missingDependencyLinks: MissingDependencyLink[] = [];
  for (const summary of [...acceptedDecisions, ...confirmedAssumptions])
    for (const link of summary.links)
      if (link.status === 'missing' || link.status === 'unknown')
        missingDependencyLinks.push({
          recordId: summary.id,
          linkType: link.type,
          targetId: link.targetId,
          status: link.status,
        });

  const authorizations: AuthorizationSummary[] = task.authorizations
    .slice(-50)
    .map((item) => ({ id: item.id, scope: item.scope, grantedAt: item.grantedAt }));

  const criteria = task.criteria.map(criterionSummaryOf);

  const requiredCriterionHasCurrentEvidence = new Map(
    task.criteria
      .filter((item) => item.required)
      .map((item) => [item.id, Boolean(currentPassingEvidence(item, task, source))] as const),
  );

  const reconciliationsAll = [...(task.reconciliations ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const reconciliationOutcomesFull = reconciliationsAll.map((item) =>
    summarizeReconciliation(item, task),
  );

  const planReferencesFull = buildPlanReferences(task, workflow);
  const nextAction = deriveNextAction(workflow, task);
  const resumeGuidance = buildResumeGuidance(task);

  const resolvedSinceDigest =
    input.sinceDigest !== undefined
      ? assertOptionalDigest(input.sinceDigest, '$.sinceDigest')
      : (workflow?.lastDispatchedContext?.digest ?? null);

  let changeSinceLastRun: ChangeSinceLastRun;
  let reconciliationsSinceFull: TaskReconciliation[] = [];
  let workNeedingAttentionFull: WorkNeedingAttentionEntry[] = [];
  const completedWorkRemainingFull: CompletedWorkEntry[] = [];
  if (resolvedSinceDigest === null) {
    changeSinceLastRun = emptyChangeSinceLastRun('no-prior-dispatch', null, null);
  } else if (
    !workflow?.lastDispatchedContext ||
    workflow.lastDispatchedContext.digest !== resolvedSinceDigest
  ) {
    changeSinceLastRun = emptyChangeSinceLastRun(
      'digest-mismatch',
      resolvedSinceDigest,
      workflow?.lastDispatchedContext?.deliveredAt ?? null,
    );
  } else {
    const bound = workflow.lastDispatchedContext;
    reconciliationsSinceFull = reconciliationsAll.filter((item) => {
      const event = task.events.find((candidate) => candidate.id === item.mutationId);
      return (event?.taskRevision ?? Number.POSITIVE_INFINITY) > bound.taskRevision;
    });

    const criteriaDigestChanged = criteriaDigestValue !== bound.criteriaDigest;
    const intentDigestChanged = intentDigestValue !== bound.intentDigest;
    let unreconciledChange: UnreconciledChangeSummary | null = null;
    if (criteriaDigestChanged || intentDigestChanged) {
      const explainedByReconciliation = reconciliationsSinceFull.length > 0;
      unreconciledChange = {
        criteriaDigestChanged,
        intentDigestChanged,
        note: explainedByReconciliation
          ? null
          : 'Criteria and/or accepted intent changed outside the reconciliation flow (for ' +
            'example a direct edit); inspect task criteria/records directly.',
      };
    }

    const workNeedingAttentionMap = new Map<string, WorkNeedingAttentionEntry>();
    for (const item of reconciliationsSinceFull)
      for (const entry of item.impact) {
        if (
          !['needs-re-verification', 'needs-replanning', 'needs-user-decision'].includes(
            entry.outcome,
          )
        )
          continue;
        workNeedingAttentionMap.set(`${entry.kind}:${entry.id}`, {
          kind: entry.kind,
          id: entry.id,
          outcome: entry.outcome,
          reasonCode: entry.reasonCode,
        });
      }
    workNeedingAttentionFull = [...workNeedingAttentionMap.values()].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
    );
    const flaggedCriterionIds = new Set(
      workNeedingAttentionFull.filter((item) => item.kind === 'criterion').map((item) => item.id),
    );

    for (const criterion of task.criteria.filter((item) => item.required)) {
      if (flaggedCriterionIds.has(criterion.id)) continue;
      if (!requiredCriterionHasCurrentEvidence.get(criterion.id)) continue;
      const evidence = currentPassingEvidence(criterion, task, source);
      if (evidence)
        completedWorkRemainingFull.push({
          criterionId: criterion.id,
          description: criterion.description,
          evidenceId: evidence.id,
        });
    }
    completedWorkRemainingFull.sort((a, b) => a.criterionId.localeCompare(b.criterionId));

    changeSinceLastRun = {
      available: true,
      reason: 'ok',
      sinceDigest: resolvedSinceDigest,
      boundAt: bound.deliveredAt,
      reconciliationsSince: [],
      reconciliationsSinceTruncated: false,
      unreconciledChange,
      workNeedingAttention: [],
      completedWorkRemaining: [],
      missingDependencyLinks: [],
    };
  }

  const content: Record<string, unknown> = {
    schemaVersion: CONTEXT_BRIEF_SCHEMA_VERSION,
    taskId: task.id,
    taskRevision: task.revision,
    taskState: task.state,
    intentDigest: intentDigestValue,
    criteriaDigest: criteriaDigestValue,
    source,
    workflow: {
      exists: Boolean(workflow),
      workflowId: workflow?.workflowId ?? null,
      revision: workflow?.revision ?? null,
      phase: workflow?.phase ?? null,
      status: workflow?.status ?? null,
    },
    authorizations,
    acceptedDecisions,
    confirmedAssumptions,
    pendingDecisions,
    openAssumptions,
    openQuestions,
    historicalObservations: [] as IntentRecordSummary[],
    criteria,
    reconciliationOutcomes: [] as ReconciliationOutcomeSummary[],
    reconciliationOutcomesTruncated: false,
    planReferences: [] as PlanReferenceSummary[],
    nextAction,
    changeSinceLastRun,
    deliveryNote: DELIVERY_NOTE,
    resumeGuidance,
  };

  const mandatoryBytes = bytesOf(content);
  if (mandatoryBytes > byteBudget)
    throw new ContextBriefError(
      `Mandatory context (${mandatoryBytes} bytes: accepted decisions, confirmed assumptions, ` +
        'pending decisions, open assumptions/questions, criteria, authorizations, and the next ' +
        `action) exceeds the ${byteBudget}-byte budget. Raise --byte-budget to at least ` +
        `${mandatoryBytes}, or resolve/supersede pending records to shrink the brief before ` +
        'requesting one again. Optional material is never used to make room for mandatory content.',
      'CONTEXT_BRIEF_BUDGET_EXCEEDED',
      '$.byteBudget',
    );

  const omitted: OmittedItem[] = [];
  const reconciliationRef = (item: ReconciliationOutcomeSummary) =>
    `task.reconciliations[id=${item.id}]`;

  growList(
    content,
    missingDependencyLinks,
    (list) => {
      (content.changeSinceLastRun as ChangeSinceLastRun).missingDependencyLinks = list;
    },
    byteBudget,
    'changeSinceLastRun.missingDependencyLinks',
    (item) => `${item.recordId}:${item.linkType}:${item.targetId}`,
    (item) => `task.records[id=${item.recordId}].links[${item.linkType}:${item.targetId}]`,
    omitted,
  );
  growList(
    content,
    workNeedingAttentionFull,
    (list) => {
      (content.changeSinceLastRun as ChangeSinceLastRun).workNeedingAttention = list;
    },
    byteBudget,
    'changeSinceLastRun.workNeedingAttention',
    (item) => `${item.kind}:${item.id}`,
    (item) => `${item.kind}:${item.id}`,
    omitted,
  );
  const keptReconciliationsSince = growList(
    content,
    reconciliationsSinceFull.map((item) => summarizeReconciliation(item, task)),
    (list) => {
      (content.changeSinceLastRun as ChangeSinceLastRun).reconciliationsSince = list;
    },
    byteBudget,
    'changeSinceLastRun.reconciliationsSince',
    (item) => item.id,
    reconciliationRef,
    omitted,
  );
  (content.changeSinceLastRun as ChangeSinceLastRun).reconciliationsSinceTruncated =
    keptReconciliationsSince.length < reconciliationsSinceFull.length;
  growList(
    content,
    completedWorkRemainingFull,
    (list) => {
      (content.changeSinceLastRun as ChangeSinceLastRun).completedWorkRemaining = list;
    },
    byteBudget,
    'changeSinceLastRun.completedWorkRemaining',
    (item) => item.criterionId,
    (item) => `task.criteria[id=${item.criterionId}]`,
    omitted,
  );
  const keptReconciliationOutcomes = growList(
    content,
    reconciliationOutcomesFull,
    (list) => {
      content.reconciliationOutcomes = list;
    },
    byteBudget,
    'reconciliationOutcomes',
    (item) => item.id,
    reconciliationRef,
    omitted,
  );
  content.reconciliationOutcomesTruncated =
    keptReconciliationOutcomes.length < reconciliationOutcomesFull.length;
  growList(
    content,
    planReferencesFull,
    (list) => {
      content.planReferences = list;
    },
    byteBudget,
    'planReferences',
    (item) => item.sourceRef,
    (item) => item.sourceRef,
    omitted,
  );
  growList(
    content,
    historicalObservationsFull,
    (list) => {
      content.historicalObservations = list;
    },
    byteBudget,
    'historicalObservations',
    (item) => item.id,
    (item) => `task.records[id=${item.id}]`,
    omitted,
  );

  const usedBytes = bytesOf(content);
  const digest = digestBriefJson(content);
  const generatedAt = clock().toISOString();

  return {
    ...(content as Omit<ContextBrief, 'omitted' | 'budget' | 'digest' | 'generatedAt'>),
    omitted,
    budget: {
      requestedBytes: byteBudget,
      effectiveBytes: byteBudget,
      mandatoryBytes,
      usedBytes,
      estimatedTokens: Math.ceil(usedBytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN),
      estimateDisclaimer: TOKEN_ESTIMATE_DISCLAIMER,
    },
    digest,
    generatedAt,
  };
}

export type ContextBriefInput = {
  taskId: string;
  /** Explicit byte budget (AC #3); defaults to `DEFAULT_CONTEXT_BRIEF_BYTES`. */
  byteBudget?: number;
  /** The digest to diff "change since last run" against. Omit to use the workflow's own
   * last-dispatched digest automatically; pass `null` explicitly to force `no-prior-dispatch`. */
  sinceDigest?: string | null;
  clock?: () => Date;
};

/** The root-driven, fully "live" entry point used by `latchkit task context-preview` and
 * `latchkit workflow context`: reads the actual current task and workflow state, then delegates to
 * `assembleContextBrief`. */
export async function buildContextBrief(
  root: string,
  input: ContextBriefInput,
): Promise<ContextBrief> {
  root = await resolveProjectRoot(root);
  const inspected = await inspectTask(root, input.taskId);
  const workflow = await readWorkflow(root, input.taskId);
  return assembleContextBrief({
    task: inspected.task,
    workflow,
    source: inspected.reconciliation.currentSource,
    byteBudget: input.byteBudget ?? DEFAULT_CONTEXT_BRIEF_BYTES,
    sinceDigest: input.sinceDigest,
    clock: input.clock,
    resolveLinks: defaultLinkResolver(root, input.taskId),
  });
}

export type BindDispatchContextInput = {
  /** The task snapshot the caller's own dispatch is already using — never re-fetched, so a
   * caller with an injectable/mockable task service (see `src/workflows/service.ts#invoke`)
   * cannot silently disagree with a second, independent storage read. */
  task: Task;
  workflow: WorkflowRecord;
  source: SourceIdentity;
  byteBudget?: number;
  clock?: () => Date;
};

/**
 * Builds a fresh brief from the caller's own already-loaded task/workflow snapshot and returns the
 * exact binding `src/workflows/service.ts#invoke` records on the workflow's own dispatch journal
 * (`WorkflowRecord.lastDispatchedContext`) in the same mutation that claims `pendingAction`. Always
 * rebuilds rather than reusing a previously bound brief, so a source drift or an intent/criteria
 * change between dispatches is reflected immediately (AC #5's "reject or rebuild before dispatch
 * if those inputs change"). `root` is used only for the best-effort, gracefully-degrading
 * declared-link status resolution (`defaultLinkResolver`) — never to re-read the task or workflow
 * themselves.
 */
export async function bindDispatchContext(
  root: string,
  input: BindDispatchContextInput,
): Promise<{ brief: ContextBrief; binding: ContextBriefBinding }> {
  const brief = await assembleContextBrief({
    task: input.task,
    workflow: input.workflow,
    source: input.source,
    byteBudget: input.byteBudget ?? DEFAULT_CONTEXT_BRIEF_BYTES,
    clock: input.clock,
    resolveLinks: defaultLinkResolver(root, input.task.id),
  });
  const binding: ContextBriefBinding = {
    digest: brief.digest,
    briefSchemaVersion: brief.schemaVersion,
    taskRevision: brief.taskRevision,
    workflowRevision: brief.workflow.revision ?? 0,
    criteriaDigest: brief.criteriaDigest,
    intentDigest: brief.intentDigest,
    source: brief.source,
    artifactHashes: brief.planReferences.map((item) => ({
      path: item.sourceRef,
      digest: item.digest,
    })),
    deliveredAt: brief.generatedAt,
  };
  return { brief, binding };
}
