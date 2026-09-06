/**
 * Installation onboarding orchestration (issue #100).
 *
 * This module is deliberately thin: every mutation it performs delegates to
 * an existing, already-tested primitive (`initProject`, `saveConfig`,
 * `configureVerification`, `configureUsage`, `planSync`/`syncProject`). It
 * adds nothing new to *how* a project is configured — only a resumable,
 * skippable, step-ordered wizard on top of those primitives, plus an honest
 * read model of provider/project state for the CLI and browser console.
 */
import { withTaskStateLock } from '../task-state/lock.js';
import { resolveProjectRoot } from '../storage.js';
import {
  doctor,
  initProject,
  planSync,
  readConfig,
  saveConfig,
  syncProject,
  PROVIDERS,
  SKILLS,
} from '../core.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../config/contracts.js';
import type { LatchkitConfig, WorkspaceExecutionPreference } from '../config/contracts.js';
import { configureVerification, inspectVerificationSettings } from '../verification/service.js';
import type { VerificationMode } from '../verification/service.js';
import { configureUsage, inspectUsage } from '../usage/service.js';
import {
  markOnboardingHandoffCompleted,
  markOnboardingHandoffDismissed,
  markOnboardingHandoffStarted,
  readOnboardingHandoffState,
} from '../installation/onboarding-state.js';
import {
  ONBOARDING_STEP_IDS,
  REQUIRED_ONBOARDING_STEPS,
  OnboardingError,
  isOnboardingStepId,
  nextOnboardingStepId,
} from './contracts.js';
import type { OnboardingState, OnboardingStepId } from './contracts.js';
import { readOnboardingState, writeOnboardingState } from './store.js';

export { ONBOARDING_STEP_IDS };
export type { OnboardingStepId, OnboardingState };

type ClockOptions = { clock?: () => Date };
/** `installRoot` overrides the user-local installation root that backs
 * `src/installation/onboarding-state.ts` (defaults to `defaultInstallationRoot()`
 * when omitted). It exists so tests never touch the real machine's
 * installation directory. */
type HandoffOptions = ClockOptions & { installRoot?: string };

/**
 * Integration point for issue #94 (multi-project overview backed by a local
 * project registry under `src/projects/`). Onboarding intentionally does not
 * build or own a registry of its own (see AGENTS.md coordination note for
 * #100): it only records the chosen root in the user-local installation
 * hand-off state (`lastProjectRoot`, `src/installation/onboarding-state.ts`)
 * so a caller resuming onboarding knows which project it was working on.
 *
 * Once #94 lands, replace this no-op body with a call that upserts `root`
 * into that registry. It is called every time a project is selected, so the
 * registry implementation is responsible for its own idempotency (upsert by
 * resolved root, never append a duplicate entry).
 */
export async function registerProjectWithRegistry(_root: string): Promise<void> {
  // TODO(#94): call into src/projects/ once the local project registry lands.
}

async function mutate<T>(
  root: string,
  operation: (state: OnboardingState) => T | Promise<T>,
): Promise<T> {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readOnboardingState(root);
    const result = await operation(state);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    await writeOnboardingState(root, state);
    return result;
  });
}

type StepAction = 'complete' | 'skip' | 'back';

/** Advance (or retreat) exactly one step, recording completion/skip and
 * moving `currentStepId`. Resuming after a dismissal or an interrupted run
 * simply calls this again for whichever step the caller is now working on;
 * nothing here re-runs or duplicates the underlying settings mutation, which
 * the caller already performed (or is performing) through its own idempotent
 * store. */
async function advanceStep(
  root: string,
  stepId: string,
  action: StepAction,
): Promise<{ progress: OnboardingState['progress'] }> {
  if (!isOnboardingStepId(stepId))
    throw new OnboardingError(`Unknown onboarding step "${stepId}".`, 'ONBOARDING_INVALID_STEP');
  if (action === 'skip' && REQUIRED_ONBOARDING_STEPS.has(stepId))
    throw new OnboardingError(
      `The "${stepId}" step cannot be skipped.`,
      'ONBOARDING_STEP_REQUIRED',
    );
  return mutate(root, (state) => {
    const progress = state.progress;
    const index = ONBOARDING_STEP_IDS.indexOf(stepId);
    progress.completedStepIds = progress.completedStepIds.filter((id) => id !== stepId);
    progress.skippedStepIds = progress.skippedStepIds.filter((id) => id !== stepId);
    if (action === 'back') {
      progress.currentStepId = ONBOARDING_STEP_IDS[Math.max(0, index - 1)] ?? stepId;
    } else {
      (action === 'skip' ? progress.skippedStepIds : progress.completedStepIds).push(stepId);
      progress.currentStepId = ONBOARDING_STEP_IDS[index + 1] ?? stepId;
    }
    if (progress.status !== 'completed') progress.status = 'in-progress';
    return { progress: structuredClone(progress) };
  });
}

export async function startOnboarding(
  root: string,
  options: { installedVersion?: string } & HandoffOptions = {},
): Promise<{ progress: OnboardingState['progress'] }> {
  root = await resolveProjectRoot(root);
  await markOnboardingHandoffStarted({
    projectRoot: root,
    installedVersion: options.installedVersion,
    clock: options.clock,
    installRoot: options.installRoot,
  });
  return mutate(root, (state) => {
    if (state.progress.status !== 'completed') state.progress.status = 'in-progress';
    return { progress: structuredClone(state.progress) };
  });
}

/** "Select or add a project": initializes configuration for an existing
 * project directory without replacing an already-initialized project's
 * settings (`initProject` is idempotent), then advances the "project" step. */
export async function selectProject(
  root: string,
  options: { providers?: readonly string[]; skills?: readonly string[] } = {},
): Promise<LatchkitConfig> {
  root = await resolveProjectRoot(root);
  const config = await initProject(root, options);
  await registerProjectWithRegistry(root);
  await advanceStep(root, 'project', 'complete');
  return config;
}

export async function updateProjectSelection(
  root: string,
  options: { providers?: readonly string[]; skills?: readonly string[] } = {},
): Promise<LatchkitConfig> {
  root = await resolveProjectRoot(root);
  if (options.providers === undefined && options.skills === undefined)
    throw new OnboardingError(
      'Select at least one provider or skill change.',
      'ONBOARDING_INVALID',
      '$.providers',
    );
  const config = await initProject(root);
  const next = await saveConfig(root, {
    ...config,
    ...(options.providers !== undefined ? { providers: [...new Set(options.providers)] } : {}),
    ...(options.skills !== undefined ? { skills: [...new Set(options.skills)] } : {}),
  });
  await advanceStep(root, 'providers', 'complete');
  return next;
}

export async function updateWorkspacePreference(
  root: string,
  patch: { executionPreference?: WorkspaceExecutionPreference; worktreeRoot?: string },
): Promise<LatchkitConfig> {
  root = await resolveProjectRoot(root);
  if (patch.executionPreference === undefined && patch.worktreeRoot === undefined)
    throw new OnboardingError(
      'Provide an execution preference or worktree root.',
      'ONBOARDING_INVALID',
      '$.workspace',
    );
  const config = await readConfig(root);
  const current = config.workspace ?? DEFAULT_WORKSPACE_SETTINGS;
  const next = await saveConfig(root, {
    ...config,
    workspace: {
      executionPreference: patch.executionPreference ?? current.executionPreference,
      worktreeRoot: patch.worktreeRoot ?? current.worktreeRoot,
    },
  });
  await advanceStep(root, 'workspace', 'complete');
  return next;
}

export async function updateVerificationPreference(
  root: string,
  mode: VerificationMode,
  options: ClockOptions = {},
) {
  const result = await configureVerification(root, { defaultMode: mode }, options);
  await advanceStep(root, 'verification', 'complete');
  return result;
}

/** Explicit opt-in/opt-out. Never inferred: onboarding always calls this with
 * a caller-supplied boolean, and declining leaves usage state exactly as
 * `configureUsage`/`inspectUsage` already represent it (`billing.status:
 * "unknown"`, not zero — see docs/local-usage.md). */
export async function updateUsagePreference(
  root: string,
  enabled: boolean,
  options: ClockOptions = {},
) {
  const result = await configureUsage(root, { enabled }, options);
  await advanceStep(root, 'usage', 'complete');
  return result;
}

/** Reuses the existing sync dry-run preview so onboarding never diverges
 * from what `latchkit sync --dry-run` / the console's "Preview sync" already
 * show: the actual project/configuration/provider files setup will change,
 * with conflicts, before anything is written. */
export async function previewOnboardingSetup(root: string) {
  const plan = await planSync(root);
  await advanceStep(root, 'preview', 'complete');
  return plan;
}

/** Reuses the existing registered-resource transaction layer via
 * `syncProject`. An optional `planId` re-checks the previewed plan is still
 * current (the same optimistic-concurrency guard the console API uses);
 * omitting it (the CLI's plain `sync` behavior) recomputes and applies the
 * latest plan directly. */
export async function applyOnboardingSetup(root: string, options: { planId?: string } = {}) {
  return syncProject(root, options.planId ? { planId: options.planId } : {});
}

export async function skipStep(root: string, stepId: string) {
  return advanceStep(root, stepId, 'skip');
}
export async function backStep(root: string, stepId: string) {
  return advanceStep(root, stepId, 'back');
}

export async function completeOnboarding(root: string, options: HandoffOptions = {}) {
  root = await resolveProjectRoot(root);
  const result = await mutate(root, (state) => {
    state.progress.status = 'completed';
    state.completedAt = (options.clock ?? (() => new Date()))().toISOString();
    return { progress: structuredClone(state.progress) };
  });
  await markOnboardingHandoffCompleted({
    projectRoot: root,
    clock: options.clock,
    installRoot: options.installRoot,
  });
  return result;
}

/** Dismiss the current run: it stops being offered automatically (the
 * install-local hand-off flips to "dismissed"), but nothing already saved is
 * discarded, and any later explicit step action resumes and un-dismisses it
 * (see `advanceStep`, which always moves a non-"completed" run back to
 * "in-progress"). This also serves as "cancel": there is nothing else to roll
 * back, because every step commits directly to its own already-idempotent
 * store as it runs. */
export async function dismissOnboarding(root: string, options: HandoffOptions = {}) {
  root = await resolveProjectRoot(root);
  const result = await mutate(root, (state) => {
    state.progress.status = 'dismissed';
    state.dismissedAt = (options.clock ?? (() => new Date()))().toISOString();
    return { progress: structuredClone(state.progress) };
  });
  await markOnboardingHandoffDismissed({
    projectRoot: root,
    clock: options.clock,
    installRoot: options.installRoot,
  });
  return result;
}

function honestProviderState(
  provider: (typeof PROVIDERS)[number],
  detected: boolean,
  selected: boolean,
) {
  return {
    id: provider.id,
    label: provider.label,
    skillDirectory: provider.skillDirectory,
    // "unavailable": not found on PATH at all. "installed": found, not yet
    // selected for this project. "configured": found and selected here.
    // "authenticated" is always reported separately and honestly as
    // "unknown" — no adapter in this repository can verify a signed-in
    // provider session (see providers/contracts.ts verification.authenticated
    // and PROVIDERS in providers/registry.ts); claiming otherwise here would
    // be exactly the dishonest state acceptance criteria forbid.
    status: !detected ? 'unavailable' : selected ? 'configured' : 'installed',
    installed: detected,
    selected,
    authenticated: 'unknown' as const,
    authenticatedReason:
      'Latchkit does not check provider credentials. Only the provider itself can confirm a signed-in session.',
  };
}

export interface OnboardingReadiness {
  ready: boolean;
  missingPrerequisites: string[];
  nextStepId: OnboardingStepId | null;
  nextAction: string;
}

export async function inspectOnboarding(
  root: string,
  { clock = () => new Date(), installRoot }: HandoffOptions = {},
) {
  root = await resolveProjectRoot(root);
  const [state, handoff, doctorReport] = await Promise.all([
    readOnboardingState(root, { clock }),
    readOnboardingHandoffState(installRoot),
    doctor(root),
  ]);
  let config: LatchkitConfig | null = null;
  try {
    config = await readConfig(root);
  } catch {
    config = null;
  }
  const [verification, usage] = await Promise.all([
    inspectVerificationSettings(root, { clock }),
    inspectUsage(root, { clock }),
  ]);
  const providers = PROVIDERS.map((provider) => {
    const detected =
      doctorReport.providers.find((item) => item.id === provider.id)?.detected ?? false;
    const selected = config?.providers.includes(provider.id) ?? false;
    return honestProviderState(provider, detected, selected);
  });
  const workspace = config?.workspace ?? DEFAULT_WORKSPACE_SETTINGS;
  const missingPrerequisites: string[] = [];
  if (!config)
    missingPrerequisites.push('Project is not initialized yet. Complete the project step.');
  else if (config.providers.length === 0)
    missingPrerequisites.push('No coding agent is selected yet.');
  else if (!providers.some((provider) => provider.selected && provider.installed))
    missingPrerequisites.push(
      'No selected agent was detected on PATH. Install and authenticate one, then re-run doctor.',
    );
  const nextStepId = nextOnboardingStepId(state.progress);
  const nextAction = nextStepId
    ? `Complete the "${nextStepId}" step.`
    : missingPrerequisites.length
      ? missingPrerequisites[0]!
      : 'Open the project and run latchkit spec (or start a task) to begin work.';
  const readiness: OnboardingReadiness = {
    ready: missingPrerequisites.length === 0 && nextStepId === null,
    missingPrerequisites,
    nextStepId,
    nextAction,
  };
  return {
    project: state.project,
    revision: state.revision,
    progress: state.progress,
    handoff,
    initialized: config !== null,
    doctor: doctorReport,
    providers,
    skills: SKILLS,
    selection: { providers: config?.providers ?? [], skills: config?.skills ?? [] },
    workspace,
    verification: verification.settings,
    usage: {
      enabled: usage.settings.enabled,
      retentionDays: usage.settings.retentionDays,
      billing: usage.billing,
    },
    readiness,
  };
}
