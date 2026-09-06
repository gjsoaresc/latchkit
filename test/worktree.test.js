import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  cancelTaskWorkspace,
  cleanupTaskWorkspace,
  createReviewWorkspace,
  createTaskWorkspace,
  inspectWorkspaceCapability,
  WorkspaceError,
} from '../dist/src/workspaces/git.js';
import { createTask } from '../dist/src/task-state/service.js';

const execFileAsync = promisify(execFile);
const mutationId = () => `event_${randomUUID()}`;

async function git(root, args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit worktrees é '));
  const root = path.join(base, 'main project 東京');
  await fs.mkdir(root);
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Latchkit test']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function sourceSnapshot(root) {
  return {
    status: await git(root, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=matching',
    ]),
    tracked: await fs.readFile(path.join(root, 'tracked.txt')),
    staged: await fs.readFile(path.join(root, '.gitignore')),
    untracked: await fs.readFile(path.join(root, 'untracked.txt')),
    ignored: await fs.readFile(path.join(root, 'ignored.txt')),
  };
}

/** These fixtures never run `latchkit init`, so nothing has arranged a
 * `.gitignore` entry for the default in-project worktree root. Tests that
 * assert an exact, unaffected source `git status` explicitly opt an external
 * root instead — this is a scope choice for these specific isolation/snapshot
 * assertions, not a claim that the default root is always ignored. */
function externalWorktreeRoot(root) {
  return path.join(path.dirname(root), 'external-worktrees');
}

async function taskId(root) {
  return (
    await createTask(root, {
      title: 'Isolate task workspace',
      mutationId: mutationId(),
      authorization: {
        source: 'user',
        scope: 'test worktree isolation',
        reference: 'direct test request',
      },
    })
  ).id;
}

test('two task-owned worktrees are isolated and source dirty state is untouched', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'unstaged\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\nmore-ignored.txt\n');
  await git(root, ['add', '.gitignore']);
  await fs.writeFile(path.join(root, 'untracked.txt'), 'untracked\n');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored\n');
  const firstTask = await taskId(root);
  const secondTask = await taskId(root);
  const before = await sourceSnapshot(root);
  const worktreeRoot = externalWorktreeRoot(root);
  const first = await createTaskWorkspace(root, { taskId: firstTask, worktreeRoot });
  const second = await createTaskWorkspace(root, { taskId: secondTask, worktreeRoot });
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(first.path, second.path);
  assert.notEqual(first.branch, second.branch);
  await fs.writeFile(path.join(first.path, 'task-only.txt'), 'one\n');
  assert.equal(await fs.stat(path.join(second.path, 'task-only.txt')).catch(() => null), null);
  assert.deepEqual(await sourceSnapshot(root), before);
  assert.equal((await createTaskWorkspace(root, { taskId: first.taskId })).reconciled, true);
});

test('review worktree materializes the exact tracked and untracked source snapshot', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'unstaged implementation\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\nnew-ignore.txt\n');
  await git(root, ['add', '.gitignore']);
  await fs.writeFile(path.join(root, 'untracked.txt'), 'new implementation file\n');
  const reviewTaskId = await taskId(root);
  const before = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const workspace = await createReviewWorkspace(root, {
    taskId: reviewTaskId,
    worktreeRoot: externalWorktreeRoot(root),
  });
  assert.match(workspace.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    await fs.readFile(path.join(workspace.path, 'tracked.txt'), 'utf8'),
    'unstaged implementation\n',
  );
  assert.equal(
    await fs.readFile(path.join(workspace.path, '.gitignore'), 'utf8'),
    'ignored.txt\nnew-ignore.txt\n',
  );
  assert.equal(
    await fs.readFile(path.join(workspace.path, 'untracked.txt'), 'utf8'),
    'new implementation file\n',
  );
  assert.equal(await git(root, ['status', '--porcelain=v1', '--untracked-files=all']), before);
});

test('review snapshot removes files deleted from the source index', async (t) => {
  const root = await fixture(t);
  await git(root, ['rm', 'tracked.txt']);
  const workspace = await createReviewWorkspace(root, { taskId: await taskId(root) });
  assert.equal(await fs.lstat(path.join(workspace.path, 'tracked.txt')).catch(() => null), null);
});

test('review snapshot replaces a tracked symlink leaf without writing its referent', async (t) => {
  const root = await fixture(t);
  const outside = path.join(path.dirname(root), 'outside-leaf.txt');
  const redirect = path.join(root, 'redirect.txt');
  await fs.writeFile(outside, 'outside sentinel\n');
  try {
    await fs.symlink(outside, redirect, 'file');
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('symbolic links are unavailable');
    throw error;
  }
  await git(root, ['config', 'core.symlinks', 'true']);
  await git(root, ['add', 'redirect.txt']);
  await git(root, ['commit', '-m', 'tracked link']);
  await fs.rm(redirect);
  await fs.writeFile(redirect, 'implementation file\n');
  const workspace = await createReviewWorkspace(root, { taskId: await taskId(root) });
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside sentinel\n');
  assert.equal(
    await fs.readFile(path.join(workspace.path, 'redirect.txt'), 'utf8'),
    'implementation file\n',
  );
  assert.equal((await fs.lstat(path.join(workspace.path, 'redirect.txt'))).isSymbolicLink(), false);
});

test('review snapshot replaces a tracked symlink directory before copying descendants', async (t) => {
  const root = await fixture(t);
  const outside = path.join(path.dirname(root), 'outside-directory');
  const redirect = path.join(root, 'redirect-directory');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside sentinel\n');
  try {
    await fs.symlink(outside, redirect, 'dir');
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('symbolic links are unavailable');
    throw error;
  }
  await git(root, ['config', 'core.symlinks', 'true']);
  await git(root, ['add', 'redirect-directory']);
  await git(root, ['commit', '-m', 'tracked directory link']);
  await git(root, ['rm', 'redirect-directory']);
  await fs.mkdir(redirect);
  await fs.writeFile(path.join(redirect, 'implementation.txt'), 'implementation directory\n');
  const workspace = await createReviewWorkspace(root, { taskId: await taskId(root) });
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel\n');
  assert.equal(
    await fs.readFile(
      path.join(workspace.path, 'redirect-directory', 'implementation.txt'),
      'utf8',
    ),
    'implementation directory\n',
  );
  assert.equal(
    (await fs.lstat(path.join(workspace.path, 'redirect-directory'))).isSymbolicLink(),
    false,
  );
});

test('cancellation records a recovery location and preserves staged, untracked, and ignored task work', async (t) => {
  const root = await fixture(t);
  const workspace = await createTaskWorkspace(root, { taskId: await taskId(root) });
  await fs.writeFile(path.join(workspace.path, 'tracked.txt'), 'changed\n');
  await git(workspace.path, ['add', 'tracked.txt']);
  await fs.writeFile(path.join(workspace.path, 'untracked.txt'), 'keep\n');
  await fs.writeFile(path.join(workspace.path, 'ignored.txt'), 'keep\n');
  const cancelled = await cancelTaskWorkspace(root, { taskId: workspace.taskId });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.dirty, true);
  assert.match(cancelled.recoveryCommand, /git -C/);
  assert.equal(await fs.readFile(path.join(workspace.path, 'untracked.txt'), 'utf8'), 'keep\n');
  await assert.rejects(
    cleanupTaskWorkspace(root, { taskId: workspace.taskId, authorized: true }),
    (error) => error instanceof WorkspaceError && error.code === 'WORKSPACE_DIRTY',
  );
});

test('cleanup needs explicit authorization, rejects branch mismatch, and retains the branch', async (t) => {
  const root = await fixture(t);
  const workspace = await createTaskWorkspace(root, { taskId: await taskId(root) });
  await assert.rejects(
    cleanupTaskWorkspace(root, { taskId: workspace.taskId }),
    (error) => error.code === 'WORKSPACE_CLEANUP_UNAUTHORIZED',
  );
  await git(workspace.path, ['checkout', '--detach']);
  await assert.rejects(
    cleanupTaskWorkspace(root, { taskId: workspace.taskId, authorized: true }),
    (error) => error.code === 'WORKSPACE_BRANCH_MISMATCH',
  );
  await git(workspace.path, ['checkout', workspace.branch]);
  const cleaned = await cleanupTaskWorkspace(root, { taskId: workspace.taskId, authorized: true });
  assert.equal(cleaned.branchRetained, workspace.branch);
  assert.equal(
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`]).catch(
      () => 'missing',
    ),
    '',
  );
});

test('never overwrites existing branches and reports unavailable Git capability', async (t) => {
  const root = await fixture(t);
  const branch = 'user/existing';
  await git(root, ['branch', branch]);
  await assert.rejects(
    createTaskWorkspace(root, { taskId: await taskId(root), branch }),
    (error) => error.code === 'WORKSPACE_BRANCH_EXISTS',
  );
  const nonGit = path.join(path.dirname(root), 'not a repository');
  await fs.mkdir(nonGit);
  assert.deepEqual(await inspectWorkspaceCapability(nonGit), {
    capability: 'unavailable',
    code: 'GIT_REPOSITORY_UNAVAILABLE',
  });
  assert.equal((await inspectWorkspaceCapability(root, { mode: 'direct' })).mode, 'direct');
});

test('reconciles an interrupted registry write only when deterministic Git ownership matches', async (t) => {
  const root = await fixture(t);
  const workspace = await createTaskWorkspace(root, { taskId: await taskId(root) });
  const common = await git(root, ['rev-parse', '--git-common-dir']);
  await fs.rm(path.join(root, common, 'latchkit', 'workspaces-v1.json'));
  const recovered = await createTaskWorkspace(root, { taskId: workspace.taskId });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.path, workspace.path);
  await fs.writeFile(path.join(workspace.path, 'later.txt'), 'changed after setup\n');
  await fs.rm(path.join(root, common, 'latchkit', 'workspaces-v1.json'));
  await assert.rejects(
    createTaskWorkspace(root, { taskId: workspace.taskId }),
    (error) => error.code === 'WORKSPACE_PATH_OCCUPIED',
  );
});

test('the default worktree root resolves inside the project, and its effective location is visible before creation', async (t) => {
  const root = await fixture(t);
  const inspected = await inspectWorkspaceCapability(root);
  assert.equal(inspected.workspaceRoot, path.join(root, '.latchkit', 'worktrees'));
  const workspace = await createTaskWorkspace(root, { taskId: await taskId(root) });
  assert.equal(workspace.path, path.join(root, '.latchkit', 'worktrees', workspace.taskId));
});

test('a persisted project worktree-root setting is honored without an explicit override', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.latchkit'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.latchkit', 'config.json'),
    JSON.stringify({
      workspace: { executionPreference: 'direct', worktreeRoot: 'custom/nested-root' },
    }),
  );
  const inspected = await inspectWorkspaceCapability(root);
  assert.equal(inspected.workspaceRoot, path.join(root, 'custom', 'nested-root'));
  const workspace = await createTaskWorkspace(root, { taskId: await taskId(root) });
  assert.equal(workspace.path, path.join(root, 'custom', 'nested-root', workspace.taskId));
});

test('an explicit per-call worktree-root override wins over the persisted project setting', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.latchkit'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.latchkit', 'config.json'),
    JSON.stringify({
      workspace: { executionPreference: 'direct', worktreeRoot: 'configured-root' },
    }),
  );
  const override = path.join(path.dirname(root), 'override-root');
  const inspected = await inspectWorkspaceCapability(root, { worktreeRoot: override });
  assert.equal(inspected.workspaceRoot, override);
});

test('an absolute worktree root is honored verbatim', async (t) => {
  const root = await fixture(t);
  const absolute = path.join(path.dirname(root), 'external absolute root é');
  const inspected = await inspectWorkspaceCapability(root, { worktreeRoot: absolute });
  assert.equal(inspected.workspaceRoot, absolute);
});

test('an invalid worktree root is refused before any worktree is created', async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    inspectWorkspaceCapability(root, { worktreeRoot: root }),
    (error) => error instanceof WorkspaceError && error.code === 'WORKSPACE_ROOT_INVALID',
  );
  await assert.rejects(
    inspectWorkspaceCapability(root, { worktreeRoot: path.dirname(root) }),
    (error) => error instanceof WorkspaceError && error.code === 'WORKSPACE_ROOT_INVALID',
  );
  const common = await git(root, ['rev-parse', '--git-common-dir']);
  await assert.rejects(
    inspectWorkspaceCapability(root, { worktreeRoot: path.resolve(root, common) }),
    (error) => error instanceof WorkspaceError && error.code === 'WORKSPACE_ROOT_INVALID',
  );
  await assert.rejects(
    inspectWorkspaceCapability(root, { worktreeRoot: '../escaping' }),
    (error) => error instanceof WorkspaceError && error.code === 'WORKSPACE_ROOT_INVALID',
  );
});

test('a project-relative default resolves against the stable main checkout, never a linked worktree', async (t) => {
  const root = await fixture(t);
  const first = await createTaskWorkspace(root, {
    taskId: await taskId(root),
    worktreeRoot: path.join(path.dirname(root), 'external-worktrees'),
  });
  // Inspecting from inside the linked worktree must still resolve the
  // project-relative default against the original project, not nest a new
  // worktree root inside this worktree.
  const insideWorktree = await inspectWorkspaceCapability(first.path);
  assert.equal(insideWorktree.workspaceRoot, path.join(root, '.latchkit', 'worktrees'));
  assert.notEqual(insideWorktree.workspaceRoot, path.join(first.path, '.latchkit', 'worktrees'));
});

test('registry entries recorded at the legacy sibling location remain resumable after the default moves in-project', async (t) => {
  const root = await fixture(t);
  const task = await taskId(root);
  const commonRelative = await git(root, ['rev-parse', '--git-common-dir']);
  const commonDir = path.resolve(root, commonRelative);
  const legacyRoot = path.join(path.dirname(root), '.legacy-latchkit-worktrees');
  const branch = `latchkit/task/${task.slice('task_'.length)}`;
  const target = path.join(legacyRoot, task);
  await fs.mkdir(legacyRoot, { recursive: true });
  const head = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['worktree', 'add', '-b', branch, target, head]);
  const registryPath = path.join(commonDir, 'latchkit', 'workspaces-v1.json');
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        workspaces: [
          {
            taskId: task,
            repositoryCommonDir: commonDir,
            sourceRoot: root,
            workspaceRoot: legacyRoot,
            path: target,
            branch,
            baseRevision: head,
            state: 'active',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      null,
      2,
    ),
  );
  // The current default resolves inside the project, yet the legacy record
  // is unaffected: it still resolves, reconciles, and cancels correctly.
  const reconciled = await createTaskWorkspace(root, { taskId: task });
  assert.equal(reconciled.path, target);
  assert.equal(reconciled.reconciled, true);
  const cancelled = await cancelTaskWorkspace(root, { taskId: task });
  assert.equal(cancelled.path, target);
  assert.equal(cancelled.state, 'cancelled');
});

test('CLI workspace preference reports and persists the execution preference and worktree root', async (t) => {
  const root = await fixture(t);
  const cli = path.resolve('dist', 'src', 'cli.js');
  const runCli = async (args) => {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args, '--project', root], {
      windowsHide: true,
    });
    return JSON.parse(stdout);
  };
  assert.deepEqual(await runCli(['workspace', 'preference']), {
    executionPreference: 'direct',
    worktreeRoot: '.latchkit/worktrees',
  });
  await execFileAsync(process.execPath, [cli, 'init', '--project', root], { windowsHide: true });
  const set = await runCli([
    'workspace',
    'preference',
    '--execution',
    'always-worktree',
    '--worktree-root',
    'custom/worktrees',
  ]);
  assert.equal(set.workspace.executionPreference, 'always-worktree');
  assert.equal(set.workspace.worktreeRoot, 'custom/worktrees');
  assert.deepEqual(await runCli(['workspace', 'preference']), {
    executionPreference: 'always-worktree',
    worktreeRoot: 'custom/worktrees',
  });
  const inspected = await runCli(['workspace', 'inspect']);
  assert.equal(inspected.workspaceRoot, path.join(root, 'custom', 'worktrees'));
});
