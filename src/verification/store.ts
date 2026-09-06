import { randomUUID } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import {
  DEFAULT_VERIFICATION_MODE,
  parseVerificationSettingsState,
  VERIFICATION_SETTINGS_PATH,
  VERIFICATION_SETTINGS_SCHEMA_VERSION,
  validateVerificationSettingsState,
} from './contracts.js';
import type { VerificationSettingsState } from './contracts.js';

export { VERIFICATION_SETTINGS_PATH };

const now = (clock: () => Date) => clock().toISOString();

export function emptyVerificationSettingsState(
  clock = () => new Date(),
): VerificationSettingsState {
  const createdAt = now(clock);
  return {
    schemaVersion: VERIFICATION_SETTINGS_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}` },
    revision: 0,
    settings: { defaultMode: DEFAULT_VERIFICATION_MODE },
    createdAt,
    updatedAt: createdAt,
  };
}

export async function readVerificationSettingsState(
  root: string,
  { clock }: { clock?: () => Date } = {},
): Promise<VerificationSettingsState> {
  const raw = await readOptional(root, VERIFICATION_SETTINGS_PATH);
  return raw === null ? emptyVerificationSettingsState(clock) : parseVerificationSettingsState(raw);
}

export async function writeVerificationSettingsState(
  root: string,
  state: VerificationSettingsState,
): Promise<void> {
  validateVerificationSettingsState(state);
  await writeAtomic(root, VERIFICATION_SETTINGS_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
