import { errorMessage } from '../types.js';

/**
 * User-local, cross-project registry: the projects a person has initialized, opened, run
 * work through, or explicitly added, independent of whichever single project the running
 * `latchkit ui` server currently serves. Stored outside any project checkout (see
 * ./store.js), never inside `.latchkit/`. This is additive: it does not change the shape or
 * location of any existing per-project store (task-state, project memory, usage, workflows).
 */
export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
/** Relative to the user-local projects registry root (see ./store.js). */
export const PROJECT_REGISTRY_PATH = 'registry-v1.json';
export const MAX_DISPLAY_NAME_BYTES = 200;

/** How a project entered the registry. Distinct from `lastSeenVia`, which tracks the most
 * recent touch without erasing how the project was first captured. `onboarding` is the
 * installation-onboarding wizard's "select/confirm a project" step (issue #100,
 * `src/onboarding/service.ts`'s `registerProjectWithRegistry`) — kept distinct from `init` so a
 * project captured through the first-run wizard is distinguishable from one captured by a bare
 * `latchkit init`. */
export const PROJECT_SOURCES = Object.freeze([
  'init',
  'ui-start',
  'task-run',
  'manual',
  'onboarding',
]);
export type ProjectSource = 'init' | 'ui-start' | 'task-run' | 'manual' | 'onboarding';

export type ProjectRecord = {
  schemaVersion: 1;
  id: string;
  /** Absolute, OS-native path resolved (realpath) at registration time. The registry never
   * stores a relative or unresolved path, so a moved project is detected as unavailable
   * rather than silently resolving somewhere else. */
  root: string;
  displayName: string;
  addedAt: string;
  addedVia: ProjectSource;
  lastSeenAt: string;
  lastSeenVia: ProjectSource;
};

export type ProjectRegistryState = {
  schemaVersion: 1;
  revision: number;
  createdAt: string;
  updatedAt: string;
  projects: ProjectRecord[];
};

export class ProjectError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code = 'PROJECT_INVALID', status?: number) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const ID_PATTERN =
  /^project_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PROJECT_ID_PATTERN = ID_PATTERN;

function exactKeys(candidate: object, expected: readonly string[]): boolean {
  const actual = Object.keys(candidate).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}

export function assertProjectRecord(value: unknown): asserts value is ProjectRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProjectError('Project record must be an object.', 'PROJECT_REGISTRY_INVALID');
  const item = value as Partial<ProjectRecord>;
  if (
    !exactKeys(value, [
      'schemaVersion',
      'id',
      'root',
      'displayName',
      'addedAt',
      'addedVia',
      'lastSeenAt',
      'lastSeenVia',
    ]) ||
    item.schemaVersion !== 1 ||
    typeof item.id !== 'string' ||
    !ID_PATTERN.test(item.id) ||
    typeof item.root !== 'string' ||
    !item.root ||
    !boundedText(item.displayName, MAX_DISPLAY_NAME_BYTES) ||
    !isIsoDate(item.addedAt) ||
    !PROJECT_SOURCES.includes(item.addedVia ?? '') ||
    !isIsoDate(item.lastSeenAt) ||
    !PROJECT_SOURCES.includes(item.lastSeenVia ?? '')
  )
    throw new ProjectError('Project record has an unsupported shape.', 'PROJECT_REGISTRY_INVALID');
}

function canonicalRootKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function validateProjectRegistryState(
  value: unknown,
): asserts value is ProjectRegistryState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProjectError('Project registry must be an object.', 'PROJECT_REGISTRY_INVALID');
  const state = value as Partial<ProjectRegistryState>;
  if (
    !exactKeys(value, ['schemaVersion', 'revision', 'createdAt', 'updatedAt', 'projects']) ||
    state.schemaVersion !== PROJECT_REGISTRY_SCHEMA_VERSION ||
    typeof state.revision !== 'number' ||
    !Number.isInteger(state.revision) ||
    state.revision < 0 ||
    !isIsoDate(state.createdAt) ||
    !isIsoDate(state.updatedAt) ||
    !Array.isArray(state.projects)
  )
    throw new ProjectError(
      'Project registry has an unsupported shape.',
      'PROJECT_REGISTRY_INVALID',
    );
  for (const project of state.projects) assertProjectRecord(project);
  const ids = new Set(state.projects.map((item) => item.id));
  if (ids.size !== state.projects.length)
    throw new ProjectError(
      'Project registry has duplicate project IDs.',
      'PROJECT_REGISTRY_INVALID',
    );
  const roots = new Set(state.projects.map((item) => canonicalRootKey(item.root)));
  if (roots.size !== state.projects.length)
    throw new ProjectError(
      'Project registry has duplicate registered roots.',
      'PROJECT_REGISTRY_INVALID',
    );
}

export function parseProjectRegistryState(raw: string): ProjectRegistryState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ProjectError(
      `Project registry is invalid JSON (${errorMessage(error)}).`,
      'PROJECT_REGISTRY_INVALID',
    );
  }
  validateProjectRegistryState(value);
  return value;
}
