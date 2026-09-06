import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowController } from '../dist/src/workflows/service.js';
import {
  applyTaskReconciliation,
  createTask,
  inspectTask,
  previewTaskReconciliation,
  recordTaskRecord,
  transitionTaskRecord,
} from '../dist/src/task-state/service.js';

// Wrap mkdtemp's root in realpath before deriving expected paths: CI can hand back an 8.3
// short-path alias on Windows, which would otherwise mismatch a later canonicalized path. The
// project directory itself carries a space and a non-ASCII character.
async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-workflow-reconcile-')),
  );
  const root = path.join(base, 'workflow reconcile é');
  await fs.mkdir(root);
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

/**
 * A minimal fake provider adapter/launch pair, reusing the same "detect phase from the recorded
 * prompt text" trick `test/workflow.test.js` uses: `planInvocation` records the exact prompt it
 * was given, and `launch` inspects the most recent one to decide which phase is executing. The
 * requirements and plan phases always report `ready`; the implementation phase always reports
 * `needs-input`, so the drive loop settles cleanly in `awaiting-input` — with no pending action —
 * right after an approval, instead of racing ahead through verification/review/completion. That
 * gives a stable, non-active window in which to reconcile intent and then observe how `resume`
 * behaves against the now-stale approval.
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

test('reconciling an accepted decision after plan approval invalidates that approval, and an ordinary resume reroutes to awaiting-approval instead of executing the stale contract', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Export orders',
    criteria: [
      { description: 'Export completes successfully', required: true, approvalRequired: false },
    ],
    authorizationRequired: false,
  });
  const criterionId = task.criteria[0].id;
  const checksDocument = {
    schemaVersion: 1,
    checks: [
      {
        id: 'export-check',
        criterionId,
        label: 'Export produced the expected file',
        type: 'manual',
        instructions: 'Inspect the exported file.',
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
  const awaitingApproval = await controller.wait(created.taskId);
  assert.equal(awaitingApproval.status, 'awaiting-approval');

  // Adopt an accepted decision on the task before approving the plan, so the workflow's approval
  // binds to it (see intentDigest in src/workflows/service.ts). Requirements/plan phases never
  // resume the task, so it is still at its as-created revision here.
  const beforeDecision = await inspectTask(root, task.id);
  const withDecisionAdd = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: beforeDecision.task.revision,
    kind: 'decision',
    text: 'Export includes all orders',
    provenance: { kind: 'direct-user', reference: 'requirements phase' },
  });
  const decision = withDecisionAdd.records.at(-1);
  await transitionTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withDecisionAdd.revision,
    recordId: decision.id,
    recordRevision: decision.revision,
    status: 'accepted',
    reason: 'confirmed with the user',
    authorization: {
      source: 'user',
      scope: 'accept decision',
      reference: 'user confirmed in chat',
    },
  });

  const inspected = await controller.inspect(created.taskId);
  const approved = await controller.approve({
    taskId: created.taskId,
    expectedRevision: inspected.revision,
    planDigest: inspected.plan.digest,
    requirementsDigest: inspected.requirements.digest,
    checksDigest: inspected.plan.checksDigest,
    scope: 'approve the plan',
    reference: 'user approved',
  });
  assert.equal(approved.status, 'running');

  // The fake implementation phase reports needs-input, so the drive loop settles cleanly with no
  // pending action — a safe window to reconcile without touching the active-effect path. Invoking
  // implementation still resumes the task first (bumping its revision) regardless of that
  // eventual needs-input outcome, so re-read the task fresh rather than reusing an earlier
  // snapshot's revision.
  const awaitingInput = await controller.wait(created.taskId);
  assert.equal(awaitingInput.status, 'awaiting-input');
  assert.equal(awaitingInput.pendingAction, null);
  const afterResume = await inspectTask(root, task.id);

  const patch = {
    recordOps: [
      {
        op: 'supersede',
        recordId: decision.id,
        recordRevision: afterResume.task.records.find((item) => item.id === decision.id).revision,
        kind: 'decision',
        text: 'Export includes only orders visible to the current user',
        provenance: { kind: 'direct-user', reference: 'user requested narrower export' },
        authorization: {
          source: 'user',
          scope: 'change export scope',
          reference: 'user narrowed scope in chat',
        },
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });
  assert.equal(
    preview.approval.currentlyValid,
    true,
    'the plan approval was valid before reconciling',
  );
  assert.equal(
    preview.approval.remainsValidAfterPatch,
    false,
    'superseding the accepted decision must invalidate the plan approval',
  );
  await applyTaskReconciliation(root, {
    taskId: task.id,
    expectedRevision: afterResume.task.revision,
    patch,
    previewDigest: preview.digest,
  });

  // Ordinary resume must not execute the stale (pre-reconciliation) contract: instead of
  // re-invoking implementation with the old approval, the workflow reroutes back to
  // awaiting-approval through the existing plan-approval transition. The reconciliation's own
  // best-effort secondary workflow acknowledgment also bumped the workflow revision, so read it
  // fresh rather than reusing the pre-reconciliation snapshot.
  const beforeResume = await controller.inspect(created.taskId);
  await controller.resume({
    taskId: created.taskId,
    executionAuthorized: true,
    expectedRevision: beforeResume.revision,
    prompt: 'continue',
  });
  const settled = await controller.wait(created.taskId);
  assert.equal(
    settled.status,
    'awaiting-approval',
    'resume must require replanning/re-approval instead of running the old contract',
  );
  // No new action ran with the stale contract: the completed-action count is exactly what it was
  // before this resume (the one prior needs-input implementation attempt, from before
  // reconciliation), and nothing is left pending.
  assert.equal(
    settled.completedActions.length,
    beforeResume.completedActions.length,
    'resume must not invoke implementation again against the reconciled-away contract',
  );
  assert.equal(settled.pendingAction, null);
});

test('reconcile-apply refuses to touch a task with an owned, in-flight workflow effect', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Export orders',
    criteria: [
      { description: 'Export completes successfully', required: true, approvalRequired: false },
    ],
    authorizationRequired: false,
  });
  const criterionId = task.criteria[0].id;
  const checksDocument = {
    schemaVersion: 1,
    checks: [
      {
        id: 'export-check',
        criterionId,
        label: 'Export produced the expected file',
        type: 'manual',
        instructions: 'Inspect the exported file.',
      },
    ],
  };

  let releaseImplementation;
  let implementationStarted;
  const startedPromise = new Promise((resolve) => {
    implementationStarted = resolve;
  });
  const held = new Promise((resolve) => {
    releaseImplementation = resolve;
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
    if (phase === 'implementation') {
      implementationStarted();
      await held;
      return {
        status: 'exited',
        exitCode: 0,
        stdout: JSON.stringify({
          status: 'ready',
          summary: 'implementation ready',
          artifact: 'implementation artifact',
          questions: [],
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
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', adapter]]),
    launch,
  });
  t.after(() => {
    releaseImplementation();
    return controller.shutdown();
  });

  const created = await controller.run({
    taskId: task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture',
    executionAuthorized: true,
  });
  const awaitingApproval = await controller.wait(created.taskId);
  const inspected = await controller.inspect(created.taskId);
  await controller.approve({
    taskId: created.taskId,
    expectedRevision: awaitingApproval.revision,
    planDigest: inspected.plan.digest,
    requirementsDigest: inspected.requirements.digest,
    checksDigest: inspected.plan.checksDigest,
    scope: 'approve the plan',
    reference: 'user approved',
  });

  // Wait until implementation is actually pending (a live, owned in-flight effect) before trying
  // to reconcile.
  await startedPromise;
  const beforeDecision = await inspectTask(root, task.id);

  const withDecision = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: beforeDecision.task.revision,
    kind: 'decision',
    text: 'Export includes all orders',
    provenance: { kind: 'direct-user', reference: 'chat' },
  });
  const decision = withDecision.records.at(-1);
  const patch = {
    recordOps: [
      {
        op: 'transition',
        recordId: decision.id,
        recordRevision: decision.revision,
        status: 'retracted',
        reason: 'no longer relevant',
        authorization: { source: 'user', scope: 'retract decision', reference: 'chat' },
      },
    ],
  };
  const preview = await previewTaskReconciliation(root, { taskId: task.id, patch });

  await assert.rejects(
    applyTaskReconciliation(root, {
      taskId: task.id,
      expectedRevision: withDecision.revision,
      patch,
      previewDigest: preview.digest,
    }),
    { code: 'TASK_RECONCILE_ACTIVE_EFFECT' },
  );

  releaseImplementation();
});
