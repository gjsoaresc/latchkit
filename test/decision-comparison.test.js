import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { initProject } from '../dist/src/core.js';
import { startServer } from '../dist/src/server.js';
import {
  createTask,
  recordEvidence,
  recordTaskRecord,
  resumeTask,
  transitionTaskRecord,
} from '../dist/src/task-state/service.js';
import {
  addResultDecisionNotes,
  approveResultDecision,
  presentResultDecision,
} from '../dist/src/workflows/result-decision-service.js';
import {
  DecisionComparisonError,
  formatDecisionComparisonText,
  inspectDecisionComparison,
} from '../dist/src/reviews/decision-comparison.js';

// Issue #113: read-only decision-comparison coverage. Every scenario below is one of the
// acceptance criterion's named fixtures: an initial review, an unchanged approved plan, a changed
// decision with stale evidence, missing consequence metadata, a stale approval submission, and
// notes surviving revision/resume.

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const authorization = (scope, reference = 'current direct test request') => ({
  source: 'user',
  scope,
  reference,
});

async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-decision-comparison-')),
  );
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'README.md'), 'placeholder\n');
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function baseTask(root, criteria = []) {
  return createTask(root, {
    title: 'Export orders',
    authorization: authorization('implement task'),
    criteria,
  });
}

/** Creates and immediately accepts a decision record, mirroring the direct-user acceptance flow
 * every other task-record test in this repository already uses. */
async function acceptedDecision(root, taskId, expectedRevision, text, links = []) {
  let updated = await recordTaskRecord(root, {
    taskId,
    expectedRevision,
    kind: 'decision',
    text,
    provenance: { kind: 'direct-user', reference: 'user message' },
    links,
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

async function approvedResultDecision(root, taskId, resultDigest, overrides = {}) {
  const presented = await presentResultDecision(root, {
    taskId,
    resultRef: 'https://example.invalid/diff/1',
    resultDigest,
    summary: 'Adds the exact requested export behavior.',
    verificationResults: 'npm test: 12/12 passed.',
    ...overrides,
  });
  return approveResultDecision(root, {
    taskId,
    expectedRevision: presented.revision,
    resultDigest,
  });
}

// ---------------------------------------------------------------------------
// Fixture 1: an initial review — no prior reviewed snapshot exists.
// ---------------------------------------------------------------------------

test('an initial review has no baseline and shows every recorded decision as added, never an invented before state', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );

  const report = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(report.baseline.kind, 'initial');
  assert.equal(report.baseline.taskRevision, null);
  assert.equal(report.baseline.at, null);
  assert.equal(report.taskRevision, withDecision.revision);
  assert.equal(report.hasDecisionRecords, true);

  const entry = report.decisions.find((item) => item.recordId === decision.id);
  assert.equal(entry.changeKind, 'added');
  assert.equal(entry.before, null);
  assert.equal(entry.after.text, 'Export includes all orders');
  assert.equal(entry.after.status, 'accepted');
  assert.equal(entry.interpretation, false);
});

test('a task with no structured decision records falls back to the source diff without claiming decision coverage', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  const report = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(report.hasDecisionRecords, false);
  assert.match(report.coverageNote, /falls back to the ordinary source diff/i);
  assert.deepEqual(report.decisions, []);
  // No owned worktree exists in this fixture, so the diff link itself is honestly reported
  // unavailable rather than the comparison inventing a diff it cannot produce.
  assert.equal(report.sourceDiff.available, false);
  assert.ok(report.sourceDiff.reason);
});

// ---------------------------------------------------------------------------
// Fixture 2: an unchanged, already-approved plan — opening/refreshing causes no prompt.
// ---------------------------------------------------------------------------

test('an unchanged approved result shows no changed decisions and viewing it twice mutates nothing', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');
  const resultDigest = sha256Hex('diff-v1 + evidence-v1');
  await approvedResultDecision(root, task.id, resultDigest);

  const first = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(first.baseline.kind, 'previous-review');
  assert.ok(Number.isInteger(first.baseline.taskRevision));
  assert.ok(first.decisions.length > 0);
  assert.ok(first.decisions.every((item) => item.changeKind === 'unchanged'));
  assert.equal(first.unchangedCount, first.decisions.length);
  assert.equal(first.approvals.resultDecision.present, true);
  assert.equal(first.approvals.resultDecision.valid, true);
  assert.equal(first.approvals.resultDecision.staleReasons.length, 0);

  // Viewing is read-only: a second, unrelated call reproduces the identical decision list and the
  // identical current task revision — nothing about opening this view executes or advances state.
  const second = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(second.taskRevision, first.taskRevision);
  assert.deepEqual(second.decisions, first.decisions);
  assert.deepEqual(second.baseline, first.baseline);
});

// ---------------------------------------------------------------------------
// Fixture 3: a changed decision with stale evidence.
// ---------------------------------------------------------------------------

test('a decision superseded after approval shows removed/added with a source-drift reason on its evidence', async (t) => {
  const root = await fixture(t);
  const criterionDescription = 'Export is scoped to the current user';
  const task = await baseTask(root, [{ description: criterionDescription }]);
  const criterion = task.criteria[0];
  const { task: withDecision, decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
    [{ type: 'criterion', criterionId: criterion.id, criterionRevision: criterion.revision }],
  );
  const resumed = await resumeTask(root, {
    taskId: task.id,
    expectedRevision: withDecision.revision,
  });
  const withEvidence = await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: resumed.revision,
    runId: resumed.owner.runId,
    criterionId: criterion.id,
    criterionRevision: criterion.revision,
    kind: 'check',
    outcome: 'passed',
  });
  const resultDigest = sha256Hex('diff-v1 + evidence-v1');
  await approvedResultDecision(root, task.id, resultDigest);

  // The working tree drifts after the reviewed snapshot: recorded evidence is now source-stale
  // even though nothing about the criterion itself changed.
  await fs.appendFile(path.join(root, 'README.md'), 'edited after review\n');

  const superseded = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: withEvidence.revision,
    kind: 'decision',
    text: 'Export includes only orders visible to the current user',
    provenance: { kind: 'direct-user', reference: 'user narrowed the export in chat' },
    supersedes: decision.id,
    authorization: authorization('narrow export scope', 'user narrowed the export in chat'),
  });
  const newDecision = superseded.records.find((item) => item.supersedes === decision.id);

  const report = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(report.baseline.kind, 'previous-review');

  const oldEntry = report.decisions.find((item) => item.recordId === decision.id);
  assert.equal(oldEntry.changeKind, 'removed');
  assert.equal(oldEntry.after.status, 'superseded');
  assert.equal(oldEntry.supersededBy, newDecision.id);

  const newEntry = report.decisions.find((item) => item.recordId === newDecision.id);
  assert.equal(newEntry.changeKind, 'added');
  assert.equal(newEntry.supersedes, decision.id);
  assert.equal(newEntry.before, null);

  const evidenceView = report.evidence.find((item) => item.criterionId === criterion.id);
  assert.equal(evidenceView.status, 'stale');
  assert.match(evidenceView.reason, /source changed/i);
  assert.equal(evidenceView.outcome, 'passed');

  // A historical pass never turns into a current one — the raw text explains why.
  assert.notEqual(evidenceView.status, 'current-pass');
});

// ---------------------------------------------------------------------------
// Fixture 4: missing consequence metadata — absence is shown, never invented or hidden.
// ---------------------------------------------------------------------------

test('a required criterion with no declared decision link is an explicit uncertainty, never proof of independence', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  const { decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );

  const report = await inspectDecisionComparison(root, { taskId: task.id });
  assert.deepEqual(report.uncoveredRequiredCriteria, [task.criteria[0].id]);
  const entry = report.decisions.find((item) => item.recordId === decision.id);
  assert.deepEqual(entry.sourceLinks, []);
  assert.deepEqual(
    report.impact.filter((item) => item.classification === 'declared-dependent'),
    [],
  );
  assert.equal(report.impactTruncated, false);
});

// ---------------------------------------------------------------------------
// Fixture 5: notes survive revision and resume; a stale submission is rejected, not applied.
// ---------------------------------------------------------------------------

test('result-decision notes are visible on the comparison and survive a later resume', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');
  const resultDigest = sha256Hex('diff-v1');
  const presented = await presentResultDecision(root, {
    taskId: task.id,
    resultRef: 'https://example.invalid/diff/1',
    resultDigest,
    summary: 'Adds export filtering.',
    verificationResults: 'npm test: 12/12 passed.',
  });
  await addResultDecisionNotes(root, {
    taskId: task.id,
    expectedRevision: presented.revision,
    notes: 'Re: decision text — please also filter archived orders.',
    resultDigest,
  });

  const report = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(report.resultDecision.status, 'changes-requested');
  assert.equal(report.resultDecision.notes.length, 1);
  assert.match(report.resultDecision.notes[0].text, /filter archived orders/);
  assert.equal(report.approvals.resultDecision.present, false);
  assert.equal(report.approvals.resultDecision.valid, null);

  // A repeated completion event for the exact same reviewed snapshot (a resume that produced no
  // new content) is idempotent — the unresolved note stays exactly as recorded, never duplicated
  // and never silently treated as acceptance.
  const mutationId = `event_${randomUUID()}`;
  await presentResultDecision(root, {
    taskId: task.id,
    resultRef: 'https://example.invalid/diff/1',
    resultDigest,
    summary: 'Adds export filtering.',
    verificationResults: 'npm test: 12/12 passed.',
    mutationId,
  });
  const again = await presentResultDecision(root, {
    taskId: task.id,
    resultRef: 'https://example.invalid/diff/1',
    resultDigest,
    summary: 'Adds export filtering.',
    verificationResults: 'npm test: 12/12 passed.',
    mutationId,
  });
  assert.equal(again.notes.length, 1);
  assert.equal(again.status, 'changes-requested');

  const resumed = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(resumed.resultDecision.notes.length, 1);
  assert.equal(resumed.resultDecision.status, 'changes-requested');
});

test('a stale result-decision approval is rejected by the shared service rather than silently carried forward', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');
  const resultDigest = sha256Hex('diff-v1');
  const presented = await presentResultDecision(root, {
    taskId: task.id,
    resultRef: 'https://example.invalid/diff/1',
    resultDigest,
    summary: 'Adds export filtering.',
    verificationResults: 'npm test: 12/12 passed.',
  });
  await approveResultDecision(root, {
    taskId: task.id,
    expectedRevision: presented.revision,
    resultDigest,
  });

  // A UI still holding the pre-approval revision retries with a now-stale expectedRevision.
  await assert.rejects(
    approveResultDecision(root, {
      taskId: task.id,
      expectedRevision: presented.revision,
      resultDigest,
    }),
    (error) => {
      assert.equal(error.code, 'RESULT_DECISION_REVISION_CONFLICT');
      return true;
    },
  );

  // A corrected result changes the digest; approving the old digest is rejected as stale, not
  // silently accepted against the new snapshot.
  const secondDigest = sha256Hex('diff-v2');
  const rePresented = await presentResultDecision(root, {
    taskId: task.id,
    resultRef: 'https://example.invalid/diff/2',
    resultDigest: secondDigest,
    summary: 'Adds export filtering and an archived-orders filter.',
    verificationResults: 'npm test: 13/13 passed.',
  });
  await assert.rejects(
    approveResultDecision(root, {
      taskId: task.id,
      expectedRevision: rePresented.revision,
      resultDigest,
    }),
    (error) => {
      assert.equal(error.code, 'RESULT_DECISION_SNAPSHOT_STALE');
      return true;
    },
  );

  // The comparison itself never turns this stale/failed state into a current pass.
  const report = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(report.resultDecision.resultDigest, secondDigest);
  assert.equal(report.resultDecision.status, 'pending');
});

// ---------------------------------------------------------------------------
// baselineRevision — an explicitly selected retained revision.
// ---------------------------------------------------------------------------

test('an explicitly selected retained task revision reproduces the same before/after split as the derived baseline', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  const { task: withDecision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const derived = await inspectDecisionComparison(root, { taskId: task.id });
  const explicit = await inspectDecisionComparison(root, {
    taskId: task.id,
    baselineRevision: withDecision.revision,
  });
  assert.equal(explicit.baseline.kind, 'explicit-revision');
  assert.equal(explicit.baseline.taskRevision, withDecision.revision);
  assert.deepEqual(
    explicit.decisions.map((item) => item.changeKind),
    derived.decisions.map(() => 'unchanged'),
  );

  await assert.rejects(
    inspectDecisionComparison(root, {
      taskId: task.id,
      baselineRevision: withDecision.revision + 100,
    }),
    (error) => {
      assert.ok(error instanceof DecisionComparisonError);
      assert.equal(error.code, 'DECISION_COMPARISON_BASELINE_INVALID');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Text/JSON formatting (read-only textual comparison for users without the UI).
// ---------------------------------------------------------------------------

test('the concise text rendering reflects the same recorded state as the JSON report', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  const { decision } = await acceptedDecision(
    root,
    task.id,
    task.revision,
    'Export includes all orders',
  );
  const report = await inspectDecisionComparison(root, { taskId: task.id });
  const text = formatDecisionComparisonText(report);
  assert.match(text, /Initial review/i);
  assert.match(text, new RegExp(decision.id));
  assert.match(text, /Export includes all orders/);
  assert.match(text, /Verification:/);
});

// ---------------------------------------------------------------------------
// HTTP API: additive routes, authenticated, and a stale submission maps to 409.
// ---------------------------------------------------------------------------

async function serverFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-decision-comparison-api-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url, token } = await startServer(root);
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = new URL(url).origin;
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  return { root, origin, headers };
}

test('the decision-comparison API route is authenticated and supports a concise text export', async (t) => {
  const { root, origin, headers } = await serverFixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');

  const denied = await fetch(`${origin}/api/reviews/decision-comparison?task=${task.id}`);
  assert.equal(denied.status, 401);

  const jsonResponse = await fetch(`${origin}/api/reviews/decision-comparison?task=${task.id}`, {
    headers,
  });
  assert.equal(jsonResponse.status, 200);
  const jsonBody = await jsonResponse.json();
  assert.equal(jsonBody.report.taskId, task.id);
  assert.equal(jsonBody.report.baseline.kind, 'initial');

  const textResponse = await fetch(
    `${origin}/api/reviews/decision-comparison?task=${task.id}&format=text`,
    { headers },
  );
  assert.equal(textResponse.status, 200);
  assert.match(textResponse.headers.get('content-type'), /text\/plain/);
  const text = await textResponse.text();
  assert.match(text, /Export includes all orders/);
});

test('a stale result-decision approval submitted through the API is rejected with 409, not silently applied', async (t) => {
  const { root, origin, headers } = await serverFixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');
  const resultDigest = sha256Hex('diff-v1');
  const presented = await presentResultDecision(root, {
    taskId: task.id,
    resultRef: 'https://example.invalid/diff/1',
    resultDigest,
    summary: 'Adds export filtering.',
    verificationResults: 'npm test: 12/12 passed.',
  });
  const approve = () =>
    fetch(`${origin}/api/reviews/result-decision/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        taskId: task.id,
        expectedRevision: presented.revision,
        resultDigest,
      }),
    });
  const first = await approve();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'approved');

  const second = await approve();
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.equal(secondBody.code, 'RESULT_DECISION_REVISION_CONFLICT');

  // A UI acting on this response is expected to refresh the comparison — the refreshed report
  // still reflects the real, already-approved state, never a duplicated approval.
  const refreshed = await fetch(`${origin}/api/reviews/decision-comparison?task=${task.id}`, {
    headers,
  });
  const refreshedBody = await refreshed.json();
  assert.equal(refreshedBody.report.approvals.resultDecision.valid, true);
});

test('review compare is read-only from the CLI and matches --format text/json', async (t) => {
  const root = await fixture(t);
  const task = await baseTask(root, [{ description: 'Export renders every row' }]);
  await acceptedDecision(root, task.id, task.revision, 'Export includes all orders');

  const before = await inspectDecisionComparison(root, { taskId: task.id });
  const json = await execFile(process.execPath, [
    cli,
    'review',
    'compare',
    '--project',
    root,
    '--task',
    task.id,
  ]);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.taskId, task.id);

  const text = await execFile(process.execPath, [
    cli,
    'review',
    'compare',
    '--project',
    root,
    '--task',
    task.id,
    '--format',
    'text',
  ]);
  assert.match(text.stdout, /Export includes all orders/);

  const after = await inspectDecisionComparison(root, { taskId: task.id });
  assert.equal(after.taskRevision, before.taskRevision);
});
