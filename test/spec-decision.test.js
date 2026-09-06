import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  addSpecDecisionNotes,
  approveSpecDecision,
  inspectSpecDecision,
  markSpecBuildStarted,
  pauseSpecDecision,
  presentSpecDecision,
  selectSpecDecisionPresentation,
  SpecDecisionError,
} from '../dist/src/workflows/spec-decision-service.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');
const execFileAsync = promisify(execFile);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const taskId = () => `task_${randomUUID()}`;

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-spec-decision-'));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('plan-only completion presents a pending decision with the plan link and summary', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigestV1 = digest('# Plan v1');
  const record = await presentSpecDecision(root, {
    taskId: task,
    planRef: '.latchkit/notes/example-spec.md',
    planDigest: planDigestV1,
    summary: 'Adds a widget with two acceptance criteria.',
  });
  assert.equal(record.taskId, task);
  assert.equal(record.status, 'pending');
  assert.equal(record.planDigest, planDigestV1);
  assert.equal(record.planRevision, 1);
  assert.equal(record.approval, null);
  assert.equal(record.buildStarted, false);
  assert.equal(record.revision, 1);

  const resumed = await inspectSpecDecision(root, task);
  assert.deepEqual(resumed, record);
});

test('approve and build records approval bound to the exact plan revision', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigestV1 = digest('# Plan v1');
  const presented = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest: planDigestV1,
    summary: 'Plan summary.',
  });
  const approved = await approveSpecDecision(root, {
    taskId: task,
    expectedRevision: presented.revision,
    planDigest: planDigestV1,
    scope: 'src/** and test/**',
    reference: 'maintainer approval',
  });
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approval);
  assert.equal(approved.approval.planDigest, planDigestV1);
  assert.equal(approved.approval.planRevision, presented.planRevision);
  assert.equal(approved.approval.scope, 'src/** and test/**');
  assert.equal(approved.buildStarted, false);

  const started = await markSpecBuildStarted(root, {
    taskId: task,
    expectedRevision: approved.revision,
  });
  assert.equal(started.buildStarted, true);
  assert.ok(started.buildStartedAt);
});

test('revision notes attach to the plan, re-present it, and invalidate the prior approval', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigestV1 = digest('# Plan v1');
  const presented = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest: planDigestV1,
    summary: 'Plan summary v1.',
  });
  const approved = await approveSpecDecision(root, {
    taskId: task,
    expectedRevision: presented.revision,
    planDigest: planDigestV1,
    scope: 'src/**',
    reference: 'maintainer approval',
  });
  assert.equal(approved.status, 'approved');

  // The user asks for a change instead of approving further; the plan is
  // revised and the notes call re-presents it for a fresh decision.
  const planDigestV2 = digest('# Plan v2 (addresses feedback)');
  const revised = await addSpecDecisionNotes(root, {
    taskId: task,
    expectedRevision: approved.revision,
    notes: 'Please also cover the error path.',
    planDigest: planDigestV2,
  });
  assert.equal(revised.status, 'pending');
  assert.equal(revised.approval, null);
  assert.equal(revised.buildStarted, false);
  assert.equal(revised.planDigest, planDigestV2);
  assert.equal(revised.planRevision, presented.planRevision + 1);
  assert.equal(revised.notes.length, 1);
  assert.equal(revised.notes[0].text, 'Please also cover the error path.');
  assert.equal(revised.notes[0].planDigestBefore, planDigestV1);

  // Stale approval: approving against the old (pre-notes) digest is rejected.
  await rejects(
    approveSpecDecision(root, {
      taskId: task,
      expectedRevision: revised.revision,
      planDigest: planDigestV1,
      scope: 'src/**',
      reference: 'maintainer approval',
    }),
    'SPEC_DECISION_PLAN_STALE',
  );

  // Approving the current (post-notes) digest re-presents cleanly.
  const reapproved = await approveSpecDecision(root, {
    taskId: task,
    expectedRevision: revised.revision,
    planDigest: planDigestV2,
    scope: 'src/**',
    reference: 'maintainer approval',
  });
  assert.equal(reapproved.status, 'approved');
  assert.equal(reapproved.approval.planDigest, planDigestV2);
});

test('pausing or leaving the decision unanswered persists the plan without launching implementation, and resume restores it', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigest = digest('# Plan');
  const presented = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
  });

  // Leaving the prompt unanswered: nothing is recorded and the record stays exactly as presented.
  const untouched = await inspectSpecDecision(root, task);
  assert.deepEqual(untouched, presented);
  assert.equal(untouched.status, 'pending');

  // Explicit pause records the choice without changing the plan or authorizing implementation.
  const paused = await pauseSpecDecision(root, {
    taskId: task,
    expectedRevision: presented.revision,
  });
  assert.ok(paused.pausedAt);
  assert.equal(paused.status, 'pending');
  assert.equal(paused.approval, null);

  // Resume restores the pending decision and its current revision.
  const resumed = await inspectSpecDecision(root, task);
  assert.deepEqual(resumed, paused);
  assert.equal(resumed.revision, presented.revision + 1);
});

test('a stale expected revision is rejected for approve, notes, and pause', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigest = digest('# Plan');
  const presented = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
  });
  const staleRevision = presented.revision + 41;
  await rejects(
    approveSpecDecision(root, {
      taskId: task,
      expectedRevision: staleRevision,
      planDigest,
      scope: 'src/**',
      reference: 'maintainer approval',
    }),
    'SPEC_DECISION_REVISION_CONFLICT',
  );
  await rejects(
    addSpecDecisionNotes(root, {
      taskId: task,
      expectedRevision: staleRevision,
      notes: 'change something',
      planDigest: digest('# Plan v2'),
    }),
    'SPEC_DECISION_REVISION_CONFLICT',
  );
  await rejects(
    pauseSpecDecision(root, { taskId: task, expectedRevision: staleRevision }),
    'SPEC_DECISION_REVISION_CONFLICT',
  );
});

test('repeated completion events do not duplicate the decision, a valid approval, or the build', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigest = digest('# Plan');

  // The first presentation creates the record.
  const first = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
  });

  // An identical retry with the exact same mutation ID is a pure idempotent replay.
  const mutationId = `event_${randomUUID()}`;
  const replayA = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
    mutationId,
  });
  const replayB = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
    mutationId,
  });
  assert.equal(replayA.revision, replayB.revision);

  // Reusing the mutation ID with different input is rejected, not silently applied.
  await rejects(
    presentSpecDecision(root, {
      taskId: task,
      planRef: 'docs/plans/example.md',
      planDigest,
      summary: 'A different summary.',
      mutationId,
    }),
    'SPEC_DECISION_IDEMPOTENCY_CONFLICT',
  );

  // A second, distinct completion event for the *same unchanged* plan does not duplicate the pending prompt.
  const secondCompletion = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
  });
  assert.equal(secondCompletion.revision, first.revision);

  // Approve, then simulate the workflow already having been authorized: presenting again for the
  // same content must not re-prompt or discard the approval ("already-authorized continuation").
  const approved = await approveSpecDecision(root, {
    taskId: task,
    expectedRevision: secondCompletion.revision,
    planDigest,
    scope: 'src/**',
    reference: 'maintainer approval',
  });
  const stillApproved = await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
  });
  assert.equal(stillApproved.status, 'approved');
  assert.deepEqual(stillApproved.approval, approved.approval);
  assert.equal(stillApproved.revision, approved.revision);

  // Re-approving with the same scope/reference for the same plan is preserved, not duplicated.
  const reapproved = await approveSpecDecision(root, {
    taskId: task,
    expectedRevision: approved.revision,
    planDigest,
    scope: 'src/**',
    reference: 'maintainer approval',
  });
  assert.equal(reapproved.revision, approved.revision);

  // Starting the build twice never launches a second build.
  const startedOnce = await markSpecBuildStarted(root, {
    taskId: task,
    expectedRevision: reapproved.revision,
  });
  const startedTwice = await markSpecBuildStarted(root, {
    taskId: task,
    expectedRevision: startedOnce.revision,
  });
  assert.equal(startedOnce.buildStartedAt, startedTwice.buildStartedAt);
  assert.equal(startedTwice.revision, startedOnce.revision);
});

test('build can only start for an approved decision, and unknown tasks are reported explicitly', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigest = digest('# Plan');
  await presentSpecDecision(root, {
    taskId: task,
    planRef: 'docs/plans/example.md',
    planDigest,
    summary: 'Plan summary.',
  });
  await rejects(
    markSpecBuildStarted(root, { taskId: task, expectedRevision: 1 }),
    'SPEC_DECISION_NOT_APPROVED',
  );
  const missingTask = taskId();
  await rejects(
    approveSpecDecision(root, {
      taskId: missingTask,
      expectedRevision: 1,
      planDigest,
      scope: 'src/**',
      reference: 'maintainer approval',
    }),
    'SPEC_DECISION_NOT_FOUND',
  );
  assert.equal(await inspectSpecDecision(root, missingTask), null);
});

test('decision presentation prefers a documented native control and never fabricates one', async () => {
  const claude = selectSpecDecisionPresentation('claude');
  assert.equal(claude.mode, 'native-question');
  assert.equal(claude.documented, true);
  assert.ok(claude.evidenceUrl);

  for (const providerId of [
    'codex',
    'antigravity',
    'cursor',
    'cursor-cli',
    'not-a-real-provider',
  ]) {
    const presentation = selectSpecDecisionPresentation(providerId);
    assert.equal(presentation.mode, 'text-fallback');
    assert.equal(presentation.documented, false);
    assert.equal(presentation.control, null);
  }
});

test('CLI presents, approves, and inspects a spec decision end to end', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const planDigest = digest('# Plan');
  const run = (args) => execFileAsync(process.execPath, [cli, ...args, '--project', root]);

  const { stdout: presentOut } = await run([
    'spec',
    'decision-present',
    '--task',
    task,
    '--plan-ref',
    'docs/plans/example.md',
    '--plan-digest',
    planDigest,
    '--summary',
    'CLI plan summary.',
  ]);
  const presented = JSON.parse(presentOut);
  assert.equal(presented.status, 'pending');

  const { stdout: approveOut } = await run([
    'spec',
    'decision-approve',
    '--task',
    task,
    '--expected-revision',
    String(presented.revision),
    '--plan-digest',
    planDigest,
    '--scope',
    'src/**',
    '--reference',
    'maintainer approval',
  ]);
  const approved = JSON.parse(approveOut);
  assert.equal(approved.status, 'approved');

  const { stdout: inspectOut } = await run(['spec', 'decision-inspect', '--task', task]);
  assert.deepEqual(JSON.parse(inspectOut), approved);
});

test('SpecDecisionError instances carry the machine-readable code used by the CLI and skill', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  try {
    await approveSpecDecision(root, {
      taskId: task,
      expectedRevision: 1,
      planDigest: digest('# Plan'),
      scope: 'src/**',
      reference: 'maintainer approval',
    });
    assert.fail('expected approveSpecDecision to reject for an unknown task');
  } catch (error) {
    assert.ok(error instanceof SpecDecisionError);
    assert.equal(error.code, 'SPEC_DECISION_NOT_FOUND');
  }
});
