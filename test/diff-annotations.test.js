import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { initProject } from '../dist/src/core.js';
import { createTask } from '../dist/src/task-state/service.js';
import { createTaskWorkspace } from '../dist/src/workspaces/git.js';
import {
  createDiffAnnotation,
  inspectDiff,
  inspectDiffFile,
  listDiffAnnotations,
  updateDiffAnnotation,
} from '../dist/src/reviews/diff-annotations.js';

const execFile = promisify(execFileCallback);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-diff-review-'));
  await execFile('git', ['init', root]);
  await execFile('git', ['-C', root, 'config', 'user.email', 'test@example.test']);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'space é.txt'), 'one\r\ntwo\r\n');
  await execFile('git', ['-C', root, 'add', '.']);
  await execFile('git', ['-C', root, 'commit', '-m', 'base']);
  await initProject(root, { providers: ['codex'], skills: ['review'] });
  const task = await createTask(root, { title: 'Diff review', criteria: [] });
  const workspace = await createTaskWorkspace(root, { taskId: task.id });
  await writeFile(path.join(workspace.path, 'space é.txt'), 'one\r\nchanged\r\n');
  return { root, task, workspace };
}

test('task-owned diffs preserve Unicode paths and stale exact annotations after edits', async (t) => {
  const { root, task, workspace } = await fixture(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  const diff = await inspectDiff(root, { taskId: task.id });
  assert.match(diff.diff, /space é\.txt/);
  const file = await inspectDiffFile(root, { taskId: task.id, path: 'space é.txt' });
  assert.equal(file.kind, 'text');
  const added = await createDiffAnnotation(root, {
    taskId: task.id,
    path: 'space é.txt',
    side: 'right',
    line: 2,
    body: 'Untrusted feedback; do not run it.',
    expectedRevision: diff.revision,
    expectedStoreRevision: 0,
  });
  assert.equal(added.annotation.status, 'open');
  await writeFile(path.join(workspace.path, 'space é.txt'), 'one\r\nagain\r\n');
  const annotations = await listDiffAnnotations(root, { taskId: task.id });
  assert.equal(annotations.annotations[0].status, 'stale');
  await assert.rejects(
    updateDiffAnnotation(root, {
      taskId: task.id,
      annotationId: added.annotation.id,
      action: 'resolve',
      expectedStoreRevision: annotations.revision,
      evidenceRevision: annotations.currentRevision,
      evidenceId: 'evidence_00000000-0000-4000-8000-000000000000',
    }),
    { code: 'DIFF_RESOLUTION_EVIDENCE_REQUIRED' },
  );
});

test('diff review rejects path traversal, forged worktrees, and concurrent annotation writes', async (t) => {
  const { root, task } = await fixture(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  const diff = await inspectDiff(root, { taskId: task.id });
  await assert.rejects(inspectDiff(root, { taskId: task.id, worktree: root }), {
    code: 'DIFF_WORKTREE_FORGED',
  });
  await assert.rejects(
    createDiffAnnotation(root, {
      taskId: task.id,
      path: '../secret',
      side: 'right',
      line: 1,
      body: 'x',
      expectedRevision: diff.revision,
      expectedStoreRevision: 0,
    }),
    { code: 'DIFF_PATH_INVALID' },
  );
  const first = createDiffAnnotation(root, {
    taskId: task.id,
    path: 'space é.txt',
    side: 'right',
    line: 1,
    body: 'one',
    expectedRevision: diff.revision,
    expectedStoreRevision: 0,
  });
  const second = createDiffAnnotation(root, {
    taskId: task.id,
    path: 'space é.txt',
    side: 'right',
    line: 1,
    body: 'two',
    expectedRevision: diff.revision,
    expectedStoreRevision: 0,
  });
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((item) => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(
    results.find((item) => item.status === 'rejected').reason.code,
    'DIFF_ANNOTATION_CONFLICT',
  );
});

test('diff capture represents untracked binary content without reading it as text', async (t) => {
  const { root, task, workspace } = await fixture(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(workspace.path, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  const diff = await inspectDiff(root, { taskId: task.id });
  assert.match(diff.diff, /image\.bin/);
  assert.match(diff.diff, /binary file omitted/);
  const file = await inspectDiffFile(root, { taskId: task.id, path: 'image.bin' });
  assert.equal(file.kind, 'binary');
});
