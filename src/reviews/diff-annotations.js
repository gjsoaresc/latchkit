import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOptional, safePath, writeAtomic } from '../storage.js';
import { withTaskStateLock } from '../task-state/lock.js';
import { inspectTask } from '../task-state/service.js';
import { inspectTaskWorkspace } from '../workspaces/git.js';

const execFileAsync = promisify(execFile);
export const DIFF_ANNOTATION_SCHEMA_VERSION = 1;
export const DIFF_ANNOTATION_PATH = '.latchkit/tasks/diff-annotations-v1.json';
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class DiffAnnotationError extends Error {
  constructor(message, code = 'DIFF_ANNOTATION_INVALID', pathName = '$') {
    super(`${pathName}: ${message}`);
    this.code = code;
    this.path = pathName;
  }
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const stableTaskId = (value) => /^task_[0-9a-f-]{36}$/i.test(value);
const relativePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !path.isAbsolute(value) &&
  !value.includes('\\') &&
  !value.split('/').some((part) => !part || part === '.' || part === '..');

async function git(root, args, { maxBuffer = MAX_DIFF_BYTES + 4096 } = {}) {
  try {
    return await execFileAsync('git', ['-c', 'core.quotePath=false', '-C', root, ...args], {
      windowsHide: true,
      maxBuffer,
    });
  } catch (error) {
    throw new DiffAnnotationError(
      `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message,
      error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'DIFF_GIT_FAILED',
    );
  }
}

async function ownedWorkspace(projectRoot, taskId) {
  if (!stableTaskId(taskId))
    throw new DiffAnnotationError('Expected a stable task ID.', 'DIFF_TASK_INVALID', '$.taskId');
  await inspectTask(projectRoot, taskId);
  const workspace = await inspectTaskWorkspace(projectRoot, taskId);
  if (!workspace.path)
    throw new DiffAnnotationError(
      'Task has no available owned worktree.',
      'DIFF_WORKTREE_UNAVAILABLE',
    );
  return workspace;
}

async function revision(worktree) {
  const [head, status, diff] = await Promise.all([
    git(worktree, ['rev-parse', 'HEAD']),
    git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(worktree, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--']),
  ]);
  const dirty = digest(`${status.stdout}\0${diff.stdout}`);
  return {
    head: head.stdout.trim(),
    dirty,
    id: `${head.stdout.trim()}:${dirty.slice(0, 16)}`,
  };
}

function safeText(bytes) {
  if (bytes.length > MAX_FILE_BYTES) return { kind: 'large', bytes: bytes.length };
  if (bytes.includes(0)) return { kind: 'binary', bytes: bytes.length, digest: digest(bytes) };
  try {
    return { kind: 'text', text: textDecoder.decode(bytes), digest: digest(bytes) };
  } catch {
    return { kind: 'binary', bytes: bytes.length, digest: digest(bytes) };
  }
}

async function worktreeFile(worktree, relative) {
  if (!relativePath(relative))
    throw new DiffAnnotationError(
      'Path must be workspace-relative.',
      'DIFF_PATH_INVALID',
      '$.path',
    );
  const target = await safePath(worktree, relative);
  const stat = await lstat(target).catch((error) =>
    error.code === 'ENOENT' ? null : Promise.reject(error),
  );
  if (!stat) return { kind: 'deleted', digest: null };
  if (!stat.isFile()) return { kind: 'unsupported', digest: null };
  return safeText(await readFile(target));
}

async function untrackedDiff(worktree) {
  const listed = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = listed.stdout.split('\0').filter(Boolean).slice(0, 100);
  const parts = [];
  for (const relative of paths) {
    if (!relativePath(relative))
      throw new DiffAnnotationError('Git returned an unsafe path.', 'DIFF_PATH_INVALID', '$.path');
    const content = await worktreeFile(worktree, relative);
    if (content.kind === 'text') {
      const snippet = content.text.slice(0, 32 * 1024);
      const marker =
        snippet.length < content.text.length ? '+[Latchkit: untracked file truncated]\n' : '';
      parts.push(
        `diff --git a/${relative} b/${relative}\nnew file mode 100644\n--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1 @@\n${snippet
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => `+${line}\n`)
          .join('')}${marker}`,
      );
    } else
      parts.push(
        `diff --git a/${relative} b/${relative}\nBinary or bounded ${content.kind} file omitted.\n`,
      );
  }
  return {
    diff: parts.join(''),
    limited: listed.stdout.split('\0').filter(Boolean).length > paths.length,
  };
}

function emptyStore() {
  return { schemaVersion: DIFF_ANNOTATION_SCHEMA_VERSION, revision: 0, annotations: [] };
}

function validateStore(value) {
  if (
    !record(value) ||
    value.schemaVersion !== DIFF_ANNOTATION_SCHEMA_VERSION ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.annotations)
  )
    throw new DiffAnnotationError(
      'Review annotation store has an unsupported shape.',
      'DIFF_ANNOTATION_STORE_INVALID',
    );
  for (const annotation of value.annotations) {
    if (
      !record(annotation) ||
      !/^annotation_[0-9a-f-]{36}$/i.test(annotation.id) ||
      !stableTaskId(annotation.taskId) ||
      !relativePath(annotation.path) ||
      !/^[a-f0-9]{64}$/.test(annotation.fileDigest) ||
      !['left', 'right'].includes(annotation.side) ||
      !Number.isInteger(annotation.line) ||
      annotation.line < 1 ||
      !['open', 'resolved', 'stale'].includes(annotation.status)
    )
      throw new DiffAnnotationError(
        'Review annotation store contains an invalid annotation.',
        'DIFF_ANNOTATION_STORE_INVALID',
      );
  }
  return value;
}

async function readStore(root) {
  const raw = await readOptional(root, DIFF_ANNOTATION_PATH);
  if (raw === null) return emptyStore();
  try {
    return validateStore(JSON.parse(raw));
  } catch (error) {
    if (error instanceof DiffAnnotationError) throw error;
    throw new DiffAnnotationError(
      'Review annotation store is not JSON.',
      'DIFF_ANNOTATION_STORE_INVALID',
    );
  }
}

async function writeStore(root, store) {
  validateStore(store);
  await writeAtomic(root, DIFF_ANNOTATION_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function annotationView(annotation, current) {
  const stale = annotation.revision !== current.id && annotation.status !== 'resolved';
  return { ...annotation, status: stale ? 'stale' : annotation.status, stale };
}

async function markStale(projectRoot, taskId, current) {
  return withTaskStateLock(projectRoot, async () => {
    const store = await readStore(projectRoot);
    let changed = false;
    for (const annotation of store.annotations) {
      if (
        annotation.taskId === taskId &&
        annotation.status === 'open' &&
        annotation.revision !== current.id
      ) {
        annotation.status = 'stale';
        annotation.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      store.revision += 1;
      await writeStore(projectRoot, store);
    }
    return store;
  });
}

export async function inspectDiff(projectRoot, input = {}) {
  const workspace = await ownedWorkspace(projectRoot, input.taskId);
  if (input.worktree !== undefined)
    throw new DiffAnnotationError(
      'Worktree selection is task-owned and cannot be supplied.',
      'DIFF_WORKTREE_FORGED',
      '$.worktree',
    );
  const base = input.base ?? workspace.baseRevision;
  if (!/^[0-9a-f]{40}$/i.test(base) || base !== workspace.baseRevision)
    throw new DiffAnnotationError(
      'Base revision does not match the owned worktree.',
      'DIFF_BASE_INVALID',
      '$.base',
    );
  const [result, untracked] = await Promise.all([
    git(workspace.path, [
      'diff',
      '--no-ext-diff',
      '--find-renames',
      '--binary',
      '--no-color',
      base,
      '--',
    ]),
    untrackedDiff(workspace.path),
  ]);
  const output = `${result.stdout}${untracked.diff}`;
  const current = await revision(workspace.path);
  return {
    schemaVersion: DIFF_ANNOTATION_SCHEMA_VERSION,
    taskId: input.taskId,
    base,
    revision: current.id,
    truncated: Buffer.byteLength(output) > MAX_DIFF_BYTES || untracked.limited,
    diff: output.slice(0, MAX_DIFF_BYTES),
    limitBytes: MAX_DIFF_BYTES,
  };
}

export async function inspectDiffFile(projectRoot, input = {}) {
  const workspace = await ownedWorkspace(projectRoot, input.taskId);
  const content = await worktreeFile(workspace.path, input.path);
  return {
    schemaVersion: DIFF_ANNOTATION_SCHEMA_VERSION,
    taskId: input.taskId,
    path: input.path,
    revision: (await revision(workspace.path)).id,
    ...content,
  };
}

export async function listDiffAnnotations(projectRoot, input = {}) {
  const workspace = await ownedWorkspace(projectRoot, input.taskId);
  const current = await revision(workspace.path);
  const store = await markStale(projectRoot, input.taskId, current);
  return {
    schemaVersion: DIFF_ANNOTATION_SCHEMA_VERSION,
    revision: store.revision,
    currentRevision: current.id,
    annotations: store.annotations
      .filter((item) => item.taskId === input.taskId)
      .map((item) => annotationView(item, current)),
  };
}

export async function createDiffAnnotation(projectRoot, input = {}) {
  const workspace = await ownedWorkspace(projectRoot, input.taskId);
  if (!relativePath(input.path))
    throw new DiffAnnotationError(
      'Path must be workspace-relative.',
      'DIFF_PATH_INVALID',
      '$.path',
    );
  if (!['left', 'right'].includes(input.side))
    throw new DiffAnnotationError(
      'Side must be left or right.',
      'DIFF_ANNOTATION_INVALID',
      '$.side',
    );
  if (!Number.isInteger(input.line) || input.line < 1)
    throw new DiffAnnotationError(
      'Line must be a positive integer.',
      'DIFF_ANNOTATION_INVALID',
      '$.line',
    );
  if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 8000)
    throw new DiffAnnotationError(
      'Comment body must be 1–8000 characters.',
      'DIFF_ANNOTATION_INVALID',
      '$.body',
    );
  const current = await revision(workspace.path);
  if (input.expectedRevision !== current.id)
    throw new DiffAnnotationError(
      'Diff changed; refresh before annotating.',
      'DIFF_REVISION_CONFLICT',
      '$.expectedRevision',
    );
  const content = await worktreeFile(workspace.path, input.path);
  if (content.kind !== 'text')
    throw new DiffAnnotationError(
      'Only bounded text files can receive annotations.',
      'DIFF_ANNOTATION_UNSUPPORTED',
    );
  return withTaskStateLock(projectRoot, async () => {
    const store = await readStore(projectRoot);
    if (input.expectedStoreRevision !== store.revision)
      throw new DiffAnnotationError(
        'Annotations changed; refresh before saving.',
        'DIFF_ANNOTATION_CONFLICT',
        '$.expectedStoreRevision',
      );
    const at = new Date().toISOString();
    const annotation = {
      id: `annotation_${randomUUID()}`,
      taskId: input.taskId,
      path: input.path,
      fileDigest: content.digest,
      side: input.side,
      line: input.line,
      body: input.body.trim(),
      authorKind: input.authorKind === 'agent' ? 'agent' : 'user',
      status: 'open',
      revision: current.id,
      createdAt: at,
      updatedAt: at,
      resolution: null,
    };
    store.annotations.push(annotation);
    store.revision += 1;
    await writeStore(projectRoot, store);
    return { annotation, revision: store.revision };
  });
}

export async function updateDiffAnnotation(projectRoot, input = {}) {
  const workspace = await ownedWorkspace(projectRoot, input.taskId);
  const current = await revision(workspace.path);
  return withTaskStateLock(projectRoot, async () => {
    const store = await readStore(projectRoot);
    if (input.expectedStoreRevision !== store.revision)
      throw new DiffAnnotationError(
        'Annotations changed; refresh before saving.',
        'DIFF_ANNOTATION_CONFLICT',
        '$.expectedStoreRevision',
      );
    const annotation = store.annotations.find(
      (item) => item.id === input.annotationId && item.taskId === input.taskId,
    );
    if (!annotation)
      throw new DiffAnnotationError(
        'Annotation was not found for this task.',
        'DIFF_ANNOTATION_NOT_FOUND',
        '$.annotationId',
      );
    if (input.action === 'resolve') {
      const task = await inspectTask(projectRoot, input.taskId);
      if (
        annotation.revision !== current.id ||
        input.evidenceRevision !== current.id ||
        !task.evidence.some((item) => item.id === input.evidenceId)
      )
        throw new DiffAnnotationError(
          'Resolution must link task evidence to the current diff revision.',
          'DIFF_RESOLUTION_EVIDENCE_REQUIRED',
          '$.evidenceId',
        );
      annotation.status = 'resolved';
      annotation.resolution = { revision: current.id, evidenceId: input.evidenceId };
    } else if (input.action === 'reopen') {
      annotation.status = 'open';
      annotation.resolution = null;
      annotation.revision = current.id;
    } else
      throw new DiffAnnotationError(
        'Action must be resolve or reopen.',
        'DIFF_ANNOTATION_INVALID',
        '$.action',
      );
    annotation.updatedAt = new Date().toISOString();
    store.revision += 1;
    await writeStore(projectRoot, store);
    return { annotation: annotationView(annotation, current), revision: store.revision };
  });
}
