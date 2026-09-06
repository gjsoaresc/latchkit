import { errorMessage, type JsonObject, type JsonValue } from '../types.js';
import path from 'node:path';

export const CURRENT_CONFIG_SCHEMA_VERSION = 3;
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS = Object.freeze([1, 2, 3] as const);
export const MANIFEST_SCHEMA_VERSION = 3;

export interface ConfigOptions {
  providerIds: readonly string[];
  skillIds: readonly string[];
}
export interface BundledPackSource {
  type: 'bundled';
}
export interface LocalPackSource {
  type: 'local';
  path: string;
}
export interface GitPackSource {
  type: 'git';
  repository: string;
  /** Immutable object ID. A branch or tag is intentionally not accepted here. */
  commit: string;
  /** Optional portable subdirectory containing latchkit-pack.json. */
  path?: string;
}
export interface PackSelection {
  id: string;
  version: string;
  source: BundledPackSource | LocalPackSource | GitPackSource;
  pinned: boolean;
}
export type WorkspaceExecutionPreference = 'ask' | 'always-worktree' | 'direct';
/** A project-persisted, provider-independent preference for whether a new task's
 * implementation runs in an isolated Git worktree or directly in the project
 * checkout, plus where new worktrees are created. It is independent of any
 * reviewer isolation, which remains separately required. */
export interface WorkspaceSettings {
  executionPreference: WorkspaceExecutionPreference;
  /** A portable project-relative path (forward slashes) or an explicit absolute
   * path. Relative roots resolve against the main checkout, never a linked
   * worktree, so starting from a worktree cannot nest worktree roots. */
  worktreeRoot: string;
}
export const DEFAULT_WORKTREE_ROOT = '.latchkit/worktrees';
/** "direct" preserves today's only behavior (every task runs in the project
 * checkout) so a project without this setting sees no behavioral change. */
export const DEFAULT_WORKSPACE_EXECUTION_PREFERENCE: WorkspaceExecutionPreference = 'direct';
export const DEFAULT_WORKSPACE_SETTINGS: Readonly<WorkspaceSettings> = Object.freeze({
  executionPreference: DEFAULT_WORKSPACE_EXECUTION_PREFERENCE,
  worktreeRoot: DEFAULT_WORKTREE_ROOT,
});

export interface LatchkitConfig {
  schemaVersion: 1 | 2 | 3;
  providers: string[];
  skills: string[];
  providerSettings?: Record<string, JsonObject>;
  packs?: PackSelection[];
  /** Optional on every supported schema version; absent means the documented
   * defaults above apply. It is not part of any version's required field set,
   * so existing configuration files remain valid without it. */
  workspace?: WorkspaceSettings;
}
export interface ManifestSection {
  id: 'project-instructions';
  sha256: string;
}
export interface LatchkitManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  files: Record<string, string>;
  packs: JsonValue[];
  sections: Record<string, ManifestSection>;
}

const CONFIG_FIELDS = new Map<number, ReadonlySet<string>>([
  [1, new Set(['schemaVersion', 'providers', 'skills'])],
  [2, new Set(['schemaVersion', 'providers', 'skills', 'providerSettings'])],
  [3, new Set(['schemaVersion', 'providers', 'skills', 'providerSettings', 'packs'])],
]);

export class ConfigContractError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(message: string, path = '$', code = 'CONFIG_INVALID') {
    super(`${path}: ${message}`);
    this.name = 'ConfigContractError';
    this.code = code;
    this.path = path;
  }
}

function record(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeGitRepository(value: string): boolean {
  if (!value.trim() || value.startsWith('-') || /[\r\n\0]/.test(value)) return false;
  if (path.isAbsolute(value)) return true;
  if (value.startsWith('file:///')) return true;
  try {
    const url = new URL(value);
    return (
      ['https:', 'ssh:', 'git:'].includes(url.protocol) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'ssh:' || !url.username)
    );
  } catch {
    return /^[^@\s/:]+@[^\s/:]+:[^\s]+$/.test(value);
  }
}

function isConfigSchemaVersion(value: unknown): value is 1 | 2 | 3 {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(value as 1 | 2 | 3)
  );
}

function cloneJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (record(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item, `${path}.${key}`)]),
    ) as JsonObject;
  }
  throw new ConfigContractError('Expected a JSON value.', path);
}

const WORKSPACE_EXECUTION_PREFERENCES: ReadonlySet<string> = new Set([
  'ask',
  'always-worktree',
  'direct',
]);
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isSafeWorktreeRootSegment(part: string): boolean {
  return (
    part !== '' &&
    part !== '.' &&
    part !== '..' &&
    !/[<>:"|?*]/.test(part) &&
    !RESERVED_WINDOWS_NAMES.test(part)
  );
}

/** Accepts a portable project-relative path (POSIX separators only) or an
 * explicit absolute native path. Containment and overlap with the project
 * checkout require filesystem access and are enforced separately at
 * workspace-creation time, not here. */
export function validateWorktreeRoot(value: unknown, fieldPath = '$.worktreeRoot'): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new ConfigContractError('Expected a non-empty path.', fieldPath);
  if (value.length > 4096 || /[\r\n\0]/.test(value))
    throw new ConfigContractError('Path is invalid.', fieldPath);
  if (value !== value.normalize('NFC'))
    throw new ConfigContractError('Path must be Unicode NFC-normalized.', fieldPath);
  const isAbsolute = path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
  if (isAbsolute) {
    if (value.split(/[\\/]/).includes('..'))
      throw new ConfigContractError('An absolute path must not contain "..".', fieldPath);
    return value;
  }
  if (value.includes('\\'))
    throw new ConfigContractError(
      'A project-relative worktree root uses portable forward slashes.',
      fieldPath,
    );
  if (!value.split('/').every(isSafeWorktreeRootSegment))
    throw new ConfigContractError('Path has an empty, traversal, or reserved segment.', fieldPath);
  return value;
}

export function validateWorkspaceSettings(
  value: unknown,
  fieldPath = '$.workspace',
): WorkspaceSettings {
  if (!record(value)) throw new ConfigContractError('Expected an object.', fieldPath);
  const allowed = new Set(['executionPreference', 'worktreeRoot']);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new ConfigContractError(`Unknown field "${key}".`, `${fieldPath}.${key}`);
  for (const key of allowed)
    if (!Object.hasOwn(value, key))
      throw new ConfigContractError('Required field is missing.', `${fieldPath}.${key}`);
  const executionPreference = value.executionPreference;
  if (
    typeof executionPreference !== 'string' ||
    !WORKSPACE_EXECUTION_PREFERENCES.has(executionPreference)
  )
    throw new ConfigContractError(
      'Expected "ask", "always-worktree", or "direct".',
      `${fieldPath}.executionPreference`,
    );
  return {
    executionPreference: executionPreference as WorkspaceExecutionPreference,
    worktreeRoot: validateWorktreeRoot(value.worktreeRoot, `${fieldPath}.worktreeRoot`),
  };
}

function validateSelection(
  config: JsonObject,
  key: string,
  allowedIds: ReadonlySet<string>,
): string[] {
  const value = config[key];
  if (!Array.isArray(value)) throw new ConfigContractError('Expected an array.', `$.${key}`);
  const seen = new Set<string>();
  return value.map((id, index) => {
    const itemPath = `$.${key}[${index}]`;
    if (typeof id !== 'string') throw new ConfigContractError('Expected a string ID.', itemPath);
    if (!allowedIds.has(id)) throw new ConfigContractError(`Unknown ID "${id}".`, itemPath);
    if (seen.has(id)) throw new ConfigContractError(`Duplicate ID "${id}".`, itemPath);
    seen.add(id);
    return id;
  });
}

export function parseConfig(raw: string, options: ConfigOptions): LatchkitConfig {
  let config: unknown;
  try {
    config = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConfigContractError(
      `Invalid JSON (${errorMessage(error, 'Unknown parsing error.')}).`,
      '$',
      'CONFIG_INVALID_JSON',
    );
  }
  return validateConfig(config, options);
}

export function validateConfig(
  config: unknown,
  { providerIds, skillIds }: ConfigOptions,
): LatchkitConfig {
  if (!record(config)) throw new ConfigContractError('Expected an object.');
  const schemaVersion = config.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion))
    throw new ConfigContractError('Expected an integer schema version.', '$.schemaVersion');
  if (!isConfigSchemaVersion(schemaVersion)) {
    throw new ConfigContractError(
      `Unsupported schema version ${schemaVersion}; supported versions are ${SUPPORTED_CONFIG_SCHEMA_VERSIONS.join(', ')}.`,
      '$.schemaVersion',
      'CONFIG_UNSUPPORTED_VERSION',
    );
  }
  const fields = CONFIG_FIELDS.get(schemaVersion);
  if (!fields) throw new ConfigContractError('Unsupported schema version.', '$.schemaVersion');
  for (const key of Object.keys(config))
    if (!fields.has(key) && key !== 'workspace')
      throw new ConfigContractError(`Unknown field "${key}".`, `$.${key}`);
  for (const key of fields)
    if (!Object.hasOwn(config, key))
      throw new ConfigContractError('Required field is missing.', `$.${key}`);

  const validated: LatchkitConfig = {
    schemaVersion,
    providers: validateSelection(config, 'providers', new Set(providerIds)),
    skills: validateSelection(config, 'skills', new Set(skillIds)),
  };
  if (schemaVersion >= 2) {
    if (!record(config.providerSettings))
      throw new ConfigContractError(
        'Expected an object keyed by provider ID.',
        '$.providerSettings',
      );
    const providerSettings: Record<string, JsonObject> = {};
    for (const [providerId, settings] of Object.entries(config.providerSettings)) {
      const settingsPath = `$.providerSettings.${providerId}`;
      if (!providerIds.includes(providerId))
        throw new ConfigContractError(`Unknown provider ID "${providerId}".`, settingsPath);
      if (!record(settings))
        throw new ConfigContractError('Expected a provider settings object.', settingsPath);
      providerSettings[providerId] = cloneJson(settings, settingsPath) as JsonObject;
    }
    validated.providerSettings = providerSettings;
  }
  if (schemaVersion === 3) {
    if (!Array.isArray(config.packs))
      throw new ConfigContractError('Expected an array.', '$.packs');
    const ids = new Set<string>();
    validated.packs = config.packs.map((pack, index): PackSelection => {
      const packPath = `$.packs[${index}]`;
      if (
        !record(pack) ||
        !['id', 'version', 'source', 'pinned'].every((key) => Object.hasOwn(pack, key)) ||
        Object.keys(pack).length !== 4
      )
        throw new ConfigContractError('Expected a complete pack selection.', packPath);
      if (
        typeof pack.id !== 'string' ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(pack.id) ||
        ids.has(pack.id)
      )
        throw new ConfigContractError('Expected a unique portable pack ID.', `${packPath}.id`);
      ids.add(pack.id);
      if (
        typeof pack.version !== 'string' ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pack.version)
      )
        throw new ConfigContractError('Expected a semantic version.', `${packPath}.version`);
      if (!record(pack.source) || !Object.hasOwn(pack.source, 'type'))
        throw new ConfigContractError('Expected a pack source.', `${packPath}.source`);
      let source: PackSelection['source'];
      if (pack.source.type === 'local') {
        if (
          Object.keys(pack.source).length !== 2 ||
          typeof pack.source.path !== 'string' ||
          !pack.source.path
        )
          throw new ConfigContractError('Local packs require a source path.', `${packPath}.source`);
        source = { type: 'local', path: pack.source.path };
      } else if (pack.source.type === 'git') {
        const sourcePath = pack.source.path;
        if (
          !Object.keys(pack.source).every((key) =>
            ['type', 'repository', 'commit', 'path'].includes(key),
          ) ||
          typeof pack.source.repository !== 'string' ||
          !safeGitRepository(pack.source.repository) ||
          typeof pack.source.commit !== 'string' ||
          !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(pack.source.commit) ||
          (sourcePath !== undefined &&
            (typeof sourcePath !== 'string' ||
              !sourcePath ||
              sourcePath.includes('\\') ||
              path.posix.isAbsolute(sourcePath) ||
              sourcePath !== sourcePath.normalize('NFC') ||
              sourcePath
                .split('/')
                .some(
                  (part) =>
                    part === '' ||
                    part === '.' ||
                    part === '..' ||
                    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part) ||
                    /[<>:"|?*]/.test(part),
                )))
        )
          throw new ConfigContractError(
            'Git packs require a repository, lowercase immutable commit, and an optional portable path.',
            `${packPath}.source`,
          );
        if (pack.pinned !== true)
          throw new ConfigContractError(
            'Git packs must be pinned to their immutable commit.',
            `${packPath}.pinned`,
          );
        source = {
          type: 'git',
          repository: pack.source.repository,
          commit: pack.source.commit,
          ...(sourcePath === undefined ? {} : { path: sourcePath }),
        };
      } else if (pack.source.type === 'bundled' && Object.keys(pack.source).length === 1)
        source = { type: 'bundled' };
      else
        throw new ConfigContractError(
          'Expected a bundled, local, or immutable Git pack source.',
          `${packPath}.source`,
        );
      if (typeof pack.pinned !== 'boolean')
        throw new ConfigContractError('Expected a boolean.', `${packPath}.pinned`);
      return { id: pack.id, version: pack.version, source, pinned: pack.pinned };
    });
  }
  if (Object.hasOwn(config, 'workspace'))
    validated.workspace = validateWorkspaceSettings(config.workspace);
  return validated;
}

export function validateManifest(
  manifest: unknown,
  allowedPaths?: ReadonlySet<string>,
): LatchkitManifest {
  if (!record(manifest))
    throw new ConfigContractError('Expected an object.', '$', 'MANIFEST_INVALID');
  const fields = new Set(['schemaVersion', 'files', 'packs', 'sections']);
  for (const key of Object.keys(manifest))
    if (!fields.has(key))
      throw new ConfigContractError(`Unknown field "${key}".`, `$.${key}`, 'MANIFEST_INVALID');
  if (![1, 2, MANIFEST_SCHEMA_VERSION].includes(manifest.schemaVersion as number))
    throw new ConfigContractError(
      `Expected schema version 1, 2, or ${MANIFEST_SCHEMA_VERSION}.`,
      '$.schemaVersion',
      'MANIFEST_INVALID',
    );
  if (!record(manifest.files))
    throw new ConfigContractError('Expected an object.', '$.files', 'MANIFEST_INVALID');
  const files: Record<string, string> = {};
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const entryPath = `$.files.${relative}`;
    if (allowedPaths && !allowedPaths.has(relative))
      throw new ConfigContractError('Unknown managed file path.', entryPath, 'MANIFEST_INVALID');
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      throw new ConfigContractError(
        'Expected a lowercase SHA-256 digest.',
        entryPath,
        'MANIFEST_INVALID',
      );
    files[relative] = digest;
  }
  if (manifest.schemaVersion === 1)
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, files, packs: [], sections: {} };
  if (!Array.isArray(manifest.packs))
    throw new ConfigContractError('Expected an array.', '$.packs', 'MANIFEST_INVALID');
  const packs = manifest.packs.map((pack, index) => {
    if (
      !record(pack) ||
      typeof pack.id !== 'string' ||
      typeof pack.version !== 'string' ||
      !record(pack.source)
    )
      throw new ConfigContractError(
        'Expected installed pack metadata.',
        `$.packs[${index}]`,
        'MANIFEST_INVALID',
      );
    return cloneJson(pack, `$.packs[${index}]`);
  });
  if (manifest.schemaVersion === 2)
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, files, packs, sections: {} };
  if (!record(manifest.sections))
    throw new ConfigContractError('Expected an object.', '$.sections', 'MANIFEST_INVALID');
  const sections: Record<string, ManifestSection> = {};
  for (const [relative, entry] of Object.entries(manifest.sections)) {
    const entryPath = `$.sections.${relative}`;
    if (Object.hasOwn(files, relative))
      throw new ConfigContractError(
        'A path cannot be owned as both a file and a section.',
        entryPath,
        'MANIFEST_INVALID',
      );
    if (allowedPaths && !allowedPaths.has(relative))
      throw new ConfigContractError('Unknown managed section path.', entryPath, 'MANIFEST_INVALID');
    if (
      !record(entry) ||
      Object.keys(entry).length !== 2 ||
      entry.id !== 'project-instructions' ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new ConfigContractError(
        'Expected managed section metadata.',
        entryPath,
        'MANIFEST_INVALID',
      );
    sections[relative] = { id: entry.id, sha256: entry.sha256 };
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, files, packs, sections };
}
