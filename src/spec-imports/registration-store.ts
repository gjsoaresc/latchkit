// Persisted store for explicit spec-import registrations (issue #114,
// registration increment). This module never touches task-state; it tracks
// only Latchkit's own association metadata (which discovered entry maps to
// which task/record, and at what source hash) so reinspection and detach do
// not require re-running discovery or reading task-state. Reads/writes are
// plain, atomic (`writeAtomic`), and always guarded by the caller holding
// `withProjectLock` (see registration-service.ts) — the same lock already
// used by other Latchkit-owned managed-resource stores (see
// src/managed-tools/fcc.ts, src/integrations/mcp/managed.ts). See
// docs/spec-imports.md for why this store does not also route through
// src/installer/transactions.ts: that facility's journal is anchored to a
// single project-wide `.latchkit/manifest.json`, which is installer-owned
// state this feature has no reason to depend on or take a stake in.
import { readOptional, writeAtomic } from '../storage.js';
import {
  emptySpecImportRegistrationStore,
  validateSpecImportRegistrationStore,
  type SpecImportRegistrationStore,
} from './contracts.js';

export const SPEC_IMPORT_REGISTRATIONS_PATH = '.latchkit/spec-imports/registrations-v1.json';

export type SpecImportRegistrationWriteOptions = {
  /** Test-only fault-injection point, same shape as `writeAtomic`'s own boundary callback
   * ("prepared" after the temp file is written and synced, before the atomic rename). */
  faultBoundary?: (
    boundary: string,
    detail: { temporary?: string; target: string },
  ) => Promise<void>;
};

/** Read the current store, or an empty one when nothing has been registered yet. Never
 * mutates and takes no lock; callers that will write should hold `withProjectLock` across
 * both this read and the subsequent write. */
export async function readSpecImportRegistrationStore(
  root: string,
): Promise<SpecImportRegistrationStore> {
  const raw = await readOptional(root, SPEC_IMPORT_REGISTRATIONS_PATH);
  if (raw === null) return emptySpecImportRegistrationStore();
  return validateSpecImportRegistrationStore(JSON.parse(raw));
}

/** Validate and atomically persist the store. Callers must already hold `withProjectLock`. */
export async function writeSpecImportRegistrationStore(
  root: string,
  store: SpecImportRegistrationStore,
  options: SpecImportRegistrationWriteOptions = {},
): Promise<void> {
  validateSpecImportRegistrationStore(store);
  await writeAtomic(
    root,
    SPEC_IMPORT_REGISTRATIONS_PATH,
    `${JSON.stringify(store, null, 2)}\n`,
    0o600,
    { faultBoundary: options.faultBoundary },
  );
}
