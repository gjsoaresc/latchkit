// Read-only discovery/preview adapters for external specification frameworks
// (issue #114, first increment: GitHub Spec Kit only). This module never
// writes to disk, never spawns a process, and never follows a reference
// outside the caller-selected root. See docs/spec-imports.md.

export class SpecImportError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'SPEC_IMPORT_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'SpecImportError';
    this.code = code;
    this.path = path;
  }
}

export const SPEC_IMPORT_MANIFEST_SCHEMA_VERSION = 1;

export const SPEC_KIT_ADAPTER_ID = 'spec-kit';
/** This adapter's own version, independent of the pinned upstream commit. */
export const SPEC_KIT_ADAPTER_VERSION = '1.0.0';

/**
 * The exact upstream GitHub Spec Kit release this adapter parses against.
 * Recorded from `gh api repos/github/spec-kit/{tags,releases}` on 2026-09-06;
 * see the adapter compatibility table in docs/spec-imports.md. A future
 * upstream template change requires a new pinned adapter version, not a
 * silent behavior change here.
 */
export const SPEC_KIT_UPSTREAM = Object.freeze({
  repository: 'https://github.com/github/spec-kit',
  ref: 'v1.0.4',
  commit: 'cb610277fdea781fcfa83d20522c2db37c94068d',
  publishedAt: '2026-09-02T21:06:05Z',
  pinnedTemplatePaths: Object.freeze([
    'templates/spec-template.md',
    'templates/plan-template.md',
    'templates/tasks-template.md',
  ]) as readonly string[],
});

export type SpecImportLimits = {
  /** Feature directories scanned under `<root>/specs/`. */
  maxFeatureDirectories: number;
  /** Files (core + supporting) whose bytes are actually read across the whole discovery. */
  maxTotalFiles: number;
  /** Files (core + supporting) read for a single feature directory. */
  maxFilesPerEntry: number;
  /** A single file larger than this is reported and excluded, never read. */
  maxFileBytes: number;
  /** Sum of bytes read across the whole discovery. */
  maxTotalBytes: number;
  /** Path segments a resolved supporting link may add beyond the source root. */
  maxDepth: number;
  /** Explicit markdown links inspected per artifact file. */
  maxLinksPerArtifact: number;
  /** Checklist tasks parsed per tasks.md. */
  maxTasksPerEntry: number;
  /** User stories parsed per spec.md. */
  maxUserStoriesPerEntry: number;
};

export const DEFAULT_SPEC_IMPORT_LIMITS: SpecImportLimits = Object.freeze({
  maxFeatureDirectories: 200,
  maxTotalFiles: 2000,
  maxFilesPerEntry: 32,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxDepth: 6,
  maxLinksPerArtifact: 100,
  maxTasksPerEntry: 500,
  maxUserStoriesPerEntry: 50,
});

export type SpecImportArtifactRole = 'spec' | 'plan' | 'tasks' | 'supporting';

export type SpecImportArtifact = {
  role: SpecImportArtifactRole;
  /** Root-relative, `/`-separated. Never absolute, never a symlink target. */
  path: string;
  sha256: string;
  byteLength: number;
  /** Markdown ATX heading text found in the file, in document order, bounded. */
  sectionAnchors: string[];
};

export type SpecImportDeclaredLink = {
  fromRole: SpecImportArtifactRole;
  fromPath: string;
  linkText: string;
  /** Root-relative resolved target path. */
  targetPath: string;
  targetExists: boolean;
  provenance: 'explicit-link';
};

export type SpecImportInferredReference = {
  fromRole: SpecImportArtifactRole;
  fromPath: string;
  /** Bounded excerpt of the source text the candidate path was found in. */
  text: string;
  /** The raw path-like token as written; never resolved, hashed, or existence-checked. */
  candidatePath: string;
  provenance: 'inferred';
  /** Always false: structural co-location or wording cannot establish a relationship. */
  established: false;
};

export type SpecImportTaskIdentifier = {
  id: string;
  checked: boolean;
  parallel: boolean;
  userStory: string | null;
  description: string;
};

export type SpecImportUserStory = {
  number: number;
  title: string;
  priority: string | null;
};

export type SpecImportWarning = { code: string; message: string; path?: string };

export type SpecImportEntryStatus =
  'complete' | 'partial' | 'ambiguous' | 'unsupported-version' | 'malformed' | 'inaccessible';

/** Source-declared status is an imported claim only, never verification evidence. */
export type SpecImportDeclaredStatus = {
  value: string | null;
  provenance: 'source-declared-claim';
};

export type SpecImportEntry = {
  /** The feature directory name; stable and unique within one discovery. */
  id: string;
  /** Directory name with a leading `NNN-` numeric prefix stripped, if present. */
  slug: string;
  /** Root-relative feature directory path, e.g. `specs/001-example`. */
  directory: string;
  status: SpecImportEntryStatus;
  sourceDeclaredStatus: SpecImportDeclaredStatus;
  artifacts: SpecImportArtifact[];
  declaredLinks: SpecImportDeclaredLink[];
  inferredReferences: SpecImportInferredReference[];
  parsedIdentifiers: {
    tasks: SpecImportTaskIdentifier[];
    userStories: SpecImportUserStory[];
  };
  warnings: SpecImportWarning[];
};

export type SpecImportManifest = {
  schemaVersion: 1;
  adapter: {
    id: typeof SPEC_KIT_ADAPTER_ID;
    version: string;
    upstream: typeof SPEC_KIT_UPSTREAM;
  };
  discoveredAt: string;
  sourceRoot: { path: string };
  limits: SpecImportLimits;
  /** True when a bound was reached and some candidates were not fully processed. */
  truncated: boolean;
  entries: SpecImportEntry[];
  warnings: SpecImportWarning[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function fields(value: unknown, names: string[], required: string[], path: string) {
  if (!record(value)) throw new SpecImportError('Expected an object.', 'SPEC_IMPORT_INVALID', path);
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new SpecImportError(`Unknown field "${key}".`, 'SPEC_IMPORT_INVALID', `${path}.${key}`);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw new SpecImportError(
        'Required field is missing.',
        'SPEC_IMPORT_INVALID',
        `${path}.${key}`,
      );
}
function text(value: unknown, path: string, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string')
    throw new SpecImportError('Expected a string.', 'SPEC_IMPORT_INVALID', path);
}
function bool(value: unknown, path: string) {
  if (typeof value !== 'boolean')
    throw new SpecImportError('Expected a boolean.', 'SPEC_IMPORT_INVALID', path);
}
function nonNegativeInt(value: unknown, path: string) {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new SpecImportError('Expected a non-negative integer.', 'SPEC_IMPORT_INVALID', path);
}
function relativePath(value: unknown, path: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new SpecImportError(
      'Expected a root-relative, "/"-separated path.',
      'SPEC_IMPORT_INVALID',
      path,
    );
}
const ARTIFACT_ROLES = ['spec', 'plan', 'tasks', 'supporting'];
const ENTRY_STATUSES = [
  'complete',
  'partial',
  'ambiguous',
  'unsupported-version',
  'malformed',
  'inaccessible',
];

function validateWarning(value: unknown, path: string) {
  fields(value, ['code', 'message', 'path'], ['code', 'message'], path);
  const warning = value as SpecImportWarning;
  text(warning.code, `${path}.code`);
  if (!warning.code)
    throw new SpecImportError('Expected a warning code.', 'SPEC_IMPORT_INVALID', `${path}.code`);
  text(warning.message, `${path}.message`);
  if (warning.path !== undefined) text(warning.path, `${path}.path`);
}

function validateArtifact(value: unknown, path: string) {
  fields(
    value,
    ['role', 'path', 'sha256', 'byteLength', 'sectionAnchors'],
    ['role', 'path', 'sha256', 'byteLength', 'sectionAnchors'],
    path,
  );
  const artifact = value as SpecImportArtifact;
  if (!ARTIFACT_ROLES.includes(artifact.role))
    throw new SpecImportError('Unknown artifact role.', 'SPEC_IMPORT_INVALID', `${path}.role`);
  relativePath(artifact.path, `${path}.path`);
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256))
    throw new SpecImportError(
      'Expected a lowercase SHA-256 digest.',
      'SPEC_IMPORT_INVALID',
      `${path}.sha256`,
    );
  nonNegativeInt(artifact.byteLength, `${path}.byteLength`);
  if (!Array.isArray(artifact.sectionAnchors))
    throw new SpecImportError(
      'Expected an array.',
      'SPEC_IMPORT_INVALID',
      `${path}.sectionAnchors`,
    );
  artifact.sectionAnchors.forEach((anchor, index) =>
    text(anchor, `${path}.sectionAnchors[${index}]`),
  );
}

function validateDeclaredLink(value: unknown, path: string) {
  fields(
    value,
    ['fromRole', 'fromPath', 'linkText', 'targetPath', 'targetExists', 'provenance'],
    ['fromRole', 'fromPath', 'linkText', 'targetPath', 'targetExists', 'provenance'],
    path,
  );
  const link = value as SpecImportDeclaredLink;
  if (!ARTIFACT_ROLES.includes(link.fromRole))
    throw new SpecImportError('Unknown artifact role.', 'SPEC_IMPORT_INVALID', `${path}.fromRole`);
  relativePath(link.fromPath, `${path}.fromPath`);
  text(link.linkText, `${path}.linkText`);
  relativePath(link.targetPath, `${path}.targetPath`);
  bool(link.targetExists, `${path}.targetExists`);
  if (link.provenance !== 'explicit-link')
    throw new SpecImportError(
      'Expected provenance "explicit-link".',
      'SPEC_IMPORT_INVALID',
      `${path}.provenance`,
    );
}

function validateInferredReference(value: unknown, path: string) {
  fields(
    value,
    ['fromRole', 'fromPath', 'text', 'candidatePath', 'provenance', 'established'],
    ['fromRole', 'fromPath', 'text', 'candidatePath', 'provenance', 'established'],
    path,
  );
  const reference = value as SpecImportInferredReference;
  if (!ARTIFACT_ROLES.includes(reference.fromRole))
    throw new SpecImportError('Unknown artifact role.', 'SPEC_IMPORT_INVALID', `${path}.fromRole`);
  relativePath(reference.fromPath, `${path}.fromPath`);
  text(reference.text, `${path}.text`);
  text(reference.candidatePath, `${path}.candidatePath`);
  if (reference.provenance !== 'inferred')
    throw new SpecImportError(
      'Expected provenance "inferred".',
      'SPEC_IMPORT_INVALID',
      `${path}.provenance`,
    );
  if (reference.established !== false)
    throw new SpecImportError(
      'Inferred references must not be established by default.',
      'SPEC_IMPORT_INVALID',
      `${path}.established`,
    );
}

function validateTask(value: unknown, path: string) {
  fields(
    value,
    ['id', 'checked', 'parallel', 'userStory', 'description'],
    ['id', 'checked', 'parallel', 'userStory', 'description'],
    path,
  );
  const task = value as SpecImportTaskIdentifier;
  if (typeof task.id !== 'string' || !/^T\d{3,}$/.test(task.id))
    throw new SpecImportError('Expected a Txxx task ID.', 'SPEC_IMPORT_INVALID', `${path}.id`);
  bool(task.checked, `${path}.checked`);
  bool(task.parallel, `${path}.parallel`);
  text(task.userStory, `${path}.userStory`, { nullable: true });
  text(task.description, `${path}.description`);
}

function validateUserStory(value: unknown, path: string) {
  fields(value, ['number', 'title', 'priority'], ['number', 'title', 'priority'], path);
  const story = value as SpecImportUserStory;
  if (!Number.isInteger(story.number) || story.number < 1)
    throw new SpecImportError(
      'Expected a positive integer.',
      'SPEC_IMPORT_INVALID',
      `${path}.number`,
    );
  text(story.title, `${path}.title`);
  text(story.priority, `${path}.priority`, { nullable: true });
}

function validateEntry(value: unknown, path: string) {
  fields(
    value,
    [
      'id',
      'slug',
      'directory',
      'status',
      'sourceDeclaredStatus',
      'artifacts',
      'declaredLinks',
      'inferredReferences',
      'parsedIdentifiers',
      'warnings',
    ],
    [
      'id',
      'slug',
      'directory',
      'status',
      'sourceDeclaredStatus',
      'artifacts',
      'declaredLinks',
      'inferredReferences',
      'parsedIdentifiers',
      'warnings',
    ],
    path,
  );
  const entry = value as SpecImportEntry;
  text(entry.id, `${path}.id`);
  if (!entry.id)
    throw new SpecImportError('Expected a non-empty id.', 'SPEC_IMPORT_INVALID', `${path}.id`);
  text(entry.slug, `${path}.slug`);
  relativePath(entry.directory, `${path}.directory`);
  if (!ENTRY_STATUSES.includes(entry.status))
    throw new SpecImportError('Unknown entry status.', 'SPEC_IMPORT_INVALID', `${path}.status`);
  fields(
    entry.sourceDeclaredStatus,
    ['value', 'provenance'],
    ['value', 'provenance'],
    `${path}.sourceDeclaredStatus`,
  );
  text(entry.sourceDeclaredStatus.value, `${path}.sourceDeclaredStatus.value`, { nullable: true });
  if (entry.sourceDeclaredStatus.provenance !== 'source-declared-claim')
    throw new SpecImportError(
      'Expected provenance "source-declared-claim".',
      'SPEC_IMPORT_INVALID',
      `${path}.sourceDeclaredStatus.provenance`,
    );
  if (!Array.isArray(entry.artifacts))
    throw new SpecImportError('Expected an array.', 'SPEC_IMPORT_INVALID', `${path}.artifacts`);
  entry.artifacts.forEach((artifact, index) =>
    validateArtifact(artifact, `${path}.artifacts[${index}]`),
  );
  if (!Array.isArray(entry.declaredLinks))
    throw new SpecImportError('Expected an array.', 'SPEC_IMPORT_INVALID', `${path}.declaredLinks`);
  entry.declaredLinks.forEach((link, index) =>
    validateDeclaredLink(link, `${path}.declaredLinks[${index}]`),
  );
  if (!Array.isArray(entry.inferredReferences))
    throw new SpecImportError(
      'Expected an array.',
      'SPEC_IMPORT_INVALID',
      `${path}.inferredReferences`,
    );
  entry.inferredReferences.forEach((reference, index) =>
    validateInferredReference(reference, `${path}.inferredReferences[${index}]`),
  );
  fields(
    entry.parsedIdentifiers,
    ['tasks', 'userStories'],
    ['tasks', 'userStories'],
    `${path}.parsedIdentifiers`,
  );
  if (!Array.isArray(entry.parsedIdentifiers.tasks))
    throw new SpecImportError(
      'Expected an array.',
      'SPEC_IMPORT_INVALID',
      `${path}.parsedIdentifiers.tasks`,
    );
  entry.parsedIdentifiers.tasks.forEach((task, index) =>
    validateTask(task, `${path}.parsedIdentifiers.tasks[${index}]`),
  );
  if (!Array.isArray(entry.parsedIdentifiers.userStories))
    throw new SpecImportError(
      'Expected an array.',
      'SPEC_IMPORT_INVALID',
      `${path}.parsedIdentifiers.userStories`,
    );
  entry.parsedIdentifiers.userStories.forEach((story, index) =>
    validateUserStory(story, `${path}.parsedIdentifiers.userStories[${index}]`),
  );
  if (!Array.isArray(entry.warnings))
    throw new SpecImportError('Expected an array.', 'SPEC_IMPORT_INVALID', `${path}.warnings`);
  entry.warnings.forEach((warning, index) =>
    validateWarning(warning, `${path}.warnings[${index}]`),
  );
}

/** Structural validation only; used to keep the manifest this module builds honest. */
export function validateSpecImportManifest(input: unknown): SpecImportManifest {
  const value = input as SpecImportManifest;
  fields(
    value,
    [
      'schemaVersion',
      'adapter',
      'discoveredAt',
      'sourceRoot',
      'limits',
      'truncated',
      'entries',
      'warnings',
    ],
    [
      'schemaVersion',
      'adapter',
      'discoveredAt',
      'sourceRoot',
      'limits',
      'truncated',
      'entries',
      'warnings',
    ],
    '$',
  );
  if (value.schemaVersion !== SPEC_IMPORT_MANIFEST_SCHEMA_VERSION)
    throw new SpecImportError(
      `Unsupported spec-import manifest schema version ${String(value.schemaVersion)}.`,
      'SPEC_IMPORT_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  fields(value.adapter, ['id', 'version', 'upstream'], ['id', 'version', 'upstream'], '$.adapter');
  if (value.adapter.id !== SPEC_KIT_ADAPTER_ID)
    throw new SpecImportError('Unknown adapter ID.', 'SPEC_IMPORT_INVALID', '$.adapter.id');
  text(value.adapter.version, '$.adapter.version');
  if (typeof value.discoveredAt !== 'string' || !Number.isFinite(Date.parse(value.discoveredAt)))
    throw new SpecImportError(
      'Expected an ISO date-time.',
      'SPEC_IMPORT_INVALID',
      '$.discoveredAt',
    );
  fields(value.sourceRoot, ['path'], ['path'], '$.sourceRoot');
  text(value.sourceRoot.path, '$.sourceRoot.path');
  if (!value.sourceRoot.path)
    throw new SpecImportError(
      'Expected a non-empty path.',
      'SPEC_IMPORT_INVALID',
      '$.sourceRoot.path',
    );
  bool(value.truncated, '$.truncated');
  if (!Array.isArray(value.entries))
    throw new SpecImportError('Expected an array.', 'SPEC_IMPORT_INVALID', '$.entries');
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    validateEntry(entry, `$.entries[${index}]`);
    if (seen.has(entry.id))
      throw new SpecImportError(
        'Duplicate entry id.',
        'SPEC_IMPORT_INVALID',
        `$.entries[${index}].id`,
      );
    seen.add(entry.id);
  });
  if (!Array.isArray(value.warnings))
    throw new SpecImportError('Expected an array.', 'SPEC_IMPORT_INVALID', '$.warnings');
  value.warnings.forEach((warning, index) => validateWarning(warning, `$.warnings[${index}]`));
  return value;
}
