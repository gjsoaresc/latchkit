// Read-only discovery/preview adapters for external specification frameworks
// (issue #114). This module never writes to disk, never spawns a process,
// and never follows a reference outside the caller-selected root. See
// docs/spec-imports.md.

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

/** Shape shared by every adapter's pinned-upstream record (contracts.ts). */
export type SpecImportUpstreamPin = {
  repository: string;
  ref: string;
  commit: string;
  publishedAt: string;
  pinnedTemplatePaths: readonly string[];
};

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
export const SPEC_KIT_UPSTREAM: SpecImportUpstreamPin = Object.freeze({
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

export const OPENSPEC_ADAPTER_ID = 'openspec';
/** This adapter's own version, independent of the pinned upstream commit. */
export const OPENSPEC_ADAPTER_VERSION = '1.0.0';

/**
 * The exact upstream OpenSpec release this adapter parses against. Recorded
 * from `gh api repos/Fission-AI/OpenSpec/{tags,releases}` on 2026-09-06; see
 * the adapter compatibility table in docs/spec-imports.md. The pinned
 * template paths are the built-in `spec-driven` schema's scaffold files,
 * which document the recognizable marker headings this adapter checks for.
 */
export const OPENSPEC_UPSTREAM: SpecImportUpstreamPin = Object.freeze({
  repository: 'https://github.com/Fission-AI/OpenSpec',
  ref: 'v1.12.0',
  commit: 'e062b9572be933564ba3899d059377dfa1393e32',
  publishedAt: '2026-09-03T00:09:15Z',
  pinnedTemplatePaths: Object.freeze([
    'schemas/spec-driven/templates/proposal.md',
    'schemas/spec-driven/templates/design.md',
    'schemas/spec-driven/templates/tasks.md',
    'schemas/spec-driven/templates/spec.md',
  ]) as readonly string[],
});

export const TINYSPEC_ADAPTER_ID = 'tinyspec';
/** This adapter's own version, independent of the pinned upstream commit. */
export const TINYSPEC_ADAPTER_VERSION = '1.0.0';

/**
 * The exact upstream `nmcdaines/tinyspec` release this adapter parses
 * against. Recorded from `gh api repos/nmcdaines/tinyspec/{tags,releases}`
 * on 2026-09-06; see the adapter compatibility table in
 * docs/spec-imports.md. `.specs/templates/default.md` is the shipped default
 * scaffold; `src/spec/mod.rs` and `src/spec/summary.rs` are the upstream
 * source files this adapter's front-matter/task parsing was pinned against.
 */
export const TINYSPEC_UPSTREAM: SpecImportUpstreamPin = Object.freeze({
  repository: 'https://github.com/nmcdaines/tinyspec',
  ref: 'v0.0.9',
  commit: 'd1c122f10f4bddf07299aea0df6f781e403ed340',
  publishedAt: '2026-02-19T00:01:13Z',
  pinnedTemplatePaths: Object.freeze([
    '.specs/templates/default.md',
    'src/spec/mod.rs',
    'src/spec/summary.rs',
  ]) as readonly string[],
});

export type SpecImportAdapterId =
  typeof SPEC_KIT_ADAPTER_ID | typeof OPENSPEC_ADAPTER_ID | typeof TINYSPEC_ADAPTER_ID;

const KNOWN_ADAPTER_IDS: readonly SpecImportAdapterId[] = Object.freeze([
  SPEC_KIT_ADAPTER_ID,
  OPENSPEC_ADAPTER_ID,
  TINYSPEC_ADAPTER_ID,
]);

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

/**
 * Only meaningful for a source framework that itself documents this
 * distinction (OpenSpec: `current` specs vs. an `active` or `archived`
 * change). `null` when the framework does not document the concept (Spec
 * Kit, TinySpec) — never guessed.
 */
export type SpecImportLifecycle = 'current' | 'active' | 'archived';

export type SpecImportEntry = {
  /** The feature directory (or, for a file-per-entry framework, file) identity; stable and unique within one discovery. */
  id: string;
  /** Human-facing short name with any adapter-specific prefix (numeric, date, or group) stripped, if present. */
  slug: string;
  /** Root-relative path to the entry's directory or file, e.g. `specs/001-example`. */
  directory: string;
  status: SpecImportEntryStatus;
  lifecycle: SpecImportLifecycle | null;
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
    id: SpecImportAdapterId;
    version: string;
    upstream: SpecImportUpstreamPin;
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
  // Task ID shape is adapter-specific (Spec Kit: "T001"; OpenSpec: "1.1";
  // TinySpec: "A", "A.1", or a customized non-empty label) — only bounded
  // and non-empty is enforced here, not one adapter's own convention.
  if (typeof task.id !== 'string' || !task.id || task.id.length > 64)
    throw new SpecImportError(
      'Expected a non-empty task ID no longer than 64 characters.',
      'SPEC_IMPORT_INVALID',
      `${path}.id`,
    );
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

const ENTRY_LIFECYCLES = ['current', 'active', 'archived'];

function validateEntry(value: unknown, path: string) {
  fields(
    value,
    [
      'id',
      'slug',
      'directory',
      'status',
      'lifecycle',
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
      'lifecycle',
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
  if (entry.lifecycle !== null && !ENTRY_LIFECYCLES.includes(entry.lifecycle))
    throw new SpecImportError(
      'Expected null, "current", "active", or "archived".',
      'SPEC_IMPORT_INVALID',
      `${path}.lifecycle`,
    );
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
  if (!KNOWN_ADAPTER_IDS.includes(value.adapter.id))
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

// ---------------------------------------------------------------------------
// Registration (issue #114, registration increment): an explicit, reviewed
// binding of one selected discovered entry into existing Latchkit task
// state. This never copies, moves, or reformats the source file; it stores a
// project-relative path and the SHA-256 observed at registration time,
// exactly like the task record `source` link (src/task-state/records.ts)
// that registration creates. See docs/spec-imports.md.
// ---------------------------------------------------------------------------

export const SPEC_IMPORT_REGISTRATION_SCHEMA_VERSION = 1;
/** Bounds the association store itself; registered tasks/records use the existing,
 * separately bounded task-state limits (MAX_RECORDS_PER_TASK, etc). */
export const MAX_SPEC_IMPORT_REGISTRATIONS = 2000;
export const MAX_SPEC_IMPORT_REGISTRATION_HISTORY = 40;

export type SpecImportRegistrationStatus = 'registered' | 'detached';
export type SpecImportRegistrationAction = 'registered' | 'revised' | 'detached';

export type SpecImportRegisteredArtifact = { path: string; sha256: string };

export type SpecImportRegistrationHistoryEntry = {
  revision: number;
  action: SpecImportRegistrationAction;
  manifestDigest: string;
  entryDirectory: string;
  primaryArtifact: SpecImportRegisteredArtifact;
  taskId: string;
  recordId: string;
  at: string;
};

export type SpecImportRegistration = {
  id: string;
  revision: number;
  status: SpecImportRegistrationStatus;
  adapter: SpecImportAdapterId;
  /** Project-relative, "/"-separated path to the adapter's source root; "" when the source
   * root is the Latchkit project root itself (the common case). */
  sourceRoot: string;
  /** The adapter-scoped entry identity (directory-derived) at the time of the last
   * registration/revision. A renamed source directory produces a different entry ID; see
   * `docs/spec-imports.md` on ambiguous moves/renames. */
  entryId: string;
  entryDirectory: string;
  manifestDigest: string;
  /** Project-relative path + hash of the entry's primary artifact, as last registered. */
  primaryArtifact: SpecImportRegisteredArtifact;
  taskId: string;
  /** The current (non-superseded) imported task record carrying this registration's claim. */
  recordId: string;
  registeredAt: string;
  updatedAt: string;
  detachedAt: string | null;
  history: SpecImportRegistrationHistoryEntry[];
};

export type SpecImportRegistrationStore = {
  schemaVersion: 1;
  registrations: SpecImportRegistration[];
};

export function emptySpecImportRegistrationStore(): SpecImportRegistrationStore {
  return { schemaVersion: SPEC_IMPORT_REGISTRATION_SCHEMA_VERSION, registrations: [] };
}

function projectRelativeRootPath(value: unknown, path: string): string {
  if (typeof value !== 'string')
    throw new SpecImportError('Expected a string.', 'SPEC_IMPORT_INVALID', path);
  if (value === '') return value;
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new SpecImportError(
      'Expected a project-relative, "/"-separated path, or "".',
      'SPEC_IMPORT_INVALID',
      path,
    );
  return value;
}

function stableId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value || value.length > 128)
    throw new SpecImportError(
      'Expected a non-empty ID no longer than 128 characters.',
      'SPEC_IMPORT_INVALID',
      path,
    );
  return value;
}

function isoDateTime(value: unknown, path: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new SpecImportError('Expected an ISO date-time.', 'SPEC_IMPORT_INVALID', path);
  return value;
}

const REGISTRATION_HASH_PATTERN = /^[a-f0-9]{64}$/;

function validateRegisteredArtifact(value: unknown, path: string): SpecImportRegisteredArtifact {
  fields(value, ['path', 'sha256'], ['path', 'sha256'], path);
  const artifact = value as SpecImportRegisteredArtifact;
  relativePath(artifact.path, `${path}.path`);
  if (typeof artifact.sha256 !== 'string' || !REGISTRATION_HASH_PATTERN.test(artifact.sha256))
    throw new SpecImportError(
      'Expected a lowercase SHA-256 digest.',
      'SPEC_IMPORT_INVALID',
      `${path}.sha256`,
    );
  return artifact;
}

const REGISTRATION_ACTIONS = ['registered', 'revised', 'detached'];
const REGISTRATION_STATUSES = ['registered', 'detached'];

function validateRegistrationHistoryEntry(value: unknown, path: string) {
  fields(
    value,
    [
      'revision',
      'action',
      'manifestDigest',
      'entryDirectory',
      'primaryArtifact',
      'taskId',
      'recordId',
      'at',
    ],
    [
      'revision',
      'action',
      'manifestDigest',
      'entryDirectory',
      'primaryArtifact',
      'taskId',
      'recordId',
      'at',
    ],
    path,
  );
  const entry = value as SpecImportRegistrationHistoryEntry;
  if (!Number.isInteger(entry.revision) || entry.revision < 1)
    throw new SpecImportError(
      'Expected a positive integer.',
      'SPEC_IMPORT_INVALID',
      `${path}.revision`,
    );
  if (!REGISTRATION_ACTIONS.includes(entry.action))
    throw new SpecImportError(
      'Unknown registration action.',
      'SPEC_IMPORT_INVALID',
      `${path}.action`,
    );
  if (
    typeof entry.manifestDigest !== 'string' ||
    !REGISTRATION_HASH_PATTERN.test(entry.manifestDigest)
  )
    throw new SpecImportError(
      'Expected a lowercase SHA-256 digest.',
      'SPEC_IMPORT_INVALID',
      `${path}.manifestDigest`,
    );
  relativePath(entry.entryDirectory, `${path}.entryDirectory`);
  validateRegisteredArtifact(entry.primaryArtifact, `${path}.primaryArtifact`);
  stableId(entry.taskId, `${path}.taskId`);
  stableId(entry.recordId, `${path}.recordId`);
  isoDateTime(entry.at, `${path}.at`);
}

function validateRegistration(value: unknown, path: string) {
  fields(
    value,
    [
      'id',
      'revision',
      'status',
      'adapter',
      'sourceRoot',
      'entryId',
      'entryDirectory',
      'manifestDigest',
      'primaryArtifact',
      'taskId',
      'recordId',
      'registeredAt',
      'updatedAt',
      'detachedAt',
      'history',
    ],
    [
      'id',
      'revision',
      'status',
      'adapter',
      'sourceRoot',
      'entryId',
      'entryDirectory',
      'manifestDigest',
      'primaryArtifact',
      'taskId',
      'recordId',
      'registeredAt',
      'updatedAt',
      'detachedAt',
      'history',
    ],
    path,
  );
  const registration = value as SpecImportRegistration;
  stableId(registration.id, `${path}.id`);
  if (!Number.isInteger(registration.revision) || registration.revision < 1)
    throw new SpecImportError(
      'Expected a positive integer.',
      'SPEC_IMPORT_INVALID',
      `${path}.revision`,
    );
  if (!REGISTRATION_STATUSES.includes(registration.status))
    throw new SpecImportError(
      'Unknown registration status.',
      'SPEC_IMPORT_INVALID',
      `${path}.status`,
    );
  if (!KNOWN_ADAPTER_IDS.includes(registration.adapter))
    throw new SpecImportError('Unknown adapter ID.', 'SPEC_IMPORT_INVALID', `${path}.adapter`);
  projectRelativeRootPath(registration.sourceRoot, `${path}.sourceRoot`);
  stableId(registration.entryId, `${path}.entryId`);
  relativePath(registration.entryDirectory, `${path}.entryDirectory`);
  if (
    typeof registration.manifestDigest !== 'string' ||
    !REGISTRATION_HASH_PATTERN.test(registration.manifestDigest)
  )
    throw new SpecImportError(
      'Expected a lowercase SHA-256 digest.',
      'SPEC_IMPORT_INVALID',
      `${path}.manifestDigest`,
    );
  validateRegisteredArtifact(registration.primaryArtifact, `${path}.primaryArtifact`);
  stableId(registration.taskId, `${path}.taskId`);
  stableId(registration.recordId, `${path}.recordId`);
  isoDateTime(registration.registeredAt, `${path}.registeredAt`);
  isoDateTime(registration.updatedAt, `${path}.updatedAt`);
  if (registration.detachedAt !== null) isoDateTime(registration.detachedAt, `${path}.detachedAt`);
  if (registration.status === 'detached' && registration.detachedAt === null)
    throw new SpecImportError(
      'A detached registration must record when it was detached.',
      'SPEC_IMPORT_INVALID',
      `${path}.detachedAt`,
    );
  if (!Array.isArray(registration.history))
    throw new SpecImportError('Expected an array.', 'SPEC_IMPORT_INVALID', `${path}.history`);
  if (registration.history.length > MAX_SPEC_IMPORT_REGISTRATION_HISTORY)
    throw new SpecImportError(
      'Registration history exceeds its bound.',
      'SPEC_IMPORT_INVALID',
      `${path}.history`,
    );
  registration.history.forEach((entry, index) =>
    validateRegistrationHistoryEntry(entry, `${path}.history[${index}]`),
  );
}

/** Structural validation only; used to keep the store this module reads/writes honest. */
export function validateSpecImportRegistrationStore(input: unknown): SpecImportRegistrationStore {
  const value = input as SpecImportRegistrationStore;
  fields(value, ['schemaVersion', 'registrations'], ['schemaVersion', 'registrations'], '$');
  if (value.schemaVersion !== SPEC_IMPORT_REGISTRATION_SCHEMA_VERSION)
    throw new SpecImportError(
      `Unsupported spec-import registration schema version ${String(value.schemaVersion)}.`,
      'SPEC_IMPORT_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  if (!Array.isArray(value.registrations))
    throw new SpecImportError('Expected an array.', 'SPEC_IMPORT_INVALID', '$.registrations');
  if (value.registrations.length > MAX_SPEC_IMPORT_REGISTRATIONS)
    throw new SpecImportError(
      'This project has reached its spec-import registration limit.',
      'SPEC_IMPORT_REGISTRATION_LIMIT_EXCEEDED',
      '$.registrations',
    );
  const seen = new Set<string>();
  value.registrations.forEach((registration, index) => {
    validateRegistration(registration, `$.registrations[${index}]`);
    if (seen.has(registration.id))
      throw new SpecImportError(
        'Duplicate registration id.',
        'SPEC_IMPORT_INVALID',
        `$.registrations[${index}].id`,
      );
    seen.add(registration.id);
  });
  return value;
}
