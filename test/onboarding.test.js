import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject, readConfig } from '../dist/src/core.js';
import { inspectUsage } from '../dist/src/usage/service.js';
import {
  ONBOARDING_STEP_IDS,
  OnboardingError,
  isOnboardingStepId,
  nextOnboardingStepId,
  validateOnboardingState,
} from '../dist/src/onboarding/contracts.js';
import { emptyOnboardingState, readOnboardingState } from '../dist/src/onboarding/store.js';
import {
  applyOnboardingSetup,
  backStep,
  completeOnboarding,
  dismissOnboarding,
  inspectOnboarding,
  previewOnboardingSetup,
  registerProjectWithRegistry,
  selectProject,
  skipStep,
  startOnboarding,
  updateProjectSelection,
  updateUsagePreference,
  updateVerificationPreference,
  updateWorkspacePreference,
} from '../dist/src/onboarding/service.js';
import { readOnboardingHandoffState } from '../dist/src/installation/onboarding-state.js';

async function tempProject(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
async function tempInstallRoot(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-install-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test('contracts: step order, validation, and nextOnboardingStepId', () => {
  assert.deepEqual(
    [...ONBOARDING_STEP_IDS],
    ['project', 'providers', 'workspace', 'verification', 'usage', 'preview'],
  );
  assert.equal(isOnboardingStepId('providers'), true);
  assert.equal(isOnboardingStepId('nope'), false);
  const empty = emptyOnboardingState(() => new Date('2026-01-01T00:00:00.000Z'));
  assert.deepEqual(validateOnboardingState(empty), empty);
  assert.equal(nextOnboardingStepId(empty.progress), 'project');
  assert.throws(() => validateOnboardingState({ ...empty, schemaVersion: 2 }), OnboardingError);
  assert.throws(
    () => validateOnboardingState({ ...empty, progress: { ...empty.progress, status: 'nope' } }),
    OnboardingError,
  );
});

test('inspectOnboarding on an uninitialized project is honest: not initialized, project step required next', async (t) => {
  const root = await tempProject(t);
  const view = await inspectOnboarding(root);
  assert.equal(view.initialized, false);
  assert.equal(view.readiness.ready, false);
  assert.ok(view.readiness.missingPrerequisites.length > 0);
  assert.equal(view.readiness.nextStepId, 'project');
  // Every provider reports authentication honestly as unknown; Latchkit
  // never claims a verified sign-in without provider adapter evidence.
  for (const provider of view.providers) {
    assert.equal(provider.authenticated, 'unknown');
    assert.ok(['unavailable', 'installed', 'configured'].includes(provider.status));
    assert.equal(provider.selected, false);
  }
});

test('selectProject initializes idempotently, advances the project step, and calls the #94 registry integration point', async (t) => {
  const root = await tempProject(t);
  // registerProjectWithRegistry is the named, documented integration point for
  // #94's future local project registry (see src/onboarding/service.ts). It
  // is a no-op today but must exist, be exported, and be callable without
  // throwing so a future registry implementation can replace its body.
  assert.equal(typeof registerProjectWithRegistry, 'function');
  await assert.doesNotReject(registerProjectWithRegistry(root));

  const config = await selectProject(root, { providers: ['codex'], skills: ['spec'] });
  assert.deepEqual(config.providers, ['codex']);
  assert.deepEqual(config.skills, ['spec']);
  const afterFirst = await readOnboardingState(root);
  assert.deepEqual(afterFirst.progress.completedStepIds, ['project']);
  assert.equal(afterFirst.progress.status, 'in-progress');

  // Calling it again on an already-initialized project must not duplicate or
  // overwrite the existing configuration (initProject is idempotent).
  const again = await selectProject(root, { providers: ['claude'] });
  assert.deepEqual(again.providers, ['codex']); // unchanged: init never replaces an existing config
  const afterSecond = await readOnboardingState(root);
  assert.deepEqual(afterSecond.progress.completedStepIds, ['project']); // not duplicated
});

test('updateProjectSelection requires at least one field and merges without clobbering the other', async (t) => {
  const root = await tempProject(t);
  await initProject(root, { providers: ['claude'], skills: ['spec', 'build'] });
  await assert.rejects(updateProjectSelection(root), OnboardingError);

  const providersOnly = await updateProjectSelection(root, { providers: ['codex', 'cursor'] });
  assert.deepEqual(providersOnly.providers.sort(), ['codex', 'cursor']);
  assert.deepEqual(providersOnly.skills, ['spec', 'build']); // untouched

  const skillsOnly = await updateProjectSelection(root, { skills: ['review'] });
  assert.deepEqual(skillsOnly.providers.sort(), ['codex', 'cursor']); // untouched
  assert.deepEqual(skillsOnly.skills, ['review']);

  const state = await readOnboardingState(root);
  assert.ok(state.progress.completedStepIds.includes('providers'));
});

test('updateWorkspacePreference requires a field, merges with the existing preference, and preserves other config', async (t) => {
  const root = await tempProject(t);
  await initProject(root, { providers: ['claude'], skills: ['spec'] });
  await assert.rejects(updateWorkspacePreference(root, {}), OnboardingError);

  const first = await updateWorkspacePreference(root, { executionPreference: 'always-worktree' });
  assert.equal(first.workspace.executionPreference, 'always-worktree');
  assert.equal(first.workspace.worktreeRoot, '.latchkit/worktrees'); // default preserved
  assert.deepEqual(first.providers, ['claude']); // unrelated config untouched

  const second = await updateWorkspacePreference(root, { worktreeRoot: 'custom/worktrees' });
  assert.equal(second.workspace.executionPreference, 'always-worktree'); // preserved from the first call
  assert.equal(second.workspace.worktreeRoot, 'custom/worktrees');
});

test('updateVerificationPreference sets the project default and advances its step', async (t) => {
  const root = await tempProject(t);
  await initProject(root, { providers: ['claude'], skills: ['spec'] });
  const result = await updateVerificationPreference(root, 'fast');
  assert.equal(result.settings.defaultMode, 'fast');
  const state = await readOnboardingState(root);
  assert.ok(state.progress.completedStepIds.includes('verification'));
});

test('updateUsagePreference is an explicit decision; declining never reports usage as zero', async (t) => {
  const root = await tempProject(t);
  await initProject(root, { providers: ['claude'], skills: ['spec'] });
  const declined = await updateUsagePreference(root, false);
  assert.equal(declined.settings.enabled, false);
  const inspected = await inspectUsage(root);
  assert.equal(inspected.billing.status, 'unknown'); // never "zero"
  assert.equal(inspected.summary.tokens.input, null);

  const enabled = await updateUsagePreference(root, true);
  assert.equal(enabled.settings.enabled, true);
});

test('preview reuses the same shape as sync --dry-run and preserves an unrelated user file across apply', async (t) => {
  const root = await tempProject(t);
  await selectProject(root, { providers: ['codex'], skills: ['spec'] });
  await fs.writeFile(path.join(root, 'notes.txt'), 'user-owned, unmanaged by Latchkit\n');

  const preview = await previewOnboardingSetup(root);
  assert.ok(Array.isArray(preview.changes));
  assert.ok(Array.isArray(preview.conflicts));
  assert.equal(preview.conflicts.length, 0);
  assert.ok(preview.planId);

  const applied = await applyOnboardingSetup(root, { planId: preview.planId });
  assert.equal(applied.conflicts.length, 0);

  // The unrelated file the user created is untouched by setup.
  assert.equal(
    await fs.readFile(path.join(root, 'notes.txt'), 'utf8'),
    'user-owned, unmanaged by Latchkit\n',
  );
  const state = await readOnboardingState(root);
  assert.ok(state.progress.completedStepIds.includes('preview'));
});

test('apply rejects a stale plan the same way sync --plan-id already does', async (t) => {
  const root = await tempProject(t);
  await selectProject(root, { providers: ['codex'], skills: ['spec'] });
  await previewOnboardingSetup(root);
  await updateProjectSelection(root, { skills: ['build'] }); // changes the plan underneath us
  await assert.rejects(applyOnboardingSetup(root, { planId: 'sha256:stale' }), (error) => {
    assert.equal(error.code, 'SYNC_PLAN_STALE');
    return true;
  });
});

test('a locally edited managed file surfaces as a preview/apply conflict, never silently overwritten', async (t) => {
  const root = await tempProject(t);
  await selectProject(root, { providers: ['claude'], skills: ['spec'] });
  const firstPreview = await previewOnboardingSetup(root);
  assert.equal(firstPreview.conflicts.length, 0);
  await applyOnboardingSetup(root, { planId: firstPreview.planId });

  const managedFile = path.join(root, '.claude', 'skills', 'latchkit-spec', 'SKILL.md');
  await fs.appendFile(managedFile, '\nlocally edited outside Latchkit\n');

  const conflicted = await previewOnboardingSetup(root);
  assert.ok(conflicted.conflicts.length > 0);
  assert.match(conflicted.conflicts[0].reason, /local edits/i);

  await assert.rejects(applyOnboardingSetup(root, { planId: conflicted.planId }), (error) => {
    assert.ok(Array.isArray(error.conflicts) && error.conflicts.length > 0);
    return true;
  });
  // The user's local edit is preserved, never silently overwritten.
  assert.match(await fs.readFile(managedFile, 'utf8'), /locally edited outside Latchkit/);
});

test('the required "project" step cannot be skipped; every other step can be', async (t) => {
  const root = await tempProject(t);
  await assert.rejects(skipStep(root, 'project'), (error) => {
    assert.equal(error.code, 'ONBOARDING_STEP_REQUIRED');
    return true;
  });
  await selectProject(root, { providers: ['codex'] });
  const afterSkip = await skipStep(root, 'providers');
  assert.deepEqual(afterSkip.progress.skippedStepIds, ['providers']);
  assert.equal(afterSkip.progress.currentStepId, 'workspace');
});

test('back undoes completion/skip and returns to the previous step without discarding saved settings', async (t) => {
  const root = await tempProject(t);
  await selectProject(root, { providers: ['codex'], skills: ['spec'] });
  await updateProjectSelection(root, { skills: ['spec', 'build'] });
  const afterBack = await backStep(root, 'providers');
  assert.equal(afterBack.progress.currentStepId, 'project');
  assert.ok(!afterBack.progress.completedStepIds.includes('providers'));
  // The actual saved selection from the completed step is not rolled back —
  // only wizard progress is. Config remains exactly what was saved.
  const config = await readConfig(root);
  assert.deepEqual(config.skills, ['spec', 'build']);
});

test('an unknown step ID is rejected for skip/back/complete-via-advance', async (t) => {
  const root = await tempProject(t);
  await selectProject(root, { providers: ['codex'] });
  await assert.rejects(skipStep(root, 'not-a-real-step'), OnboardingError);
  await assert.rejects(backStep(root, 'not-a-real-step'), OnboardingError);
});

test('dismiss records the machine-local hand-off, and any later step action resumes without repeating from scratch', async (t) => {
  const root = await tempProject(t);
  const installRoot = await tempInstallRoot(t);
  await selectProject(root, { providers: ['codex'], skills: ['spec'] });

  const dismissed = await dismissOnboarding(root, { installRoot });
  assert.equal(dismissed.progress.status, 'dismissed');
  const handoffAfterDismiss = await readOnboardingHandoffState(installRoot);
  assert.equal(handoffAfterDismiss.status, 'dismissed');

  // Resuming preserves the already-completed "project" step: it is not
  // repeated/duplicated, and the project's own saved config is untouched.
  const resumed = await updateWorkspacePreference(root, { executionPreference: 'ask' });
  assert.equal(resumed.providers[0], 'codex');
  const state = await readOnboardingState(root);
  assert.equal(state.progress.status, 'in-progress');
  assert.deepEqual(state.progress.completedStepIds, ['project', 'workspace']);
});

test('completeOnboarding marks the project done and records the machine-local hand-off as completed', async (t) => {
  const root = await tempProject(t);
  const installRoot = await tempInstallRoot(t);
  await selectProject(root, { providers: ['codex'], skills: ['spec'] });
  const completed = await completeOnboarding(root, { installRoot });
  assert.equal(completed.progress.status, 'completed');
  const handoff = await readOnboardingHandoffState(installRoot);
  assert.equal(handoff.status, 'completed');
  assert.equal(handoff.lastProjectRoot, path.resolve(root));

  // Once complete, view reflects a ready project once prerequisites are met
  // for the providers actually selected (authentication remains unknown).
  const view = await inspectOnboarding(root, { installRoot });
  assert.equal(view.progress.status, 'completed');
});

test('startOnboarding records the machine-local hand-off as in-progress and never regresses a completed installation', async (t) => {
  const root = await tempProject(t);
  const installRoot = await tempInstallRoot(t);
  const started = await startOnboarding(root, { installRoot, installedVersion: '1.0.0' });
  assert.equal(started.progress.status, 'in-progress');
  assert.equal((await readOnboardingHandoffState(installRoot)).status, 'in-progress');

  await completeOnboarding(root, { installRoot });
  await startOnboarding(root, { installRoot });
  assert.equal((await readOnboardingHandoffState(installRoot)).status, 'completed');
});
