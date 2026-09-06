import { errorMessage } from '../types.js';
export type MemorySource = { path: string; observedAt: string; sha256: string | null };
export type ProjectMemory = {
  id: string;
  revision: number;
  kind: string;
  title: string;
  text: string;
  tags: string[];
  sources: MemorySource[];
  provenance: { kind: string; reference: string; importedId: string | null };
  supersedes: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ProjectMemoryState = {
  schemaVersion: number;
  project: { id: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  memories: ProjectMemory[];
};
export type MemoryExport = { schemaVersion: number; exportedAt: string; memories: ProjectMemory[] };
export const PROJECT_MEMORY_SCHEMA_VERSION = 1;
export const PROJECT_MEMORY_EXPORT_SCHEMA_VERSION = 1;
export const MEMORY_KINDS = Object.freeze([
  'decision',
  'discovery',
  'constraint',
  'resolved-defect',
]);

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const memoryId = new RegExp(`^memory_${uuid}$`, 'i');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class ProjectMemoryError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'PROJECT_MEMORY_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'ProjectMemoryError';
    this.code = code;
    this.path = path;
  }
}

function fields(value: unknown, names: string[], required: string[], path: string) {
  if (!record(value))
    throw new ProjectMemoryError('Expected an object.', 'PROJECT_MEMORY_INVALID', path);
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new ProjectMemoryError(
        `Unknown field "${key}".`,
        'PROJECT_MEMORY_INVALID',
        `${path}.${key}`,
      );
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw new ProjectMemoryError(
        'Required field is missing.',
        'PROJECT_MEMORY_INVALID',
        `${path}.${key}`,
      );
}
function text(value: unknown, path: string, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.trim())
    throw new ProjectMemoryError('Expected a non-empty string.', 'PROJECT_MEMORY_INVALID', path);
  return value;
}
function timestamp(value: unknown, path: string, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new ProjectMemoryError('Expected an ISO date-time.', 'PROJECT_MEMORY_INVALID', path);
  return value;
}
function validateSource(value: MemorySource, path: string) {
  fields(value, ['path', 'observedAt', 'sha256'], ['path', 'observedAt', 'sha256'], path);
  if (
    typeof value.path !== 'string' ||
    !value.path ||
    value.path.includes('\\') ||
    value.path.startsWith('/') ||
    value.path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new ProjectMemoryError(
      'Expected a repository-relative path.',
      'PROJECT_MEMORY_INVALID',
      `${path}.path`,
    );
  timestamp(value.observedAt, `${path}.observedAt`);
  if (value.sha256 !== null && !/^[a-f0-9]{64}$/.test(value.sha256))
    throw new ProjectMemoryError(
      'Expected a lowercase SHA-256 digest or null.',
      'PROJECT_MEMORY_INVALID',
      `${path}.sha256`,
    );
}
function validateMemory(value: ProjectMemory, path: string) {
  const names = [
    'id',
    'revision',
    'kind',
    'title',
    'text',
    'tags',
    'sources',
    'provenance',
    'supersedes',
    'deletedAt',
    'createdAt',
    'updatedAt',
  ];
  fields(value, names, names, path);
  if (typeof value.id !== 'string' || !memoryId.test(value.id))
    throw new ProjectMemoryError(
      'Expected a stable memory ID.',
      'PROJECT_MEMORY_INVALID',
      `${path}.id`,
    );
  if (!Number.isInteger(value.revision) || value.revision < 1)
    throw new ProjectMemoryError(
      'Expected a positive revision.',
      'PROJECT_MEMORY_INVALID',
      `${path}.revision`,
    );
  if (!MEMORY_KINDS.includes(value.kind))
    throw new ProjectMemoryError('Unknown memory kind.', 'PROJECT_MEMORY_INVALID', `${path}.kind`);
  text(value.title, `${path}.title`);
  text(value.text, `${path}.text`);
  if (
    !Array.isArray(value.tags) ||
    value.tags.some((tag) => typeof tag !== 'string' || !tag.trim())
  )
    throw new ProjectMemoryError(
      'Expected non-empty string tags.',
      'PROJECT_MEMORY_INVALID',
      `${path}.tags`,
    );
  if (!Array.isArray(value.sources))
    throw new ProjectMemoryError(
      'Expected sources array.',
      'PROJECT_MEMORY_INVALID',
      `${path}.sources`,
    );
  value.sources.forEach((source, index) => validateSource(source, `${path}.sources[${index}]`));
  fields(
    value.provenance,
    ['kind', 'reference', 'importedId'],
    ['kind', 'reference', 'importedId'],
    `${path}.provenance`,
  );
  if (!['manual', 'import'].includes(value.provenance.kind))
    throw new ProjectMemoryError(
      'Unknown provenance kind.',
      'PROJECT_MEMORY_INVALID',
      `${path}.provenance.kind`,
    );
  text(value.provenance.reference, `${path}.provenance.reference`);
  if (
    value.provenance.importedId !== null &&
    (typeof value.provenance.importedId !== 'string' || !memoryId.test(value.provenance.importedId))
  )
    throw new ProjectMemoryError(
      'Expected imported memory ID or null.',
      'PROJECT_MEMORY_INVALID',
      `${path}.provenance.importedId`,
    );
  if (
    value.supersedes !== null &&
    (typeof value.supersedes !== 'string' || !memoryId.test(value.supersedes))
  )
    throw new ProjectMemoryError(
      'Expected superseded memory ID or null.',
      'PROJECT_MEMORY_INVALID',
      `${path}.supersedes`,
    );
  timestamp(value.deletedAt, `${path}.deletedAt`, { nullable: true });
  timestamp(value.createdAt, `${path}.createdAt`);
  timestamp(value.updatedAt, `${path}.updatedAt`);
}

export function validateProjectMemory(input: unknown): ProjectMemoryState {
  const value = input as ProjectMemoryState;
  const names = ['schemaVersion', 'project', 'revision', 'createdAt', 'updatedAt', 'memories'];
  fields(value, names, names, '$');
  if (value.schemaVersion !== PROJECT_MEMORY_SCHEMA_VERSION)
    throw new ProjectMemoryError(
      `Unsupported project-memory schema version ${value.schemaVersion}.`,
      'PROJECT_MEMORY_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  fields(value.project, ['id'], ['id'], '$.project');
  text(value.project.id, '$.project.id');
  if (!Number.isInteger(value.revision) || value.revision < 0)
    throw new ProjectMemoryError(
      'Expected a non-negative revision.',
      'PROJECT_MEMORY_INVALID',
      '$.revision',
    );
  timestamp(value.createdAt, '$.createdAt');
  timestamp(value.updatedAt, '$.updatedAt');
  if (!Array.isArray(value.memories))
    throw new ProjectMemoryError(
      'Expected memories array.',
      'PROJECT_MEMORY_INVALID',
      '$.memories',
    );
  const ids = new Set();
  value.memories.forEach((item, index) => {
    validateMemory(item, `$.memories[${index}]`);
    if (ids.has(item.id))
      throw new ProjectMemoryError(
        'Duplicate memory ID.',
        'PROJECT_MEMORY_INVALID',
        `$.memories[${index}].id`,
      );
    ids.add(item.id);
  });
  return value;
}

export function parseProjectMemory(raw: string) {
  try {
    return validateProjectMemory(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ProjectMemoryError) throw error;
    throw new ProjectMemoryError(
      `Invalid JSON (${errorMessage(error)}).`,
      'PROJECT_MEMORY_INVALID_JSON',
    );
  }
}
export function validateMemoryExport(input: unknown): MemoryExport {
  const value = input as MemoryExport;
  fields(
    value,
    ['schemaVersion', 'exportedAt', 'memories'],
    ['schemaVersion', 'exportedAt', 'memories'],
    '$',
  );
  if (value.schemaVersion !== PROJECT_MEMORY_EXPORT_SCHEMA_VERSION)
    throw new ProjectMemoryError(
      'Unsupported memory export schema version.',
      'PROJECT_MEMORY_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  timestamp(value.exportedAt, '$.exportedAt');
  if (!Array.isArray(value.memories))
    throw new ProjectMemoryError(
      'Expected memories array.',
      'PROJECT_MEMORY_INVALID',
      '$.memories',
    );
  value.memories.forEach((item, index) => validateMemory(item, `$.memories[${index}]`));
  return value;
}
