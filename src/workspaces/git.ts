import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOptional, writeAtomic } from '../storage.js';
import { validateStableId } from '../task-state/contracts.js';
import { inspectTask } from '../task-state/service.js';
import { errorCode, errorMessage, isRecord } from '../types.js';

const execFileAsync = promisify(execFile);
/** Relative to Git's common directory, never the user's checkout. */
export const WORKSPACE_REGISTRY_PATH = 'latchkit/workspaces-v1.json';
export const WORKSPACE_SCHEMA_VERSION = 1;

type WorkspaceRecord = {
  taskId: string;
  repositoryCommonDir: string;
  sourceRoot: string;
  workspaceRoot: string;
  path: string;
  branch: string;
  baseRevision: string;
  state: 'active' | 'cancelled';
  createdAt: string;
};
type WorkspaceRegistry = { schemaVersion: number; workspaces: WorkspaceRecord[] };
type Repository =
  | { capability: 'unavailable'; code: 'GIT_REPOSITORY_UNAVAILABLE' | 'GIT_BARE_REPOSITORY' }
  | {
      capability: 'available';
      mode: 'direct' | 'isolated';
      sourceRoot: string;
      commonDir: string;
      workspaceRoot: string;
    };
type CapabilityOptions = { mode?: unknown };
type WorkspaceInput = { taskId?: unknown; mode?: unknown; revision?: unknown; branch?: unknown };
type CleanupInput = { taskId?: unknown; authorized?: unknown };

export class WorkspaceError extends Error {
  code: string;
  constructor(message: string, code = 'WORKSPACE_INVALID') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

async function git(
  root: string,
  args: string[],
  { allowFailure = false }: { allowFailure?: boolean } = {},
): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    if (errorCode(error) === 'ENOENT')
      throw new WorkspaceError('Git is unavailable on PATH.', 'GIT_UNAVAILABLE');
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new WorkspaceError(stderr || errorMessage(error), 'GIT_COMMAND_FAILED');
  }
}

async function gitRaw(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    if (errorCode(error) === 'ENOENT')
      throw new WorkspaceError('Git is unavailable on PATH.', 'GIT_UNAVAILABLE');
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new WorkspaceError(stderr || errorMessage(error), 'GIT_COMMAND_FAILED');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function canonicalPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('/', path.sep);
  if (
    !value ||
    path.isAbsolute(normalized) ||
    normalized.split(path.sep).some((part) => part === '..' || part === '')
  )
    throw new WorkspaceError('Review snapshot contains an unsafe path.', 'WORKSPACE_PATH_UNSAFE');
  return normalized;
}

async function reviewPaths(root: string): Promise<string[]> {
  return (
    await gitRaw(root, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--exclude=.latchkit/**',
      '-z',
    ])
  )
    .split('\0')
    .filter(Boolean)
    .filter((name) => name !== '.latchkit' && !name.startsWith('.latchkit/'))
    .sort();
}

async function reviewManifest(root: string): Promise<string> {
  const names = await reviewPaths(root);
  const entries: string[] = [];
  for (const name of names) {
    const relative = safeRelativePath(name);
    const absolute = path.resolve(root, relative);
    if (!isContained(root, absolute))
      throw new WorkspaceError('Review snapshot escaped the checkout.', 'WORKSPACE_PATH_UNSAFE');
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink())
        throw new WorkspaceError(
          'Review snapshots do not copy untracked symbolic links.',
          'WORKSPACE_SNAPSHOT_UNSUPPORTED',
        );
      if (!stat.isFile())
        throw new WorkspaceError(
          'Review snapshot contains an unsupported entry.',
          'WORKSPACE_SNAPSHOT_UNSUPPORTED',
        );
      entries.push(
        `${name}\0${stat.mode & 0o111 ? 'x' : '-'}\0${createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex')}\0`,
      );
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return createHash('sha256').update(entries.join('')).digest('hex');
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(
    relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative),
  );
}

async function noLinkPath(root: string, target: string): Promise<boolean> {
  if (!isContained(root, target)) return false;
  try {
    if ((await lstat(root)).isSymbolicLink()) return false;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      throw error;
    }
  }
  return true;
}

async function removeReviewEntry(root: string, target: string): Promise<void> {
  if (!isContained(root, target))
    throw new WorkspaceError('Review snapshot escaped a checkout.', 'WORKSPACE_PATH_UNSAFE');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink() || canonicalPath(current) === canonicalPath(target)) {
      await rm(current, { recursive: true, force: true });
      return;
    }
    if (!stat.isDirectory()) {
      await rm(current, { force: true });
      return;
    }
  }
}

async function prepareReviewFile(root: string, target: string): Promise<void> {
  if (!isContained(root, target))
    throw new WorkspaceError('Review snapshot escaped a checkout.', 'WORKSPACE_PATH_UNSAFE');
  let current = root;
  const segments = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      await rm(current, { recursive: true, force: true });
    await mkdir(current, { recursive: true });
    if (!(await noLinkPath(root, current)))
      throw new WorkspaceError('Review snapshot target is redirected.', 'WORKSPACE_PATH_UNSAFE');
  }
  await removeReviewEntry(root, target);
}

function branchFor(taskId: string): string {
  return `latchkit/task/${taskId.slice('task_'.length)}`;
}

function validateRecord(record: unknown): WorkspaceRecord {
  if (!isRecord(record))
    throw new WorkspaceError('Workspace registry record is invalid.', 'WORKSPACE_REGISTRY_INVALID');
  const stableTaskId = validateStableId(record.taskId, 'task', '$.taskId');
  const state = record.state;
  const strings = [
    'taskId',
    'repositoryCommonDir',
    'sourceRoot',
    'workspaceRoot',
    'path',
    'branch',
    'baseRevision',
    'createdAt',
  ] as const;
  if (
    strings.some((key) => typeof record[key] !== 'string') ||
    (state !== 'active' && state !== 'cancelled')
  )
    throw new WorkspaceError('Workspace registry record is invalid.', 'WORKSPACE_REGISTRY_INVALID');
  return {
    taskId: stableTaskId,
    repositoryCommonDir: String(record.repositoryCommonDir),
    sourceRoot: String(record.sourceRoot),
    workspaceRoot: String(record.workspaceRoot),
    path: String(record.path),
    branch: String(record.branch),
    baseRevision: String(record.baseRevision),
    state,
    createdAt: String(record.createdAt),
  };
}

async function readRegistry(root: string): Promise<WorkspaceRegistry> {
  const raw = await readOptional(root, WORKSPACE_REGISTRY_PATH);
  if (raw === null) return { schemaVersion: WORKSPACE_SCHEMA_VERSION, workspaces: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkspaceError('Workspace registry is not valid JSON.', 'WORKSPACE_REGISTRY_INVALID');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
    !Array.isArray(value.workspaces) ||
    Object.keys(value).some((key) => !['schemaVersion', 'workspaces'].includes(key))
  ) {
    throw new WorkspaceError(
      'Workspace registry has an unsupported shape.',
      'WORKSPACE_REGISTRY_INVALID',
    );
  }
  const workspaces = value.workspaces.map(validateRecord);
  const ids = new Set(workspaces.map((item) => item.taskId));
  if (ids.size !== workspaces.length)
    throw new WorkspaceError(
      'Workspace registry has duplicate task ownership.',
      'WORKSPACE_REGISTRY_INVALID',
    );
  return { schemaVersion: WORKSPACE_SCHEMA_VERSION, workspaces };
}

async function writeRegistry(root: string, registry: WorkspaceRegistry): Promise<void> {
  await writeAtomic(root, WORKSPACE_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

async function repository(
  root: string,
  { mode = 'isolated' }: CapabilityOptions = {},
): Promise<Repository> {
  if (mode !== 'isolated' && mode !== 'direct')
    throw new WorkspaceError(
      'Workspace mode must be isolated or direct.',
      'WORKSPACE_MODE_INVALID',
    );
  const top = await git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!top) return { capability: 'unavailable', code: 'GIT_REPOSITORY_UNAVAILABLE' };
  const sourceRoot = await realpath(top);
  const commonRaw = await git(sourceRoot, ['rev-parse', '--git-common-dir']);
  if (!commonRaw)
    throw new WorkspaceError('Git did not return its common directory.', 'GIT_COMMAND_FAILED');
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

async function requireRecordedTask(root: string, taskId: string): Promise<void> {
  try {
    await inspectTask(root, taskId);
  } catch (error) {
    if (errorCode(error) === 'TASK_NOT_FOUND')
      throw new WorkspaceError(
        'Task ownership is not recorded in task state.',
        'WORKSPACE_TASK_NOT_FOUND',
      );
    throw error;
  }
}

async function status(root: string): Promise<string> {
  const output = await git(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignored=matching',
  ]);
  if (output === null) throw new WorkspaceError('Git status is unavailable.', 'GIT_COMMAND_FAILED');
  return output;
}

async function verifyOwned(record: WorkspaceRecord): Promise<string> {
  const root = await realpath(record.workspaceRoot).catch(() => null);
  const target = await realpath(record.path).catch(() => null);
  if (!root || !target || !isContained(root, target) || !(await noLinkPath(root, target)))
    throw new WorkspaceError(
      'Workspace path is missing, outside its owned root, or redirected.',
      'WORKSPACE_PATH_UNSAFE',
    );
  const commonRaw = await git(target, ['rev-parse', '--git-common-dir']);
  if (!commonRaw)
    throw new WorkspaceError('Git did not return its common directory.', 'GIT_COMMAND_FAILED');
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
export async function inspectWorkspaceCapability(
  root: string,
  options: CapabilityOptions = {},
): Promise<Repository> {
  return repository(path.resolve(root), options);
}

/** Return a verified task-owned checkout without changing Git or user files. */
export async function inspectTaskWorkspace(root: string, taskId: unknown) {
  const projectRoot = await realpath(path.resolve(root));
  const id = validateStableId(taskId, 'task', '$.taskId');
  await requireRecordedTask(projectRoot, id);
  const info = await repository(projectRoot);
  if (info.capability !== 'available') return info;
  const registry = await readRegistry(info.commonDir);
  const record = registry.workspaces.find((item) => item.taskId === id);
  if (!record) throw new WorkspaceError('Task has no recorded workspace.', 'WORKSPACE_NOT_FOUND');
  return { ...record, path: await verifyOwned(record) };
}

/** Create or reconcile one deterministic, task-owned Git worktree. */
export async function createTaskWorkspace(root: string, input: WorkspaceInput = {}) {
  const projectRoot = await realpath(path.resolve(root));
  const taskId = validateStableId(input.taskId, 'task', '$.taskId');
  await requireRecordedTask(projectRoot, taskId);
  const info = await repository(projectRoot, { mode: input.mode ?? 'isolated' });
  if (info.capability !== 'available') return info;
  if (info.mode === 'direct') {
    return { ...info, taskId, created: false, reason: 'direct-workspace-mode' };
  }
  const registry = await readRegistry(info.commonDir);
  const existing = registry.workspaces.find((item) => item.taskId === taskId);
  if (existing) {
    const workspacePath = await verifyOwned(existing);
    return { ...existing, path: workspacePath, created: false, reconciled: true };
  }
  const baseRevision = await git(info.sourceRoot, [
    'rev-parse',
    '--verify',
    `${input.revision ?? 'HEAD'}^{commit}`,
  ]);
  if (!baseRevision)
    throw new WorkspaceError(
      'Git did not resolve the requested base revision.',
      'GIT_COMMAND_FAILED',
    );
  const branch = input.branch === undefined ? branchFor(taskId) : input.branch;
  if (
    typeof branch !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.endsWith('/') ||
    branch.includes('..')
  )
    throw new WorkspaceError('Branch name is unsafe.', 'WORKSPACE_BRANCH_INVALID');
  const target = path.join(info.workspaceRoot, taskId);
  if (!(await noLinkPath(info.workspaceRoot, target)))
    throw new WorkspaceError(
      'Workspace target is outside or redirected from the owned root.',
      'WORKSPACE_PATH_UNSAFE',
    );
  try {
    await lstat(target);
    const recoveredPath = await realpath(target);
    const commonRaw = await git(recoveredPath, ['rev-parse', '--git-common-dir']);
    if (!commonRaw)
      throw new WorkspaceError('Git did not return its common directory.', 'GIT_COMMAND_FAILED');
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
    const record: WorkspaceRecord = {
      taskId,
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
    if (errorCode(error) !== 'ENOENT') throw error;
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
  const record: WorkspaceRecord = {
    taskId,
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
      `Worktree exists at ${target}, but ownership was not recorded: ${errorMessage(error)}`,
      'WORKSPACE_RECORDING_INTERRUPTED',
    );
  }
  return { ...record, created: true, sourceStatus: await status(info.sourceRoot) };
}

/** Materialize the current tracked and untracked Git snapshot in an isolated
 * task worktree. The source checkout and its index/refs are never changed. */
export async function createReviewWorkspace(root: string, input: WorkspaceInput = {}) {
  const sourceRoot = await realpath(path.resolve(root));
  const before = await reviewManifest(sourceRoot);
  const created = await createTaskWorkspace(sourceRoot, input);
  const workspacePath = 'path' in created && typeof created.path === 'string' ? created.path : null;
  if (!workspacePath)
    throw new WorkspaceError(
      'Independent review requires an isolated Git worktree.',
      'WORKSPACE_REVIEW_UNAVAILABLE',
    );
  const target = await realpath(workspacePath);
  if (canonicalPath(target) === canonicalPath(sourceRoot))
    throw new WorkspaceError(
      'Independent review cannot use the source checkout.',
      'WORKSPACE_REVIEW_UNAVAILABLE',
    );
  if (await status(target))
    throw new WorkspaceError(
      'The review worktree is not clean before snapshot transfer.',
      'WORKSPACE_DIRTY',
    );
  const names = [...new Set([...(await reviewPaths(sourceRoot)), ...(await reviewPaths(target))])];
  const entries: Array<{
    name: string;
    source: string;
    destination: string;
    stat: { mode: number } | null;
  }> = [];
  for (const name of names) {
    const relative = safeRelativePath(name);
    const source = path.resolve(sourceRoot, relative);
    const destination = path.resolve(target, relative);
    if (!isContained(sourceRoot, source) || !isContained(target, destination))
      throw new WorkspaceError('Review snapshot escaped a checkout.', 'WORKSPACE_PATH_UNSAFE');
    const stat = await lstat(source).catch((error) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new WorkspaceError(
        'Review snapshot contains an unsupported entry.',
        'WORKSPACE_SNAPSHOT_UNSUPPORTED',
      );
    entries.push({ name, source, destination, stat });
  }
  for (const entry of entries
    .filter((item) => !item.stat)
    .sort((left, right) => right.name.length - left.name.length))
    await removeReviewEntry(target, entry.destination);
  for (const entry of entries
    .filter((item) => item.stat)
    .sort((left, right) => left.name.localeCompare(right.name))) {
    await prepareReviewFile(target, entry.destination);
    const handle = await open(entry.destination, 'wx', entry.stat!.mode & 0o777);
    try {
      await handle.writeFile(await readFile(entry.source));
      await handle.chmod(entry.stat!.mode & 0o777);
    } finally {
      await handle.close();
    }
  }
  const [after, transferred] = await Promise.all([
    reviewManifest(sourceRoot),
    reviewManifest(target),
  ]);
  if (before !== after)
    throw new WorkspaceError(
      'Source changed while the review snapshot was copied.',
      'WORKSPACE_SOURCE_CHANGED',
    );
  if (before !== transferred)
    throw new WorkspaceError(
      'Review worktree does not match the source snapshot.',
      'WORKSPACE_SNAPSHOT_MISMATCH',
    );
  return { ...created, path: target, snapshotDigest: before };
}

/** Mark a task workspace cancelled while retaining every worktree change for recovery. */
export async function cancelTaskWorkspace(root: string, input: { taskId?: unknown } = {}) {
  const projectRoot = await realpath(path.resolve(root));
  const taskId = validateStableId(input.taskId, 'task', '$.taskId');
  await requireRecordedTask(projectRoot, taskId);
  const info = await repository(projectRoot);
  if (info.capability !== 'available') return info;
  const registry = await readRegistry(info.commonDir);
  const record = registry.workspaces.find((item) => item.taskId === taskId);
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
export async function cleanupTaskWorkspace(root: string, input: CleanupInput = {}) {
  const projectRoot = await realpath(path.resolve(root));
  const taskId = validateStableId(input.taskId, 'task', '$.taskId');
  await requireRecordedTask(projectRoot, taskId);
  if (input.authorized !== true)
    throw new WorkspaceError(
      'Cleanup requires explicit user authorization.',
      'WORKSPACE_CLEANUP_UNAUTHORIZED',
    );
  const info = await repository(projectRoot);
  if (info.capability !== 'available') return info;
  const registry = await readRegistry(info.commonDir);
  const index = registry.workspaces.findIndex((item) => item.taskId === taskId);
  if (index < 0) throw new WorkspaceError('Task has no recorded workspace.', 'WORKSPACE_NOT_FOUND');
  const record = registry.workspaces[index];
  if (!record) throw new WorkspaceError('Task has no recorded workspace.', 'WORKSPACE_NOT_FOUND');
  const workspacePath = await verifyOwned(record);
  if (await status(workspacePath))
    throw new WorkspaceError('Refusing to remove a dirty task workspace.', 'WORKSPACE_DIRTY');
  await git(projectRoot, ['worktree', 'remove', workspacePath]);
  registry.workspaces.splice(index, 1);
  await writeRegistry(info.commonDir, registry);
  return { removed: workspacePath, branchRetained: record.branch };
}
