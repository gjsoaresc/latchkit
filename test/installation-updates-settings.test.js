import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  configureUpdateSettings,
  inspectUpdateSettings,
  isStagedUpdateEligibleForAutomaticActivation,
} from '../dist/src/installation/updates/service.js';
import {
  emptyUpdateSettingsState,
  readUpdateSettingsState,
  UPDATE_SETTINGS_PATH,
  writeStagedUpdateRecord,
} from '../dist/src/installation/updates/store.js';

async function tempRoot(t, prefix) {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return scratch;
}

test('reading settings that were never written returns a non-mutating legacy default', async (t) => {
  const root = await tempRoot(t, 'latchkit-update-settings-legacy-');
  const settings = await inspectUpdateSettings(root);
  assert.equal(settings.mode, 'manual');
  assert.equal(settings.consent.source, 'legacy-default');
  assert.equal(settings.consent.actor, null);
  assert.equal(settings.revision, 0);
  // Reading must never create the file — viewing/dismissing onboarding never opts in.
  await assert.rejects(readFile(path.join(root, UPDATE_SETTINGS_PATH)), { code: 'ENOENT' });
});

test('configuring settings persists an explicit choice with consent provenance and bumps the revision', async (t) => {
  const root = await tempRoot(t, 'latchkit-update-settings-explicit-é-');
  const { settings, cancelledAutomaticStaging } = await configureUpdateSettings(root, {
    mode: 'automatic',
    actor: 'cli',
    reason: 'user opted in during onboarding',
  });
  assert.equal(settings.mode, 'automatic');
  assert.equal(settings.revision, 1);
  assert.equal(settings.consent.source, 'explicit-user');
  assert.equal(settings.consent.actor, 'cli');
  assert.equal(settings.consent.reason, 'user opted in during onboarding');
  assert.ok(settings.consent.requestedAt);
  assert.equal(cancelledAutomaticStaging, false);

  const reread = await inspectUpdateSettings(root);
  assert.deepEqual(reread, settings);

  const raw = JSON.parse(await readFile(path.join(root, UPDATE_SETTINGS_PATH), 'utf8'));
  assert.equal(raw.mode, 'automatic');
  assert.equal(raw.revision, 1);
});

test('switching away from automatic bumps the revision and reports a cancelled automatic staging', async (t) => {
  const root = await tempRoot(t, 'latchkit-update-settings-revoke-');
  const enabled = await configureUpdateSettings(root, { mode: 'automatic', actor: 'cli' });
  assert.equal(enabled.settings.revision, 1);

  // Simulate a previously staged update that was authorized under automatic
  // mode at this exact settings revision.
  await writeStagedUpdateRecord(
    {
      schemaVersion: 1,
      previewId: 'preview-1',
      version: '9.9.9',
      target: `${process.platform}-${process.arch}`,
      assetName: 'latchkit-9.9.9-x.zip',
      sha256: 'a'.repeat(64),
      key: `9.9.9-${process.platform}-${process.arch}`,
      directory: path.join(root, 'versions', 'staged'),
      stagedAt: new Date().toISOString(),
      authorizedMode: 'automatic',
      authorizedRevision: enabled.settings.revision,
      status: 'ready',
      failureReason: null,
    },
    root,
  );

  const revoked = await configureUpdateSettings(root, { mode: 'manual', actor: 'cli' });
  assert.equal(revoked.settings.mode, 'manual');
  assert.equal(revoked.settings.revision, 2);
  assert.equal(
    revoked.cancelledAutomaticStaging,
    true,
    'turning automation off must report that a pending automatic activation was cancelled',
  );

  // The staged record survives on disk (still usable for a manual
  // activation) but is no longer eligible for *automatic* activation,
  // because the settings revision it was authorized under has moved on.
  const { readStagedUpdateRecord } = await import('../dist/src/installation/updates/store.js');
  const staged = await readStagedUpdateRecord(root);
  assert.ok(staged);
  assert.equal(
    isStagedUpdateEligibleForAutomaticActivation(staged, revoked.settings),
    false,
    'a staged record authorized under a stale revision must not auto-activate',
  );
});

test('switching to notify while automatic staging is still current-revision voids eligibility by mode, not revision alone', async (t) => {
  const root = await tempRoot(t, 'latchkit-update-settings-notify-');
  const enabled = await configureUpdateSettings(root, { mode: 'automatic' });
  await writeStagedUpdateRecord(
    {
      schemaVersion: 1,
      previewId: 'preview-1',
      version: '9.9.9',
      target: `${process.platform}-${process.arch}`,
      assetName: 'latchkit-9.9.9-x.zip',
      sha256: 'b'.repeat(64),
      key: `9.9.9-${process.platform}-${process.arch}`,
      directory: path.join(root, 'versions', 'staged'),
      stagedAt: new Date().toISOString(),
      authorizedMode: 'automatic',
      authorizedRevision: enabled.settings.revision,
      status: 'ready',
      failureReason: null,
    },
    root,
  );
  const notified = await configureUpdateSettings(root, { mode: 'notify' });
  assert.equal(notified.cancelledAutomaticStaging, true);
});

test('an unknown settings field or mode is rejected', async () => {
  const { validateUpdateSettingsState } = await import('../dist/src/installation/updates/store.js');
  assert.throws(() => validateUpdateSettingsState({ ...emptyUpdateSettingsState(), extra: 1 }));
  assert.throws(() =>
    validateUpdateSettingsState({ ...emptyUpdateSettingsState(), mode: 'sometimes' }),
  );
});

test('settings persist correctly under a Windows path containing spaces and Unicode', async (t) => {
  const root = await tempRoot(t, 'latchkit update settings 空間 -');
  const configured = await configureUpdateSettings(root, { mode: 'notify', actor: 'cli' });
  assert.equal(configured.settings.mode, 'notify');
  const reread = await readUpdateSettingsState(root);
  assert.deepEqual(reread, configured.settings);
});

test('a corrupted settings file surfaces a clear error instead of silently defaulting', async (t) => {
  const root = await tempRoot(t, 'latchkit-update-settings-corrupt-');
  await writeFile(path.join(root, UPDATE_SETTINGS_PATH), 'not json');
  await assert.rejects(readUpdateSettingsState(root), /not valid JSON/);
});
