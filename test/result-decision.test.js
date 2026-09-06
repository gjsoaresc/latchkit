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
  addResultDecisionNotes,
  approveResultDecision,
  deferResultDecision,
  inspectResultDecision,
  presentResultDecision,
  selectResultDecisionPresentation,
  ResultDecisionError,
} from '../dist/src/workflows/result-decision-service.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');
const execFileAsync = promisify(execFile);

const digest = (value) => createHash('sha256').update(value).digest('hex');
const taskId = () => `task_${randomUUID()}`;

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-result-decision-'));
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

const basePresent = (task, digestValue, overrides = {}) => ({
  taskId: task,
  resultRef: 'https://example.invalid/diff/1',
  resultDigest: digestValue,
  summary: 'Adds a widget and its regression test.',
  verificationResults: 'npm test: 42/42 passed.',
  completedCriteria: ['Widget renders', 'Widget persists state'],
  artifactRefs: ['https://example.invalid/artifacts/widget.png'],
  ...overrides,
});

test('execution completion presents a reviewable result with links, criteria, verification, and gaps', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigestV1 = digest('diff-v1 + evidence-v1');
  const record = await presentResultDecision(
    root,
    basePresent(task, resultDigestV1, { remainingGaps: 'Browser check not run.' }),
  );
  assert.equal(record.taskId, task);
  assert.equal(record.status, 'pending');
  assert.equal(record.resultDigest, resultDigestV1);
  assert.equal(record.resultRevision, 1);
  assert.equal(record.approval, null);
  assert.equal(record.revision, 1);
  assert.deepEqual(record.completedCriteria, ['Widget renders', 'Widget persists state']);
  assert.equal(record.verificationResults, 'npm test: 42/42 passed.');
  assert.equal(record.remainingGaps, 'Browser check not run.');
  assert.deepEqual(record.artifactRefs, ['https://example.invalid/artifacts/widget.png']);

  const resumed = await inspectResultDecision(root, task);
  assert.deepEqual(resumed, record);
});

test('approve binds acceptance to the exact reviewed digest and never touches verification/gaps', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-v1 + evidence-v1');
  const presented = await presentResultDecision(
    root,
    basePresent(task, resultDigest, { remainingGaps: 'Docs not updated.' }),
  );
  const approved = await approveResultDecision(root, {
    taskId: task,
    expectedRevision: presented.revision,
    resultDigest,
    note: 'Accepting the missing docs for now.',
  });
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approval);
  assert.equal(approved.approval.resultDigest, resultDigest);
  assert.equal(approved.approval.resultRevision, presented.resultRevision);
  assert.equal(approved.approval.note, 'Accepting the missing docs for now.');

  // Verification status stays separate from acceptance: the known gap the user
  // just accepted is still visible on the record, not rewritten as resolved.
  assert.equal(approved.remainingGaps, 'Docs not updated.');
  assert.equal(approved.verificationResults, 'npm test: 42/42 passed.');
});

test('a failed or incomplete check stays visible even after the user accepts a known limitation', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-with-a-failure');
  const presented = await presentResultDecision(
    root,
    basePresent(task, resultDigest, {
      verificationResults: 'npm test: 41/42 passed; 1 failing (flaky network test).',
      remainingGaps: 'One test still fails intermittently.',
    }),
  );
  const approved = await approveResultDecision(root, {
    taskId: task,
    expectedRevision: presented.revision,
    resultDigest,
    note: 'Known flaky test; accepted.',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(
    approved.verificationResults,
    'npm test: 41/42 passed; 1 failing (flaky network test).',
  );
  assert.equal(approved.remainingGaps, 'One test still fails intermittently.');
  const inspected = await inspectResultDecision(root, task);
  assert.equal(inspected.verificationResults, presented.verificationResults);
});

test('a changed result invalidates a prior approval and re-presents a fresh decision', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigestV1 = digest('diff-v1 + evidence-v1');
  const presented = await presentResultDecision(root, basePresent(task, resultDigestV1));
  const approved = await approveResultDecision(root, {
    taskId: task,
    expectedRevision: presented.revision,
    resultDigest: resultDigestV1,
  });
  assert.equal(approved.status, 'approved');

  // A later implementation change produces a new snapshot; presenting it
  // invalidates the prior approval even though nothing else was submitted.
  const resultDigestV2 = digest('diff-v2 + evidence-v2');
  const rePresented = await presentResultDecision(
    root,
    basePresent(task, resultDigestV2, { summary: 'Also handles the error path now.' }),
  );
  assert.equal(rePresented.status, 'pending');
  assert.equal(rePresented.approval, null);
  assert.equal(rePresented.resultDigest, resultDigestV2);
  assert.equal(rePresented.resultRevision, presented.resultRevision + 1);

  // Approving against the stale (pre-change) digest is rejected.
  await rejects(
    approveResultDecision(root, {
      taskId: task,
      expectedRevision: rePresented.revision,
      resultDigest: resultDigestV1,
    }),
    'RESULT_DECISION_SNAPSHOT_STALE',
  );

  // Approving the current digest works cleanly.
  const reapproved = await approveResultDecision(root, {
    taskId: task,
    expectedRevision: rePresented.revision,
    resultDigest: resultDigestV2,
  });
  assert.equal(reapproved.status, 'approved');
  assert.equal(reapproved.approval.resultDigest, resultDigestV2);
});

test('notes route feedback into changes-requested with context, preserving in-scope authorization', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-v1 + evidence-v1');
  const presented = await presentResultDecision(root, basePresent(task, resultDigest));

  const withNotes = await addResultDecisionNotes(root, {
    taskId: task,
    expectedRevision: presented.revision,
    notes: 'Please also handle the empty-input case.',
    resultDigest,
  });
  assert.equal(withNotes.status, 'changes-requested');
  assert.equal(withNotes.approval, null);
  // The reviewed content itself (what was actually verified) is untouched by
  // feedback alone: only the build/fix follow-up can change it.
  assert.equal(withNotes.resultDigest, resultDigest);
  assert.equal(withNotes.verificationResults, presented.verificationResults);
  assert.equal(withNotes.notes.length, 1);
  assert.equal(withNotes.notes[0].text, 'Please also handle the empty-input case.');
  assert.equal(withNotes.notes[0].changeScope, 'in-scope');
  assert.equal(withNotes.notes[0].scopeAuthorization, null);
  assert.equal(withNotes.notes[0].resultDigestBefore, resultDigest);

  // Notes against a stale (already-superseded) digest are rejected.
  await rejects(
    addResultDecisionNotes(root, {
      taskId: task,
      expectedRevision: withNotes.revision,
      notes: 'Different feedback.',
      resultDigest: digest('a different, stale snapshot'),
    }),
    'RESULT_DECISION_SNAPSHOT_STALE',
  );

  // The correction lands and the caller re-presents the updated result;
  // review then returns to a fresh pending decision for the new snapshot.
  const resultDigestV2 = digest('diff-v2 + evidence-v2');
  const rePresented = await presentResultDecision(
    root,
    basePresent(task, resultDigestV2, { summary: 'Handles empty input now.' }),
  );
  assert.equal(rePresented.status, 'pending');
  assert.equal(rePresented.notes.length, 1, 'notes history is preserved across corrections');
});

test('new-scope feedback requires explicit authorization and is never silently applied', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-v1 + evidence-v1');
  const presented = await presentResultDecision(root, basePresent(task, resultDigest));

  await rejects(
    addResultDecisionNotes(root, {
      taskId: task,
      expectedRevision: presented.revision,
      notes: 'Actually, please also add an admin dashboard.',
      resultDigest,
      changeScope: 'new-scope',
    }),
    'RESULT_DECISION_NEW_SCOPE_AUTHORIZATION_REQUIRED',
  );

  const withScopedNotes = await addResultDecisionNotes(root, {
    taskId: task,
    expectedRevision: presented.revision,
    notes: 'Actually, please also add an admin dashboard.',
    resultDigest,
    changeScope: 'new-scope',
    scopeAuthorization: { scope: 'src/admin/**', reference: 'maintainer approved new scope' },
  });
  assert.equal(withScopedNotes.status, 'changes-requested');
  assert.equal(withScopedNotes.notes[0].changeScope, 'new-scope');
  assert.deepEqual(withScopedNotes.notes[0].scopeAuthorization, {
    scope: 'src/admin/**',
    reference: 'maintainer approved new scope',
  });
});

test('deferring (review later) leaves the decision pending, and dismissal/no-answer needs no call at all', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-v1 + evidence-v1');
  const presented = await presentResultDecision(root, basePresent(task, resultDigest));

  // Leaving the prompt unanswered: nothing is recorded and the record stays exactly as presented.
  const untouched = await inspectResultDecision(root, task);
  assert.deepEqual(untouched, presented);
  assert.equal(untouched.status, 'pending');

  const deferred = await deferResultDecision(root, {
    taskId: task,
    expectedRevision: presented.revision,
  });
  assert.ok(deferred.deferredAt);
  assert.equal(deferred.status, 'pending');
  assert.equal(deferred.approval, null);

  // Resume restores the pending decision, its outstanding notes, and its current revision.
  const resumed = await inspectResultDecision(root, task);
  assert.deepEqual(resumed, deferred);
  assert.equal(resumed.revision, presented.revision + 1);
});

test('a stale expected revision is rejected for approve, notes, and defer', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-v1 + evidence-v1');
  const presented = await presentResultDecision(root, basePresent(task, resultDigest));
  const staleRevision = presented.revision + 41;
  await rejects(
    approveResultDecision(root, {
      taskId: task,
      expectedRevision: staleRevision,
      resultDigest,
    }),
    'RESULT_DECISION_REVISION_CONFLICT',
  );
  await rejects(
    addResultDecisionNotes(root, {
      taskId: task,
      expectedRevision: staleRevision,
      notes: 'change something',
      resultDigest,
    }),
    'RESULT_DECISION_REVISION_CONFLICT',
  );
  await rejects(
    deferResultDecision(root, { taskId: task, expectedRevision: staleRevision }),
    'RESULT_DECISION_REVISION_CONFLICT',
  );
});

test('repeated completion events and repeated submissions do not duplicate prompts, approvals, or notes', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-v1 + evidence-v1');

  const first = await presentResultDecision(root, basePresent(task, resultDigest));

  const mutationId = `event_${randomUUID()}`;
  const replayA = await presentResultDecision(
    root,
    basePresent(task, resultDigest, { mutationId }),
  );
  const replayB = await presentResultDecision(
    root,
    basePresent(task, resultDigest, { mutationId }),
  );
  assert.equal(replayA.revision, replayB.revision);

  // Reusing the mutation ID with materially different input is rejected, not silently applied.
  await rejects(
    presentResultDecision(
      root,
      basePresent(task, resultDigest, { mutationId, summary: 'A different summary.' }),
    ),
    'RESULT_DECISION_IDEMPOTENCY_CONFLICT',
  );

  // A second, distinct completion event for the *same unchanged* result does not duplicate the pending prompt.
  const secondCompletion = await presentResultDecision(root, basePresent(task, resultDigest));
  assert.equal(secondCompletion.revision, first.revision);

  // Approve, then simulate a repeated completion event for the same content: it must not re-prompt or
  // discard the approval ("already-authorized continuation").
  const approved = await approveResultDecision(root, {
    taskId: task,
    expectedRevision: secondCompletion.revision,
    resultDigest,
  });
  const stillApproved = await presentResultDecision(root, basePresent(task, resultDigest));
  assert.equal(stillApproved.status, 'approved');
  assert.deepEqual(stillApproved.approval, approved.approval);
  assert.equal(stillApproved.revision, approved.revision);

  // A retried notes submission with the same mutation ID does not create a second note.
  const notesMutationId = `event_${randomUUID()}`;
  const notesA = await addResultDecisionNotes(root, {
    taskId: task,
    expectedRevision: stillApproved.revision,
    notes: 'Please also cover the retry path.',
    resultDigest,
    mutationId: notesMutationId,
  });
  const notesB = await addResultDecisionNotes(root, {
    taskId: task,
    expectedRevision: stillApproved.revision,
    notes: 'Please also cover the retry path.',
    resultDigest,
    mutationId: notesMutationId,
  });
  assert.equal(notesA.notes.length, 1);
  assert.equal(notesB.notes.length, 1);
  assert.equal(notesA.revision, notesB.revision);
});

test('approving or adding notes for an unknown task is reported explicitly', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigest = digest('diff-v1 + evidence-v1');
  await rejects(
    approveResultDecision(root, { taskId: task, expectedRevision: 1, resultDigest }),
    'RESULT_DECISION_NOT_FOUND',
  );
  assert.equal(await inspectResultDecision(root, task), null);
});

test('decision presentation prefers a documented native control and never fabricates one', async () => {
  const claude = selectResultDecisionPresentation('claude');
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
    const presentation = selectResultDecisionPresentation(providerId);
    assert.equal(presentation.mode, 'text-fallback');
    assert.equal(presentation.documented, false);
    assert.equal(presentation.control, null);
  }
});

test('CLI presents, requests changes, re-presents, approves, and inspects a result decision end to end', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  const resultDigestV1 = digest('diff-v1 + evidence-v1');
  const run = (args) => execFileAsync(process.execPath, [cli, ...args, '--project', root]);

  const { stdout: presentOut } = await run([
    'task',
    'result-present',
    '--task',
    task,
    '--result-ref',
    'https://example.invalid/diff/1',
    '--result-digest',
    resultDigestV1,
    '--summary',
    'CLI result summary.',
    '--verification-results',
    'npm test: 10/10 passed.',
  ]);
  const presented = JSON.parse(presentOut);
  assert.equal(presented.status, 'pending');
  assert.equal(presented.verificationResults, 'npm test: 10/10 passed.');

  const { stdout: notesOut } = await run([
    'task',
    'result-notes',
    '--task',
    task,
    '--expected-revision',
    String(presented.revision),
    '--text',
    'Please rename the widget prop.',
    '--result-digest',
    resultDigestV1,
  ]);
  const notesResult = JSON.parse(notesOut);
  assert.equal(notesResult.status, 'changes-requested');

  const resultDigestV2 = digest('diff-v2 + evidence-v2');
  const { stdout: rePresentOut } = await run([
    'task',
    'result-present',
    '--task',
    task,
    '--result-ref',
    'https://example.invalid/diff/2',
    '--result-digest',
    resultDigestV2,
    '--summary',
    'Renamed the widget prop.',
    '--verification-results',
    'npm test: 10/10 passed.',
  ]);
  const rePresented = JSON.parse(rePresentOut);
  assert.equal(rePresented.status, 'pending');

  const { stdout: approveOut } = await run([
    'task',
    'result-approve',
    '--task',
    task,
    '--expected-revision',
    String(rePresented.revision),
    '--result-digest',
    resultDigestV2,
  ]);
  const approved = JSON.parse(approveOut);
  assert.equal(approved.status, 'approved');

  const { stdout: inspectOut } = await run(['task', 'result-inspect', '--task', task]);
  assert.deepEqual(JSON.parse(inspectOut), approved);
});

test('ResultDecisionError instances carry the machine-readable code used by the CLI and skill', async (t) => {
  const root = await fixture(t);
  const task = taskId();
  try {
    await approveResultDecision(root, {
      taskId: task,
      expectedRevision: 1,
      resultDigest: digest('diff'),
    });
    assert.fail('expected approveResultDecision to reject for an unknown task');
  } catch (error) {
    assert.ok(error instanceof ResultDecisionError);
    assert.equal(error.code, 'RESULT_DECISION_NOT_FOUND');
  }
});
