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
  recordEvidence,
  resumeTask,
  reviseCriteria,
  verifyTask,
} from '../src/task-state/service.js';
import { readTaskState, TASK_STATE_PATH } from '../src/task-state/store.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const crashHelper = path.join(repositoryRoot, 'scripts', 'test-helpers', 'crash-task-state.js');
const cli = path.join(repositoryRoot, 'src', 'cli.js');
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
