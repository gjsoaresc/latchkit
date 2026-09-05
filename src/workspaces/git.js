import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOptional, writeAtomic } from '../storage.js';
import { validateStableId } from '../task-state/contracts.js';
import { inspectTask } from '../task-state/service.js';

const execFileAsync = promisify(execFile);
/** Relative to Git's common directory, never the user's checkout. */
export const WORKSPACE_REGISTRY_PATH = 'latchkit/workspaces-v1.json';
export const WORKSPACE_SCHEMA_VERSION = 1;

export class WorkspaceError extends Error {
  constructor(message, code = 'WORKSPACE_INVALID') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

async function git(root, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    if (error.code === 'ENOENT')
      throw new WorkspaceError('Git is unavailable on PATH.', 'GIT_UNAVAILABLE');
    throw new WorkspaceError(error.stderr?.trim() || error.message, 'GIT_COMMAND_FAILED');
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function canonicalPath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

async function noLinkPath(root, target) {
  if (!isContained(root, target)) return false;
  try {
    if ((await lstat(root)).isSymbolicLink()) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }
  return true;
}

function branchFor(taskId) {
  return `latchkit/task/${taskId.slice('task_'.length)}`;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new WorkspaceError('Invalid workspace record.');
  validateStableId(record.taskId, 'task', '$.taskId');
  for (const field of [
    'repositoryCommonDir',
    'sourceRoot',
    'workspaceRoot',
    'path',
    'branch',
    'baseRevision',
    'createdAt',
  ]) {
    if (typeof record[field] !== 'string' || !record[field])
      throw new WorkspaceError(`Invalid workspace ${field}.`);
  }
  if (!['active', 'cancelled'].includes(record.state))
    throw new WorkspaceError('Invalid workspace state.');
  return record;
}

async function readRegistry(root) {
  const raw = await readOptional(root, WORKSPACE_REGISTRY_PATH);
  if (raw === null) return { schemaVersion: WORKSPACE_SCHEMA_VERSION, workspaces: [] };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkspaceError('Workspace registry is not valid JSON.', 'WORKSPACE_REGISTRY_INVALID');
  }
  if (
    !value ||
    value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
    !Array.isArray(value.workspaces) ||
    Object.keys(value).some((key) => !['schemaVersion', 'workspaces'].includes(key))
  ) {
    throw new WorkspaceError(
      'Workspace registry has an unsupported shape.',
      'WORKSPACE_REGISTRY_INVALID',
    );
  }
  value.workspaces.forEach(validateRecord);
  const ids = new Set(value.workspaces.map((item) => item.taskId));
  if (ids.size !== value.workspaces.length)
    throw new WorkspaceError(
      'Workspace registry has duplicate task ownership.',
      'WORKSPACE_REGISTRY_INVALID',
    );
  return value;
}

async function writeRegistry(root, registry) {
  await writeAtomic(root, WORKSPACE_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

async function repository(root, { mode = 'isolated' } = {}) {
  if (!['isolated', 'direct'].includes(mode))
    throw new WorkspaceError(
      'Workspace mode must be isolated or direct.',
      'WORKSPACE_MODE_INVALID',
    );
  const top = await git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top) return { capability: 'unavailable', code: 'GIT_REPOSITORY_UNAVAILABLE' };
  const sourceRoot = await realpath(top);
  const commonRaw = await git(sourceRoot, ['rev-parse', '--git-common-dir']);
  const commonDir = await realpath(path.resolve(sourceRoot, commonRaw));
  const isBare = await git(sourceRoot, ['rev-parse', '--is-bare-repository']);
  if (isBare === 'true') return { capability: 'unavailable', code: 'GIT_BARE_REPOSITORY' };
  if (mode === 'direct') {
    return {
      capability: 'available',
      mode: 'direct',
      sourceRoot,
      commonDir,
      workspaceRoot: sourceRoot,
    };
  }
  const rootName = `latchkit-worktrees-${digest(canonicalPath(commonDir))}`;
  return {
    capability: 'available',
    mode: 'isolated',
    sourceRoot,
    commonDir,
    workspaceRoot: path.join(path.dirname(sourceRoot), `.${rootName}`),
  };
}

async function requireRecordedTask(root, taskId) {
  try {
    await inspectTask(root, taskId);
  } catch (error) {
    if (error.code === 'TASK_NOT_FOUND')
      throw new WorkspaceError(
        'Task ownership is not recorded in task state.',
        'WORKSPACE_TASK_NOT_FOUND',
      );
    throw error;
  }
}

async function status(root) {
  return git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);
}

async function verifyOwned(record) {
  const root = await realpath(record.workspaceRoot).catch(() => null);
  const target = await realpath(record.path).catch(() => null);
  if (!root || !target || !isContained(root, target) || !(await noLinkPath(root, target)))
    throw new WorkspaceError(
      'Workspace path is missing, outside its owned root, or redirected.',
      'WORKSPACE_PATH_UNSAFE',
    );
  const commonRaw = await git(target, ['rev-parse', '--git-common-dir']);
  const common = await realpath(path.resolve(target, commonRaw));
  if (canonicalPath(common) !== canonicalPath(record.repositoryCommonDir))
    throw new WorkspaceError(
      'Workspace belongs to a different Git repository.',
      'WORKSPACE_OWNERSHIP_CONFLICT',
    );
  const branch = await git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true,
  });
  if (branch !== record.branch)
    throw new WorkspaceError(
      'Workspace branch does not match its ownership record.',
      'WORKSPACE_BRANCH_MISMATCH',
    );
  return target;
}

/** Inspect Git capability without changing a checkout. Direct mode is explicit and never creates a worktree. */
export async function inspectWorkspaceCapability(root, options = {}) {
  return repository(path.resolve(root), options);
}

/** Create or reconcile one deterministic, task-owned Git worktree. */
export async function createTaskWorkspace(root, input = {}) {
  const projectRoot = await realpath(path.resolve(root));
  validateStableId(input.taskId, 'task', '$.taskId');
  await requireRecordedTask(projectRoot, input.taskId);
  const info = await repository(projectRoot, { mode: input.mode ?? 'isolated' });
  if (info.capability !== 'available') return info;
  if (info.mode === 'direct') {
    return { ...info, taskId: input.taskId, created: false, reason: 'direct-workspace-mode' };
  }
  const registry = await readRegistry(info.commonDir);
  const existing = registry.workspaces.find((item) => item.taskId === input.taskId);
  if (existing) {
    const workspacePath = await verifyOwned(existing);
    return { ...existing, path: workspacePath, created: false, reconciled: true };
  }
  const baseRevision = await git(info.sourceRoot, [
    'rev-parse',
    '--verify',
    `${input.revision ?? 'HEAD'}^{commit}`,
  ]);
  const branch = input.branch ?? branchFor(input.taskId);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.endsWith('/') ||
    branch.includes('..')
  )
    throw new WorkspaceError('Branch name is unsafe.', 'WORKSPACE_BRANCH_INVALID');
  const target = path.join(info.workspaceRoot, input.taskId);
  if (!(await noLinkPath(info.workspaceRoot, target)))
    throw new WorkspaceError(
      'Workspace target is outside or redirected from the owned root.',
      'WORKSPACE_PATH_UNSAFE',
    );
  try {
    await lstat(target);
    const recoveredPath = await realpath(target);
    const commonRaw = await git(recoveredPath, ['rev-parse', '--git-common-dir']);
    const common = await realpath(path.resolve(recoveredPath, commonRaw));
    const recoveredBranch = await git(
      recoveredPath,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      {
        allowFailure: true,
      },
    );
    const recoveredHead = await git(recoveredPath, ['rev-parse', 'HEAD']);
    const recoveredStatus = await status(recoveredPath);
    if (
      canonicalPath(common) !== canonicalPath(info.commonDir) ||
      recoveredBranch !== branch ||
      recoveredHead !== baseRevision ||
      recoveredStatus
    ) {
      throw new WorkspaceError(
        'Workspace target exists without matching interrupted setup state.',
        'WORKSPACE_PATH_OCCUPIED',
      );
    }
    const record = {
      taskId: input.taskId,
      repositoryCommonDir: info.commonDir,
      sourceRoot: info.sourceRoot,
      workspaceRoot: info.workspaceRoot,
      path: target,
      branch,
      baseRevision,
      state: 'active',
      createdAt: new Date().toISOString(),
    };
    registry.workspaces.push(record);
    await writeRegistry(info.commonDir, registry);
    return { ...record, path: recoveredPath, created: false, reconciled: true, recovered: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const existingBranch = await git(
    info.sourceRoot,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { allowFailure: true },
  );
  if (existingBranch !== null)
    throw new WorkspaceError(
      'Refusing to overwrite an existing user branch.',
      'WORKSPACE_BRANCH_EXISTS',
    );
  await mkdir(info.workspaceRoot, { recursive: true });
  if (!(await noLinkPath(info.workspaceRoot, target)))
    throw new WorkspaceError(
      'Workspace target is redirected after creation.',
      'WORKSPACE_PATH_UNSAFE',
    );
  await git(info.sourceRoot, ['worktree', 'add', '-b', branch, target, baseRevision]);
  const record = {
    taskId: input.taskId,
    repositoryCommonDir: info.commonDir,
    sourceRoot: info.sourceRoot,
    workspaceRoot: info.workspaceRoot,
    path: target,
    branch,
    baseRevision,
    state: 'active',
    createdAt: new Date().toISOString(),
  };
  try {
    registry.workspaces.push(record);
    await writeRegistry(info.commonDir, registry);
  } catch (error) {
    // Git worktree state is intentionally retained for recovery; it is never removed as rollback.
    throw new WorkspaceError(
      `Worktree exists at ${target}, but ownership was not recorded: ${error.message}`,
      'WORKSPACE_RECORDING_INTERRUPTED',
    );
  }
  return { ...record, created: true, sourceStatus: await status(info.sourceRoot) };
}

/** Mark a task workspace cancelled while retaining every worktree change for recovery. */
export async function cancelTaskWorkspace(root, input = {}) {
  const projectRoot = await realpath(path.resolve(root));
  validateStableId(input.taskId, 'task', '$.taskId');
  await requireRecordedTask(projectRoot, input.taskId);
  const info = await repository(projectRoot);
  if (info.capability !== 'available') return info;
  const registry = await readRegistry(info.commonDir);
  const record = registry.workspaces.find((item) => item.taskId === input.taskId);
  if (!record) throw new WorkspaceError('Task has no recorded workspace.', 'WORKSPACE_NOT_FOUND');
  const workspacePath = await verifyOwned(record);
  record.state = 'cancelled';
  await writeRegistry(info.commonDir, registry);
  return {
    ...record,
    path: workspacePath,
    dirty: Boolean(await status(workspacePath)),
    recoveryCommand: `git -C ${JSON.stringify(workspacePath)} status --short --ignored`,
  };
}

/** Remove only a clean, recorded task worktree after explicit user cleanup authorization. Branches are retained. */
export async function cleanupTaskWorkspace(root, input = {}) {
  const projectRoot = await realpath(path.resolve(root));
  validateStableId(input.taskId, 'task', '$.taskId');
  await requireRecordedTask(projectRoot, input.taskId);
  if (input.authorized !== true)
    throw new WorkspaceError(
      'Cleanup requires explicit user authorization.',
      'WORKSPACE_CLEANUP_UNAUTHORIZED',
    );
  const info = await repository(projectRoot);
  if (info.capability !== 'available') return info;
  const registry = await readRegistry(info.commonDir);
  const index = registry.workspaces.findIndex((item) => item.taskId === input.taskId);
  if (index < 0) throw new WorkspaceError('Task has no recorded workspace.', 'WORKSPACE_NOT_FOUND');
  const record = registry.workspaces[index];
  const workspacePath = await verifyOwned(record);
  if (await status(workspacePath))
    throw new WorkspaceError('Refusing to remove a dirty task workspace.', 'WORKSPACE_DIRTY');
  await git(projectRoot, ['worktree', 'remove', workspacePath]);
  registry.workspaces.splice(index, 1);
  await writeRegistry(info.commonDir, registry);
  return { removed: workspacePath, branchRetained: record.branch };
}
