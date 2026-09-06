/**
 * Shared update-service contract (issue #139 slice 1).
 *
 * This module only declares the versioned data shapes and small validators
 * used by every other module under `src/installation/updates/`. It has no
 * filesystem or network dependency so it can be imported anywhere (CLI,
 * service, a future local API/console) without pulling in I/O.
 */

export const UPDATE_SCHEMA_VERSION = 1;

export const UPDATE_MODES = Object.freeze(['manual', 'notify', 'automatic'] as const);
export type UpdateMode = (typeof UPDATE_MODES)[number];
/** Existing installations remain manual until a user explicitly changes this
 * (see docs/installation.md#update-ownership-and-channel-detection). Reading
 * settings that were never written never opts a user into anything. */
export const DEFAULT_UPDATE_MODE: UpdateMode = 'manual';

export function isUpdateMode(value: unknown): value is UpdateMode {
  return typeof value === 'string' && (UPDATE_MODES as readonly string[]).includes(value);
}

/**
 * Full status vocabulary from issue #139's acceptance criteria. Slice 1 (this
 * module) only ever produces `unavailable`, `current`, `update-available`,
 * `ready`, and `failed` from a synchronous inspect/check/stage call.
 * `checking`, `downloading`, and `verifying` are emitted transiently as
 * progress callbacks during `stageUpdate` (see service.ts) but are not
 * persisted as a resting state. `waiting` (installation-wide quiescence),
 * `restarting`, and `completed` are reserved for the restart-handoff and
 * automation slices (#139 slices 2-3) and are never produced here.
 */
export const UPDATE_STATUS_KINDS = Object.freeze([
  'checking',
  'unavailable',
  'current',
  'update-available',
  'downloading',
  'verifying',
  'ready',
  'waiting',
  'restarting',
  'completed',
  'failed',
] as const);
export type UpdateStatusKind = (typeof UPDATE_STATUS_KINDS)[number];

export class UpdateContractError extends Error {
  code: string;
  constructor(message: string, code = 'UPDATE_INVALID') {
    super(message);
    this.name = 'UpdateContractError';
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireFields(
  value: unknown,
  names: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new UpdateContractError(`${label} must be an object.`);
  for (const key of Object.keys(value))
    if (!names.includes(key)) throw new UpdateContractError(`${label} has unknown field "${key}".`);
  for (const key of names)
    if (!Object.hasOwn(value, key))
      throw new UpdateContractError(`${label} is missing required field "${key}".`);
}

export function optionalNonEmptyString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value)
    throw new UpdateContractError(`${label} must be a non-empty string or null.`);
  return value;
}

export function isoDateTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new UpdateContractError(`${label} must be an ISO date-time string.`);
  return value;
}

/** Where a mode currently in effect came from. `legacy-default` never comes
 * from a write — it is the value returned when no settings file exists yet,
 * so viewing or dismissing onboarding, or any other read, never opts in. */
export const UPDATE_CONSENT_SOURCES = Object.freeze(['legacy-default', 'explicit-user'] as const);
export type UpdateConsentSource = (typeof UPDATE_CONSENT_SOURCES)[number];

export interface UpdateConsent {
  source: UpdateConsentSource;
  /** Free-form caller identity for the explicit request (for example "cli"
   * or a future authenticated console session id). Null for the legacy
   * default and whenever a caller does not supply one. */
  actor: string | null;
  reason: string | null;
  requestedAt: string | null;
}

export interface UpdateSettingsState {
  schemaVersion: 1;
  revision: number;
  mode: UpdateMode;
  consent: UpdateConsent;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number | null;
}

export interface ReleaseCandidate {
  version: string;
  tag: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  notesUrl: string | null;
  /** Raw, untrusted release body text. Any future console surface must
   * render this as plain/escaped text, never as interpreted HTML/markdown. */
  notes: string;
  /** Null when no asset matches this platform's expected archive name yet. */
  asset: ReleaseAsset | null;
}

export type ReleaseCheckOutcome =
  'no-releases' | 'offline' | 'rate-limited' | 'missing-asset' | 'current' | 'update-available';

export interface ReleaseCheckResult {
  schemaVersion: 1;
  checkedAt: string;
  source: { owner: string; name: string; target: string };
  outcome: ReleaseCheckOutcome;
  currentVersion: string;
  /** The best eligible candidate found, even when excluded from automatic
   * selection by a missing asset or a required major-version review. Null
   * when no eligible (non-draft, non-prerelease, non-downgrade) release
   * exists. */
  candidate: ReleaseCandidate | null;
  /** True when `candidate` is a major-version bump over the running version
   * and therefore requires manual review before it can be selected. */
  majorUpdate: boolean;
  /** Count of releases excluded as drafts, prereleases, or downgrades. */
  excludedCount: number;
  /** Actionable, non-null reason for every outcome except `update-available`
   * and `current` (which need none) and `no-releases` (a normal, supported,
   * non-error state). */
  reason: string | null;
}

export interface UpdatePreview {
  schemaVersion: 1;
  previewId: string;
  createdAt: string;
  currentVersion: string;
  target: string;
  version: string;
  tag: string;
  assetName: string;
  assetUrl: string;
  /** Checksum resolved and bound at preview time; `stageUpdate` verifies the
   * downloaded archive against this exact value, not a value re-fetched at
   * stage time. */
  sha256: string;
  majorUpdate: boolean;
  notes: string;
}

export type StagedUpdateStatus = 'ready' | 'failed';

export interface StagedUpdateRecord {
  schemaVersion: 1;
  previewId: string;
  version: string;
  target: string;
  assetName: string;
  sha256: string;
  key: string;
  directory: string;
  stagedAt: string;
  /** The update mode and settings revision in effect when staging completed.
   * A future automatic-activation step must re-check these against the
   * current settings before activating — see
   * `isStagedUpdateEligibleForAutomaticActivation` in service.ts. */
  authorizedMode: UpdateMode;
  authorizedRevision: number;
  status: StagedUpdateStatus;
  failureReason: string | null;
}

export interface UpdateStatusSnapshot {
  schemaVersion: 1;
  installedVersion: string;
  target: string;
  mode: UpdateMode;
  settingsRevision: number;
  status: UpdateStatusKind;
  reason: string | null;
  staged: StagedUpdateRecord | null;
  lastCheck: ReleaseCheckResult | null;
}
