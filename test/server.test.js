import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { initProject, readConfig, syncProject } from '../dist/src/core.js';
import { startServer } from '../dist/src/server.js';
import { createTask, resumeTask } from '../dist/src/task-state/service.js';
import { createTaskWorkspace } from '../dist/src/workspaces/git.js';
import { createReviewOrchestrator } from '../dist/src/reviews/orchestrator.js';

const execFile = promisify(execFileCallback);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-api-'));
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const { server, url, token } = await startServer(root);
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = new URL(url).origin;
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const state = await (await fetch(`${origin}/api/state`, { headers })).json();
  return { root, origin, headers, server, revision: state.configRevision };
}

test('console binds to loopback and all API data requires a session token', async (t) => {
  const { origin, headers, server } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
  const denied = await fetch(`${origin}/api/state`);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const state = await fetch(`${origin}/api/state`, { headers });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).config.skills[0], 'spec');
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
});

test('review cancellation uses a separate request and is not queued behind a long review', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-review-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launched;
  const ready = new Promise((resolve) => {
    launched = resolve;
  });
  const reviews = createReviewOrchestrator({
    root,
    source: async () => ({ revision: 'fixture', dirtyFingerprint: 'fixture' }),
    workspace: async () => ({ path: root, snapshotDigest: 'fixture' }),
    reviewerAdapters: new Map([
      [
        'codex',
        {
          contract: { capabilities: { invocation: { state: 'supported' } } },
          operations: {
            planInvocation: () => ({
              executable: process.execPath,
              args: ['--version', '--sandbox', 'read-only'],
            }),
          },
        },
      ],
    ]),
    launch: ({ signal }) =>
      new Promise((resolve) => {
        launched();
        signal.addEventListener('abort', () => resolve({ status: 'cancelled', stdout: '' }), {
          once: true,
        });
      }),
  });
  const { server, url, token } = await startServer(root, { reviewOrchestrator: reviews });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = new URL(url).origin;
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const run = fetch(`${origin}/api/reviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskId: 'task_parent',
      reviewers: [{ providerId: 'codex' }],
      executionAuthorized: true,
      sandbox: 'read-only',
    }),
  });
  await ready;
  const listed = await (await fetch(`${origin}/api/reviews`, { headers })).json();
  const cancelled = await fetch(`${origin}/api/reviews/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reviewId: listed.reviews[0].id }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).state, 'cancelling');
  assert.equal((await (await run).json()).state, 'cancelled');
});

test('server close cancels a long review before Node waits for its POST socket', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-review-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launched;
  const ready = new Promise((resolve) => {
    launched = resolve;
  });
  const reviews = createReviewOrchestrator({
    root,
    source: async () => ({ revision: 'fixture', dirtyFingerprint: 'fixture' }),
    workspace: async () => ({ path: root, snapshotDigest: 'fixture' }),
    reviewerAdapters: new Map([
      [
        'codex',
        {
          contract: { capabilities: { invocation: { state: 'supported' } } },
          operations: {
            planInvocation: () => ({
              executable: process.execPath,
              args: ['--version', '--sandbox', 'read-only'],
            }),
          },
        },
      ],
    ]),
    launch: ({ signal }) =>
      new Promise((resolve) => {
        launched();
        signal.addEventListener('abort', () => resolve({ status: 'cancelled', stdout: '' }), {
          once: true,
        });
      }),
  });
  const { server, url, token } = await startServer(root, { reviewOrchestrator: reviews });
  const origin = new URL(url).origin;
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: origin,
    'Content-Type': 'application/json',
  };
  const run = fetch(`${origin}/api/reviews`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskId: 'task_parent',
      reviewers: [{ providerId: 'codex' }],
      executionAuthorized: true,
      sandbox: 'read-only',
    }),
  });
  await ready;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.equal((await (await run).json()).state, 'cancelled');
});

test('MCP API preview is inert, apply requires the exact reviewed preview, and Codex qualification is explicit', async (t) => {
  const { root, origin, headers } = await fixture(t);
  const definition = {
    schemaVersion: 1,
    id: 'local-fixture',
    transport: 'http',
    endpoint: 'http://127.0.0.1:8765/mcp',
    providers: ['claude'],
    scope: 'project',
    requiredEnvironment: [],
    enabled: true,
  };
  const preview = await fetch(`${origin}/api/mcp/preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ definitions: [definition], reviewActivation: true }),
  });
  assert.equal(preview.status, 200);
  const reviewed = await preview.json();
  assert.equal(reviewed.plan.changes[0].action, 'create');
  await assert.rejects(readFile(path.join(root, '.mcp.json'), 'utf8'));
  const stale = await fetch(`${origin}/api/mcp/apply`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      definitions: [{ ...definition, endpoint: 'http://127.0.0.1:9876/mcp' }],
      previewId: reviewed.previewId,
      authorized: true,
    }),
  });
  assert.equal(stale.status, 409);
  const isolatedPath = await mkdtemp(path.join(os.tmpdir(), 'latchkit-no-codex-'));
  t.after(() => rm(isolatedPath, { recursive: true, force: true }));
  const pathEntries = Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'PATH');
  const pathKeys = pathEntries.length ? pathEntries.map(([key]) => key) : ['PATH'];
  let unsupported;
  try {
    for (const key of pathKeys) process.env[key] = isolatedPath;
    unsupported = await fetch(`${origin}/api/mcp/preview`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        definitions: [{ ...definition, providers: ['codex'] }],
        reviewActivation: true,
      }),
    });
  } finally {
    for (const [key, value] of pathEntries) process.env[key] = value;
    if (!pathEntries.length) delete process.env.PATH;
  }
  assert.equal(unsupported.status, 400);
  const unsupportedBody = await unsupported.json();
  assert.equal(unsupportedBody.code, 'MCP_RUNTIME_DENIED');
});

test('MCP apply refuses stale managed state and a preview that did not review activation', async (t) => {
  const { root, origin, headers } = await fixture(t);
  await syncProject(root);
  const alpha = {
    schemaVersion: 1,
    id: 'alpha',
    transport: 'http',
    endpoint: 'http://127.0.0.1:8765/mcp',
    providers: ['claude'],
    scope: 'project',
    requiredEnvironment: [],
    enabled: true,
  };
  const beta = { ...alpha, id: 'beta', endpoint: 'http://127.0.0.1:8766/mcp' };
  const post = (route, body) =>
    fetch(`${origin}/api/mcp/${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const initial = await (
    await post('preview', { definitions: [alpha], reviewActivation: true })
  ).json();
  assert.equal(
    (await post('apply', { definitions: [alpha], previewId: initial.previewId, authorized: true }))
      .status,
    200,
  );
  const clientA = await (
    await post('preview', { definitions: [alpha], reviewActivation: true })
  ).json();
  const clientB = await (
    await post('preview', { definitions: [alpha, beta], reviewActivation: true })
  ).json();
  assert.equal(
    (
      await post('apply', {
        definitions: [alpha, beta],
        previewId: clientB.previewId,
        authorized: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await post('apply', { definitions: [alpha], previewId: clientA.previewId, authorized: true }))
      .status,
    409,
  );
  assert.match(await readFile(path.join(root, '.mcp.json'), 'utf8'), /"beta"/);
  const inert = await (
    await post('preview', { definitions: [alpha], reviewActivation: false })
  ).json();
  assert.equal(
    (await post('apply', { definitions: [alpha], previewId: inert.previewId, authorized: true }))
      .status,
    400,
  );
});

test('usage API is authenticated, opt-in, and returns only normalized local records', async (t) => {
  const { origin, headers } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/usage`)).status, 401);
  const disabled = await fetch(`${origin}/api/usage/import`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider: 'claude',
      output: {
        provider: 'claude',
        providerVersion: '2.1.258',
        model: 'claude-haiku-4-5',
        observedAt: '2026-09-06T13:38:54.333Z',
        usage: { input_tokens: 172, output_tokens: 7 },
      },
    }),
  });
  assert.equal((await disabled.json()).status, 'disabled');
  const enabled = await fetch(`${origin}/api/usage/settings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal((await enabled.json()).settings.enabled, true);
  const imported = await fetch(`${origin}/api/usage/import`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider: 'claude',
      output: {
        provider: 'claude',
        providerVersion: '2.1.258',
        model: 'claude-haiku-4-5',
        observedAt: '2026-09-06T13:38:54.333Z',
        usage: { input_tokens: 172, output_tokens: 7 },
      },
    }),
  });
  assert.equal((await imported.json()).records[0].status, 'partial');
  const usage = await (await fetch(`${origin}/api/usage`, { headers })).json();
  assert.equal(usage.records[0].tokens.input, 172);
  assert.equal(Object.hasOwn(usage.records[0], 'output'), false);
  assert.equal((await fetch(`${origin}/api/usage/export`, { headers })).status, 200);
});

test('workflow endpoints require authentication, execution authorization, and current revisions', async (t) => {
  const { origin, headers } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/workflows`)).status, 401);
  const listed = await fetch(`${origin}/api/workflows`, { headers });
  assert.deepEqual((await listed.json()).workflows, []);
  const unauthorized = await fetch(`${origin}/api/workflows/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providerId: 'codex',
      prompt: 'Do not execute',
      executionAuthorized: false,
    }),
  });
  assert.equal(unauthorized.status, 400);
  for (const action of ['approve', 'resume', 'cancel']) {
    const missingRevision = await fetch(`${origin}/api/workflows/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ taskId: 'task_missing' }),
    });
    assert.equal(missingRevision.status, 428);
  }
});

test('enhanced specification API registers and inspects revision-bound metadata', async (t) => {
  const { root, origin, headers } = await fixture(t);
  await mkdir(path.join(root, '.latchkit', 'notes'), { recursive: true });
  await writeFile(path.join(root, '.latchkit', 'notes', 'prd.md'), '# PRD\n');
  await writeFile(path.join(root, '.latchkit', 'notes', 'plan.md'), '# Plan\n');
  const task = await createTask(root, {
    title: 'API enhanced task',
    authorization: { source: 'user', scope: 'register spec', reference: 'api test' },
    criteria: [{ description: 'API result' }],
  });
  assert.equal((await fetch(`${origin}/api/spec?taskId=${task.id}`)).status, 401);
  const response = await fetch(`${origin}/api/spec/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskId: task.id,
      expectedRevision: task.revision,
      artifacts: {
        prd: { path: '.latchkit/notes/prd.md', templateVersion: 1 },
        technicalPlan: { path: '.latchkit/notes/plan.md', templateVersion: 1 },
      },
      checks: [{ id: 'api-result', criterionId: task.criteria[0].id, type: 'http' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enhancedWorkflow.revision, 1);
  const inspected = await (
    await fetch(`${origin}/api/spec?taskId=${encodeURIComponent(task.id)}`, { headers })
  ).json();
  assert.equal(inspected.enhancedWorkflow.checks[0].id, 'api-result');
});

test('spec plan-path and migrate-plan APIs are authenticated and never overwrite a conflicting file', async (t) => {
  const { root, origin, headers } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/spec/plan-path?title=API+Plan`)).status, 401);
  const previewed = await (
    await fetch(`${origin}/api/spec/plan-path?title=${encodeURIComponent('API Plan')}`, { headers })
  ).json();
  assert.equal(previewed.path, 'docs/plans/api-plan.md');

  await mkdir(path.join(root, '.latchkit', 'notes'), { recursive: true });
  await writeFile(path.join(root, '.latchkit', 'notes', 'api-plan.md'), '# API plan\n');
  assert.equal(
    (
      await fetch(`${origin}/api/spec/migrate-plan`, {
        method: 'POST',
        body: JSON.stringify({ from: '.latchkit/notes/api-plan.md' }),
      })
    ).status,
    401,
  );
  const migrated = await (
    await fetch(`${origin}/api/spec/migrate-plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: '.latchkit/notes/api-plan.md' }),
    })
  ).json();
  assert.equal(migrated.action, 'migrated');
  assert.equal(migrated.to, 'docs/plans/api-plan.md');
  assert.equal(
    await readFile(path.join(root, 'docs', 'plans', 'api-plan.md'), 'utf8'),
    '# API plan\n',
  );
  assert.equal(
    await readFile(path.join(root, '.latchkit', 'notes', 'api-plan.md'), 'utf8'),
    '# API plan\n',
  );

  await writeFile(path.join(root, '.latchkit', 'notes', 'conflict.md'), '# Conflicting\n');
  const conflict = await fetch(`${origin}/api/spec/migrate-plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from: '.latchkit/notes/conflict.md', to: 'docs/plans/api-plan.md' }),
  });
  assert.equal(conflict.status, 400);
  assert.match((await conflict.json()).error, /already exists with different content/);
  assert.equal(
    await readFile(path.join(root, 'docs', 'plans', 'api-plan.md'), 'utf8'),
    '# API plan\n',
  );
});

test('authenticated API exposes a task-owned diff and revision-bound annotations', async (t) => {
  const { root, origin, headers } = await fixture(t);
  await execFile('git', ['init', root]);
  await execFile('git', ['-C', root, 'config', 'user.email', 'test@example.test']);
  await execFile('git', ['-C', root, 'config', 'user.name', 'Test']);
  await writeFile(path.join(root, 'review.txt'), 'before\n');
  await execFile('git', ['-C', root, 'add', 'review.txt']);
  await execFile('git', ['-C', root, 'commit', '-m', 'base']);
  const task = await createTask(root, { title: 'API diff review', criteria: [] });
  const workspace = await createTaskWorkspace(root, { taskId: task.id });
  await writeFile(path.join(workspace.path, 'review.txt'), 'after\n');

  const diffResponse = await fetch(`${origin}/api/diff?taskId=${encodeURIComponent(task.id)}`, {
    headers,
  });
  assert.equal(diffResponse.status, 200);
  const diff = await diffResponse.json();
  assert.match(diff.diff, /review\.txt/);

  const createdResponse = await fetch(`${origin}/api/annotations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskId: task.id,
      path: 'review.txt',
      side: 'right',
      line: 1,
      body: 'Please verify this change.',
      expectedRevision: diff.revision,
      expectedStoreRevision: 0,
    }),
  });
  assert.equal(createdResponse.status, 200);
  const annotationsResponse = await fetch(
    `${origin}/api/annotations?taskId=${encodeURIComponent(task.id)}`,
    { headers },
  );
  assert.equal(annotationsResponse.status, 200);
  const annotations = await annotationsResponse.json();
  assert.equal(annotations.annotations[0].body, 'Please verify this change.');
  assert.equal(annotations.annotations[0].status, 'open');
});

test('acceptance API runs declared checks and exposes only safe evidence locations to task consumers', async (t) => {
  const { root, origin, headers } = await fixture(t);
  await writeFile(path.join(root, 'source.txt'), 'source\n');
  let task = await createTask(root, {
    title: 'API acceptance',
    authorization: { source: 'user', scope: 'acceptance', reference: 'api test' },
    criteria: [{ description: 'CLI works' }],
  });
  task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
  const response = await fetch(`${origin}/api/acceptance/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskId: task.id,
      executionAuthorized: true,
      document: {
        schemaVersion: 1,
        checks: [
          {
            id: 'cli',
            criterionId: task.criteria[0].id,
            label: 'node version',
            type: 'cli',
            plan: { executable: process.execPath, args: ['--version'] },
          },
        ],
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'passed');
  const listed = await (await fetch(`${origin}/api/tasks`, { headers })).json();
  const artifact = JSON.parse(listed.tasks[0].evidence[0].artifact);
  assert.match(artifact.location, /^\.latchkit\/tasks\/acceptance-evidence\//);
  assert.equal(Object.hasOwn(artifact, 'stdout'), false);
});

test('acceptance API cancellation stops its owned command and returns partial evidence', async (t) => {
  const { root, origin, headers } = await fixture(t);
  await writeFile(path.join(root, 'source.txt'), 'source\n');
  let task = await createTask(root, {
    title: 'Cancel acceptance',
    authorization: { source: 'user', scope: 'acceptance', reference: 'api test' },
    criteria: [{ description: 'Long command' }],
  });
  task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
  const pending = fetch(`${origin}/api/acceptance/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskId: task.id,
      executionAuthorized: true,
      document: {
        schemaVersion: 1,
        checks: [
          {
            id: 'long',
            criterionId: task.criteria[0].id,
            label: 'long command',
            type: 'cli',
            timeoutMs: 5_000,
            plan: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
          },
        ],
      },
    }),
  });
  let cancellation;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const cancelled = await fetch(`${origin}/api/acceptance/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ taskId: task.id }),
    });
    cancellation = await cancelled.json();
    if (cancellation.cancelled) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(cancellation.cancelled, true);
  const result = await (await pending).json();
  assert.equal(result.results[0].outcome, 'cancelled');
  assert.match(result.results[0].artifact.location, /acceptance-evidence/);
});

test('configuration and sync API persist the selected skills with a read-only preview', async (t) => {
  const { root, origin, headers, revision } = await fixture(t);
  const config = { schemaVersion: 1, providers: ['codex'], skills: ['fix', 'review'] };
  const save = await fetch(`${origin}/api/config`, {
    method: 'PUT',
    headers: { ...headers, 'If-Match': revision },
    body: JSON.stringify(config),
  });
  assert.equal(save.status, 200);
  assert.deepEqual(await readConfig(root), config);
  const preview = await (await fetch(`${origin}/api/plan`, { headers })).json();
  // `latchkit-fix/SKILL.md`, `latchkit-review/SKILL.md`, and the shared
  // `references/efficiency.md` resource `review` links to (`fix` links to
  // no shared resource).
  assert.equal(preview.changes.filter((c) => c.action === 'create').length, 3);
  await assert.rejects(readFile(path.join(root, '.agents/skills/latchkit-fix/SKILL.md')), {
    code: 'ENOENT',
  });
  const synced = await fetch(`${origin}/api/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ planId: preview.planId }),
  });
  assert.equal(synced.status, 200);
  assert.match(
    await readFile(path.join(root, '.agents/skills/latchkit-fix/SKILL.md'), 'utf8'),
    /name: latchkit-fix/,
  );
  const repeated = await (await fetch(`${origin}/api/plan`, { headers })).json();
  assert.ok(repeated.changes.every((c) => c.action === 'unchanged'));
});

test('configuration compare-and-set rejects one of two saves made from the same revision', async (t) => {
  const { root, origin, headers, revision } = await fixture(t);
  const save = (skills) =>
    fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { ...headers, 'If-Match': revision },
      body: JSON.stringify({ schemaVersion: 1, providers: ['codex'], skills }),
    });
  const responses = await Promise.all([save(['fix']), save(['review'])]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const conflict = await (
    await Promise.all(responses.map((response) => response.json()))
  ).find((body) => body.code === 'CONFIG_REVISION_CONFLICT');
  assert.equal(conflict.apiVersion, 1);
  assert.match(conflict.configRevision, /^"sha256:[a-f0-9]{64}"$/);
  const saved = await readConfig(root);
  assert.ok(
    [['fix'], ['review']].some((skills) => JSON.stringify(skills) === JSON.stringify(saved.skills)),
  );
});

test('configuration writes require the state revision and expose it as an ETag', async (t) => {
  const { origin, headers } = await fixture(t);
  const state = await fetch(`${origin}/api/state`, { headers });
  assert.match(state.headers.get('etag'), /^"sha256:[a-f0-9]{64}"$/);
  const response = await fetch(`${origin}/api/config`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ schemaVersion: 1, providers: ['codex'], skills: ['fix'] }),
  });
  assert.equal(response.status, 428);
  assert.equal((await response.json()).apiVersion, 1);
});

test('sync rejects a preview made stale by an external CLI sync without applying it again', async (t) => {
  const { root, origin, headers } = await fixture(t);
  const preview = await (await fetch(`${origin}/api/plan`, { headers })).json();
  await execFile(process.execPath, ['dist/src/cli.js', 'sync', '--project', root], {
    cwd: process.cwd(),
  });
  const response = await fetch(`${origin}/api/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ planId: preview.planId }),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'SYNC_PLAN_STALE');
  assert.equal(body.apiVersion, 1);
  assert.match(body.planId, /^sha256:[a-f0-9]{64}$/);
});

test('sync rejects a preview made stale by a managed destination change', async (t) => {
  const { root, origin, headers } = await fixture(t);
  const preview = await (await fetch(`${origin}/api/plan`, { headers })).json();
  const managed = path.join(root, '.agents', 'skills', 'latchkit-spec', 'SKILL.md');
  await mkdir(path.dirname(managed), { recursive: true });
  await writeFile(managed, 'external edit');
  const response = await fetch(`${origin}/api/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ planId: preview.planId }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SYNC_PLAN_STALE');
  assert.equal(await readFile(managed, 'utf8'), 'external edit');
});

test('configuration migration API previews without writing and preserves a v1 backup', async (t) => {
  const { root, origin, headers } = await fixture(t);
  const configPath = path.join(root, '.latchkit', 'config.json');
  const original = '{\n  "schemaVersion": 1,\n  "providers": ["codex"],\n  "skills": ["spec"]\n}\n';
  await writeFile(configPath, original);

  const stateResponse = await fetch(`${origin}/api/state`, { headers });
  assert.equal(stateResponse.status, 200);
  assert.deepEqual((await stateResponse.json()).config, JSON.parse(original));

  const previewResponse = await fetch(`${origin}/api/config/migration?to=2`, { headers });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.status, 'ready');
  assert.equal(await readFile(configPath, 'utf8'), original);

  const applyResponse = await fetch(`${origin}/api/config/migration`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ toVersion: 2 }),
  });
  assert.equal(applyResponse.status, 200);
  const applied = await applyResponse.json();
  assert.equal(applied.status, 'migrated');
  assert.equal(await readFile(path.join(root, ...applied.backupPath.split('/')), 'utf8'), original);
  assert.equal((await readConfig(root)).schemaVersion, 2);
});

test('foreign origins, missing origins, invalid config and oversized requests cannot mutate configuration', async (t) => {
  const { root, origin, headers, revision } = await fixture(t);
  const original = await readConfig(root);
  const body = JSON.stringify({ schemaVersion: 1, providers: [], skills: [] });
  for (const requestOrigin of ['https://example.com', undefined]) {
    const requestHeaders = { ...headers };
    if (requestOrigin) requestHeaders.Origin = requestOrigin;
    else delete requestHeaders.Origin;
    const response = await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { ...requestHeaders, 'If-Match': revision },
      body,
    });
    assert.equal(response.status, 403);
  }
  const invalid = await fetch(`${origin}/api/config`, {
    method: 'PUT',
    headers: { ...headers, 'If-Match': revision },
    body: '{"schemaVersion":2}',
  });
  assert.equal(invalid.status, 400);
  const large = await fetch(`${origin}/api/config`, {
    method: 'PUT',
    headers: { ...headers, 'If-Match': revision },
    body: JSON.stringify({ value: 'x'.repeat(70_000) }),
  });
  assert.equal(large.status, 413);
  assert.deepEqual(await readConfig(root), original);
});

test('configuration API exposes field-specific validation diagnostics', async (t) => {
  const { origin, headers, revision } = await fixture(t);
  const response = await fetch(`${origin}/api/config`, {
    method: 'PUT',
    headers: { ...headers, 'If-Match': revision },
    body: JSON.stringify({
      schemaVersion: 2,
      providers: ['missing'],
      skills: [],
      providerSettings: {},
    }),
  });
  assert.equal(response.status, 400);
  const error = await response.json();
  assert.equal(error.code, 'CONFIG_INVALID');
  assert.equal(error.path, '$.providers[0]');
});

test('untrusted host headers are rejected before serving the console', async (t) => {
  const { origin } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(origin, { headers: { Host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(status, 403);
});

test('server cannot serve arbitrary project files', async (t) => {
  const { origin, headers } = await fixture(t);
  const response = await fetch(`${origin}/.latchkit/config.json`, { headers });
  assert.equal(response.status, 404);
});

test('workbench API paginates local memory, preserves revisions, and only reads task-bound artifacts', async (t) => {
  const { root, origin, headers } = await fixture(t);
  const added = await fetch(`${origin}/api/memory`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Local decision',
      kind: 'decision',
      text: 'Keep recovery bounded.',
    }),
  });
  assert.equal(added.status, 200);
  const memory = await added.json();
  const workbench = await (await fetch(`${origin}/api/workbench`, { headers })).json();
  assert.equal(workbench.memory.memories[0].memory.id, memory.id);
  assert.equal(workbench.memory.revision, 1);
  const updated = await fetch(`${origin}/api/memory/${memory.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ expectedRevision: memory.revision, title: 'Updated local decision' }),
  });
  assert.equal(updated.status, 200);
  const currentMemory = await updated.json();
  const staleDelete = await fetch(`${origin}/api/memory/${memory.id}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ expectedRevision: memory.revision }),
  });
  assert.equal(staleDelete.status, 409);
  const removed = await fetch(`${origin}/api/memory/${memory.id}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ expectedRevision: currentMemory.revision }),
  });
  assert.equal(removed.status, 200);

  await writeFile(path.join(root, 'source.txt'), 'source\n');
  let task = await createTask(root, {
    title: 'Artifact scope',
    authorization: { source: 'user', scope: 'test', reference: 'server test' },
    criteria: [{ description: 'Bound artifact' }],
  });
  task = await resumeTask(root, { taskId: task.id, expectedRevision: task.revision });
  const verification = await fetch(`${origin}/api/acceptance/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskId: task.id,
      executionAuthorized: true,
      document: {
        schemaVersion: 1,
        checks: [
          {
            id: 'version',
            criterionId: task.criteria[0].id,
            label: 'node',
            type: 'cli',
            plan: { executable: process.execPath, args: ['--version'] },
          },
        ],
      },
    }),
  });
  assert.equal(verification.status, 200);
  const evidenceId = (await (await fetch(`${origin}/api/tasks`, { headers })).json()).tasks.find(
    (item) => item.id === task.id,
  ).evidence[0].id;
  const artifact = await fetch(
    `${origin}/api/tasks/artifact?taskId=${encodeURIComponent(task.id)}&evidenceId=${encodeURIComponent(evidenceId)}`,
    { headers },
  );
  assert.equal(artifact.status, 200);
  assert.equal((await artifact.json()).evidenceId, evidenceId);
  const foreign = await fetch(
    `${origin}/api/tasks/artifact?taskId=${encodeURIComponent(task.id)}&evidenceId=evidence_00000000-0000-4000-8000-000000000000`,
    { headers },
  );
  assert.equal(foreign.status, 404);
});
