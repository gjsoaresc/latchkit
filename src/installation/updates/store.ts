/**
 * Installation-local update state persistence (issue #139 slice 1).
 *
 * Follows the exact pattern established by
 * `src/installation/onboarding-state.ts`: user-local, per-installation state
 * written beside the activation pointer (`current`) and the launcher
 * ownership record (`.launchers.json`) inside the root returned by
 * `defaultInstallationRoot()` — never inside a project checkout, and never
 * once per project. Reading a store that has never been written never
 * creates or mutates anything (so viewing or dismissing onboarding, or any
 * other read, never opts a user into anything).
 */
import { readOptional, removeFile, writeAtomic } from '../../storage.js';
import { errorCode, errorMessage } from '../../types.js';
import { defaultInstallationRoot } from '../manager.js';
import {
  DEFAULT_UPDATE_MODE,
  UPDATE_CONSENT_SOURCES,
  UPDATE_MODES,
  UpdateContractError,
  isUpdateMode,
  isoDateTime,
  optionalNonEmptyString,
  requireFields,
} from './contracts.js';
import type {
  ReleaseAsset,
  ReleaseCandidate,
  ReleaseCheckResult,
  StagedUpdateRecord,
  UpdateConsent,
  UpdateConsentSource,
  UpdateSettingsState,
} from './contracts.js';

export const UPDATE_SETTINGS_PATH = 'update-settings.json';
export const UPDATE_STAGED_PATH = 'update-staged.json';
export const UPDATE_LAST_CHECK_PATH = 'update-last-check.json';

async function parseJson(raw: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new UpdateContractError(`${label} is not valid JSON (${errorMessage(error)}).`);
  }
}

// --- Settings -------------------------------------------------------------

function validateConsent(value: unknown): UpdateConsent {
  requireFields(value, ['source', 'actor', 'reason', 'requestedAt'], 'consent');
  if (!(UPDATE_CONSENT_SOURCES as readonly string[]).includes(value.source as string))
    throw new UpdateContractError('consent.source must be a known consent source.');
  return {
    source: value.source as UpdateConsentSource,
    actor: optionalNonEmptyString(value.actor, 'consent.actor'),
    reason: optionalNonEmptyString(value.reason, 'consent.reason'),
    requestedAt:
      value.requestedAt === null ? null : isoDateTime(value.requestedAt, 'consent.requestedAt'),
  };
}

export function validateUpdateSettingsState(input: unknown): UpdateSettingsState {
  requireFields(
    input,
    ['schemaVersion', 'revision', 'mode', 'consent', 'createdAt', 'updatedAt'],
    'update settings',
  );
  if (input.schemaVersion !== 1)
    throw new UpdateContractError(
      `Unsupported update settings schema version ${String(input.schemaVersion)}.`,
    );
  if (!Number.isInteger(input.revision) || (input.revision as number) < 0)
    throw new UpdateContractError('revision must be a non-negative integer.');
  if (!isUpdateMode(input.mode))
    throw new UpdateContractError(`mode must be one of: ${UPDATE_MODES.join(', ')}.`);
  return {
    schemaVersion: 1,
    revision: input.revision as number,
    mode: input.mode,
    consent: validateConsent(input.consent),
    createdAt: isoDateTime(input.createdAt, 'createdAt'),
    updatedAt: isoDateTime(input.updatedAt, 'updatedAt'),
  };
}

export function emptyUpdateSettingsState(
  clock: () => Date = () => new Date(),
): UpdateSettingsState {
  const at = clock().toISOString();
  return {
    schemaVersion: 1,
    revision: 0,
    mode: DEFAULT_UPDATE_MODE,
    consent: { source: 'legacy-default', actor: null, reason: null, requestedAt: null },
    createdAt: at,
    updatedAt: at,
  };
}

export async function readUpdateSettingsState(
  installRoot: string = defaultInstallationRoot(),
): Promise<UpdateSettingsState> {
  const raw = await readOptional(installRoot, UPDATE_SETTINGS_PATH);
  if (raw === null) return emptyUpdateSettingsState();
  return validateUpdateSettingsState(await parseJson(raw, 'Update settings'));
}

export async function writeUpdateSettingsState(
  state: UpdateSettingsState,
  installRoot: string = defaultInstallationRoot(),
): Promise<void> {
  validateUpdateSettingsState(state);
  await writeAtomic(
    installRoot,
    UPDATE_SETTINGS_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
    0o600,
  );
}

// --- Staged update record ---------------------------------------------------

function validateStagedUpdateRecord(input: unknown): StagedUpdateRecord {
  requireFields(
    input,
    [
      'schemaVersion',
      'previewId',
      'version',
      'target',
      'assetName',
      'sha256',
      'key',
      'directory',
      'stagedAt',
      'authorizedMode',
      'authorizedRevision',
      'status',
      'failureReason',
    ],
    'staged update record',
  );
  if (input.schemaVersion !== 1)
    throw new UpdateContractError(
      `Unsupported staged update schema version ${String(input.schemaVersion)}.`,
    );
  if (typeof input.previewId !== 'string' || !input.previewId)
    throw new UpdateContractError('previewId must be a non-empty string.');
  if (typeof input.version !== 'string' || !input.version)
    throw new UpdateContractError('version must be a non-empty string.');
  if (typeof input.target !== 'string' || !input.target)
    throw new UpdateContractError('target must be a non-empty string.');
  if (typeof input.assetName !== 'string' || !input.assetName)
    throw new UpdateContractError('assetName must be a non-empty string.');
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256))
    throw new UpdateContractError('sha256 must be a 64-character lowercase hex digest.');
  if (typeof input.key !== 'string' || !input.key)
    throw new UpdateContractError('key must be a non-empty string.');
  // Empty only for a failed record whose staging never reached a resolved
  // version directory (for example a download or checksum failure before
  // `manager.stageBundle` ever ran).
  if (typeof input.directory !== 'string')
    throw new UpdateContractError('directory must be a string.');
  if (!isUpdateMode(input.authorizedMode))
    throw new UpdateContractError(`authorizedMode must be one of: ${UPDATE_MODES.join(', ')}.`);
  if (!Number.isInteger(input.authorizedRevision) || (input.authorizedRevision as number) < 0)
    throw new UpdateContractError('authorizedRevision must be a non-negative integer.');
  if (input.status !== 'ready' && input.status !== 'failed')
    throw new UpdateContractError('status must be "ready" or "failed".');
  return {
    schemaVersion: 1,
    previewId: input.previewId,
    version: input.version,
    target: input.target,
    assetName: input.assetName,
    sha256: input.sha256,
    key: input.key,
    directory: input.directory,
    stagedAt: isoDateTime(input.stagedAt, 'stagedAt'),
    authorizedMode: input.authorizedMode,
    authorizedRevision: input.authorizedRevision as number,
    status: input.status,
    failureReason: optionalNonEmptyString(input.failureReason, 'failureReason'),
  };
}

export async function readStagedUpdateRecord(
  installRoot: string = defaultInstallationRoot(),
): Promise<StagedUpdateRecord | null> {
  const raw = await readOptional(installRoot, UPDATE_STAGED_PATH);
  if (raw === null) return null;
  return validateStagedUpdateRecord(await parseJson(raw, 'Staged update record'));
}

export async function writeStagedUpdateRecord(
  record: StagedUpdateRecord,
  installRoot: string = defaultInstallationRoot(),
): Promise<void> {
  validateStagedUpdateRecord(record);
  await writeAtomic(installRoot, UPDATE_STAGED_PATH, `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export async function clearStagedUpdateRecord(
  installRoot: string = defaultInstallationRoot(),
): Promise<void> {
  try {
    await removeFile(installRoot, UPDATE_STAGED_PATH);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

// --- Last release check -----------------------------------------------------

function validateCandidate(value: unknown): ReleaseCandidate | null {
  if (value === null) return null;
  requireFields(
    value,
    ['version', 'tag', 'draft', 'prerelease', 'publishedAt', 'notesUrl', 'notes', 'asset'],
    'release candidate',
  );
  if (typeof value.version !== 'string' || !value.version)
    throw new UpdateContractError('candidate.version must be a non-empty string.');
  if (typeof value.tag !== 'string' || !value.tag)
    throw new UpdateContractError('candidate.tag must be a non-empty string.');
  if (typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean')
    throw new UpdateContractError('candidate.draft and candidate.prerelease must be booleans.');
  if (typeof value.notes !== 'string')
    throw new UpdateContractError('candidate.notes must be a string.');
  const asset = value.asset;
  let parsedAsset: ReleaseAsset | null = null;
  if (asset !== null) {
    requireFields(asset, ['name', 'url', 'size'], 'candidate.asset');
    if (
      typeof asset.name !== 'string' ||
      !asset.name ||
      typeof asset.url !== 'string' ||
      !asset.url
    )
      throw new UpdateContractError('candidate.asset.name and .url must be non-empty strings.');
    if (asset.size !== null && typeof asset.size !== 'number')
      throw new UpdateContractError('candidate.asset.size must be a number or null.');
    parsedAsset = { name: asset.name, url: asset.url, size: (asset.size as number | null) ?? null };
  }
  return {
    version: value.version,
    tag: value.tag,
    draft: value.draft,
    prerelease: value.prerelease,
    publishedAt: optionalNonEmptyString(value.publishedAt, 'candidate.publishedAt'),
    notesUrl: optionalNonEmptyString(value.notesUrl, 'candidate.notesUrl'),
    notes: value.notes,
    asset: parsedAsset,
  };
}

const RELEASE_CHECK_OUTCOMES = new Set([
  'no-releases',
  'offline',
  'rate-limited',
  'missing-asset',
  'current',
  'update-available',
]);

function validateReleaseCheckResult(input: unknown): ReleaseCheckResult {
  requireFields(
    input,
    [
      'schemaVersion',
      'checkedAt',
      'source',
      'outcome',
      'currentVersion',
      'candidate',
      'majorUpdate',
      'excludedCount',
      'reason',
    ],
    'release check result',
  );
  if (input.schemaVersion !== 1)
    throw new UpdateContractError(
      `Unsupported release check schema version ${String(input.schemaVersion)}.`,
    );
  if (!RELEASE_CHECK_OUTCOMES.has(input.outcome as string))
    throw new UpdateContractError('outcome is not a recognized release check outcome.');
  requireFields(input.source, ['owner', 'name', 'target'], 'source');
  const source = input.source;
  if (
    typeof source.owner !== 'string' ||
    !source.owner ||
    typeof source.name !== 'string' ||
    !source.name ||
    typeof source.target !== 'string' ||
    !source.target
  )
    throw new UpdateContractError(
      'source.owner, source.name, and source.target must be non-empty strings.',
    );
  if (typeof input.currentVersion !== 'string' || !input.currentVersion)
    throw new UpdateContractError('currentVersion must be a non-empty string.');
  if (typeof input.majorUpdate !== 'boolean')
    throw new UpdateContractError('majorUpdate must be a boolean.');
  if (!Number.isInteger(input.excludedCount) || (input.excludedCount as number) < 0)
    throw new UpdateContractError('excludedCount must be a non-negative integer.');
  return {
    schemaVersion: 1,
    checkedAt: isoDateTime(input.checkedAt, 'checkedAt'),
    source: { owner: source.owner, name: source.name, target: source.target },
    outcome: input.outcome as ReleaseCheckResult['outcome'],
    currentVersion: input.currentVersion,
    candidate: validateCandidate(input.candidate),
    majorUpdate: input.majorUpdate,
    excludedCount: input.excludedCount as number,
    reason: optionalNonEmptyString(input.reason, 'reason'),
  };
}

export async function readLastCheckRecord(
  installRoot: string = defaultInstallationRoot(),
): Promise<ReleaseCheckResult | null> {
  const raw = await readOptional(installRoot, UPDATE_LAST_CHECK_PATH);
  if (raw === null) return null;
  return validateReleaseCheckResult(await parseJson(raw, 'Last update check'));
}

export async function writeLastCheckRecord(
  result: ReleaseCheckResult,
  installRoot: string = defaultInstallationRoot(),
): Promise<void> {
  validateReleaseCheckResult(result);
  await writeAtomic(
    installRoot,
    UPDATE_LAST_CHECK_PATH,
    `${JSON.stringify(result, null, 2)}\n`,
    0o600,
  );
}
