import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  applyTaskReconciliation,
  cancelTask,
  completeTask,
  createTask,
  previewTaskReconciliation,
  recordEvidence,
  recordTaskRecord,
  registerEnhancedWorkflow,
  resumeTask,
  transitionTaskRecord,
  verifyTask,
} from '../dist/src/task-state/service.js';
import { readTaskState, writeTaskState } from '../dist/src/task-state/store.js';
import { createWorkflow } from '../dist/src/workflows/store.js';
import { digestJson } from '../dist/src/workflows/contracts.js';
import { computeIntentDigest } from '../dist/src/task-state/records.js';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

// Wrap mkdtemp's root in realpath before deriving expected paths: CI can hand back an 8.3
// short-path alias on Windows, which would otherwise mismatch a later canonicalized path. The
// project directory itself carries a space and a non-ASCII character, matching the fixture
// requirement for reconciliation coverage.
async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-task-reconcile-')),
  );
  const root = path.join(base, 'reconcile project é');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'orders.sql'), 'select * from orders;\n');
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

const authorization = (scope, reference = 'current direct test request') => ({
  source: 'user',
  scope,
  reference,
});

async function baseTask(root, criteria = []) {
  return createTask(root, {
    title: 'Export orders',
    authorization: authorization('implement task'),
    criteria,
  });
}

async function acceptedDecision(root, taskId, expectedRevision, text) {
  let updated = await recordTaskRecord(root, {
    taskId,
    expectedRevision,
    kind: 'decision',
    text,
    provenance: { kind: 'direct-user', reference: 'user message' },
  });
  const decision = updated.records.at(-1);
  updated = await transitionTaskRecord(root, {
    taskId,
    expectedRevision: updated.revision,
    recordId: decision.id,
    recordRevision: decision.revision,
    status: 'accepted',
    reason: 'confirmed with the user',
    authorization: authorization('accept decision', 'user confirmed in chat'),
  });
  return { task: updated, decision: updated.records.find((item) => item.id === decision.id) };
}

function criteriaDigestOf(criteria) {
  return digestJson(
    criteria.map(({ id, revision, description, required, approvalRequired }) => ({
      id,
      revision,
      description,
      required,
      approvalRequired,
    })),
  );
}

function supersedeDecisionPatch(decision) {
  return {
    recordOps: [
      {
        op: 'supersede',
        recordId: decision.id,
        recordRevision: decision.revision,
        kind: 'decision',
        text: 'Export includes only orders visible to the current user',
        provenance: { kind: 'direct-user', reference: 'user requested narrower export' },
        authorization: authorization('change export scope', 'user narrowed the export in chat'),
      },
    ],
  };
}

test('reconcile-preview distinguishes directly affected from declared-dependent records and is deterministic', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const withAssumption = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    kind: 'assumption',
    text: 'The export query has no per-user filter',
    provenance: { kind: 'agent-inferred', reference: 'code review' },
    links: [{ type: 'record', recordId: decision.id, recordRevision: decision.revision }],
  });
  const assumption = withAssumption.records.at(-1);
  const patch = supersedeDecisionPatch(decision);

  // A fixed clock isolates the one genuinely time-varying field (generatedAt, metadata about the
  // computation, not part of the reported state) so the rest of the report can be compared for
  // byte-identical determinism across repeated calls.
  const fixedClock = { clock: () => new Date('2026-01-01T00:00:00.000Z') };
  const first = await previewTaskReconciliation(root, { taskId: task.id, patch }, fixedClock);
  const second = await previewTaskReconciliation(root, { taskId: task.id, patch }, fixedClock);
  assert.deepEqual(
    first,
    second,
    'identical input against identical state must reproduce an identical report',
  );
  assert.match(first.digest, /^[a-f0-9]{64}$/);

  const decisionEntry = first.impact.find((item) => item.id === decision.id);
  assert.equal(decisionEntry.classification, 'directly-affected');
  assert.equal(decisionEntry.reasonCode, 'patched');

  const newDecisionEntry = first.impact.find(
    (item) => item.kind === 'record' && item.id !== decision.id && item.id !== assumption.id,
  );
  assert.equal(newDecisionEntry.classification, 'directly-affected');
  assert.equal(
    newDecisionEntry.outcome,
    'needs-user-decision',
    'a newly proposed decision still needs explicit acceptance',
  );

  const assumptionEntry = first.impact.find((item) => item.id === assumption.id);
  assert.equal(assumptionEntry.classification, 'declared-dependent');
  assert.equal(assumptionEntry.reasonCode, 'declared-record-link');
  assert.deepEqual(assumptionEntry.path, [`record:${decision.id}`, `record:${assumption.id}`]);
  assert.equal(
    first.impactSummary.unchanged,
    0,
    'every record in this task is reachable from the patch',
  );

  // Preview never mutates persisted state.
  const stateAfterPreview = await readTaskState(root);
  assert.equal(stateAfterPreview.tasks[0].revision, withAssumption.revision);
  assert.equal(stateAfterPreview.tasks[0].reconciliations.length, 0);

  const applied = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: withAssumption.revision,
    patch,
    previewDigest: first.digest,
  });
  assert.equal(applied.task.revision, withAssumption.revision + 1);
  assert.equal(applied.task.records.find((item) => item.id === decision.id).status, 'superseded');
  assert.equal(applied.reconciliation.patchDigest, first.patchDigest);
  assert.equal(applied.reconciliation.previewDigest, first.digest);
  assert.equal(applied.reconciliation.impactSummary.declaredDependent, 1);
});

test('reconcile-preview follows transitive (multi-hop) dependents through chained record links', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const withAssumption = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    kind: 'assumption',
    text: 'Query has no per-user filter',
    provenance: { kind: 'agent-inferred', reference: 'code review' },
    links: [{ type: 'record', recordId: decision.id, recordRevision: decision.revision }],
  });
  const assumption = withAssumption.records.at(-1);
  const withQuestion = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withAssumption.revision,
    kind: 'question',
    text: 'Does CSV formatting need to change too?',
    provenance: { kind: 'direct-user', reference: 'chat' },
    links: [{ type: 'record', recordId: assumption.id, recordRevision: assumption.revision }],
  });
  const question = withQuestion.records.at(-1);

  const report = await previewTaskReconciliation(root, {
    taskId: task.id,
    patch: supersedeDecisionPatch(decision),
  });
  const questionEntry = report.impact.find((item) => item.id === question.id);
  assert.equal(questionEntry.classification, 'declared-dependent');
  assert.deepEqual(questionEntry.path, [
    `record:${decision.id}`,
    `record:${assumption.id}`,
    `record:${question.id}`,
  ]);
  assert.equal(questionEntry.outcome, 'needs-user-decision');
});

test('a required criterion with no declared record link is flagged as an uncovered dependency only when adopted intent actually changes', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [
    { description: 'Export completes successfully', required: true },
  ]);
  const criterionId = task.criteria[0].id;
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );

  // Control: a patch that never touches adopted (accepted/confirmed) intent must not raise the
  // uncovered-dependency uncertainty for the unrelated, unlinked criterion.
  const observation = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    kind: 'observation',
    text: 'Export currently takes 4 seconds',
    provenance: { kind: 'execution-observed', reference: 'benchmark run' },
  });
  const observationRecord = observation.records.at(-1);
  const controlReport = await previewTaskReconciliation(root, {
    taskId: task.id,
    patch: {
      recordOps: [
        {
          op: 'revise',
          recordId: observationRecord.id,
          recordRevision: observationRecord.revision,
          text: 'Export currently takes 4.2 seconds',
        },
      ],
    },
  });
  assert.equal(
    controlReport.uncertainties.some((item) => item.reasonCode === 'uncovered-dependency'),
    false,
    'revising a non-authoritative record must not flag unrelated, unlinked criteria',
  );

  // Now change accepted intent: the required criterion is never linked from any record, so its
  // real dependence on the changed decision cannot be ruled out.
  const report = await previewTaskReconciliation(root, {
    taskId: task.id,
    patch: supersedeDecisionPatch(decision),
  });
  const uncoveredEntry = report.impact.find(
    (item) => item.kind === 'criterion' && item.id === criterionId,
  );
  assert.equal(uncoveredEntry.classification, 'potentially-affected');
  assert.equal(uncoveredEntry.reasonCode, 'uncovered-dependency');
  assert.equal(
    report.uncertainties.some(
      (item) =>
        item.kind === 'criterion' &&
        item.id === criterionId &&
        item.reasonCode === 'uncovered-dependency',
    ),
    true,
  );
});

test('reconcile-apply can remove a criterion, and the existing enhanced-check-coverage rule still blocks weakening required checks', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'plans', 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(root, 'docs', 'plans', 'plan.md'), '# Plan\n');

  const task = await baseTask(root, [
    { description: 'Export completes successfully', required: true },
    { description: 'CSV formatting matches spec', required: true },
  ]);
  const [keepCriterion, dropCriterion] = task.criteria;
  const enrolled = await registerEnhancedWorkflow(root, {
    taskId: task.id,
    expectedRevision: task.revision,
    artifacts: {
      prd: { path: 'docs/plans/prd.md', templateVersion: 1 },
      technicalPlan: { path: 'docs/plans/plan.md', templateVersion: 1 },
    },
    checks: [
      { id: 'export-check', criterionId: keepCriterion.id, type: 'manual' },
      { id: 'csv-check', criterionId: dropCriterion.id, type: 'manual' },
    ],
  });

  // Reconciling away a criterion that a required enhanced check still maps to must fail (the
  // report may say where new verification is needed, but it can never smuggle in a weakened
  // required-check mapping), and must not partially commit.
  const rejectedPreview = await previewTaskReconciliation(root, {
    taskId: task.id,
    patch: { criteria: [keepCriterion] },
  });
  await assert.rejects(
    applyTaskReconciliation(root, {
      taskId: task.id,
      expectedRevision: enrolled.revision,
      patch: { criteria: [keepCriterion] },
      previewDigest: rejectedPreview.digest,
    }),
  );
  const unchanged = await readTaskState(root);
  assert.equal(
    unchanged.tasks[0].revision,
    enrolled.revision,
    'a rejected reconciliation must not partially commit',
  );
  assert.equal(unchanged.tasks[0].reconciliations.length, 0);

  // Dropping the check mapping together with the criterion is a two-step, always-valid sequence:
  // first stop requiring the criterion the check no longer covers (the existing
  // check-coverage rule holds at every intermediate state too), then reconcile it away entirely.
  // This exercises the criterion "removed" op summary and impact entry.
  const withUpdatedWorkflow = await registerEnhancedWorkflow(root, {
    taskId: task.id,
    expectedRevision: enrolled.revision,
    criteria: [keepCriterion, { ...dropCriterion, required: false }],
    artifacts: {
      prd: { path: 'docs/plans/prd.md', templateVersion: 1 },
      technicalPlan: { path: 'docs/plans/plan.md', templateVersion: 1 },
    },
    checks: [{ id: 'export-check', criterionId: keepCriterion.id, type: 'manual' }],
  });
  const removalPatch = { criteria: [keepCriterion] };
  const removalPreview = await previewTaskReconciliation(root, {
    taskId: task.id,
    patch: removalPatch,
  });
  const removedEntry = removalPreview.impact.find((item) => item.id === dropCriterion.id);
  assert.equal(removedEntry.reasonCode, 'removed');
  assert.equal(removedEntry.classification, 'directly-affected');
  const removalApplied = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: withUpdatedWorkflow.revision,
    patch: removalPatch,
    previewDigest: removalPreview.digest,
  });
  assert.equal(removalApplied.task.criteria.length, 1);
  assert.equal(removalApplied.task.criteria[0].id, keepCriterion.id);
});

test('unrelated source-linked records are not surfaced by the impact report', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'billing.sql'), 'select * from billing;\n');
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const unrelated = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    kind: 'observation',
    text: 'Billing export already filters by user',
    provenance: { kind: 'execution-observed', reference: 'read billing.sql' },
    links: [{ type: 'source', path: 'billing.sql' }],
  });
  const unrelatedRecord = unrelated.records.at(-1);

  const report = await previewTaskReconciliation(root, {
    taskId: task.id,
    patch: supersedeDecisionPatch(decision),
  });
  assert.equal(
    report.impact.some((item) => item.id === unrelatedRecord.id),
    false,
    'a record with no declared link to the changed intent must not appear in the impact list',
  );
  assert.equal(
    report.uncertainties.some((item) => item.id === unrelatedRecord.id),
    false,
    'an unrelated record is never marked as an uncertainty either — absence of a link is not evidence of anything',
  );
  assert.equal(
    report.impactSummary.unchanged,
    1,
    'the unrelated observation counts as unchanged-by-this-patch',
  );
});

test('a confirmed assumption is superseded exactly like an accepted decision, and reconciling it never relabels existing passing evidence', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'plans', 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(root, 'docs', 'plans', 'plan.md'), '# Plan\n');

  const task = await baseTask(root, [
    { description: 'Export completes successfully', required: true },
  ]);
  const criterion = task.criteria[0];
  const enrolled = await registerEnhancedWorkflow(root, {
    taskId: task.id,
    expectedRevision: task.revision,
    artifacts: {
      prd: { path: 'docs/plans/prd.md', templateVersion: 1 },
      technicalPlan: { path: 'docs/plans/plan.md', templateVersion: 1 },
    },
    checks: [{ id: 'export-check', criterionId: criterion.id, type: 'manual' }],
  });

  // Adopt a *confirmed assumption* (not a decision) — the first-slice example in issue #111 is
  // exactly this: an assumption the implementation is currently relying on turns out to be wrong.
  let updated = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: enrolled.revision,
    kind: 'assumption',
    text: 'The export query has no per-user filter',
    provenance: { kind: 'agent-inferred', reference: 'code review' },
    links: [
      { type: 'criterion', criterionId: criterion.id, criterionRevision: criterion.revision },
    ],
  });
  const assumption = updated.records.at(-1);
  updated = await transitionTaskRecord(root, {
    taskId: task.id,
    expectedRevision: updated.revision,
    recordId: assumption.id,
    recordRevision: assumption.revision,
    status: 'confirmed',
    reason: 'confirmed by reading the query',
    authorization: authorization('confirm assumption'),
  });
  const confirmedAssumption = updated.records.find((item) => item.id === assumption.id);

  // Record real, current, passing evidence for the mapped check before reconciling.
  const resumed = await resumeTask(root, { taskId: task.id, expectedRevision: updated.revision });
  const withEvidence = await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: resumed.revision,
    runId: resumed.owner.runId,
    criterionId: criterion.id,
    criterionRevision: criterion.revision,
    kind: `enhanced-check:${enrolled.enhancedWorkflow.checks[0].id}`,
    outcome: 'passed',
  });
  const evidenceBefore = withEvidence.evidence.at(-1);

  const patch = {
    recordOps: [
      {
        op: 'supersede',
        recordId: confirmedAssumption.id,
        recordRevision: confirmedAssumption.revision,
        kind: 'assumption',
        text: 'The export query does filter by the current user',
        provenance: { kind: 'execution-observed', reference: 're-reading the query' },
        authorization: authorization('correct the assumption'),
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });
  const assumptionEntry = preview.impact.find((item) => item.id === confirmedAssumption.id);
  assert.equal(assumptionEntry.classification, 'directly-affected');
  const criterionEntry = preview.impact.find((item) => item.id === criterion.id);
  assert.equal(criterionEntry.classification, 'declared-dependent');
  const checkEntry = preview.impact.find((item) => item.kind === 'check');
  assert.equal(checkEntry.outcome, 'needs-re-verification');
  const evidenceEntry = preview.impact.find((item) => item.kind === 'evidence');
  assert.equal(evidenceEntry.outcome, 'needs-re-verification');

  const applied = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: withEvidence.revision,
    patch,
    previewDigest: preview.digest,
  });

  // The report only ever suggests where new verification is needed; it never touches the
  // existing evidence record's own outcome, criterion binding, or source snapshot.
  const evidenceAfter = applied.task.evidence.find((item) => item.id === evidenceBefore.id);
  assert.deepEqual(evidenceAfter, evidenceBefore);
  assert.equal(evidenceAfter.outcome, 'passed', 'reconciliation never relabels old evidence');
});

test('reconcile-apply refuses a stale preview after a concurrent source edit, without mutating state', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const withSourceLink = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    kind: 'assumption',
    text: 'orders.sql has no per-user filter',
    provenance: { kind: 'agent-inferred', reference: 'read orders.sql' },
    links: [
      { type: 'record', recordId: decision.id, recordRevision: decision.revision },
      { type: 'source', path: 'orders.sql' },
    ],
  });

  const patch = supersedeDecisionPatch(decision);
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });

  // A concurrent edit to the referenced source file changes its resolved artifact hash without
  // touching the task at all — the task revision alone cannot detect this race.
  await fs.appendFile(path.join(root, 'orders.sql'), '-- edited concurrently\n');

  await assert.rejects(
    applyTaskReconciliation(root, {
      taskId: task.id,
      expectedRevision: withSourceLink.revision,
      patch,
      previewDigest: preview.digest,
    }),
    { code: 'TASK_RECONCILE_PREVIEW_STALE' },
  );
  const unchanged = await readTaskState(root);
  assert.equal(unchanged.tasks[0].revision, withSourceLink.revision);
  assert.equal(unchanged.tasks[0].reconciliations.length, 0);

  // A fresh preview against the changed source produces a different digest and applies cleanly.
  const refreshed = await previewTaskReconciliation(root, { taskId: task.id, patch });
  assert.notEqual(refreshed.digest, preview.digest);
  const applied = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: withSourceLink.revision,
    patch,
    previewDigest: refreshed.digest,
  });
  assert.equal(applied.task.revision, withSourceLink.revision + 1);
});

test('reconcile-apply refuses a concurrent unrelated task mutation (revision conflict) before touching state', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const patch = supersedeDecisionPatch(decision);
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });

  // An unrelated concurrent mutation lands between preview and apply.
  await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    kind: 'question',
    text: 'Should the CSV header change too?',
    provenance: { kind: 'direct-user', reference: 'chat' },
  });

  await assert.rejects(
    applyTaskReconciliation(root, {
      taskId: task.id,
      expectedRevision: withDecision.revision,
      patch,
      previewDigest: preview.digest,
    }),
    { code: 'TASK_REVISION_CONFLICT' },
  );
});

test('reconcile-apply refuses a terminal (cancelled) task and directs the caller to a follow-up task, without mutating it', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const patch = {
    recordOps: [
      {
        op: 'transition',
        recordId: decision.id,
        recordRevision: decision.revision,
        status: 'retracted',
        reason: 'no longer relevant',
        authorization: authorization('retract decision'),
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });
  // Simultaneous cancellation: the task is cancelled after the preview was reviewed but before
  // apply runs.
  const cancelled = await cancelTask(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    reason: 'simultaneous cancellation race',
  });

  await assert.rejects(
    applyTaskReconciliation(root, {
      taskId: task.id,
      expectedRevision: cancelled.revision,
      patch,
      previewDigest: preview.digest,
    }),
    { code: 'TASK_RECONCILE_TASK_TERMINAL' },
  );
  const state = await readTaskState(root);
  assert.equal(state.tasks[0].state, 'cancelled');
  assert.equal(state.tasks[0].reconciliations.length, 0);
});

test('reconcile-apply refuses a terminal (verified) task', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export works', required: true }]);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const patch = {
    recordOps: [
      {
        op: 'transition',
        recordId: decision.id,
        recordRevision: decision.revision,
        status: 'retracted',
        reason: 'no longer relevant',
        authorization: authorization('retract decision'),
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });

  const resumed = await resumeTask(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
  });
  await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: resumed.revision,
    runId: resumed.owner.runId,
    criterionId: task.criteria[0].id,
    criterionRevision: task.criteria[0].revision,
    outcome: 'passed',
  });
  const afterEvidence = resumed.revision + 1;
  const completed = await completeTask(root, {
    taskId: task.id,
    runId: resumed.owner.runId,
    expectedRevision: afterEvidence,
  });
  const verified = await verifyTask(root, {
    taskId: task.id,
    expectedRevision: completed.revision,
  });
  assert.equal(verified.state, 'verified');

  await assert.rejects(
    applyTaskReconciliation(root, {
      taskId: task.id,
      expectedRevision: verified.revision,
      patch,
      previewDigest: preview.digest,
    }),
    { code: 'TASK_RECONCILE_TASK_TERMINAL' },
  );
});

test('reconcile-apply is idempotent for a repeated mutationId (retry/restart) and rejects a different patch reusing that ID', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const patch = {
    recordOps: [
      {
        op: 'transition',
        recordId: decision.id,
        recordRevision: decision.revision,
        status: 'retracted',
        reason: 'no longer relevant',
        authorization: authorization('retract decision'),
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });
  const mutationId = `event_${randomUUID()}`;

  const first = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    patch,
    previewDigest: preview.digest,
    mutationId,
  });
  // A retried call with the identical input (simulating a restart before the caller observed the
  // first response) returns the already-committed result rather than mutating state again.
  const retried = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
    patch,
    previewDigest: preview.digest,
    mutationId,
  });
  assert.deepEqual(retried, first);
  const state = await readTaskState(root);
  assert.equal(
    state.tasks[0].revision,
    withDecision.revision + 1,
    'the retry must not apply a second time',
  );
  assert.equal(state.tasks[0].reconciliations.length, 1);

  // Reusing the same mutation ID with a materially different patch is rejected outright.
  await assert.rejects(
    applyTaskReconciliation(root, {
      taskId: task.id,
      expectedRevision: withDecision.revision,
      patch: { recordOps: [{ ...patch.recordOps[0], reason: 'a different reason' }] },
      previewDigest: preview.digest,
      mutationId,
    }),
    { code: 'TASK_IDEMPOTENCY_CONFLICT' },
  );
});

test('a fault injected between the task commit and the secondary workflow acknowledgment still leaves a mismatched approval unusable', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );

  const now = new Date().toISOString();
  const requirementsArtifact = {
    phase: 'requirements',
    artifact: 'Requirements text',
    digest: sha256Hex('Requirements text'),
    summary: 'ok',
    createdAt: now,
  };
  const planArtifactText = 'Plan text';
  const checksDoc = { schemaVersion: 1, checks: [] };
  const plan = {
    phase: 'plan',
    artifact: planArtifactText,
    digest: sha256Hex(planArtifactText),
    summary: 'ok',
    createdAt: now,
    checks: checksDoc,
    checksDigest: digestJson(checksDoc),
  };
  const workflowRecord = {
    schemaVersion: 1,
    workflowId: `workflow_${randomUUID()}`,
    taskId: task.id,
    taskOwnerId: `owner_${randomUUID()}`,
    revision: 1,
    status: 'running',
    phase: 'implementation',
    providerId: 'fixture',
    reviewProviderId: 'fixture',
    executionAuthorized: true,
    policyVersion: 'test-policy',
    policyDigest: sha256Hex('policy-placeholder'),
    promptDigest: sha256Hex('fixture prompt'),
    initialPrompt: 'fixture prompt',
    inputs: [],
    proposedChecks: null,
    requirements: requirementsArtifact,
    plan,
    approval: {
      planDigest: plan.digest,
      requirementsDigest: requirementsArtifact.digest,
      checksDigest: plan.checksDigest,
      criteriaDigest: criteriaDigestOf(withDecision.criteria),
      intentDigest: computeIntentDigest(withDecision.records),
      scope: 'approve',
      reference: 'test',
      source: { revision: null, dirtyFingerprint: null },
      approvedAt: now,
    },
    repairAttempts: 0,
    retryOfActionId: null,
    artifacts: [],
    pendingAction: null,
    completedActions: [],
    mutations: [],
    lastOutcome: { status: 'passed', summary: 'Exact plan approved.' },
    source: { revision: null, dirtyFingerprint: null },
    createdAt: now,
    updatedAt: now,
  };
  await createWorkflow(root, workflowRecord);

  const approvalCriteriaDigest = criteriaDigestOf(withDecision.criteria);
  const approvalIntentDigestBefore = computeIntentDigest(withDecision.records);
  assert.equal(
    workflowRecord.approval.intentDigest,
    approvalIntentDigestBefore,
    'sanity: approval matches current intent before reconciling',
  );

  const patch = supersedeDecisionPatch(decision);
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });
  assert.equal(preview.approval.currentlyValid, true);
  assert.equal(preview.approval.remainsValidAfterPatch, false);

  let faultBoundaryCalled = false;
  const applied = await applyTaskReconciliation(
    root,
    {
      taskId: task.id,
      expectedRevision: withDecision.revision,
      patch,
      previewDigest: preview.digest,
    },
    {
      workflowFaultBoundary: () => {
        faultBoundaryCalled = true;
        throw new Error('simulated crash between task commit and workflow acknowledgment');
      },
    },
  );
  assert.equal(faultBoundaryCalled, true);
  assert.equal(
    applied.reconciliation.workflowAcknowledged,
    false,
    'the injected failure must not be swallowed silently in the result',
  );

  // The one durable write already landed even though the secondary step failed.
  const state = await readTaskState(root);
  assert.equal(state.tasks[0].revision, withDecision.revision + 1);
  assert.equal(state.tasks[0].reconciliations.length, 1);
  assert.equal(state.tasks[0].records.find((item) => item.id === decision.id).status, 'superseded');

  // The prior approval is unusable on its own terms — recomputed live from committed task state,
  // never from the (failed) acknowledgment — proving a partial update cannot dispatch
  // implementation or verification against mixed revisions.
  const currentCriteriaDigest = criteriaDigestOf(state.tasks[0].criteria);
  const currentIntentDigest = computeIntentDigest(state.tasks[0].records);
  assert.equal(
    currentCriteriaDigest,
    approvalCriteriaDigest,
    'criteria were untouched by this patch',
  );
  assert.notEqual(
    currentIntentDigest,
    workflowRecord.approval.intentDigest,
    'the adopted-intent digest must have moved',
  );
});

test('previewTaskReconciliation truncates rather than silently omitting an oversized declared-link graph', async (t) => {
  const root = await fixture(t);
  const now = new Date().toISOString();
  const taskId = `task_${randomUUID()}`;
  const criterionCount = 40;
  const recordCount = 480;
  const criteria = Array.from({ length: criterionCount }, (_, index) => ({
    id: `criterion_${randomUUID()}`,
    revision: 1,
    description: `Criterion ${index}`,
    required: false,
    approvalRequired: false,
    createdAt: now,
    updatedAt: now,
  }));
  const records = [];
  for (let index = 0; index < recordCount; index += 1) {
    const links = [];
    if (index > 0)
      links.push({ type: 'record', recordId: records[index - 1].id, recordRevision: 1 });
    if (index % 10 === 0) {
      const criterion = criteria[(index / 10) % criteria.length];
      links.push({ type: 'criterion', criterionId: criterion.id, criterionRevision: 1 });
    }
    const text = `Chain assumption ${index}`;
    records.push({
      id: `record_${randomUUID()}`,
      kind: 'assumption',
      revision: 1,
      status: 'tentative',
      text,
      provenance: { kind: 'agent-inferred', reference: 'synthetic fixture' },
      links,
      supersedes: null,
      supersededBy: null,
      history: [
        {
          revision: 1,
          status: 'tentative',
          text,
          action: 'created',
          reason: null,
          authorizationId: null,
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }
  const task = {
    id: taskId,
    title: 'Oversized graph fixture',
    state: 'planned',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    authorizationRequired: false,
    authorizations: [],
    owner: null,
    criteria,
    runs: [],
    checkpoints: [],
    evidence: [],
    events: [
      {
        id: `event_${randomUUID()}`,
        type: 'task.created',
        requestHash: 'a'.repeat(64),
        taskRevision: 1,
        runId: null,
        createdAt: now,
      },
    ],
    import: null,
    enhancedWorkflow: null,
    verificationMode: 'standard',
    records,
    reconciliations: [],
  };
  const state = {
    schemaVersion: 5,
    project: { id: `project_${randomUUID()}`, createdAt: now },
    revision: 1,
    createdAt: now,
    updatedAt: now,
    tasks: [task],
  };
  await writeTaskState(root, state);

  const report = await previewTaskReconciliation(root, {
    taskId,
    patch: {
      recordOps: [
        {
          op: 'revise',
          recordId: records[0].id,
          recordRevision: 1,
          text: 'updated head of the chain',
        },
      ],
    },
  });
  assert.equal(
    report.impactTruncated,
    true,
    'a graph exceeding the traversal bound must report truncation explicitly',
  );
  assert.ok(
    report.impact.length <= 100,
    'the returned impact list stays bounded rather than growing unbounded',
  );
});
