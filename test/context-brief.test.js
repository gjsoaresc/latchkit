import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  createTask,
  inspectTask,
  recordEvidence,
  recordTaskRecord,
  resumeTask,
  transitionTaskRecord,
} from '../dist/src/task-state/service.js';
import { addProjectMemory, updateProjectMemory } from '../dist/src/project-memory/service.js';
import { assembleContextBrief, buildContextBrief } from '../dist/src/context-brief/service.js';
import { ContextBriefError } from '../dist/src/context-brief/contracts.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');
const execFileAsync = promisify(execFile);

// Wrap mkdtemp's root in realpath before deriving expected paths: CI can hand back an 8.3
// short-path alias on Windows, which would otherwise mismatch a later canonicalized path. The
// project directory itself carries a space and a non-ASCII character, per issue #112's fixture
// requirement.
async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-context-brief-')),
  );
  const root = path.join(base, 'context brief é');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'source.txt'), 'initial\n');
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

const authorization = (scope = 'implement task') => ({
  source: 'user',
  scope,
  reference: 'current direct test request',
});

async function acceptedDecision(root, task, text, links) {
  const added = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: task.revision,
    kind: 'decision',
    text,
    provenance: { kind: 'direct-user', reference: 'chat' },
    ...(links ? { links } : {}),
  });
  const record = added.records.at(-1);
  const transitioned = await transitionTaskRecord(root, {
    taskId: task.id,
    expectedRevision: added.revision,
    recordId: record.id,
    recordRevision: record.revision,
    status: 'accepted',
    reason: 'confirmed with the user',
    authorization: authorization('accept decision'),
  });
  return { task: transitioned, record: transitioned.records.at(-1) };
}

test('repeated previews reproduce an identical digest for unchanged state, and perform no migration/file rewrite/mutation', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Ordinary task',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  const first = await buildContextBrief(root, { taskId: task.id });
  const second = await buildContextBrief(root, { taskId: task.id });
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.generatedAt, undefined);
  // A brief for a task with no delivery workflow is explicit about it, and its next action never
  // pretends to be a workflow decision.
  assert.equal(first.workflow.exists, false);
  assert.equal(first.nextAction.kind, 'ordinary-task');
  assert.equal(first.changeSinceLastRun.available, false);
  assert.equal(first.changeSinceLastRun.reason, 'no-prior-dispatch');
  // No file besides the pre-existing task-state store exists; producing the brief wrote nothing.
  const entries = await fs.readdir(path.join(root, '.latchkit', 'tasks'));
  assert.deepEqual(entries.sort(), ['state-v1.json']);
});

test('oversized mandatory context is refused with an actionable message instead of a silently incomplete brief', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Large intent',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  // Several long accepted decisions push mandatory content past a tiny budget.
  let current = task;
  for (let index = 0; index < 6; index += 1) {
    const { task: updated } = await acceptedDecision(
      root,
      current,
      `Decision ${index}: ${'x'.repeat(400)}`,
    );
    current = updated;
  }
  await assert.rejects(buildContextBrief(root, { taskId: task.id, byteBudget: 512 }), (error) => {
    assert.ok(error instanceof ContextBriefError);
    assert.equal(error.code, 'CONTEXT_BRIEF_BUDGET_EXCEEDED');
    assert.match(error.message, /Mandatory context \(\d+ bytes/);
    assert.match(error.message, /Raise --byte-budget to at least \d+/);
    return true;
  });
  // The same task fits comfortably at the default budget.
  const brief = await buildContextBrief(root, { taskId: task.id });
  assert.equal(brief.acceptedDecisions.length, 6);
});

test('a tight (but sufficient-for-mandatory) budget trims optional material deterministically and lists every omission with an inspectable source reference', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Trimmed brief',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  // Historical observations are the lowest-priority optional section: add several so a tight
  // budget must drop some of them while keeping every mandatory field intact.
  let current = task;
  const observationIds = [];
  for (let index = 0; index < 10; index += 1) {
    const added = await recordTaskRecord(root, {
      taskId: task.id,
      expectedRevision: current.revision,
      kind: 'observation',
      text: `Observation ${index}: ${'y'.repeat(200)}`,
      provenance: { kind: 'execution-observed', reference: `check ${index}` },
    });
    current = added;
    observationIds.push(added.records.at(-1).id);
  }
  const generous = await buildContextBrief(root, { taskId: task.id });
  assert.equal(generous.historicalObservations.length, 10);
  assert.equal(generous.omitted.length, 0);

  const mandatoryOnlyBytes = generous.budget.mandatoryBytes;
  const tight = await buildContextBrief(root, {
    taskId: task.id,
    byteBudget: mandatoryOnlyBytes + 250,
  });
  assert.ok(tight.historicalObservations.length < 10, 'a tight budget must drop some observations');
  assert.ok(
    tight.omitted.length > 0,
    'every dropped item must be listed, never silently discarded',
  );
  for (const item of tight.omitted) {
    assert.equal(item.section, 'historicalObservations');
    assert.match(item.sourceRef, /^task\.records\[id=record_/);
  }
  // Deterministic order: the same call against the same state produces the same omission list.
  const repeat = await buildContextBrief(root, {
    taskId: task.id,
    byteBudget: mandatoryOnlyBytes + 250,
  });
  assert.deepEqual(repeat.omitted, tight.omitted);
  assert.equal(repeat.digest, tight.digest);
  // Character counts and estimated tokens are explicitly labeled as a heuristic, never presented
  // as provider-measured usage.
  assert.match(tight.budget.estimateDisclaimer, /[Hh]euristic/);
  assert.match(tight.budget.estimateDisclaimer, /never a provider-measured/);
});

test('malformed references (an invalid since-digest, or a link the source directly rejects) are refused or exposed, never silently accepted', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Malformed references',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  await assert.rejects(
    buildContextBrief(root, { taskId: task.id, sinceDigest: 'not-a-digest' }),
    (error) => {
      assert.ok(error instanceof ContextBriefError);
      assert.equal(error.code, 'CONTEXT_BRIEF_INVALID');
      return true;
    },
  );
  // A syntactically valid but unknown digest is an honest "no match," not a fabricated diff.
  const brief = await buildContextBrief(root, {
    taskId: task.id,
    sinceDigest: 'a'.repeat(64),
  });
  assert.equal(brief.changeSinceLastRun.available, false);
  assert.equal(brief.changeSinceLastRun.reason, 'digest-mismatch');
  assert.equal(brief.changeSinceLastRun.sinceDigest, 'a'.repeat(64));
});

test('a deleted source-linked artifact is exposed as missing, never silently dropped from an accepted decision', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Missing artifact',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  await fs.writeFile(path.join(root, 'design.md'), 'the design note\n');
  const { task: withDecision, record } = await acceptedDecision(root, task, 'Follow design.md', [
    { type: 'source', path: 'design.md' },
  ]);
  const beforeDelete = await buildContextBrief(root, { taskId: withDecision.id });
  assert.equal(beforeDelete.acceptedDecisions[0].links[0].status, 'current');
  assert.equal(beforeDelete.changeSinceLastRun.missingDependencyLinks.length, 0);

  await fs.rm(path.join(root, 'design.md'));
  const afterDelete = await buildContextBrief(root, { taskId: withDecision.id });
  assert.equal(afterDelete.acceptedDecisions[0].links[0].status, 'missing');
  const flagged = afterDelete.changeSinceLastRun.missingDependencyLinks.find(
    (item) => item.recordId === record.id,
  );
  // missingDependencyLinks is always populated regardless of the "since last run" comparison
  // result — it reflects current declared-link health, not history.
  assert.ok(
    flagged,
    'a missing declared source link must appear even with no prior dispatch bound',
  );
  assert.equal(flagged.status, 'missing');
});

test('a stale project-memory link is surfaced rather than treated as still-current context', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Stale memory link',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  const memory = await addProjectMemory(root, {
    title: 'Prior finding',
    text: 'The retry loop was already fixed once.',
    kind: 'discovery',
  });
  const { task: withDecision, record } = await acceptedDecision(root, task, 'Reuse the prior fix', [
    { type: 'memory', memoryId: memory.id, memoryRevision: memory.revision },
  ]);
  const fresh = await buildContextBrief(root, { taskId: withDecision.id });
  assert.equal(fresh.acceptedDecisions[0].links[0].status, 'current');

  await updateProjectMemory(root, memory.id, { text: 'Updated: the retry loop regressed again.' });
  const stale = await buildContextBrief(root, { taskId: withDecision.id });
  assert.equal(stale.acceptedDecisions[0].links[0].status, 'stale');
  assert.ok(
    stale.changeSinceLastRun.missingDependencyLinks.some(
      (item) => item.recordId === record.id && item.status === 'unknown',
    ) === false,
  );
});

test('assembleContextBrief keeps user intent, inferred advice, historical observations, and execution authorization visibly distinct', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Distinct sections',
    authorization: authorization('implement'),
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  const { task: accepted } = await acceptedDecision(root, task, 'User-approved decision');
  const inferred = await recordTaskRecord(root, {
    taskId: accepted.id,
    expectedRevision: accepted.revision,
    kind: 'assumption',
    text: 'Agent-inferred assumption, not yet confirmed',
    provenance: { kind: 'agent-inferred', reference: 'inferred from code' },
  });
  const withObservation = await recordTaskRecord(root, {
    taskId: accepted.id,
    expectedRevision: inferred.revision,
    kind: 'observation',
    text: 'The build succeeded once in the past',
    provenance: { kind: 'execution-observed', reference: 'ci run' },
  });
  const brief = await buildContextBrief(root, { taskId: withObservation.id });
  assert.equal(brief.acceptedDecisions.length, 1);
  assert.equal(brief.acceptedDecisions[0].provenance.kind, 'direct-user');
  assert.equal(brief.openAssumptions.length, 1);
  assert.equal(brief.openAssumptions[0].provenance.kind, 'agent-inferred');
  // Inferred, non-accepted material never appears mixed into accepted intent.
  assert.ok(!brief.acceptedDecisions.some((item) => item.provenance.kind === 'agent-inferred'));
  assert.equal(brief.historicalObservations.length, 1);
  assert.equal(brief.historicalObservations[0].kind, 'observation');
  // Execution authorization is its own section, never folded into decisions.
  assert.equal(brief.authorizations.length, 2); // the task's own + the decision acceptance.
  assert.ok(brief.authorizations.every((item) => typeof item.scope === 'string'));
});

test('assembleContextBrief never performs its own storage I/O beyond the optional resolveLinks callback', async (t) => {
  const now = () => new Date('2026-01-01T00:00:00.000Z');
  const task = {
    id: `task_${randomUUID()}`,
    title: 'In-memory task',
    state: 'planned',
    revision: 1,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    authorizationRequired: false,
    authorizations: [],
    owner: null,
    criteria: [
      {
        id: `criterion_${randomUUID()}`,
        revision: 1,
        description: 'Fixture works',
        required: true,
        approvalRequired: false,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      },
    ],
    runs: [],
    checkpoints: [],
    evidence: [],
    events: [],
    import: null,
    records: [],
  };
  const brief = await assembleContextBrief({
    task,
    workflow: null,
    source: { revision: null, dirtyFingerprint: null },
    byteBudget: 16 * 1024,
    clock: now,
  });
  assert.equal(brief.taskId, task.id);
  assert.equal(brief.workflow.exists, false);
  assert.equal(brief.generatedAt, now().toISOString());
});

test('CLI task context-preview renders text by default and the full JSON with --format json, on a Unicode project path', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'CLI preview',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  await acceptedDecision(root, task, 'CLI-visible decision');
  const text = (
    await execFileAsync(process.execPath, [
      cli,
      'task',
      'context-preview',
      '--project',
      root,
      '--task',
      task.id,
    ])
  ).stdout;
  assert.match(text, /Context brief for/);
  assert.match(text, /CLI-visible decision/);
  const json = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'task',
        'context-preview',
        '--project',
        root,
        '--task',
        task.id,
        '--format',
        'json',
      ])
    ).stdout,
  );
  assert.equal(json.taskId, task.id);
  assert.equal(json.acceptedDecisions[0].text, 'CLI-visible decision');
});

test('CLI task context-preview rejects an invalid --format or --byte-budget before building anything', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'CLI validation',
    authorizationRequired: false,
    criteria: [],
  });
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      'task',
      'context-preview',
      '--project',
      root,
      '--task',
      task.id,
      '--format',
      'yaml',
    ]),
    /--format must be text or json/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      'task',
      'context-preview',
      '--project',
      root,
      '--task',
      task.id,
      '--byte-budget',
      '0',
    ]),
    /--byte-budget must be a positive integer/,
  );
});

test('latchkit workflow context requires an actual workflow and never launches a provider or a controller', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'No workflow yet',
    authorizationRequired: false,
    criteria: [],
  });
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      'workflow',
      'context',
      '--project',
      root,
      '--task',
      task.id,
    ]),
    /WORKFLOW_NOT_FOUND|Workflow was not found/,
  );
});

test('an ordinary task with no enhanced workflow or enrollment keeps working unchanged, and gains only a read-only preview', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'Ordinary task never touched by this feature',
    authorizationRequired: false,
    criteria: [{ description: 'Works', required: true, approvalRequired: false }],
  });
  const resumed = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
  await recordEvidence(root, {
    taskId: task.id,
    expectedRevision: resumed.revision,
    runId: resumed.owner.runId,
    criterionId: task.criteria[0].id,
    criterionRevision: task.criteria[0].revision,
    outcome: 'passed',
  });
  const inspected = await inspectTask(root, task.id);
  assert.equal(inspected.reconciliation.verifiable, false); // task.state is still 'running'.
  const brief = await buildContextBrief(root, { taskId: task.id });
  assert.equal(brief.nextAction.kind, 'ordinary-task');
  assert.equal(brief.changeSinceLastRun.available, false);
  // A preview never mutates the ordinary task; its revision and evidence are untouched.
  const stillThere = await inspectTask(root, task.id);
  assert.equal(stillThere.task.revision, inspected.task.revision);
  assert.equal(stillThere.task.evidence.length, 1);
});
