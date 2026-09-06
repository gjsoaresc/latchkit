/**
 * Update service orchestration (issue #139 slice 1).
 *
 * Ties together settings/status inspection, official release discovery,
 * preview binding, staging, and (by reusing the existing manager
 * primitives) activation and rollback. Restart handoff, installation-wide
 * quiescence, and pending-task compatibility preflight are deliberately out
 * of scope here — see the module-level notes on `activateStagedUpdate`
 * below — and are covered by later #139 slices.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../../types.js';
import {
  defaultInstallationRoot,
  type InstallationInspection,
  resolveInstallationRoot,
  rollbackInstallation,
  stageBundle,
  withInstallationLock,
} from '../manager.js';
import { VERSION } from '../../version.js';
import { extractArchive } from './archive.js';
import type { ExtractOptions } from './archive.js';
import { UpdateContractError, isUpdateMode } from './contracts.js';
import type {
  ReleaseCheckResult,
  StagedUpdateRecord,
  UpdateMode,
  UpdatePreview,
  UpdateSettingsState,
  UpdateStatusSnapshot,
} from './contracts.js';
import { DownloadCancelledError, downloadToFile, fetchChecksumSidecar } from './download.js';
import type { DownloadOptions } from './download.js';
import { checkReleases, expectedAssetName, OFFICIAL_REPOSITORY } from './release-source.js';
import type { CheckReleasesOptions } from './release-source.js';
import {
  clearStagedUpdateRecord,
  readLastCheckRecord,
  readStagedUpdateRecord,
  readUpdateSettingsState,
  writeLastCheckRecord,
  writeStagedUpdateRecord,
  writeUpdateSettingsState,
} from './store.js';

export class UpdateServiceError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UpdateServiceError';
    this.code = code;
  }
}

// --- Settings ---------------------------------------------------------------

/** Pure read: never creates the installation root or any file in it, so
 * inspecting settings (for example while showing an onboarding step) never
 * opts a user into anything. Mirrors `readOnboardingHandoffState`. */
export async function inspectUpdateSettings(
  installRoot: string = defaultInstallationRoot(),
): Promise<UpdateSettingsState> {
  return readUpdateSettingsState(installRoot);
}

export interface ConfigureUpdateSettingsInput {
  mode: UpdateMode;
  actor?: string | null;
  reason?: string | null;
}

export interface ConfigureUpdateSettingsResult {
  settings: UpdateSettingsState;
  /** True when this change switched away from `automatic` while a staged
   * update was still authorized for automatic activation — that staged
   * record's automatic-activation eligibility is now void (its
   * `authorizedRevision` no longer matches). It remains on disk (still
   * usable for a manual activation) until explicitly re-staged or cleared. */
  cancelledAutomaticStaging: boolean;
}

/**
 * Persist an explicit manual/notify/automatic choice. Never called by a
 * read path — viewing or dismissing onboarding never opts a user in (see
 * `store.ts`'s module documentation). Switching away from `automatic`
 * invalidates (by revision) any staged record's automatic-activation
 * eligibility without deleting it, so a pending activation cannot proceed
 * on a preference the user just revoked; a fresh explicit request (or a new
 * `configureUpdateSettings` back to `automatic`) is required afterward.
 */
export async function configureUpdateSettings(
  installRoot: string,
  input: ConfigureUpdateSettingsInput,
  { clock = () => new Date() }: { clock?: () => Date } = {},
): Promise<ConfigureUpdateSettingsResult> {
  if (!isUpdateMode(input.mode))
    throw new UpdateContractError('mode must be manual, notify, or automatic.');
  const resolved = await resolveInstallationRoot(installRoot);
  return withInstallationLock(resolved, async () => {
    const current = await readUpdateSettingsState(resolved);
    const previousMode = current.mode;
    const at = clock().toISOString();
    const next: UpdateSettingsState = {
      schemaVersion: 1,
      revision: current.revision + 1,
      mode: input.mode,
      consent: {
        source: 'explicit-user',
        actor: input.actor ?? null,
        reason: input.reason ?? null,
        requestedAt: at,
      },
      createdAt: current.createdAt,
      updatedAt: at,
    };
    await writeUpdateSettingsState(next, resolved);
    let cancelledAutomaticStaging = false;
    if (previousMode === 'automatic' && input.mode !== 'automatic') {
      const staged = await readStagedUpdateRecord(resolved);
      cancelledAutomaticStaging = Boolean(
        staged && staged.status === 'ready' && staged.authorizedMode === 'automatic',
      );
    }
    return { settings: next, cancelledAutomaticStaging };
  });
}

/** Whether a previously staged record is still authorized to be activated
 * automatically: the mode at staging time was `automatic` and the settings
 * revision has not changed since (any settings write — including switching
 * modes — bumps the revision and voids this). A caller may still activate
 * such a record manually regardless of this check. */
export function isStagedUpdateEligibleForAutomaticActivation(
  staged: StagedUpdateRecord,
  settings: UpdateSettingsState,
): boolean {
  return (
    staged.status === 'ready' &&
    staged.authorizedMode === 'automatic' &&
    settings.mode === 'automatic' &&
    staged.authorizedRevision === settings.revision
  );
}

// --- Status -------------------------------------------------------------

/** Pure read, no network call and no directory creation: reflects the
 * persisted settings, the last `checkForUpdates` result (if any), and any
 * staged record. Use `checkForUpdates` to actually contact the release
 * source. */
export async function inspectUpdateStatus(
  installRoot: string = defaultInstallationRoot(),
): Promise<UpdateStatusSnapshot> {
  const settings = await readUpdateSettingsState(installRoot);
  const lastCheck = await readLastCheckRecord(installRoot);
  const staged = await readStagedUpdateRecord(installRoot);
  const target = `${process.platform}-${process.arch}`;
  if (staged && staged.status === 'failed') {
    return {
      schemaVersion: 1,
      installedVersion: VERSION,
      target,
      mode: settings.mode,
      settingsRevision: settings.revision,
      status: 'failed',
      reason: staged.failureReason,
      staged,
      lastCheck,
    };
  }
  if (staged && staged.status === 'ready') {
    return {
      schemaVersion: 1,
      installedVersion: VERSION,
      target,
      mode: settings.mode,
      settingsRevision: settings.revision,
      status: 'ready',
      reason: null,
      staged,
      lastCheck,
    };
  }
  if (!lastCheck) {
    return {
      schemaVersion: 1,
      installedVersion: VERSION,
      target,
      mode: settings.mode,
      settingsRevision: settings.revision,
      status: 'unavailable',
      reason: 'No update check has been performed yet.',
      staged: null,
      lastCheck: null,
    };
  }
  if (lastCheck.outcome === 'update-available') {
    return {
      schemaVersion: 1,
      installedVersion: VERSION,
      target,
      mode: settings.mode,
      settingsRevision: settings.revision,
      status: 'update-available',
      reason: lastCheck.majorUpdate
        ? 'A major-version update requires manual review before it can be selected.'
        : null,
      staged: null,
      lastCheck,
    };
  }
  if (lastCheck.outcome === 'current')
    return {
      schemaVersion: 1,
      installedVersion: VERSION,
      target,
      mode: settings.mode,
      settingsRevision: settings.revision,
      status: 'current',
      reason: null,
      staged: null,
      lastCheck,
    };
  return {
    schemaVersion: 1,
    installedVersion: VERSION,
    target,
    mode: settings.mode,
    settingsRevision: settings.revision,
    status: 'unavailable',
    reason: lastCheck.reason,
    staged: null,
    lastCheck,
  };
}

// --- Check / preview ---------------------------------------------------

export interface CheckForUpdatesOptions extends CheckReleasesOptions {
  currentVersion?: string;
}

/** Perform a live release check and persist the result so a later
 * `inspectUpdateStatus` call (a pure, non-network read) can reflect it.
 *
 * `apiBaseUrl` defaults to the real official GitHub API. `LATCHKIT_UPDATE_API_BASE_URL`
 * exists only so deterministic tests and this repository's own CLI fixtures
 * can point at a local loopback HTTP fixture instead of ever reaching the
 * network; it is read only when the caller did not already pass an explicit
 * `apiBaseUrl`, and an explicit caller-supplied value always wins. */
export async function checkForUpdates(
  installRoot: string,
  options: CheckForUpdatesOptions = {},
): Promise<ReleaseCheckResult> {
  const resolved = await resolveInstallationRoot(installRoot);
  const result = await checkReleases(options.currentVersion ?? VERSION, {
    ...options,
    apiBaseUrl: options.apiBaseUrl ?? process.env.LATCHKIT_UPDATE_API_BASE_URL,
  });
  await writeLastCheckRecord(result, resolved);
  return result;
}

export interface PreviewUpdateOptions extends CheckForUpdatesOptions {
  checksumOptions?: DownloadOptions;
}

/**
 * Perform a fresh check and bind the selected candidate's version, asset
 * identity, and checksum into a preview record. Never selects a draft,
 * prerelease, or downgrade (already excluded by `checkReleases`); a
 * major-version candidate is still returned (so it can be shown) but keeps
 * `majorUpdate: true` for manual review.
 */
export async function previewUpdate(
  installRoot: string,
  options: PreviewUpdateOptions = {},
): Promise<UpdatePreview> {
  const check = await checkForUpdates(installRoot, options);
  if (check.outcome !== 'update-available' || !check.candidate?.asset)
    throw new UpdateServiceError(
      `No update is available to preview (${check.outcome}).`,
      'UPDATE_NOT_AVAILABLE',
    );
  const asset = check.candidate.asset;
  const sha256 = await fetchChecksumSidecar(`${asset.url}.sha256`, options.checksumOptions);
  return {
    schemaVersion: 1,
    previewId: randomUUID(),
    createdAt: new Date().toISOString(),
    currentVersion: check.currentVersion,
    target: check.source.target,
    version: check.candidate.version,
    tag: check.candidate.tag,
    assetName: asset.name,
    assetUrl: asset.url,
    sha256,
    majorUpdate: check.majorUpdate,
    notes: check.candidate.notes,
  };
}

// --- Stage ---------------------------------------------------------------

export interface StageUpdateOptions {
  fetchImpl?: DownloadOptions['fetchImpl'];
  timeoutMs?: number;
  maxRetries?: number;
  maxDownloadBytes?: number;
  extract?: ExtractOptions;
  scratchParent?: string;
  onProgress?: (status: 'downloading' | 'verifying') => void;
  /** Issue #139 slice 2: cancels the in-flight download (see
   * `DownloadCancelledError` in `download.ts`). The staged record is still
   * recorded as `failed` with a distinguishable reason; cancelling never
   * activates a different release and never touches the persisted update
   * mode/preference. */
  signal?: AbortSignal;
}

/**
 * Download, verify, extract, and stage the exact preview previously bound
 * by `previewUpdate`. Never activates: `current`, the managed launchers, and
 * the runtime a new launch resolves to are all untouched until a separate
 * `activateStagedUpdate`/`rollbackUpdate` call. Idempotent: retrying with
 * the same preview re-verifies and re-smokes an already-staged immutable
 * version directory (via `manager.stageBundle`) rather than erroring. Only
 * the caller-owned scratch directory created here is registered for
 * cleanup, and it is always removed, success or failure.
 */
export async function stageUpdate(
  installRoot: string,
  preview: UpdatePreview,
  options: StageUpdateOptions = {},
): Promise<StagedUpdateRecord> {
  const resolved = await resolveInstallationRoot(installRoot);
  const settings = await readUpdateSettingsState(resolved);
  const scratchParent = options.scratchParent ?? os.tmpdir();
  const scratch = await realpath(await mkdtemp(path.join(scratchParent, 'latchkit-update-stage-')));
  try {
    options.onProgress?.('downloading');
    const archiveName = preview.target.startsWith('win32-') ? 'archive.zip' : 'archive.tar.gz';
    const archivePath = path.join(scratch, archiveName);
    const downloaded = await downloadToFile(preview.assetUrl, archivePath, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      maxBytes: options.maxDownloadBytes,
      signal: options.signal,
    });
    options.onProgress?.('verifying');
    if (downloaded.sha256 !== preview.sha256)
      throw new UpdateServiceError(
        `Downloaded archive checksum did not match the bound preview checksum for ${preview.assetName}.`,
        'UPDATE_CHECKSUM_MISMATCH',
      );
    const bundle = path.join(scratch, 'bundle');
    await extractArchive(archivePath, bundle, options.extract);
    const staged = await stageBundle({
      root: resolved,
      bundle,
      version: preview.version,
      target: preview.target,
    });
    const record: StagedUpdateRecord = {
      schemaVersion: 1,
      previewId: preview.previewId,
      version: preview.version,
      target: preview.target,
      assetName: preview.assetName,
      sha256: preview.sha256,
      key: staged.key,
      directory: staged.directory,
      stagedAt: new Date().toISOString(),
      authorizedMode: settings.mode,
      authorizedRevision: settings.revision,
      status: 'ready',
      failureReason: null,
    };
    await writeStagedUpdateRecord(record, resolved);
    return record;
  } catch (error) {
    const failure: StagedUpdateRecord = {
      schemaVersion: 1,
      previewId: preview.previewId,
      version: preview.version,
      target: preview.target,
      assetName: preview.assetName,
      sha256: preview.sha256,
      key: `${preview.version}-${preview.target}`,
      directory: '',
      stagedAt: new Date().toISOString(),
      authorizedMode: settings.mode,
      authorizedRevision: settings.revision,
      status: 'failed',
      failureReason: errorMessage(error),
    };
    await writeStagedUpdateRecord(failure, resolved).catch(() => {});
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Activate / rollback ---------------------------------------------------

/**
 * Activate a previously staged update by reusing the existing
 * `rollbackInstallation` primitive: pointing `current` at an already-staged
 * immutable version directory is exactly what rollback already does
 * (re-verify, smoke-check, recreate the managed launchers, then atomically
 * flip `current`). This function performs a manual, synchronous activation
 * only — it does not implement restart handoff, installation-wide
 * quiescence, or pending-task compatibility preflight (#139 slices 2-3), so
 * callers driving an actual restart must not call this directly yet.
 */
export async function activateStagedUpdate(
  installRoot: string,
  options: { target?: string } = {},
): Promise<InstallationInspection> {
  const resolved = await resolveInstallationRoot(installRoot);
  const staged = await readStagedUpdateRecord(resolved);
  if (!staged || staged.status !== 'ready')
    throw new UpdateServiceError('No staged update is ready to activate.', 'UPDATE_NOT_STAGED');
  const inspection = await rollbackInstallation(
    resolved,
    staged.version,
    options.target ?? staged.target,
  );
  await clearStagedUpdateRecord(resolved);
  return inspection;
}

/** Roll back (or activate any other already-installed version) by reusing
 * the existing `rollbackInstallation` primitive directly. */
export async function rollbackUpdate(
  installRoot: string,
  version: string,
  target?: string,
): Promise<InstallationInspection> {
  const resolved = await resolveInstallationRoot(installRoot);
  return rollbackInstallation(resolved, version, target ?? `${process.platform}-${process.arch}`);
}

export { OFFICIAL_REPOSITORY, expectedAssetName, DownloadCancelledError };
