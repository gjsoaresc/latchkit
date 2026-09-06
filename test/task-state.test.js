import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  authorizeTask,
  cancelTask,
  checkpointTask,
  completeTask,
  createTask,
  importMarkdownTask,
  inspectTask,
  migrateLegacyPlan,
  migrateTaskState,
  recordEvidence,
  registerEnhancedWorkflow,
  resolveCollisionSafePlanPath,
  resumeTask,
  reviseCriteria,
  slugifyPlanTitle,
  setVerificationMode,
  TASK_STATE_SCHEMA_VERSION,
  verifyTask,
} from '../dist/src/task-state/service.js';
import { readTaskState, TASK_STATE_PATH } from '../dist/src/task-state/store.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const crashHelper = path.join(repositoryRoot, 'scripts', 'test-helpers', 'crash-task-state.js');
const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');
const execFileAsync = promisify(execFile);
const eventId = () => `event_${randomUUID()}`;

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-task-state-'));
  const root = path.join(base, 'project with spaces é');
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

async function runningTask(root, criteria = [{ description: 'required check' }]) {
  const created = await createTask(root, {
    title: 'Persist workflow',
    authorization: authorization(),
    criteria,
  });
  return resumeTask(root, { taskId: created.id, expectedRevision: created.revision });
}

async function killAtBoundary(root, task, boundary, mutationId = eventId()) {
  const child = fork(
    crashHelper,
    [root, task.id, task.owner.runId, String(task.revision), mutationId, boundary],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Child exited before ${boundary} (${code}).`)));
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  return mutationId;
}

test('atomic termination recovery keeps the last checkpoint and retry never duplicates a committed event', async (t) => {
  const root = await fixture(t);
  let task = await runningTask(root);

  const preparedId = await killAtBoundary(root, task, 'prepared');
  let persisted = (await readTaskState(root)).tasks[0];
  assert.equal(persisted.revision, task.revision);
  assert.equal(persisted.checkpoints.length, 0);
  task = await checkpointTask(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
    mutationId: preparedId,
    summary: 'checkpoint at prepared',
  });
  assert.equal(task.checkpoints.length, 1);

  const committedId = await killAtBoundary(root, task, 'committed');
  persisted = (await readTaskState(root)).tasks[0];
  assert.equal(persisted.checkpoints.length, 2);
  const revision = persisted.revision;
  const retried = await checkpointTask(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
    mutationId: committedId,
    summary: 'checkpoint at committed',
  });
  assert.equal(retried.revision, revision);
  assert.equal(retried.checkpoints.length, 2);
  assert.equal(retried.events.filter((event) => event.id === committedId).length, 1);
  assert.deepEqual(
    (await fs.readdir(path.join(root, '.latchkit', 'tasks'))).filter((name) =>
      name.endsWith('.tmp'),
    ),
    [],
  );
});

test('two writers serialize and the stale revision loses without duplicating state', async (t) => {
  const root = await fixture(t);
  const task = await runningTask(root);
  const request = (summary) =>
    checkpointTask(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
      mutationId: eventId(),
      summary,
    });
  const results = await Promise.allSettled([request('writer one'), request('writer two')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'TASK_REVISION_CONFLICT');
  const persisted = (await readTaskState(root)).tasks[0];
  assert.equal(persisted.checkpoints.length, 1);
});

test('cancellation wins against a queued late completion and a cancelled task cannot be resurrected', async (t) => {
  const root = await fixture(t);
  const task = await runningTask(root);
  let release;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  let prepared;
  const atPrepared = new Promise((resolve) => {
    prepared = resolve;
  });
  const cancelling = cancelTask(
    root,
    {
      taskId: task.id,
      expectedRevision: task.revision,
      mutationId: eventId(),
      reason: 'user stopped work',
    },
    {
      faultBoundary: async (boundary) => {
        if (boundary === 'prepared') {
          prepared();
          await paused;
        }
      },
    },
  );
  await atPrepared;
  const lateCompletion = completeTask(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
    mutationId: eventId(),
  });
  release();
  const cancelled = await cancelling;
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(lateCompletion, { code: 'TASK_REVISION_CONFLICT' });
  await assert.rejects(
    completeTask(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: cancelled.revision,
    }),
    { code: 'TASK_OWNERSHIP_CONFLICT' },
  );
  assert.equal((await readTaskState(root)).tasks[0].state, 'cancelled');
});

test('changed source and revised criteria make formerly passing evidence stale', async (t) => {
  const root = await fixture(t);
  let task = await runningTask(root);
  const criterion = task.criteria[0];
  task = await recordEvidence(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
    criterionId: criterion.id,
    criterionRevision: criterion.revision,
    outcome: 'passed',
    command: 'node --test',
    artifact: 'tap output',
  });
  task = await completeTask(root, {
    taskId: task.id,
    runId: task.runs[0].id,
    expectedRevision: task.revision,
  });
  await fs.writeFile(path.join(root, 'source.txt'), 'changed\n');
  await assert.rejects(
    verifyTask(root, { taskId: task.id, expectedRevision: task.revision }),
    (error) => {
      assert.equal(error.code, 'TASK_NOT_VERIFIABLE');
      assert.equal(error.failures[0].reason, 'missing-current-evidence');
      return true;
    },
  );

  await fs.writeFile(path.join(root, 'source.txt'), 'initial\n');
  task = await reviseCriteria(root, {
    taskId: task.id,
    expectedRevision: task.revision,
    criteria: [{ ...criterion, description: 'revised required check' }],
  });
  assert.equal(task.criteria[0].revision, 2);
  task = await resumeTask(
    root,
    { taskId: task.id, expectedRevision: task.revision },
    { processProbe: () => false },
  );
  task = await completeTask(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
  });
  await assert.rejects(verifyTask(root, { taskId: task.id, expectedRevision: task.revision }), {
    code: 'TASK_NOT_VERIFIABLE',
  });
});

for (const outcome of ['missing', 'failed', 'skipped', 'unsupported']) {
  test(`${outcome} required evidence cannot verify`, async (t) => {
    const root = await fixture(t);
    let task = await runningTask(root);
    const criterion = task.criteria[0];
    task = await recordEvidence(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
      criterionId: criterion.id,
      criterionRevision: criterion.revision,
      outcome,
    });
    task = await completeTask(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
    });
    await assert.rejects(
      verifyTask(root, { taskId: task.id, expectedRevision: task.revision }),
      (error) => {
        assert.equal(error.code, 'TASK_NOT_VERIFIABLE');
        assert.equal(error.failures[0].reason, `outcome-${outcome}`);
        return true;
      },
    );
  });
}

test('approval requirements survive restart and only direct user approval evidence satisfies them', async (t) => {
  const root = await fixture(t);
  let task = await runningTask(root, [
    { description: 'maintainer approves release', approvalRequired: true },
  ]);
  const criterion = task.criteria[0];
  const inspected = await inspectTask(root, task.id);
  assert.equal(inspected.task.criteria[0].approvalRequired, true);
  await assert.rejects(
    recordEvidence(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
      criterionId: criterion.id,
      criterionRevision: 1,
      outcome: 'passed',
      kind: 'check',
    }),
    { code: 'TASK_AUTHORIZATION_REQUIRED' },
  );
  await assert.rejects(
    recordEvidence(root, {
      taskId: task.id,
      runId: task.owner.runId,
      expectedRevision: task.revision,
      criterionId: criterion.id,
      criterionRevision: 1,
      outcome: 'passed',
      kind: 'approval',
      authorization: { source: 'repository', scope: 'release', reference: 'README' },
    }),
    { code: 'TASK_AUTHORIZATION_INVALID' },
  );
  task = await recordEvidence(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
    criterionId: criterion.id,
    criterionRevision: 1,
    outcome: 'passed',
    kind: 'approval',
    authorization: authorization('approve this release'),
  });
  task = await completeTask(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
  });
  task = await verifyTask(root, { taskId: task.id, expectedRevision: task.revision });
  assert.equal(task.state, 'verified');
});

test('resume reconciles missing processes as interrupted and never as success', async (t) => {
  const root = await fixture(t);
  let task = await runningTask(root);
  const previousRun = task.owner.runId;
  task = await resumeTask(
    root,
    { taskId: task.id, expectedRevision: task.revision },
    { processProbe: () => false },
  );
  assert.equal(task.runs.find((run) => run.id === previousRun).state, 'interrupted');
  assert.equal(task.runs.at(-1).state, 'running');
  assert.equal(task.state, 'running');
  await assert.rejects(
    resumeTask(
      root,
      { taskId: task.id, expectedRevision: task.revision },
      { processProbe: () => true },
    ),
    { code: 'TASK_RUN_ACTIVE' },
  );
});

test('Markdown import preserves the note, records provenance, and cannot invent authorization', async (t) => {
  const root = await fixture(t);
  const noteDirectory = path.join(root, '.latchkit', 'notes');
  const notePath = path.join(noteDirectory, 'legacy handoff.md');
  await fs.mkdir(noteDirectory, { recursive: true });
  await fs.writeFile(notePath, '# Historical approval claim\n');
  const before = await fs.readFile(notePath, 'utf8');
  const task = await importMarkdownTask(root, {
    notePath: '.latchkit/notes/legacy handoff.md',
    title: 'Legacy handoff',
  });
  assert.equal(task.state, 'awaiting-decision');
  assert.equal(task.authorizations.length, 0);
  assert.equal(task.import.path, '.latchkit/notes/legacy handoff.md');
  await assert.rejects(resumeTask(root, { taskId: task.id, expectedRevision: task.revision }), {
    code: 'TASK_AUTHORIZATION_REQUIRED',
  });
  assert.equal(await fs.readFile(notePath, 'utf8'), before);

  const authorized = await authorizeTask(root, {
    taskId: task.id,
    expectedRevision: task.revision,
    authorization: authorization('resume imported task'),
  });
  assert.equal(authorized.state, 'planned');
});

test('enhanced workflow registration is atomic, explicit, and revision-bound', async (t) => {
  const root = await fixture(t);
  const notes = path.join(root, '.latchkit', 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(path.join(notes, 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(notes, 'plan.md'), '# Plan\n');
  const created = await createTask(root, {
    title: 'Enhanced task',
    authorization: authorization(),
    criteria: [{ description: 'first result' }, { description: 'second result', required: false }],
  });
  const before = JSON.stringify(await readTaskState(root));
  await assert.rejects(
    registerEnhancedWorkflow(root, {
      taskId: created.id,
      expectedRevision: created.revision,
      artifacts: {
        prd: { path: '.latchkit/notes/prd.md', templateVersion: 1 },
        technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
      },
      checks: [{ id: 'wrong', criterionId: `criterion_${randomUUID()}`, type: 'cli' }],
    }),
    { code: 'TASK_ENHANCED_WORKFLOW_INVALID' },
  );
  assert.equal(JSON.stringify(await readTaskState(root)), before);

  const registered = await registerEnhancedWorkflow(root, {
    taskId: created.id,
    expectedRevision: created.revision,
    artifacts: {
      prd: { path: '.latchkit/notes/prd.md', templateVersion: 1 },
      technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
    },
    checks: [{ id: 'first-cli', criterionId: created.criteria[0].id, type: 'cli' }],
  });
  assert.equal(registered.enhancedWorkflow.schemaVersion, 1);
  assert.equal(registered.enhancedWorkflow.revision, 1);
  assert.equal(registered.enhancedWorkflow.checks[0].id, 'first-cli');
  assert.match(registered.enhancedWorkflow.artifacts.prd.sha256, /^[a-f0-9]{64}$/);
  assert.equal(registered.criteria.length, 2);
  await assert.rejects(
    registerEnhancedWorkflow(root, {
      taskId: created.id,
      expectedRevision: created.revision,
      artifacts: {
        prd: { path: '.latchkit/notes/prd.md', templateVersion: 1 },
        technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
      },
      checks: [{ id: 'first-cli', criterionId: created.criteria[0].id, type: 'cli' }],
    }),
    { code: 'TASK_REVISION_CONFLICT' },
  );

  const empty = await createTask(root, {
    title: 'Atomic criteria registration',
    authorization: authorization(),
    criteria: [],
  });
  const criterionId = `criterion_${randomUUID()}`;
  const withCriteria = await registerEnhancedWorkflow(root, {
    taskId: empty.id,
    expectedRevision: empty.revision,
    criteria: [{ id: criterionId, description: 'registered with metadata' }],
    artifacts: {
      prd: { path: '.latchkit/notes/prd.md', templateVersion: 1 },
      technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
    },
    checks: [{ id: 'atomic', criterionId, type: 'cli' }],
  });
  assert.equal(withCriteria.criteria[0].id, criterionId);
  assert.equal(withCriteria.enhancedWorkflow.checks[0].criterionId, criterionId);
});

test('enhanced verification requires every mapped check while ordinary empty tasks stay compatible', async (t) => {
  const root = await fixture(t);
  const notes = path.join(root, '.latchkit', 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(path.join(notes, 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(notes, 'plan.md'), '# Plan\n');
  let task = await createTask(root, {
    title: 'Enhanced verification',
    authorization: authorization(),
    criteria: [{ description: 'observable result' }],
  });
  task = await registerEnhancedWorkflow(root, {
    taskId: task.id,
    expectedRevision: task.revision,
    artifacts: {
      prd: { path: '.latchkit/notes/prd.md', templateVersion: 1 },
      technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
    },
    checks: [
      { id: 'focused', criterionId: task.criteria[0].id, type: 'cli' },
      { id: 'final', criterionId: task.criteria[0].id, type: 'cli' },
    ],
  });
  task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
  task = await recordEvidence(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
    criterionId: task.criteria[0].id,
    criterionRevision: task.criteria[0].revision,
    outcome: 'passed',
    kind: 'enhanced-check:focused',
  });
  task = await completeTask(root, {
    taskId: task.id,
    runId: task.owner.runId,
    expectedRevision: task.revision,
  });
  await assert.rejects(
    verifyTask(root, { taskId: task.id, expectedRevision: task.revision }),
    (error) => {
      assert.equal(error.code, 'TASK_NOT_VERIFIABLE');
      assert.deepEqual(error.failures, [
        { criterionId: task.criteria[0].id, reason: 'missing-check:final' },
      ]);
      return true;
    },
  );

  let ordinary = await createTask(root, {
    title: 'Ordinary empty task',
    authorization: authorization(),
    criteria: [],
  });
  ordinary = await resumeTask(root, {
    taskId: ordinary.id,
    expectedRevision: ordinary.revision,
  });
  ordinary = await completeTask(root, {
    taskId: ordinary.id,
    runId: ordinary.owner.runId,
    expectedRevision: ordinary.revision,
  });
  ordinary = await verifyTask(root, {
    taskId: ordinary.id,
    expectedRevision: ordinary.revision,
  });
  assert.equal(ordinary.state, 'verified');
});

test('task-state v1 reads without mutation and migrates explicitly with an exact backup', async (t) => {
  const root = await fixture(t);
  const created = await createTask(root, {
    title: 'Legacy task',
    authorization: authorization(),
    criteria: [{ description: 'legacy result' }],
  });
  const file = path.join(root, TASK_STATE_PATH);
  const current = JSON.parse(await fs.readFile(file, 'utf8'));
  current.schemaVersion = 1;
  for (const task of current.tasks) {
    delete task.enhancedWorkflow;
    delete task.verificationMode;
  }
  const legacy = `${JSON.stringify(current, null, 2)}\n`;
  await fs.writeFile(file, legacy);
  assert.equal((await readTaskState(root)).schemaVersion, 1);
  assert.equal(await fs.readFile(file, 'utf8'), legacy);

  const added = await createTask(root, {
    title: 'Still ordinary on v1',
    authorization: authorization(),
    criteria: [],
  });
  assert.equal(Object.hasOwn(added, 'enhancedWorkflow'), false);
  assert.equal(Object.hasOwn(added, 'verificationMode'), false);
  assert.equal((await readTaskState(root)).schemaVersion, 1);
  const legacyAfterMutation = await fs.readFile(file, 'utf8');

  const preview = await migrateTaskState(root, { dryRun: true });
  assert.equal(preview.action, 'migrate');
  assert.equal(await fs.readFile(file, 'utf8'), legacyAfterMutation);
  await assert.rejects(
    migrateTaskState(root, {
      faultBoundary: async (boundary) => {
        if (boundary === 'prepared') throw new Error('injected task migration failure');
      },
    }),
    /injected task migration failure/,
  );
  assert.equal((await readTaskState(root)).schemaVersion, 1);
  assert.equal(await fs.readFile(file, 'utf8'), legacyAfterMutation);
  assert.equal(await fs.readFile(path.join(root, preview.backup), 'utf8'), legacyAfterMutation);
  const migrated = await migrateTaskState(root);
  assert.equal(migrated.action, 'migrated');
  assert.equal(migrated.fromVersion, 1);
  assert.equal(migrated.toVersion, TASK_STATE_SCHEMA_VERSION);
  assert.equal((await readTaskState(root)).schemaVersion, TASK_STATE_SCHEMA_VERSION);
  assert.equal((await readTaskState(root)).tasks[0].enhancedWorkflow, null);
  assert.equal((await readTaskState(root)).tasks[0].verificationMode, 'standard');
  assert.equal(await fs.readFile(path.join(root, migrated.backup), 'utf8'), legacyAfterMutation);
  assert.equal((await inspectTask(root, created.id)).task.enhancedWorkflow, null);
  assert.equal((await inspectTask(root, created.id)).task.verificationMode, 'standard');

  const repeated = await migrateTaskState(root);
  assert.equal(repeated.action, 'current');
  assert.equal(repeated.fromVersion, TASK_STATE_SCHEMA_VERSION);
  assert.equal(repeated.toVersion, TASK_STATE_SCHEMA_VERSION);

  const changed = await setVerificationMode(root, {
    taskId: created.id,
    expectedRevision: (await inspectTask(root, created.id)).task.revision,
    verificationMode: 'fast',
  });
  assert.equal(changed.verificationMode, 'fast');
  const resumed = await resumeTask(root, {
    taskId: created.id,
    expectedRevision: changed.revision,
  });
  assert.equal(resumed.verificationMode, 'fast', 'resume must preserve the task-owned mode');
});

test('CLI registers and inspects an enhanced specification document', async (t) => {
  const root = await fixture(t);
  const notes = path.join(root, '.latchkit', 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(path.join(notes, 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(notes, 'plan.md'), '# Plan\n');
  const task = await createTask(root, {
    title: 'CLI enhanced task',
    authorization: authorization(),
    criteria: [{ description: 'CLI result' }],
  });
  const input = path.join(root, 'enhanced.json');
  await fs.writeFile(
    input,
    JSON.stringify({
      artifacts: {
        prd: { path: '.latchkit/notes/prd.md', templateVersion: 1 },
        technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
      },
      checks: [{ id: 'cli-result', criterionId: task.criteria[0].id, type: 'cli' }],
    }),
  );
  const registered = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'spec',
        'register',
        '--project',
        root,
        '--task',
        task.id,
        '--expected-revision',
        String(task.revision),
        '--file',
        input,
      ])
    ).stdout,
  );
  assert.equal(registered.enhancedWorkflow.checks[0].id, 'cli-result');
  const inspected = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'spec',
        'inspect',
        '--project',
        root,
        '--task',
        task.id,
      ])
    ).stdout,
  );
  assert.equal(inspected.artifacts.prd.path, '.latchkit/notes/prd.md');
});

test('CLI inspect, resume, and cancel operate on a Unicode project path', async (t) => {
  const root = await fixture(t);
  const task = await createTask(root, {
    title: 'CLI task',
    authorization: authorization(),
    criteria: [],
  });
  const inspected = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'task',
        'inspect',
        '--project',
        root,
        '--task',
        task.id,
      ])
    ).stdout,
  );
  assert.equal(inspected.task.id, task.id);
  const resumed = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'task',
        'resume',
        '--project',
        root,
        '--task',
        task.id,
        '--expected-revision',
        String(task.revision),
      ])
    ).stdout,
  );
  assert.equal(resumed.state, 'running');
  const cancelled = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'task',
        'cancel',
        '--project',
        root,
        '--task',
        task.id,
        '--expected-revision',
        String(resumed.revision),
      ])
    ).stdout,
  );
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await readTaskState(root)).tasks[0].state, 'cancelled');
  assert.equal(TASK_STATE_PATH, '.latchkit/tasks/state-v1.json');
});

test('enhanced workflow registration and Markdown import accept durable plans under docs/plans and continue to accept the legacy notes location', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.mkdir(path.join(root, '.latchkit', 'notes'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'plans', 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(root, '.latchkit', 'notes', 'plan.md'), '# Plan\n');
  const created = await createTask(root, {
    title: 'Durable plan task',
    authorization: authorization(),
    criteria: [{ description: 'observable result' }],
  });
  const registered = await registerEnhancedWorkflow(root, {
    taskId: created.id,
    expectedRevision: created.revision,
    artifacts: {
      prd: { path: 'docs/plans/prd.md', templateVersion: 1 },
      technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
    },
    checks: [{ id: 'mixed-location', criterionId: created.criteria[0].id, type: 'cli' }],
  });
  assert.equal(registered.enhancedWorkflow.artifacts.prd.path, 'docs/plans/prd.md');
  assert.equal(registered.enhancedWorkflow.artifacts.technicalPlan.path, '.latchkit/notes/plan.md');

  await fs.writeFile(path.join(root, 'docs', 'plans', 'imported-plan.md'), '# Imported\n');
  const imported = await importMarkdownTask(root, {
    notePath: 'docs/plans/imported-plan.md',
    title: 'Imported durable plan',
  });
  assert.equal(imported.import.path, 'docs/plans/imported-plan.md');
});

test('enhanced workflow registration and Markdown import reject a plan outside docs/plans and the legacy notes location', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'docs', 'other'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'other', 'prd.md'), '# PRD\n');
  await fs.writeFile(path.join(root, 'docs', 'other', 'plan.md'), '# Plan\n');
  const created = await createTask(root, {
    title: 'Rejected plan location task',
    authorization: authorization(),
    criteria: [{ description: 'observable result' }],
  });
  await assert.rejects(
    registerEnhancedWorkflow(root, {
      taskId: created.id,
      expectedRevision: created.revision,
      artifacts: {
        prd: { path: 'docs/other/prd.md', templateVersion: 1 },
        technicalPlan: { path: 'docs/other/plan.md', templateVersion: 1 },
      },
      checks: [{ id: 'rejected', criterionId: created.criteria[0].id, type: 'cli' }],
    }),
    { code: 'TASK_ENHANCED_WORKFLOW_INVALID' },
  );
  await assert.rejects(
    importMarkdownTask(root, { notePath: 'docs/other/prd.md', title: 'Rejected import' }),
    { code: 'TASK_IMPORT_INVALID' },
  );
});

test('collision-safe plan paths are readable, portable, and never reuse an existing filename, on a Windows path with spaces and Unicode', async (t) => {
  const root = await fixture(t);
  assert.match(root, /project with spaces é/);

  assert.equal(slugifyPlanTitle(''), 'plan');
  assert.equal(slugifyPlanTitle('   ---   '), 'plan');
  assert.equal(slugifyPlanTitle('Café résumé Plan!'), 'cafe-resume-plan');

  const first = await resolveCollisionSafePlanPath(root, 'Café résumé Plan!');
  assert.equal(first, 'docs/plans/cafe-resume-plan.md');
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(root, first), '# Existing\n');

  const second = await resolveCollisionSafePlanPath(root, 'Café résumé Plan!');
  assert.equal(second, 'docs/plans/cafe-resume-plan-2.md');
  await fs.writeFile(path.join(root, second), '# Existing 2\n');

  const third = await resolveCollisionSafePlanPath(root, 'Café résumé Plan!');
  assert.equal(third, 'docs/plans/cafe-resume-plan-3.md');
});

test('legacy plan migration preserves the original, is explicit and idempotent, and never overwrites a conflicting file', async (t) => {
  const root = await fixture(t);
  const notes = path.join(root, '.latchkit', 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(path.join(notes, 'legacy-spec.md'), '# Legacy\n');

  const preview = await migrateLegacyPlan(root, {
    from: '.latchkit/notes/legacy-spec.md',
    dryRun: true,
  });
  assert.deepEqual(preview, {
    from: '.latchkit/notes/legacy-spec.md',
    to: 'docs/plans/legacy-spec.md',
    sha256: preview.sha256,
    action: 'migrated',
  });
  await assert.rejects(fs.access(path.join(root, 'docs', 'plans', 'legacy-spec.md')));

  const migrated = await migrateLegacyPlan(root, { from: '.latchkit/notes/legacy-spec.md' });
  assert.equal(migrated.action, 'migrated');
  assert.equal(migrated.to, 'docs/plans/legacy-spec.md');
  assert.equal(
    await fs.readFile(path.join(root, 'docs', 'plans', 'legacy-spec.md'), 'utf8'),
    '# Legacy\n',
  );
  assert.equal(await fs.readFile(path.join(notes, 'legacy-spec.md'), 'utf8'), '# Legacy\n');

  const repeated = await migrateLegacyPlan(root, { from: '.latchkit/notes/legacy-spec.md' });
  assert.equal(repeated.action, 'current');

  await fs.writeFile(path.join(notes, 'conflict.md'), '# Conflicting source\n');
  await fs.writeFile(
    path.join(root, 'docs', 'plans', 'conflict.md'),
    '# Unrelated existing plan\n',
  );
  await assert.rejects(migrateLegacyPlan(root, { from: '.latchkit/notes/conflict.md' }), {
    code: 'PLAN_MIGRATION_TARGET_CONFLICT',
  });
  assert.equal(
    await fs.readFile(path.join(notes, 'conflict.md'), 'utf8'),
    '# Conflicting source\n',
  );
  assert.equal(
    await fs.readFile(path.join(root, 'docs', 'plans', 'conflict.md'), 'utf8'),
    '# Unrelated existing plan\n',
  );

  await assert.rejects(migrateLegacyPlan(root, { from: '.latchkit/notes/missing.md' }), {
    code: 'PLAN_MIGRATION_SOURCE_MISSING',
  });
  await assert.rejects(migrateLegacyPlan(root, { from: 'docs/plans/legacy-spec.md' }), {
    code: 'PLAN_MIGRATION_INVALID',
  });
  await assert.rejects(
    migrateLegacyPlan(root, { from: '.latchkit/notes/legacy-spec.md', to: '.latchkit/notes/x.md' }),
    { code: 'PLAN_MIGRATION_INVALID' },
  );
});

test('CLI resolves a collision-safe plan path and migrates a legacy plan explicitly', async (t) => {
  const root = await fixture(t);
  const planPath = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'spec',
        'plan-path',
        '--project',
        root,
        '--title',
        'My New Feature',
      ])
    ).stdout,
  );
  assert.equal(planPath.path, 'docs/plans/my-new-feature.md');

  const notes = path.join(root, '.latchkit', 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(path.join(notes, 'cli-plan.md'), '# CLI plan\n');
  const migrated = JSON.parse(
    (
      await execFileAsync(process.execPath, [
        cli,
        'spec',
        'migrate-plan',
        '--project',
        root,
        '--from',
        '.latchkit/notes/cli-plan.md',
      ])
    ).stdout,
  );
  assert.equal(migrated.action, 'migrated');
  assert.equal(migrated.to, 'docs/plans/cli-plan.md');
  assert.equal(await fs.readFile(path.join(notes, 'cli-plan.md'), 'utf8'), '# CLI plan\n');
  assert.equal(
    await fs.readFile(path.join(root, 'docs', 'plans', 'cli-plan.md'), 'utf8'),
    '# CLI plan\n',
  );
});

test('editing a durable plan under docs/plans invalidates evidence like other tracked files, while the legacy notes location stays excluded', async (t) => {
  const withNewLocation = await fixture(t);
  await fs.mkdir(path.join(withNewLocation, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(path.join(withNewLocation, 'docs', 'plans', 'plan.md'), '# Plan v1\n');
  let newLocationTask = await runningTask(withNewLocation);
  const newLocationCriterion = newLocationTask.criteria[0];
  newLocationTask = await recordEvidence(withNewLocation, {
    taskId: newLocationTask.id,
    runId: newLocationTask.owner.runId,
    expectedRevision: newLocationTask.revision,
    criterionId: newLocationCriterion.id,
    criterionRevision: newLocationCriterion.revision,
    outcome: 'passed',
  });
  newLocationTask = await completeTask(withNewLocation, {
    taskId: newLocationTask.id,
    runId: newLocationTask.runs[0].id,
    expectedRevision: newLocationTask.revision,
  });
  // Editing the plan after evidence was recorded changes the working-tree source snapshot, so the
  // formerly passing evidence is no longer current for the same criterion revision.
  await fs.writeFile(path.join(withNewLocation, 'docs', 'plans', 'plan.md'), '# Plan v2\n');
  await assert.rejects(
    verifyTask(withNewLocation, {
      taskId: newLocationTask.id,
      expectedRevision: newLocationTask.revision,
    }),
    (error) => {
      assert.equal(error.code, 'TASK_NOT_VERIFIABLE');
      assert.equal(error.failures[0].reason, 'missing-current-evidence');
      return true;
    },
  );

  const legacy = await fixture(t);
  await fs.mkdir(path.join(legacy, '.latchkit', 'notes'), { recursive: true });
  await fs.writeFile(path.join(legacy, '.latchkit', 'notes', 'plan.md'), '# Plan v1\n');
  let legacyTask = await runningTask(legacy);
  const legacyCriterion = legacyTask.criteria[0];
  legacyTask = await recordEvidence(legacy, {
    taskId: legacyTask.id,
    runId: legacyTask.owner.runId,
    expectedRevision: legacyTask.revision,
    criterionId: legacyCriterion.id,
    criterionRevision: legacyCriterion.revision,
    outcome: 'passed',
  });
  legacyTask = await completeTask(legacy, {
    taskId: legacyTask.id,
    runId: legacyTask.runs[0].id,
    expectedRevision: legacyTask.revision,
  });
  // The legacy .latchkit/notes/ location is excluded from the source fingerprint, so editing a
  // plan stored there does not by itself invalidate otherwise-current evidence.
  await fs.writeFile(path.join(legacy, '.latchkit', 'notes', 'plan.md'), '# Plan v2\n');
  const verifiedLegacy = await verifyTask(legacy, {
    taskId: legacyTask.id,
    expectedRevision: legacyTask.revision,
  });
  assert.equal(verifiedLegacy.state, 'verified');
});
