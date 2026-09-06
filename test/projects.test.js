import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  inspectProject,
  listProjects,
  registerProject,
  removeProject,
  resolveProjectIdentity,
} from '../dist/src/projects/service.js';
import { ProjectError } from '../dist/src/projects/contracts.js';
import { createTask } from '../dist/src/task-state/service.js';
import { readTaskState, writeTaskState } from '../dist/src/task-state/store.js';
import { initProject } from '../dist/src/core.js';
import { startServer } from '../dist/src/server.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');

async function git(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
}

async function tempDir(t, prefix) {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return base;
}

async function registryRoot(t) {
  return tempDir(t, 'latchkit-projects-registry-');
}

async function plainProject(t, name = 'plain-project') {
  const base = await tempDir(t, 'latchkit-projects-plain-');
  const root = path.join(base, name);
  await mkdir(root, { recursive: true });
  return root;
}

async function gitProject(t, name = 'git-project') {
  const base = await tempDir(t, 'latchkit-projects-git-');
  const root = path.join(base, name);
  await mkdir(root, { recursive: true });
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Latchkit test']);
  await writeFile(path.join(root, 'file.txt'), 'hello\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'base']);
  return root;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('registry add/list/remove and a repeated registration is idempotent, not a duplicate', async (t) => {
  const registry = await registryRoot(t);
  const project = await plainProject(t);
  const first = await registerProject(registry, { root: project, source: 'manual' });
  assert.match(first.id, /^project_[0-9a-f-]{36}$/i);
  assert.equal(first.displayName, path.basename(project));
  assert.equal(first.addedVia, 'manual');
  const second = await registerProject(registry, { root: project, source: 'init' });
  assert.equal(second.id, first.id, 'the same resolved root reconciles to the same record');
  assert.equal(second.addedVia, 'manual', 'addedVia records provenance and is never overwritten');
  assert.equal(second.lastSeenVia, 'init', 'lastSeenVia reflects the most recent touch');
  const listed = await listProjects(registry);
  assert.equal(
    listed.projects.length,
    1,
    'a repeated registration never creates a duplicate entry',
  );
  const removed = await removeProject(registry, first.id);
  assert.deepEqual(removed, { removed: true, id: first.id });
  assert.deepEqual((await listProjects(registry)).projects, []);
  const info = await stat(project);
  assert.ok(info.isDirectory(), 'removing from the registry never deletes the project itself');
  await rejects(removeProject(registry, first.id), 'PROJECT_NOT_FOUND');
});

test('registering an existing project only updates the display name when one is explicitly supplied', async (t) => {
  const registry = await registryRoot(t);
  const project = await plainProject(t, 'my-app');
  const first = await registerProject(registry, { root: project, source: 'manual' });
  assert.equal(first.displayName, 'my-app');
  const touched = await registerProject(registry, { root: project, source: 'task-run' });
  assert.equal(
    touched.displayName,
    'my-app',
    'a touch without displayName keeps the existing name',
  );
  const renamed = await registerProject(registry, {
    root: project,
    displayName: 'Renamed Project',
    source: 'manual',
  });
  assert.equal(renamed.displayName, 'Renamed Project');
});

test('an unknown project source is rejected rather than silently accepted', async (t) => {
  const registry = await registryRoot(t);
  const project = await plainProject(t);
  await rejects(
    registerProject(registry, { root: project, source: 'not-a-real-source' }),
    'PROJECT_SOURCE_INVALID',
  );
});

test('identity grouping combines a main checkout and its registered linked worktree without double-counting', async (t) => {
  const registry = await registryRoot(t);
  const root = await gitProject(t);
  const worktreePath = path.join(path.dirname(root), 'linked-worktree');
  await git(root, ['worktree', 'add', '-b', 'feature', worktreePath]);

  const mainIdentity = await resolveProjectIdentity(root);
  assert.equal(mainIdentity.kind, 'git');
  assert.equal(mainIdentity.isMainCheckout, true);
  const linkedIdentity = await resolveProjectIdentity(worktreePath);
  assert.equal(linkedIdentity.kind, 'git');
  assert.equal(linkedIdentity.isMainCheckout, false);
  assert.equal(mainIdentity.commonDir, linkedIdentity.commonDir);

  const main = await registerProject(registry, { root, source: 'manual' });
  const linked = await registerProject(registry, { root: worktreePath, source: 'manual' });
  const listed = await listProjects(registry);
  const mainEntry = listed.projects.find((item) => item.id === main.id);
  const linkedEntry = listed.projects.find((item) => item.id === linked.id);
  assert.ok(mainEntry && linkedEntry);
  assert.equal(mainEntry.identity.kind, 'git');
  assert.equal(mainEntry.identity.groupKey, linkedEntry.identity.groupKey);
  assert.equal(mainEntry.isRepresentative, true, 'the main checkout represents the group');
  assert.equal(linkedEntry.isRepresentative, false, 'the linked worktree is not a second card');
  assert.deepEqual(new Set(mainEntry.groupMemberIds), new Set([main.id, linked.id]));
  assert.deepEqual(new Set(linkedEntry.groupMemberIds), new Set([main.id, linked.id]));
  assert.equal(
    listed.projects.filter((item) => item.isRepresentative).length,
    1,
    'a collapsed overview grid shows exactly one card for this repository',
  );

  // Separate tasks/runs stay independently inspectable even though the worktree is not
  // the representative card.
  const detail = await inspectProject(registry, linked.id);
  assert.equal(detail.project.id, linked.id);
  assert.equal(detail.group.length, 2);
  assert.ok(detail.worktrees.some((item) => item.path === root && item.isMain));
  assert.ok(
    detail.worktrees.some(
      (item) => item.path === worktreePath && item.registeredProjectId === linked.id,
    ),
  );
});

test('a moved or missing project root is reported unavailable, never as zero activity or zero usage', async (t) => {
  const registry = await registryRoot(t);
  const root = await plainProject(t);
  const record = await registerProject(registry, { root, source: 'manual' });
  await rm(root, { recursive: true, force: true });

  const listed = await listProjects(registry);
  const entry = listed.projects.find((item) => item.id === record.id);
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.identity.kind, 'unavailable');
  assert.equal(entry.identity.reason, 'missing');
  assert.equal(entry.isRepresentative, true);

  const detail = await inspectProject(registry, record.id);
  assert.equal(detail.tasks, null, 'unavailable task state is null, not an empty-but-present list');
  assert.equal(detail.workflows, null);
  assert.equal(detail.memory, null);
  assert.equal(detail.usage.status, 'unavailable');
  assert.ok(detail.usage.reason);
  assert.deepEqual(detail.specs, []);
  assert.deepEqual(detail.worktrees, []);
});

test('duplicate display names across unrelated projects are both listed, disambiguated by location', async (t) => {
  const registry = await registryRoot(t);
  const a = await plainProject(t, 'shared-name');
  const b = await plainProject(t, 'shared-name');
  const first = await registerProject(registry, { root: a, source: 'manual' });
  const second = await registerProject(registry, { root: b, source: 'manual' });
  assert.notEqual(first.id, second.id);
  const listed = await listProjects(registry);
  const matches = listed.projects.filter((item) => item.displayName === 'shared-name');
  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].root, matches[1].root);
});

test('an empty registry lists no projects rather than erroring', async (t) => {
  const registry = await registryRoot(t);
  const listed = await listProjects(registry);
  assert.deepEqual(listed.projects, []);
  assert.equal(listed.revision, 0);
});

test('a non-terminal task older than the activity window is reported active but flagged stale', async (t) => {
  const registry = await registryRoot(t);
  const root = await plainProject(t);
  const record = await registerProject(registry, { root, source: 'manual' });
  const created = await createTask(root, {
    title: 'Long-running task',
    mutationId: `event_${randomUUID()}`,
    authorization: {
      source: 'user',
      scope: 'test activity staleness',
      reference: 'direct test request',
    },
  });
  const state = await readTaskState(root);
  const task = state.tasks.find((item) => item.id === created.id);
  task.state = 'blocked';
  task.updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeTaskState(root, state);

  const listed = await listProjects(registry);
  const entry = listed.projects.find((item) => item.id === record.id);
  assert.equal(entry.status, 'active');
  assert.equal(entry.activityStale, true);
  assert.equal(entry.activity.openTasks, 1);
  assert.equal(entry.activity.totalTasks, 1);
});

test('a recent non-terminal task is reported active without the stale flag, and a planned task is idle', async (t) => {
  const registry = await registryRoot(t);
  const root = await plainProject(t);
  const record = await registerProject(registry, { root, source: 'manual' });
  const idleListing = await listProjects(registry);
  assert.equal(idleListing.projects.find((item) => item.id === record.id).status, 'idle');

  const created = await createTask(root, {
    title: 'Fresh task',
    mutationId: `event_${randomUUID()}`,
    authorization: {
      source: 'user',
      scope: 'test recent activity',
      reference: 'direct test request',
    },
  });
  const state = await readTaskState(root);
  const task = state.tasks.find((item) => item.id === created.id);
  task.state = 'blocked';
  task.updatedAt = new Date().toISOString();
  await writeTaskState(root, state);

  const activeListing = await listProjects(registry);
  const entry = activeListing.projects.find((item) => item.id === record.id);
  assert.equal(entry.status, 'active');
  assert.equal(entry.activityStale, false);
});

test('project-scoped reads refuse an invalid or unknown project ID', async (t) => {
  const registry = await registryRoot(t);
  await rejects(inspectProject(registry, 'not-a-real-id'), 'PROJECT_ID_INVALID');
  await rejects(inspectProject(registry, `project_${randomUUID()}`), 'PROJECT_NOT_FOUND');
  await rejects(registerProject(registry, {}), 'PROJECT_ROOT_INVALID');
});

test('registering a path that does not exist is refused rather than reserved for later', async (t) => {
  const registry = await registryRoot(t);
  const base = await tempDir(t, 'latchkit-projects-missing-');
  await rejects(
    registerProject(registry, { root: path.join(base, 'does-not-exist'), source: 'manual' }),
    'PROJECT_ROOT_UNAVAILABLE',
  );
});

test('CLI init hooks the registry, and CLI projects list/remove operate on it', async (t) => {
  const registry = await registryRoot(t);
  const root = await plainProject(t, 'cli-project');
  const env = { ...process.env, LATCHKIT_PROJECTS_ROOT: registry };
  await execFileAsync(process.execPath, [cli, 'init', '--project', root], {
    windowsHide: true,
    env,
  });
  const { stdout: listed } = await execFileAsync(process.execPath, [cli, 'projects', 'list'], {
    windowsHide: true,
    env,
  });
  const listedJson = JSON.parse(listed);
  assert.equal(listedJson.projects.length, 1);
  assert.equal(listedJson.projects[0].addedVia, 'init');
  const id = listedJson.projects[0].id;
  const { stdout: removed } = await execFileAsync(
    process.execPath,
    [cli, 'projects', 'remove', '--id', id],
    { windowsHide: true, env },
  );
  assert.deepEqual(JSON.parse(removed), { removed: true, id });
});

test('starting the local console touches the registry, and the additive /api/projects/* routes work end to end', async (t) => {
  const registry = await registryRoot(t);
  const previousOverride = process.env.LATCHKIT_PROJECTS_ROOT;
  process.env.LATCHKIT_PROJECTS_ROOT = registry;
  t.after(() => {
    if (previousOverride === undefined) delete process.env.LATCHKIT_PROJECTS_ROOT;
    else process.env.LATCHKIT_PROJECTS_ROOT = previousOverride;
  });
  const root = await plainProject(t, 'console-project');
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url, token } = await startServer(root);
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = new URL(url).origin;
  const headers = { Authorization: `Bearer ${token}`, Origin: origin };

  // The single-project routes keep serving exactly this project, unchanged.
  const state = await (await fetch(`${origin}/api/state`, { headers })).json();
  assert.equal(state.doctor.project, root);

  // ui-start registered this project.
  const list = await (await fetch(`${origin}/api/projects`, { headers })).json();
  const entry = list.projects.find((item) => item.root === root);
  assert.ok(entry, 'starting the console registers its project');
  assert.equal(entry.addedVia, 'ui-start');

  const detail = await (await fetch(`${origin}/api/projects/${entry.id}`, { headers })).json();
  assert.equal(detail.project.id, entry.id);
  assert.equal(detail.usage.status, 'available');

  // A different, unregistered project ID is refused rather than falling back to this server's
  // own fixed root or mixing another project's data into the response.
  const missing = await fetch(`${origin}/api/projects/project_${randomUUID()}`, { headers });
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.code, 'PROJECT_NOT_FOUND');

  const added = await (
    await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: await plainProject(t, 'second-project') }),
    })
  ).json();
  assert.match(added.id, /^project_[0-9a-f-]{36}$/i);

  const removeResponse = await fetch(`${origin}/api/projects/${added.id}`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(removeResponse.status, 200);
  assert.deepEqual(await removeResponse.json(), {
    apiVersion: 1,
    removed: true,
    id: added.id,
  });

  // Registered project routes require the session token just like the existing single-project
  // routes.
  const denied = await fetch(`${origin}/api/projects`);
  assert.equal(denied.status, 401);
});

test('ProjectError is exported for callers distinguishing registry failure codes', () => {
  const error = new ProjectError('example', 'PROJECT_EXAMPLE');
  assert.equal(error.code, 'PROJECT_EXAMPLE');
  assert.equal(error.name, 'ProjectError');
});
