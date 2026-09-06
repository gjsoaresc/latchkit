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
  const first = await createTaskWorkspace(root, { taskId: firstTask });
  const second = await createTaskWorkspace(root, { taskId: secondTask });
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
  const workspace = await createReviewWorkspace(root, { taskId: reviewTaskId });
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
