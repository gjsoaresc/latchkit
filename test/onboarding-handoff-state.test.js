import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ONBOARDING_STATE_PATH,
  emptyOnboardingHandoffState,
  markOnboardingHandoffCompleted,
  markOnboardingHandoffDismissed,
  markOnboardingHandoffStarted,
  readOnboardingHandoffState,
  shouldOfferOnboarding,
  validateOnboardingHandoffState,
  writeOnboardingHandoffState,
} from '../dist/src/installation/onboarding-state.js';

async function tempInstallRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test('an installation root with no state file reads as the not-started default, and offers onboarding', async (t) => {
  const root = await tempInstallRoot(t);
  const state = await readOnboardingHandoffState(root);
  assert.deepEqual(state, emptyOnboardingHandoffState());
  assert.equal(state.status, 'not-started');
  assert.equal(shouldOfferOnboarding(state), true);
});

test('started -> completed is durable, beside the installation root (not inside any project)', async (t) => {
  const root = await tempInstallRoot(t);
  const projectRoot = path.join(root, '..', 'some-project');
  const started = await markOnboardingHandoffStarted({
    installRoot: root,
    projectRoot,
    installedVersion: '1.0.0',
  });
  assert.equal(started.status, 'in-progress');
  assert.equal(started.lastProjectRoot, projectRoot);
  assert.equal(started.installedVersion, '1.0.0');
  assert.ok(started.startedAt);
  assert.equal(shouldOfferOnboarding(started), true);

  // File lives at the installation root, beside `current`/`.launchers.json`.
  const onDisk = JSON.parse(await fs.readFile(path.join(root, ONBOARDING_STATE_PATH), 'utf8'));
  assert.equal(onDisk.status, 'in-progress');

  const completed = await markOnboardingHandoffCompleted({ installRoot: root, projectRoot });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.equal(shouldOfferOnboarding(completed), false);

  // An ordinary launch/upgrade must not repeat onboarding once completed: a
  // later "started" call for the same or another project never regresses a
  // completed installation back to in-progress.
  const restarted = await markOnboardingHandoffStarted({ installRoot: root, projectRoot });
  assert.equal(restarted.status, 'completed');
});

test('dismissed stops being offered, and a later mark-started resumes it', async (t) => {
  const root = await tempInstallRoot(t);
  await markOnboardingHandoffStarted({ installRoot: root, projectRoot: '/tmp/project-a' });
  const dismissed = await markOnboardingHandoffDismissed({ installRoot: root });
  assert.equal(dismissed.status, 'dismissed');
  assert.ok(dismissed.dismissedAt);
  assert.equal(shouldOfferOnboarding(dismissed), false);

  const resumed = await markOnboardingHandoffStarted({ installRoot: root });
  assert.equal(resumed.status, 'in-progress');
  assert.equal(shouldOfferOnboarding(resumed), true);
  // startedAt is preserved from the original run rather than reset.
  assert.equal(resumed.startedAt, (await readOnboardingHandoffState(root)).startedAt);
});

test('validateOnboardingHandoffState rejects unknown fields, unknown status, and a bad schema version', () => {
  const base = emptyOnboardingHandoffState();
  assert.deepEqual(validateOnboardingHandoffState(base), base);
  assert.throws(() => validateOnboardingHandoffState({ ...base, extra: true }));
  assert.throws(() => validateOnboardingHandoffState({ ...base, status: 'unknown-status' }));
  assert.throws(() => validateOnboardingHandoffState({ ...base, schemaVersion: 2 }));
  const missing = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'status'));
  assert.throws(() => validateOnboardingHandoffState(missing));
});

test('a corrupt state file surfaces a typed OnboardingHandoffError instead of silently defaulting', async (t) => {
  const root = await tempInstallRoot(t);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, ONBOARDING_STATE_PATH), 'not json');
  await assert.rejects(readOnboardingHandoffState(root), (error) => {
    assert.equal(error.name, 'OnboardingHandoffError');
    return true;
  });
});

test('writeOnboardingHandoffState round-trips exactly through validation', async (t) => {
  const root = await tempInstallRoot(t);
  const state = {
    ...emptyOnboardingHandoffState(),
    status: 'in-progress',
    lastProjectRoot: '/tmp/some-project',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeOnboardingHandoffState(state, root);
  assert.deepEqual(await readOnboardingHandoffState(root), state);
});
