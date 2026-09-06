import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../dist/src/server.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-api-')));
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
  return { root, origin, headers };
}

test('the onboarding API requires a session token, like every other route', async (t) => {
  const { origin } = await fixture(t);
  const response = await fetch(`${origin}/api/onboarding`);
  assert.equal(response.status, 401);
});

test('GET /api/onboarding reports honest, unauthenticated provider state before any project init', async (t) => {
  const { origin, headers } = await fixture(t);
  const response = await fetch(`${origin}/api/onboarding`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.apiVersion, 1);
  assert.equal(body.initialized, false);
  assert.equal(body.readiness.nextStepId, 'project');
  for (const provider of body.providers) {
    assert.equal(provider.authenticated, 'unknown');
  }
});

test('the onboarding API drives project/providers/workspace/verification/usage/preview/apply/complete', async (t) => {
  const { origin, headers } = await fixture(t);
  const post = (route, body) =>
    fetch(`${origin}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

  const project = await post('onboarding/project', { providers: ['codex'], skills: ['spec'] });
  assert.equal(project.status, 200);
  assert.deepEqual((await project.json()).providers, ['codex']);

  const providers = await post('onboarding/providers', { providers: ['codex', 'claude'] });
  assert.deepEqual((await providers.json()).providers.sort(), ['claude', 'codex']);

  const workspace = await post('onboarding/workspace', { executionPreference: 'always-worktree' });
  assert.equal((await workspace.json()).workspace.executionPreference, 'always-worktree');

  const badVerification = await post('onboarding/verification', { mode: 'turbo' });
  assert.equal(badVerification.status, 400);
  const verification = await post('onboarding/verification', { mode: 'fast' });
  assert.equal((await verification.json()).settings.defaultMode, 'fast');

  const badUsage = await post('onboarding/usage', { enabled: 'yes' });
  assert.equal(badUsage.status, 400);
  const usage = await post('onboarding/usage', { enabled: true });
  assert.equal((await usage.json()).settings.enabled, true);

  const preview = await post('onboarding/preview');
  const previewBody = await preview.json();
  assert.equal(previewBody.conflicts.length, 0);
  assert.ok(previewBody.planId);

  const apply = await post('onboarding/apply', { planId: previewBody.planId });
  assert.equal(apply.status, 200);
  assert.equal((await apply.json()).conflicts.length, 0);

  const skip = await post('onboarding/skip', { stepId: 'usage' });
  assert.equal(skip.status, 200);
  const back = await post('onboarding/back', { stepId: 'usage' });
  assert.equal(back.status, 200);

  const complete = await post('onboarding/complete');
  assert.equal((await complete.json()).progress.status, 'completed');

  const state = await fetch(`${origin}/api/onboarding`, { headers });
  assert.equal((await state.json()).progress.status, 'completed');
});

test('dismiss is reachable through the API and preserves already-saved configuration', async (t) => {
  const { origin, headers } = await fixture(t);
  const post = (route, body) =>
    fetch(`${origin}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  await post('onboarding/project', { providers: ['codex'] });
  const dismiss = await post('onboarding/dismiss');
  assert.equal((await dismiss.json()).progress.status, 'dismissed');
  const state = await fetch(`${origin}/api/onboarding`, { headers });
  const body = await state.json();
  assert.deepEqual(body.selection.providers, ['codex']); // config preserved, not discarded
});
