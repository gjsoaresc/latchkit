import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWorkflowController } from '../dist/src/workflows/service.js';
import {
  applyTaskReconciliation,
  completeTask,
  createTask,
  inspectTask,
  previewTaskReconciliation,
  recordEvidence,
  recordTaskRecord,
  resumeTask,
  transitionTaskRecord,
  verifyTask,
} from '../dist/src/task-state/service.js';
import { buildContextBrief } from '../dist/src/context-brief/service.js';
import { readWorkflow } from '../dist/src/workflows/store.js';

const execFileAsync = promisify(execFile);

// Wrap mkdtemp's root in realpath before deriving expected paths: CI can hand back an 8.3
// short-path alias on Windows, which would otherwise mismatch a later canonicalized path. The
// project directory itself carries a space and a non-ASCII character, per issue #112's fixture
// requirement.
async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-context-brief-controller-')),
  );
  const root = path.join(base, 'context brief controller é');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'source.txt'), 'initial\n');
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

/**
 * Reused from `test/workflow-reconcile.test.js`'s fixture: requirements/plan phases report ready;
 * implementation always reports `needs-input`, so `drive()` settles cleanly at `awaiting-input`
 * with no pending action right after every approval — a stable window to inspect the bound brief
 * or reconcile intent without racing the in-flight-effect guard.
 */
function fakeAdapter(checksDocument) {
  const calls = [];
  const adapter = {
    contract: {
      id: 'fixture',
      capabilities: { invocation: { state: 'supported' }, readonly: { state: 'supported' } },
    },
    operations: {
      planInvocation: (options) => {
        calls.push(options);
        return { executable: process.execPath, args: ['--version'], cwd: options.cwd };
      },
    },
  };
  const launch = async () => {
    const prompt = calls.at(-1)?.prompt ?? '';
    const phase = /requirements phase/.test(prompt)
      ? 'requirements'
      : /plan phase/.test(prompt)
        ? 'plan'
        : 'implementation';
    if (phase === 'implementation') {
      return {
        status: 'exited',
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'needs-input',
          summary: 'Need to confirm the export scope before implementing.',
          artifact: '',
          questions: ['Should the export include all orders or only the current user’s?'],
          checks_json: '',
        }),
        stderr: '',
      };
    }
    return {
      status: 'exited',
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'ready',
        summary: `${phase} ready`,
        artifact: `${phase} artifact`,
        questions: [],
        checks_json: phase === 'plan' ? JSON.stringify(checksDocument) : '',
      }),
      stderr: '',
    };
  };
  return { adapter, launch };
}

const authorization = (scope) => ({ source: 'user', scope, reference: 'user confirmed in chat' });

async function acceptDecision(root, taskId, text, links) {
  const before = await inspectTask(root, taskId);
  const added = await recordTaskRecord(root, {
    taskId,
    expectedRevision: before.task.revision,
    kind: 'decision',
    text,
    provenance: { kind: 'direct-user', reference: 'chat' },
    ...(links ? { links } : {}),
  });
  const record = added.records.at(-1);
  const transitioned = await transitionTaskRecord(root, {
    taskId,
    expectedRevision: added.revision,
    recordId: record.id,
    recordRevision: record.revision,
    status: 'accepted',
    reason: 'confirmed with the user',
    authorization: authorization('accept decision'),
  });
  return transitioned.records.at(-1);
}

test('export scenario end to end: the revised visibility constraint reaches the resumed dispatch, the query criterion is flagged, CSV work is retained, and an executable check validates the narrowed behavior', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Export orders',
    criteria: [
      { description: 'Export query respects visibility', required: true, approvalRequired: false },
      { description: 'CSV formatting', required: true, approvalRequired: false },
    ],
    authorizationRequired: false,
  });
  const [queryCriterion, csvCriterion] = task.criteria;
  const checksDocument = {
    schemaVersion: 1,
    checks: [
      {
        id: 'query-check',
        criterionId: queryCriterion.id,
        label: 'Query respects visibility',
        type: 'manual',
        instructions: 'Inspect the query.',
      },
      {
        id: 'csv-check',
        criterionId: csvCriterion.id,
        label: 'CSV formatting is correct',
        type: 'manual',
        instructions: 'Inspect the CSV.',
      },
    ],
  };
  const { adapter, launch } = fakeAdapter(checksDocument);
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', adapter]]),
    launch,
  });
  t.after(() => controller.shutdown());

  const created = await controller.run({
    taskId: task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture',
    executionAuthorized: true,
  });
  assert.equal((await controller.wait(created.taskId)).status, 'awaiting-approval');

  const decision = await acceptDecision(root, task.id, 'Export includes all orders', [
    { type: 'criterion', criterionId: queryCriterion.id },
  ]);

  const inspected = await controller.inspect(created.taskId);
  await controller.approve({
    taskId: created.taskId,
    expectedRevision: inspected.revision,
    planDigest: inspected.plan.digest,
    requirementsDigest: inspected.requirements.digest,
    checksDigest: inspected.plan.checksDigest,
    scope: 'approve the plan',
    reference: 'user approved',
  });
  const awaitingInput = await controller.wait(created.taskId);
  assert.equal(awaitingInput.status, 'awaiting-input');
  assert.equal(awaitingInput.pendingAction, null);
  assert.ok(
    awaitingInput.lastDispatchedContext,
    'the first implementation dispatch must bind a brief',
  );
  const d1 = awaitingInput.lastDispatchedContext.digest;

  // The brief bound to this dispatch reflects the broad decision, and there is nothing to report
  // "since" itself.
  const briefAtD1 = await buildContextBrief(root, { taskId: task.id });
  assert.equal(briefAtD1.acceptedDecisions.length, 1);
  assert.match(briefAtD1.acceptedDecisions[0].text, /all orders/);
  assert.equal(briefAtD1.changeSinceLastRun.available, true);
  assert.equal(briefAtD1.changeSinceLastRun.reconciliationsSince.length, 0);

  // Record real, current, passing evidence for CSV formatting: completed work that must survive
  // the coming reconciliation untouched. A declared observation link to the CSV criterion also
  // makes it explicitly "covered" — otherwise a patch that touches adopted intent flags every
  // required criterion with no declared record link at all as an uncovered-dependency uncertainty
  // (see docs/task-state.md#reconciling-changed-intent: "absence of a declared link never proves
  // independence"), which would be a legitimate but different signal than "this work is retained."
  const afterResume = await inspectTask(root, task.id);
  const withEvidence = await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: afterResume.task.revision,
    runId: afterResume.task.owner.runId,
    criterionId: csvCriterion.id,
    criterionRevision: csvCriterion.revision,
    outcome: 'passed',
    command: 'inspect CSV output',
  });
  await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withEvidence.revision,
    kind: 'observation',
    text: 'CSV export produces correctly formatted output',
    provenance: { kind: 'execution-observed', reference: 'inspected CSV output' },
    links: [{ type: 'criterion', criterionId: csvCriterion.id }],
  });

  // Narrow the export to only the current user's orders.
  const beforeReconcile = await inspectTask(root, task.id);
  const patch = {
    recordOps: [
      {
        op: 'supersede',
        recordId: decision.id,
        recordRevision: beforeReconcile.task.records.find((item) => item.id === decision.id)
          .revision,
        kind: 'decision',
        text: 'Export includes only orders visible to the current user',
        provenance: { kind: 'direct-user', reference: 'user narrowed scope' },
        links: [{ type: 'criterion', criterionId: queryCriterion.id }],
        authorization: authorization('narrow export scope'),
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });
  assert.equal(preview.approval.remainsValidAfterPatch, false);
  const reconciled = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: beforeReconcile.task.revision,
    patch,
    previewDigest: preview.digest,
  });

  // Superseding never auto-accepts the replacement (acceptance is always a separate, explicit,
  // authority-bearing action — see docs/task-state.md#task-records): the narrower decision starts
  // `proposed` and needs its own explicit acceptance before it is "the revised visibility
  // constraint" a resumed session should receive.
  const narrower = reconciled.task.records.find((item) => item.supersedes === decision.id);
  assert.equal(narrower.status, 'proposed');
  await transitionTaskRecord(root, {
    taskId: task.id,
    expectedRevision: reconciled.task.revision,
    recordId: narrower.id,
    recordRevision: narrower.revision,
    status: 'accepted',
    reason: 'confirmed the narrower scope with the user',
    authorization: authorization('accept narrower decision'),
  });

  // The brief now shows the revised constraint, flags the query criterion, and still lists CSV
  // formatting as available completed work.
  const briefAfterReconcile = await buildContextBrief(root, { taskId: task.id, sinceDigest: d1 });
  assert.match(briefAfterReconcile.acceptedDecisions[0].text, /only orders visible/);
  assert.equal(briefAfterReconcile.changeSinceLastRun.available, true);
  assert.equal(briefAfterReconcile.changeSinceLastRun.reconciliationsSince.length, 1);
  assert.ok(
    briefAfterReconcile.changeSinceLastRun.workNeedingAttention.some(
      (item) => item.kind === 'criterion' && item.id === queryCriterion.id,
    ),
    'the query criterion must be flagged as needing attention',
  );
  assert.ok(
    briefAfterReconcile.changeSinceLastRun.completedWorkRemaining.some(
      (item) => item.criterionId === csvCriterion.id,
    ),
    'CSV formatting evidence must remain available',
  );
  assert.ok(
    !briefAfterReconcile.changeSinceLastRun.completedWorkRemaining.some(
      (item) => item.criterionId === queryCriterion.id,
    ),
    'the flagged query criterion must never also be reported as reusable completed work',
  );

  // Ordinary resume reroutes to awaiting-approval instead of running the stale contract (#111's
  // existing guarantee): the *next* dispatch this resumed session would actually receive is
  // exactly the brief just inspected above — "the revised visibility constraint reaches the
  // resumed session" is this projection, computed before any new dispatch, not a re-run of the
  // full multi-phase policy (which owns its own, separately tested, re-approval routing).
  const beforeResume = await controller.inspect(created.taskId);
  await controller.resume({
    taskId: created.taskId,
    executionAuthorized: true,
    expectedRevision: beforeResume.revision,
    prompt: 'continue',
  });
  const rerouted = await controller.wait(created.taskId);
  assert.equal(rerouted.status, 'awaiting-approval');
  // No new (and therefore no stale) dispatch happened while awaiting re-approval.
  assert.equal(rerouted.lastDispatchedContext.digest, d1);

  // Executable acceptance check: actually run a small script proving the narrowed visibility rule
  // holds, then record it as real, current evidence — never a label alone.
  const orders = [
    { id: 1, userId: 'alice' },
    { id: 2, userId: 'bob' },
  ];
  const script =
    `const orders=${JSON.stringify(orders)};` +
    "const visible=orders.filter(o=>o.userId==='alice');" +
    'if(visible.length!==1||visible[0].userId!=="alice")process.exit(1);process.exit(0);';
  await execFileAsync(process.execPath, ['-e', script]);
  const beforeQueryEvidence = await inspectTask(root, task.id);
  const withQueryEvidence = await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: beforeQueryEvidence.task.revision,
    runId: beforeQueryEvidence.task.owner.runId,
    criterionId: queryCriterion.id,
    criterionRevision: queryCriterion.revision,
    outcome: 'passed',
    command: 'run the narrowed-visibility query check',
  });
  const queryEvidence = withQueryEvidence.evidence.findLast(
    (item) => item.criterionId === queryCriterion.id,
  );
  assert.equal(queryEvidence.outcome, 'passed');
  assert.match(queryEvidence.command, /narrowed-visibility query check/);
});

test('stale completion is rejected after reconciliation bumps a criterion revision, and the brief reflects it rather than hiding it', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Stale completion',
    criteria: [
      { description: 'Export query respects visibility', required: true, approvalRequired: false },
      { description: 'CSV formatting', required: true, approvalRequired: false },
    ],
    authorizationRequired: false,
  });
  const [queryCriterion, csvCriterion] = task.criteria;
  const decision = await acceptDecision(root, task.id, 'Export includes all orders', [
    { type: 'criterion', criterionId: queryCriterion.id },
  ]);
  const beforeResume = await inspectTask(root, task.id);
  const resumed = await resumeTask(root, {
    taskId: task.id,
    expectedRevision: beforeResume.task.revision,
  });
  // Record passing evidence for both criteria against the current source and revisions.
  await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: resumed.revision,
    runId: resumed.owner.runId,
    criterionId: queryCriterion.id,
    criterionRevision: queryCriterion.revision,
    outcome: 'passed',
  });
  const afterFirst = await inspectTask(root, task.id);
  await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: afterFirst.task.revision,
    runId: afterFirst.task.owner.runId,
    criterionId: csvCriterion.id,
    criterionRevision: csvCriterion.revision,
    outcome: 'passed',
  });
  const beforeComplete = await inspectTask(root, task.id);
  const completed = await completeTask(root, {
    taskId: task.id,
    runId: beforeComplete.task.owner.runId,
    expectedRevision: beforeComplete.task.revision,
  });
  assert.equal(completed.state, 'completed');
  void completed;

  // Reconcile: narrow the decision and revise the query criterion's own wording, bumping its
  // revision — the CSV criterion is left byte-for-byte identical and keeps its revision. A task
  // in `completed` (not yet verified) state is not terminal, so reconciling it is allowed.
  const beforeReconcile = await inspectTask(root, task.id);
  const patch = {
    recordOps: [
      {
        op: 'supersede',
        recordId: decision.id,
        recordRevision: beforeReconcile.task.records.find((item) => item.id === decision.id)
          .revision,
        kind: 'decision',
        text: 'Export includes only orders visible to the current user',
        provenance: { kind: 'direct-user', reference: 'user narrowed scope' },
        links: [{ type: 'criterion', criterionId: queryCriterion.id }],
        authorization: authorization('narrow export scope'),
      },
    ],
    criteria: [
      {
        id: queryCriterion.id,
        description: 'Export query respects only the current user’s visibility',
        required: true,
        approvalRequired: false,
      },
      {
        id: csvCriterion.id,
        description: csvCriterion.description,
        required: true,
        approvalRequired: false,
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });
  const reconciled = await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: beforeReconcile.task.revision,
    patch,
    previewDigest: preview.digest,
  });

  // Changing criteria on a completed-but-not-yet-verified task reverts it to `planned` (the same
  // rule `reviseCriteria`/`registerEnhancedWorkflow` already apply) — the prior completion is
  // itself invalidated, not silently kept: the stale completion is rejected by construction, and
  // `verifyTask` now refuses because the task is no longer `completed` at all.
  assert.equal(reconciled.task.state, 'planned');
  await assert.rejects(
    verifyTask(root, { taskId: task.id, expectedRevision: reconciled.task.revision }),
    { code: 'TASK_TRANSITION_INVALID' },
  );

  // The brief's own criteria list is never behind: it shows the bumped query revision and the
  // unchanged CSV revision, and — with no prior dispatch bound for this ordinary task — an honest
  // `no-prior-dispatch` rather than a fabricated "nothing changed."
  const brief = await buildContextBrief(root, { taskId: task.id });
  assert.equal(brief.changeSinceLastRun.available, false);
  assert.equal(brief.changeSinceLastRun.reason, 'no-prior-dispatch');
  assert.equal(brief.criteria.find((item) => item.id === queryCriterion.id).revision, 2);
  assert.equal(brief.criteria.find((item) => item.id === csvCriterion.id).revision, 1);
  assert.equal(brief.taskState, 'planned');
});

test('a source drift between two dispatches is reflected in the freshly rebuilt brief, never reused from the prior dispatch', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Source drift',
    criteria: [{ description: 'Fixture works', required: true, approvalRequired: false }],
    authorizationRequired: false,
  });
  const checksDocument = {
    schemaVersion: 1,
    checks: [
      {
        id: 'fixture-check',
        criterionId: task.criteria[0].id,
        label: 'Inspect fixture result',
        type: 'manual',
        instructions: 'Inspect the deterministic fixture.',
      },
    ],
  };
  // A custom adapter that gates the requirements phase's launch call: the drift happens while that
  // call is held, after requirements has already bound its own brief (journaling — and therefore
  // binding — always happens before `launch()` is invoked) but before the plan phase's dispatch
  // (and its own fresh binding) begins.
  let releaseRequirements;
  let requirementsStarted;
  const held = new Promise((resolve) => {
    releaseRequirements = resolve;
  });
  const startedPromise = new Promise((resolve) => {
    requirementsStarted = resolve;
  });
  const calls = [];
  const adapter = {
    contract: {
      id: 'fixture',
      capabilities: { invocation: { state: 'supported' }, readonly: { state: 'supported' } },
    },
    operations: {
      planInvocation: (options) => {
        calls.push(options);
        return { executable: process.execPath, args: ['--version'], cwd: options.cwd };
      },
    },
  };
  const launch = async () => {
    const prompt = calls.at(-1)?.prompt ?? '';
    const phase = /requirements phase/.test(prompt)
      ? 'requirements'
      : /plan phase/.test(prompt)
        ? 'plan'
        : 'implementation';
    if (phase === 'requirements') {
      requirementsStarted();
      await held;
    }
    return {
      status: 'exited',
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'ready',
        summary: `${phase} ready`,
        artifact: `${phase} artifact`,
        questions: [],
        checks_json: phase === 'plan' ? JSON.stringify(checksDocument) : '',
      }),
      stderr: '',
    };
  };
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', adapter]]),
    launch,
  });
  t.after(() => {
    releaseRequirements();
    return controller.shutdown();
  });

  const created = await controller.run({
    taskId: task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture',
    executionAuthorized: true,
  });
  // Wait until the requirements dispatch has actually started (and therefore already bound its
  // brief — binding happens before `launch()` is called) before drifting the source.
  await startedPromise;
  const midRequirements = await controller.inspect(created.taskId);
  assert.ok(midRequirements.lastDispatchedContext, 'requirements must already have bound a brief');
  const requirementsBinding = midRequirements.lastDispatchedContext;

  await fs.writeFile(path.join(root, 'source.txt'), 'changed\n');
  releaseRequirements();

  const awaitingApproval = await controller.wait(created.taskId);
  assert.equal(awaitingApproval.status, 'awaiting-approval');
  assert.ok(awaitingApproval.lastDispatchedContext);
  assert.notEqual(
    awaitingApproval.lastDispatchedContext.digest,
    requirementsBinding.digest,
    'the plan phase must bind a fresh brief, never reuse the requirements-phase one',
  );
  assert.notDeepEqual(
    awaitingApproval.lastDispatchedContext.source,
    requirementsBinding.source,
    'the freshly bound brief must reflect the drifted source',
  );
});

test('restart: a freshly constructed controller reads the persisted dispatch binding back unchanged', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Restart',
    criteria: [{ description: 'Fixture works', required: true, approvalRequired: false }],
    authorizationRequired: false,
  });
  const checksDocument = {
    schemaVersion: 1,
    checks: [
      {
        id: 'fixture-check',
        criterionId: task.criteria[0].id,
        label: 'Inspect fixture result',
        type: 'manual',
        instructions: 'Inspect the deterministic fixture.',
      },
    ],
  };
  const { adapter, launch } = fakeAdapter(checksDocument);
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', adapter]]),
    launch,
  });
  const created = await controller.run({
    taskId: task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture',
    executionAuthorized: true,
  });
  await controller.wait(created.taskId);
  const inspected = await controller.inspect(created.taskId);
  await controller.approve({
    taskId: created.taskId,
    expectedRevision: inspected.revision,
    planDigest: inspected.plan.digest,
    requirementsDigest: inspected.requirements.digest,
    checksDigest: inspected.plan.checksDigest,
    scope: 'approve the plan',
    reference: 'user approved',
  });
  const before = await controller.wait(created.taskId);
  assert.ok(before.lastDispatchedContext);
  await controller.shutdown();

  // Simulate a process restart: construct a brand-new controller instance against the same
  // persisted state and confirm the brief and its binding read back identically.
  const restarted = createWorkflowController({
    root,
    adapters: new Map([['fixture', adapter]]),
    launch,
  });
  t.after(() => restarted.shutdown());
  const afterRestart = await restarted.inspect(task.id);
  assert.deepEqual(afterRestart.lastDispatchedContext, before.lastDispatchedContext);
  const brief = await buildContextBrief(root, { taskId: task.id });
  assert.equal(brief.digest, (await buildContextBrief(root, { taskId: task.id })).digest);
  const persisted = await readWorkflow(root, task.id);
  assert.equal(persisted.lastDispatchedContext.digest, before.lastDispatchedContext.digest);
});

test('a cancelled workflow still previews read-only, and the brief reports cancelled as the next action', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Cancellation',
    criteria: [{ description: 'Fixture works', required: true, approvalRequired: false }],
    authorizationRequired: false,
  });
  const { adapter, launch } = fakeAdapter({
    schemaVersion: 1,
    checks: [
      {
        id: 'fixture-check',
        criterionId: task.criteria[0].id,
        label: 'Inspect fixture result',
        type: 'manual',
        instructions: 'Inspect the deterministic fixture.',
      },
    ],
  });
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', adapter]]),
    launch,
  });
  t.after(() => controller.shutdown());
  const created = await controller.run({
    taskId: task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture',
    executionAuthorized: true,
  });
  const awaitingApproval = await controller.wait(created.taskId);
  await controller.cancel({ taskId: created.taskId, expectedRevision: awaitingApproval.revision });
  const cancelled = await controller.inspect(created.taskId);
  assert.equal(cancelled.status, 'cancelled');

  const brief = await buildContextBrief(root, { taskId: task.id });
  assert.equal(brief.nextAction.kind, 'cancelled');
  // Producing this preview never revived the workflow or started a provider.
  const stillCancelled = await controller.inspect(created.taskId);
  assert.equal(stillCancelled.status, 'cancelled');
  assert.equal(stillCancelled.revision, cancelled.revision);
});
