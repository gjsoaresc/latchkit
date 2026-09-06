import { withTaskStateLock } from '../task-state/lock.js';
import { resolveProjectRoot } from '../storage.js';
import { isVerificationMode, VerificationError } from './contracts.js';
import type { VerificationMode, VerificationSettings } from './contracts.js';
import { readVerificationSettingsState, writeVerificationSettingsState } from './store.js';
import type { VerificationSettingsState } from './contracts.js';

type ClockOptions = { clock?: () => Date };

async function mutate<T>(
  root: string,
  operation: (state: VerificationSettingsState) => T | Promise<T>,
): Promise<T> {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readVerificationSettingsState(root);
    const result = await operation(state);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    await writeVerificationSettingsState(root, state);
    return result;
  });
}

/** Read the project's persisted default verification mode. Never throws for a
 * missing store; an uninitialized project defaults to standard, matching
 * every task created before this feature existed. */
export async function inspectVerificationSettings(
  root: string,
  { clock = () => new Date() }: ClockOptions = {},
) {
  root = await resolveProjectRoot(root);
  const state = await readVerificationSettingsState(root, { clock });
  return { project: state.project, revision: state.revision, settings: state.settings };
}

/** Resolve the effective default mode without requiring the caller to know
 * whether the settings store exists yet. */
export async function resolveDefaultVerificationMode(root: string): Promise<VerificationMode> {
  return (await inspectVerificationSettings(root)).settings.defaultMode;
}

export async function configureVerification(
  root: string,
  settings: Partial<VerificationSettings>,
  { clock = () => new Date() }: ClockOptions = {},
) {
  if (settings.defaultMode !== undefined && !isVerificationMode(settings.defaultMode))
    throw new VerificationError(
      'defaultMode must be fast or standard.',
      'VERIFICATION_INVALID',
      '$.defaultMode',
    );
  return mutate(root, (state) => {
    state.settings = { ...state.settings, ...settings };
    return { settings: structuredClone(state.settings), revision: state.revision + 1 };
  });
}

export {
  VERIFICATION_MODES,
  DEFAULT_VERIFICATION_MODE,
  DEFAULT_FAST_TIME_BUDGET_MS,
  DEFAULT_FAST_MAX_EXECUTIONS,
  isVerificationMode,
  VerificationError,
  buildVerificationPlan,
  evaluateEvidenceReuse,
  isCheckAffected,
  isBudgetExceeded,
  defaultFastBudget,
  sourceEqual as verificationSourceEqual,
} from './contracts.js';
export type {
  VerificationMode,
  VerificationSettings,
  VerificationPlan,
  VerificationPlanEntry,
  VerificationStats,
  VerificationBudget,
  CheckLike,
  CriterionLike,
  EvidenceLike,
} from './contracts.js';
