/**
 * User-local, per-installation onboarding hand-off state (issue #100).
 *
 * This is deliberately separate from a project's own onboarding progress
 * (`src/onboarding/store.ts`, `.latchkit/onboarding/state-v1.json` inside a
 * project): a project can be onboarded independently in several checkouts,
 * but "does an ordinary launch or upgrade need to offer/repeat onboarding on
 * this machine" is a single, machine/user-local fact. It is stored beside the
 * installation's other user-local state — the activation pointer (`current`)
 * and the launcher ownership record (`.launchers.json`), both written next to
 * `ONBOARDING_STATE_PATH` inside the root returned by `defaultInstallationRoot`
 * in `./manager.js` — never inside a project checkout.
 */
import { readOptional, writeAtomic } from '../storage.js';
import { errorMessage } from '../types.js';
import { defaultInstallationRoot } from './manager.js';

export const ONBOARDING_HANDOFF_SCHEMA_VERSION = 1;
export const ONBOARDING_STATE_PATH = 'onboarding-state.json';

export const ONBOARDING_HANDOFF_STATUSES = Object.freeze([
  'not-started',
  'in-progress',
  'completed',
  'dismissed',
] as const);
export type OnboardingHandoffStatus = (typeof ONBOARDING_HANDOFF_STATUSES)[number];

export interface OnboardingHandoffState {
  schemaVersion: 1;
  status: OnboardingHandoffStatus;
  /** Absolute path to the most recently started/completed project, kept only
   * as a resume convenience; never used to authorize or duplicate anything. */
  lastProjectRoot: string | null;
  installedVersion: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
}

export class OnboardingHandoffError extends Error {
  code: string;
  constructor(message: string, code = 'ONBOARDING_HANDOFF_INVALID') {
    super(message);
    this.name = 'OnboardingHandoffError';
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value)
    throw new OnboardingHandoffError(`Expected a non-empty string or null for "${field}".`);
  return value;
}

export function validateOnboardingHandoffState(input: unknown): OnboardingHandoffState {
  if (!record(input)) throw new OnboardingHandoffError('Expected an object.');
  const allowed = [
    'schemaVersion',
    'status',
    'lastProjectRoot',
    'installedVersion',
    'startedAt',
    'updatedAt',
    'completedAt',
    'dismissedAt',
  ];
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw new OnboardingHandoffError(`Unknown field "${key}".`);
  for (const key of allowed)
    if (!Object.hasOwn(input, key))
      throw new OnboardingHandoffError(`Required field "${key}" is missing.`);
  if (input.schemaVersion !== ONBOARDING_HANDOFF_SCHEMA_VERSION)
    throw new OnboardingHandoffError(
      `Unsupported onboarding handoff schema version ${String(input.schemaVersion)}.`,
      'ONBOARDING_HANDOFF_UNSUPPORTED_VERSION',
    );
  if (
    typeof input.status !== 'string' ||
    !(ONBOARDING_HANDOFF_STATUSES as readonly string[]).includes(input.status)
  )
    throw new OnboardingHandoffError('status must be a known onboarding handoff status.');
  return {
    schemaVersion: 1,
    status: input.status as OnboardingHandoffStatus,
    lastProjectRoot: optionalString(input.lastProjectRoot, 'lastProjectRoot'),
    installedVersion: optionalString(input.installedVersion, 'installedVersion'),
    startedAt: optionalString(input.startedAt, 'startedAt'),
    updatedAt: optionalString(input.updatedAt, 'updatedAt'),
    completedAt: optionalString(input.completedAt, 'completedAt'),
    dismissedAt: optionalString(input.dismissedAt, 'dismissedAt'),
  };
}

export function emptyOnboardingHandoffState(): OnboardingHandoffState {
  return {
    schemaVersion: 1,
    status: 'not-started',
    lastProjectRoot: null,
    installedVersion: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    dismissedAt: null,
  };
}

export async function readOnboardingHandoffState(
  installRoot: string = defaultInstallationRoot(),
): Promise<OnboardingHandoffState> {
  const raw = await readOptional(installRoot, ONBOARDING_STATE_PATH);
  if (raw === null) return emptyOnboardingHandoffState();
  try {
    return validateOnboardingHandoffState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof OnboardingHandoffError) throw error;
    throw new OnboardingHandoffError(
      `Invalid onboarding handoff state (${errorMessage(error)}).`,
      'ONBOARDING_HANDOFF_INVALID_JSON',
    );
  }
}

export async function writeOnboardingHandoffState(
  state: OnboardingHandoffState,
  installRoot: string = defaultInstallationRoot(),
): Promise<void> {
  validateOnboardingHandoffState(state);
  await writeAtomic(
    installRoot,
    ONBOARDING_STATE_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
    0o600,
  );
}

/** True when a fresh launch/upgrade should still offer onboarding: it has
 * never been started, or it was started but never explicitly finished or
 * dismissed. A dismissed or completed run never re-prompts automatically. */
export function shouldOfferOnboarding(state: OnboardingHandoffState): boolean {
  return state.status === 'not-started' || state.status === 'in-progress';
}

async function update(
  patch: Partial<OnboardingHandoffState>,
  {
    installRoot = defaultInstallationRoot(),
    clock = () => new Date(),
  }: { installRoot?: string; clock?: () => Date } = {},
): Promise<OnboardingHandoffState> {
  const current = await readOnboardingHandoffState(installRoot);
  const next: OnboardingHandoffState = {
    ...current,
    ...patch,
    updatedAt: clock().toISOString(),
  };
  await writeOnboardingHandoffState(next, installRoot);
  return next;
}

/** Record that onboarding was offered/started for a project. Never repeated
 * once already `completed`, so re-running an already-finished onboarding
 * cannot silently flip a completed installation back to in-progress. */
export async function markOnboardingHandoffStarted(
  options: {
    projectRoot?: string;
    installedVersion?: string;
    installRoot?: string;
    clock?: () => Date;
  } = {},
): Promise<OnboardingHandoffState> {
  const current = await readOnboardingHandoffState(options.installRoot);
  if (current.status === 'completed') return current;
  const clock = options.clock ?? (() => new Date());
  return update(
    {
      status: 'in-progress',
      lastProjectRoot: options.projectRoot ?? current.lastProjectRoot,
      installedVersion: options.installedVersion ?? current.installedVersion,
      startedAt: current.startedAt ?? clock().toISOString(),
    },
    { installRoot: options.installRoot, clock },
  );
}

export async function markOnboardingHandoffCompleted(
  options: { projectRoot?: string; installRoot?: string; clock?: () => Date } = {},
): Promise<OnboardingHandoffState> {
  const clock = options.clock ?? (() => new Date());
  const at = clock().toISOString();
  const current = await readOnboardingHandoffState(options.installRoot);
  return update(
    {
      status: 'completed',
      lastProjectRoot: options.projectRoot ?? current.lastProjectRoot,
      completedAt: at,
    },
    { installRoot: options.installRoot, clock },
  );
}

export async function markOnboardingHandoffDismissed(
  options: { projectRoot?: string; installRoot?: string; clock?: () => Date } = {},
): Promise<OnboardingHandoffState> {
  const clock = options.clock ?? (() => new Date());
  const at = clock().toISOString();
  const current = await readOnboardingHandoffState(options.installRoot);
  return update(
    {
      status: 'dismissed',
      lastProjectRoot: options.projectRoot ?? current.lastProjectRoot,
      dismissedAt: at,
    },
    { installRoot: options.installRoot, clock },
  );
}
