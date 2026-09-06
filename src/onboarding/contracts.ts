/**
 * Project-scoped onboarding wizard progress (issue #100).
 *
 * This tracks step-by-step progress for a single project so an interrupted
 * or dismissed run can resume exactly where it left off, without losing or
 * duplicating anything: the actual selections it records (providers, skills,
 * workspace preference, verification mode, usage opt-in) already live in
 * their own existing, idempotent stores (`config.json`,
 * `.latchkit/verification/settings-v1.json`, `.latchkit/usage/...`). This
 * store only remembers which step the wizard is on and which steps were
 * explicitly completed or skipped — never a second copy of the settings
 * themselves.
 *
 * This is distinct from the user-local installation hand-off state in
 * `src/installation/onboarding-state.ts`, which tracks (independent of any
 * one project) whether onboarding has been offered/completed/dismissed on
 * this machine so ordinary launches and upgrades do not repeat it.
 */
import { errorMessage } from '../types.js';

export const ONBOARDING_SCHEMA_VERSION = 1;
export const ONBOARDING_PATH = '.latchkit/onboarding/state-v1.json';

/** Fixed step order. "project" must run first (nothing else can be saved
 * before a project is initialized) and is never skippable; every later step
 * has a safe, documented default and may be explicitly skipped. */
export const ONBOARDING_STEP_IDS = Object.freeze([
  'project',
  'providers',
  'workspace',
  'verification',
  'usage',
  'preview',
] as const);
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];
export const REQUIRED_ONBOARDING_STEPS: ReadonlySet<OnboardingStepId> = new Set(['project']);

export const ONBOARDING_STATUSES = Object.freeze([
  'not-started',
  'in-progress',
  'completed',
  'dismissed',
] as const);
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export interface OnboardingProgress {
  status: OnboardingStatus;
  currentStepId: OnboardingStepId;
  completedStepIds: OnboardingStepId[];
  skippedStepIds: OnboardingStepId[];
}

export interface OnboardingState {
  schemaVersion: 1;
  project: { id: string };
  revision: number;
  progress: OnboardingProgress;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  dismissedAt: string | null;
}

export class OnboardingError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'ONBOARDING_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'OnboardingError';
    this.code = code;
    this.path = path;
  }
}

export function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return (
    typeof value === 'string' && (ONBOARDING_STEP_IDS as readonly string[]).includes(value as never)
  );
}
export function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  return (
    typeof value === 'string' && (ONBOARDING_STATUSES as readonly string[]).includes(value as never)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: string[], path: string): void {
  if (!record(value)) throw new OnboardingError('Expected an object.', 'ONBOARDING_INVALID', path);
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new OnboardingError(`Unknown field "${key}".`, 'ONBOARDING_INVALID', `${path}.${key}`);
  for (const key of names)
    if (!Object.hasOwn(value, key))
      throw new OnboardingError(
        'Required field is missing.',
        'ONBOARDING_INVALID',
        `${path}.${key}`,
      );
}
function nonempty(value: unknown, path: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new OnboardingError('Expected a non-empty string.', 'ONBOARDING_INVALID', path);
}
function iso(value: unknown, path: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new OnboardingError('Expected an ISO date-time.', 'ONBOARDING_INVALID', path);
}
function isoOrNull(value: unknown, path: string): void {
  if (value === null) return;
  iso(value, path);
}
function stepIdList(value: unknown, path: string): OnboardingStepId[] {
  if (!Array.isArray(value) || value.some((item) => !isOnboardingStepId(item)))
    throw new OnboardingError('Expected an array of known step IDs.', 'ONBOARDING_INVALID', path);
  return [...new Set(value as OnboardingStepId[])];
}

export function validateOnboardingProgress(
  value: unknown,
  path = '$.progress',
): OnboardingProgress {
  fields(value, ['status', 'currentStepId', 'completedStepIds', 'skippedStepIds'], path);
  const candidate = value as Record<string, unknown>;
  if (!isOnboardingStatus(candidate.status))
    throw new OnboardingError('Unknown onboarding status.', 'ONBOARDING_INVALID', `${path}.status`);
  if (!isOnboardingStepId(candidate.currentStepId))
    throw new OnboardingError(
      'Unknown onboarding step ID.',
      'ONBOARDING_INVALID',
      `${path}.currentStepId`,
    );
  return {
    status: candidate.status,
    currentStepId: candidate.currentStepId,
    completedStepIds: stepIdList(candidate.completedStepIds, `${path}.completedStepIds`),
    skippedStepIds: stepIdList(candidate.skippedStepIds, `${path}.skippedStepIds`),
  };
}

export function validateOnboardingState(input: unknown): OnboardingState {
  const state = input as OnboardingState;
  fields(
    state,
    [
      'schemaVersion',
      'project',
      'revision',
      'progress',
      'createdAt',
      'updatedAt',
      'completedAt',
      'dismissedAt',
    ],
    '$',
  );
  if (state.schemaVersion !== ONBOARDING_SCHEMA_VERSION)
    throw new OnboardingError(
      'Unsupported onboarding schema version.',
      'ONBOARDING_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  fields(state.project, ['id'], '$.project');
  nonempty(state.project.id, '$.project.id');
  if (!Number.isInteger(state.revision) || state.revision < 0)
    throw new OnboardingError(
      'Expected a non-negative revision.',
      'ONBOARDING_INVALID',
      '$.revision',
    );
  const progress = validateOnboardingProgress(state.progress, '$.progress');
  iso(state.createdAt, '$.createdAt');
  iso(state.updatedAt, '$.updatedAt');
  isoOrNull(state.completedAt, '$.completedAt');
  isoOrNull(state.dismissedAt, '$.dismissedAt');
  return {
    schemaVersion: 1,
    project: { id: state.project.id },
    revision: state.revision,
    progress,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    dismissedAt: state.dismissedAt,
  };
}

export function parseOnboardingState(raw: string): OnboardingState {
  try {
    return validateOnboardingState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(`Invalid JSON (${errorMessage(error)}).`, 'ONBOARDING_INVALID_JSON');
  }
}

/** The next step that is neither completed nor skipped, in fixed order, or
 * `null` once every step has been resolved one way or the other. */
export function nextOnboardingStepId(progress: OnboardingProgress): OnboardingStepId | null {
  return (
    ONBOARDING_STEP_IDS.find(
      (id) => !progress.completedStepIds.includes(id) && !progress.skippedStepIds.includes(id),
    ) ?? null
  );
}
