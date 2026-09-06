import path from 'node:path';
import { readOptional, writeAtomic } from '../storage.js';
import { withTaskStateLock } from '../task-state/lock.js';
import { defaultInstallationRoot } from '../installation/manager.js';
import {
  PROJECT_REGISTRY_PATH,
  PROJECT_REGISTRY_SCHEMA_VERSION,
  parseProjectRegistryState,
  validateProjectRegistryState,
  type ProjectRegistryState,
} from './contracts.js';

export { PROJECT_REGISTRY_PATH } from './contracts.js';

/**
 * The dedicated subdirectory of the user-local installation root (see
 * src/installation/manager.js's `defaultInstallationRoot`) that stores the project registry.
 * Kept apart from installed-bundle files (`versions/`, `bin/`, `current`) under the same
 * well-known root so the registry survives independently of any particular installed
 * version and does not collide with bundle-owned paths. Callers needing an isolated
 * location (tests, an explicit override) pass their own `registryRoot` to every function
 * below instead of relying on this default, mirroring `defaultInstallationRoot`'s own
 * caller-supplied-root convention. `LATCHKIT_PROJECTS_ROOT` explicitly overrides this
 * default (used by this repository's own test suite — see test/env.mjs and
 * playwright.config.js — so `npm test`/`npm run test:browser` never write into a real
 * machine-wide location; an operator may also set it to relocate the registry).
 */
export function defaultProjectsRegistryRoot(): string {
  const override = process.env.LATCHKIT_PROJECTS_ROOT;
  if (override) return path.resolve(override);
  return path.join(defaultInstallationRoot(), 'projects');
}

function emptyState(clock: () => Date): ProjectRegistryState {
  const createdAt = clock().toISOString();
  return {
    schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    projects: [],
  };
}

async function readUnlocked(
  registryRoot: string,
  clock: () => Date,
): Promise<ProjectRegistryState> {
  const raw = await readOptional(registryRoot, PROJECT_REGISTRY_PATH);
  return raw === null ? emptyState(clock) : parseProjectRegistryState(raw);
}

async function writeUnlocked(registryRoot: string, state: ProjectRegistryState): Promise<void> {
  await writeAtomic(
    registryRoot,
    PROJECT_REGISTRY_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
    0o600,
  );
}

/** Read-only snapshot of the registry, taken under the same lock used for mutations so a
 * concurrent write is never observed half-applied. */
export async function readProjectRegistry(
  registryRoot: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
): Promise<ProjectRegistryState> {
  return withTaskStateLock(registryRoot, async () =>
    structuredClone(await readUnlocked(registryRoot, clock)),
  );
}

/**
 * Create-or-mutate helper shared by every registry service operation, following the same
 * atomic, lock-protected read/write pattern as `src/workflows/spec-decision-store.ts` and
 * `src/usage/baseline-store.ts`. `operation` receives the current state inside the lock; if
 * it throws, nothing is persisted. On success the state is re-validated and written back
 * before the lock releases, so a caller never observes a half-applied registry.
 */
export async function mutateProjectRegistry<T>(
  registryRoot: string,
  operation: (state: ProjectRegistryState) => T | Promise<T>,
  { clock = () => new Date() }: { clock?: () => Date } = {},
): Promise<T> {
  return withTaskStateLock(registryRoot, async () => {
    const state = await readUnlocked(registryRoot, clock);
    const result = await operation(state);
    state.updatedAt = clock().toISOString();
    validateProjectRegistryState(state);
    await writeUnlocked(registryRoot, state);
    return result;
  });
}
