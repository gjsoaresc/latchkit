import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createProviderAdapter } from '../dist/src/providers/contracts.js';
import { createTask, inspectTask } from '../dist/src/task-state/service.js';
import { createTaskController, readTaskSessions } from '../dist/src/runtime/task-controller.js';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

const evidence = (state = 'supported') => ({
  state,
  reason: 'fixture capability',
  versionRange: '*',
  evidenceUrl: '',
});

function fixtureAdapter(plans) {
  const contract = {
    schemaVersion: 1,
    id: 'fixture',
    label: 'Fixture',
    command: process.execPath,
    skillDirectory: '.agents/skills',
    capabilities: {
      skills: evidence(),
      invocation: evidence(),
      compaction: evidence('unknown'),
      resume: evidence(),
      cancellation: evidence(),
      usage: evidence('unknown'),
      hooks: {},
      decisions: { blocking: evidence('unknown'), advisory: evidence() },
    },
    verification: {
      installed: 'verified',
      authenticated: 'unknown',
      configured: 'unverified',
      endToEnd: 'unverified',
    },
  };
  return createProviderAdapter(contract, {
    inspect() {},
    planInstall() {},
    planSkillExport() {},
    planRuleExport() {},
    planInvocation: (options) => {
      plans.push(options);
      return { executable: process.execPath, args: ['--version'], cwd: options.cwd };
    },
    planResume: (options) => {
      plans.push(options);
      return { executable: process.execPath, args: ['--version'], cwd: options.cwd };
    },
    translateLifecycleInput() {},
    translateLifecycleOutput() {},
    planUsage() {},
  });
}

async function gitFixture(t) {
  // Canonicalize so expectations match the paths Git reports (8.3 temp names on CI runners).
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-controller-workspace-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Latchkit test']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  const task = await createTask(root, {
    title: 'Fixture task',
    authorization: { source: 'user', scope: 'run fixture', reference: 'test request' },
    criteria: [{ description: 'required result' }],
  });
  return { root, task };
}

async function nonGitFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-controller-nogit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const task = await createTask(root, {
    title: 'Fixture task',
    authorization: { source: 'user', scope: 'run fixture', reference: 'test request' },
    criteria: [{ description: 'required result' }],
  });
  return { root, task };
}

async function setPreference(root, workspace) {
  await fs.mkdir(path.join(root, '.latchkit'), { recursive: true });
  await fs.writeFile(path.join(root, '.latchkit', 'config.json'), JSON.stringify({ workspace }));
}

const launch = async () => ({ status: 'exited', exitCode: 0, stdout: '', stderr: '' });

test('a project preference of "ask" with no explicit choice starts nothing', async (t) => {
  const { root, task } = await gitFixture(t);
  await setPreference(root, { executionPreference: 'ask', worktreeRoot: '.latchkit/worktrees' });
  const plans = [];
  const controller = createTaskController({
    root,
    adapters: new Map([['fixture', fixtureAdapter(plans)]]),
    launch,
  });
  await assert.rejects(
    controller.start({ taskId: task.id, providerId: 'fixture', executionAuthorized: true }),
    (error) => error.code === 'WORKSPACE_CHOICE_REQUIRED',
  );
  assert.equal(plans.length, 0, 'the provider must never be planned for an undecided choice');
  assert.deepEqual(await readTaskSessions(root), []);
  const state = await inspectTask(root, task.id);
  assert.notEqual(state.task.state, 'running');
});

test('an explicit per-task override resolves "ask" and starts directly', async (t) => {
  const { root, task } = await gitFixture(t);
  await setPreference(root, { executionPreference: 'ask', worktreeRoot: '.latchkit/worktrees' });
  const plans = [];
  const controller = createTaskController({
    root,
    adapters: new Map([['fixture', fixtureAdapter(plans)]]),
    launch,
  });
  await controller.start({
    taskId: task.id,
    providerId: 'fixture',
    executionAuthorized: true,
    workspaceChoice: 'direct',
  });
  assert.equal(plans[0].cwd, root);
});

test('"always-worktree" isolates a new task without asking, and "direct" never creates one', async (t) => {
  const { root: worktreeRoot, task: worktreeTask } = await gitFixture(t);
  await setPreference(worktreeRoot, {
    executionPreference: 'always-worktree',
    worktreeRoot: '.latchkit/worktrees',
  });
  const worktreePlans = [];
  await createTaskController({
    root: worktreeRoot,
    adapters: new Map([['fixture', fixtureAdapter(worktreePlans)]]),
    launch,
  }).start({ taskId: worktreeTask.id, providerId: 'fixture', executionAuthorized: true });
  assert.notEqual(worktreePlans[0].cwd, worktreeRoot);
  assert.ok(
    worktreePlans[0].cwd.startsWith(path.join(worktreeRoot, '.latchkit', 'worktrees')),
    'an isolated task runs inside the configured worktree root',
  );
  const session = (await readTaskSessions(worktreeRoot))[0];
  assert.equal(session.workspace.mode, 'isolated');
  assert.equal(session.workspace.path, worktreePlans[0].cwd);

  const { root: directRoot, task: directTask } = await gitFixture(t);
  await setPreference(directRoot, {
    executionPreference: 'direct',
    worktreeRoot: '.latchkit/worktrees',
  });
  const directPlans = [];
  await createTaskController({
    root: directRoot,
    adapters: new Map([['fixture', fixtureAdapter(directPlans)]]),
    launch,
  }).start({ taskId: directTask.id, providerId: 'fixture', executionAuthorized: true });
  assert.equal(directPlans[0].cwd, directRoot);
  const directSession = (await readTaskSessions(directRoot))[0];
  assert.equal(directSession.workspace.mode, 'direct');
  assert.equal(
    await fs
      .stat(path.join(directRoot, '.latchkit', 'worktrees'))
      .then(() => true)
      .catch(() => false),
    false,
    'direct mode never creates a worktree',
  );
});

test("a project without a persisted preference keeps today's only behavior: direct, in the project", async (t) => {
  const { root, task } = await gitFixture(t);
  const plans = [];
  await createTaskController({
    root,
    adapters: new Map([['fixture', fixtureAdapter(plans)]]),
    launch,
  }).start({ taskId: task.id, providerId: 'fixture', executionAuthorized: true });
  assert.equal(plans[0].cwd, root);
});

test('worktree isolation reports Git unavailability rather than silently running directly', async (t) => {
  const { root, task } = await nonGitFixture(t);
  const plans = [];
  const controller = createTaskController({
    root,
    adapters: new Map([['fixture', fixtureAdapter(plans)]]),
    launch,
  });
  await assert.rejects(
    controller.start({
      taskId: task.id,
      providerId: 'fixture',
      executionAuthorized: true,
      workspaceChoice: 'worktree',
    }),
    (error) => error.code === 'WORKSPACE_UNAVAILABLE',
  );
  assert.equal(plans.length, 0);
});

test('resuming a task reuses its recorded workspace even after the project default changes', async (t) => {
  const { root, task } = await gitFixture(t);
  const plans = [];
  const controller = createTaskController({
    root,
    adapters: new Map([['fixture', fixtureAdapter(plans)]]),
    launch: async () => ({
      status: 'exited',
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: 'resumable-session',
    }),
  });
  await controller.start({
    taskId: task.id,
    providerId: 'fixture',
    executionAuthorized: true,
    workspaceChoice: 'worktree',
  });
  const isolatedCwd = plans[0].cwd;
  assert.notEqual(isolatedCwd, root);
  const [session] = await readTaskSessions(root);
  // Changing the default afterward must not move the already-started task's
  // workspace, and resuming it must not re-ask or re-decide.
  await setPreference(root, { executionPreference: 'direct', worktreeRoot: '.latchkit/worktrees' });
  await controller.resume({
    taskId: task.id,
    sessionId: session.id,
    providerId: 'fixture',
    executionAuthorized: true,
  });
  assert.equal(plans[1].cwd, isolatedCwd);
});
