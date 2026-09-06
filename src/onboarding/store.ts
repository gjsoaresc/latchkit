import { randomUUID } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import {
  ONBOARDING_PATH,
  ONBOARDING_SCHEMA_VERSION,
  ONBOARDING_STEP_IDS,
  parseOnboardingState,
  validateOnboardingState,
} from './contracts.js';
import type { OnboardingState } from './contracts.js';

export { ONBOARDING_PATH };

const now = (clock: () => Date) => clock().toISOString();

export function emptyOnboardingState(clock = () => new Date()): OnboardingState {
  const createdAt = now(clock);
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}` },
    revision: 0,
    progress: {
      status: 'not-started',
      currentStepId: ONBOARDING_STEP_IDS[0],
      completedStepIds: [],
      skippedStepIds: [],
    },
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    dismissedAt: null,
  };
}

export async function readOnboardingState(
  root: string,
  { clock }: { clock?: () => Date } = {},
): Promise<OnboardingState> {
  const raw = await readOptional(root, ONBOARDING_PATH);
  return raw === null ? emptyOnboardingState(clock) : parseOnboardingState(raw);
}

export async function writeOnboardingState(root: string, state: OnboardingState): Promise<void> {
  validateOnboardingState(state);
  await writeAtomic(root, ONBOARDING_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
