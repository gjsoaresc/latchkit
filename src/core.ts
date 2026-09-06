import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SKILLS } from './catalog.js';
import { loadPack, resolvePackResourceDependencies } from './packs/index.js';
import { gitCacheResource, loadMaterializedGitPack, materializeGitPack } from './packs/git.js';
import { PROVIDERS } from './providers/registry.js';
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  SUPPORTED_CONFIG_SCHEMA_VERSIONS,
  DEFAULT_WORKTREE_ROOT,
  ConfigContractError,
  parseConfig,
  validateConfig as validateConfigContract,
  validateManifest,
  type LatchkitConfig,
  type LatchkitManifest,
  type PackSelection,
} from './config/contracts.js';
import { ensureProjectPathIgnored } from './workspaces/ignore.js';
import { buildMigration, executeMigration, normalizeMigrationTarget } from './config/migrations.js';
import { readOptional, resolveProjectRoot, statIfExists, writeAtomic } from './storage.js';
import { inspectProjectLock, removeProvenStaleLock, withProjectLock } from './installer/lock.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  inspectTransaction,
  recoverTransaction,
} from './installer/transactions.js';
import { buildProjectRuleExports } from './rules/index.js';
import {
  digest as ruleDigest,
  findManagedSection,
  mergeManagedSection,
  removeManagedSection,
} from './rules/ownership.js';
import { errorMessage, type JsonValue } from './types.js';
import type { ProjectInstructionModel, RuleExportWarning } from './rules/types.js';

export {
  PROVIDERS,
  SKILLS,
  CURRENT_CONFIG_SCHEMA_VERSION,
  SUPPORTED_CONFIG_SCHEMA_VERSIONS,
  ConfigContractError,
};
const stateDirectory = '.latchkit';
const configPath = `${stateDirectory}/config.json`;
const manifestPath = `${stateDirectory}/manifest.json`;
type Root = string;
type ResourceAction = 'create' | 'remove' | 'unchanged' | 'update';

interface SyncChange {
  action: ResourceAction;
  path: string;
  resource?: 'existing-project-instructions' | 'project-instructions';
  content?: string;
}

interface SyncConflict {
  path: string;
  reason: string;
}
interface PackMetadata {
  id: string;
  version: string;
  source: PackSelection['source'];
  pinned: boolean;
  provenance: string;
  author?: string;
  license?: 'MIT';
  resolvedCommit?: string;
  files: Array<{ path: string; sha256: string }>;
}
interface DuplicateDiscovery {
  providers: string[];
  reason: string;
}
interface ManagedPlan {
  changes: SyncChange[];
  conflicts: SyncConflict[];
  desired: Map<string, string>;
  desiredSections: Map<string, string>;
  renderedSections: Map<string, string | null>;
  sectionHashes: Map<string, string>;
  manifest: LatchkitManifest;
  packMetadata: PackMetadata[];
  duplicateDiscovery: DuplicateDiscovery[];
  ruleModel: ProjectInstructionModel;
  ruleWarnings: RuleExportWarning[];
}
interface InitOptions {
  providers?: readonly string[];
  skills?: readonly string[];
  providerSettings?: Record<string, object>;
  packs?: PackSelection[];
}
interface MigrationOptions {
  toVersion?: unknown;
}
interface SyncOptions {
  planId?: string;
  faultBoundary?: (boundary: string, journal: unknown) => Promise<void> | void;
}
interface MaterializePackOptions {
  id?: string;
  faultBoundary?: (boundary: string, journal: unknown) => Promise<void> | void;
}
interface SyncDescription {
  changes: SyncChange[];
  conflicts: SyncConflict[];
  installedPacks: JsonValue[];
  desiredPacks: PackMetadata[];
  duplicateDiscovery: DuplicateDiscovery[];
  projectInstructions: ProjectInstructionModel;
  ruleWarnings: RuleExportWarning[];
  configRevision: string;
  planId: string;
}

const hash = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');
const configRevision = (content: string) => `"sha256:${hash(content)}"`;
const resourceIdForPath = (relative: string) =>
  /^\.(?:agents|claude)\/skills\//.test(relative) ? `skill:${relative}` : `rule:${relative}`;
const projectRoot = resolveProjectRoot;
const withLock = withProjectLock;

const contractOptions = {
  providerIds: PROVIDERS.map((provider) => provider.id),
  skillIds: SKILLS.map((skill) => skill.id),
};

export const validateConfig = (config: unknown) => validateConfigContract(config, contractOptions);
const parseProjectConfig = (raw: string) => parseConfig(raw, contractOptions);

function packCacheResources(packs: readonly PackSelection[]) {
  return packs.flatMap((selection) => {
    const resource = gitCacheResource(selection);
    return resource ? [resource] : [];
  });
}

async function registryFor(
  root: Root,
  manifest: LatchkitManifest,
  desired: Map<string, string> = new Map(),
  desiredSections: Map<string, string> = new Map(),
) {
  let packs: PackSelection[] = [];
  try {
    packs = (await readConfig(root)).packs ?? [];
  } catch {
    // A malformed configuration is reported by the caller; recovery still covers known resources.
  }
  return createResourceRegistry([
    ...[
      ...new Set([
        ...Object.keys(manifest.files),
        ...Object.keys(manifest.sections),
        ...desired.keys(),
        ...desiredSections.keys(),
      ]),
    ].map((relative) => ({ id: resourceIdForPath(relative), path: relative })),
    ...packCacheResources(packs),
  ]);
}

export async function readConfig(root: Root): Promise<LatchkitConfig> {
  root = await projectRoot(root);
  const raw = await readOptional(root, configPath);
  if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
  return parseProjectConfig(raw);
}

/** Return the validated configuration plus an opaque revision of its exact stored bytes. */
export async function readConfigSnapshot(
  root: Root,
): Promise<{ config: LatchkitConfig; revision: string }> {
  root = await projectRoot(root);
  const raw = await readOptional(root, configPath);
  if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
  return { config: parseProjectConfig(raw), revision: configRevision(raw) };
}

export async function initProject(root: Root, options: InitOptions = {}): Promise<LatchkitConfig> {
  root = await projectRoot(root);
  return withLock(root, async () => {
    // The documented default worktree root applies whether or not a
    // `workspace` setting is ever explicitly persisted, so it is kept out of
    // Git status/staging from project setup on, idempotently, even for an
    // already-initialized project. This is an explicit configuration-time
    // action; worktree creation itself never touches the source checkout.
    await ensureProjectPathIgnored(root, path.join(root, ...DEFAULT_WORKTREE_ROOT.split('/')));
    const raw = await readOptional(root, configPath);
    if (raw !== null) return parseProjectConfig(raw);
    const config = validateConfig({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      providers: options.providers ?? PROVIDERS.map((p) => p.id),
      skills: options.skills ?? SKILLS.map((s) => s.id),
      providerSettings: options.providerSettings ?? {},
      packs: options.packs ?? [
        { id: 'latchkit-core', version: '1.0.0', source: { type: 'bundled' }, pinned: true },
      ],
    });
    await writeAtomic(root, configPath, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  });
}

/** An explicit configuration save, not worktree creation, so keeping an
 * in-project worktree root out of Git status here does not violate the
 * guarantee that creating a worktree never touches the source checkout. */
async function ensureConfiguredWorktreeRootIgnored(
  root: Root,
  config: LatchkitConfig,
): Promise<void> {
  const worktreeRoot = config.workspace?.worktreeRoot;
  if (!worktreeRoot) return;
  await ensureProjectPathIgnored(
    root,
    path.isAbsolute(worktreeRoot) ? worktreeRoot : path.resolve(root, ...worktreeRoot.split('/')),
  );
}

export async function saveConfig(root: Root, config: unknown): Promise<LatchkitConfig> {
  root = await projectRoot(root);
  const validated = validateConfig(config);
  return withLock(root, async () => {
    await ensureConfiguredWorktreeRootIgnored(root, validated);
    await writeAtomic(root, configPath, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  });
}

/** Compare and save under the project lock so separate processes cannot lose updates. */
export async function saveConfigIfRevision(
  root: Root,
  config: unknown,
  revision: string,
): Promise<{ config: LatchkitConfig; revision: string }> {
  root = await projectRoot(root);
  const validated = validateConfig(config);
  return withLock(root, async () => {
    const raw = await readOptional(root, configPath);
    if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
    const currentRevision = configRevision(raw);
    if (revision !== currentRevision) {
      throw Object.assign(
        new Error('Configuration changed in another process. Reload it before saving.'),
        { code: 'CONFIG_REVISION_CONFLICT', revision: currentRevision },
      );
    }
    await ensureConfiguredWorktreeRootIgnored(root, validated);
    const next = `${JSON.stringify(validated, null, 2)}\n`;
    await writeAtomic(root, configPath, next);
    return { config: validated, revision: configRevision(next) };
  });
}

async function readManifest(root: Root): Promise<LatchkitManifest> {
  const raw = await readOptional(root, manifestPath);
  if (raw === null) return { schemaVersion: 3, files: {}, packs: [], sections: {} };
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new ConfigContractError(
      `Invalid JSON (${errorMessage(error, 'Unknown parsing error.')}).`,
      '$',
      'MANIFEST_INVALID_JSON',
    );
  }
  return validateManifest(manifest);
}

export async function planConfigMigration(root: Root, options: MigrationOptions = {}) {
  root = await projectRoot(root);
  const raw = await readOptional(root, configPath);
  if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
  const config = parseProjectConfig(raw);
  const toVersion = normalizeMigrationTarget(options.toVersion);
  await refuseDowngrade(root, config.schemaVersion, toVersion);
  return buildMigration(raw, config, toVersion);
}

async function refuseDowngrade(root: Root, fromVersion: number, toVersion: number): Promise<void> {
  if (toVersion >= fromVersion) return;
  const relativeDirectory = `${stateDirectory}/backups`;
  const directory = path.join(root, stateDirectory, 'backups');
  const stat = await statIfExists(directory);
  if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink or junction: ${relativeDirectory}`);
  if (stat && !stat.isDirectory()) throw new Error(`Expected directory: ${relativeDirectory}`);
  const names = stat ? await readdir(directory, { withFileTypes: true }) : [];
  const prefix = `config.v${toVersion}.`;
  const backups = names
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json'),
    )
    .map((entry) => `${relativeDirectory}/${entry.name}`)
    .sort();
  const recovery = backups.length
    ? `Review and manually restore ${backups.join(' or ')}.`
    : `No version ${toVersion} backup exists under ${relativeDirectory}/; recover an independently preserved original.`;
  throw new ConfigContractError(
    `Downgrade from version ${fromVersion} to ${toVersion} is not supported. ${recovery}`,
    '$.toVersion',
    'CONFIG_MIGRATION_UNSUPPORTED',
  );
}

export async function migrateConfig(root: Root, options: MigrationOptions = {}) {
  root = await projectRoot(root);
  const toVersion = normalizeMigrationTarget(options.toVersion);
  return withLock(root, async () => {
    const raw = await readOptional(root, configPath);
    if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
    const config = parseProjectConfig(raw);
    await refuseDowngrade(root, config.schemaVersion, toVersion);
    const migration = buildMigration(raw, config, toVersion);
    if (migration.status === 'current') return migration;

    return executeMigration(raw, migration, {
      readBackup: (relative) => readOptional(root, relative),
      writeBackup: (relative, contents) => writeAtomic(root, relative, contents),
      writeConfig: (config) =>
        writeAtomic(root, configPath, `${JSON.stringify(validateConfig(config), null, 2)}\n`),
    });
  });
}

async function makePlan(root: Root, removing = false): Promise<ManagedPlan> {
  const savedConfig = removing ? null : await readConfig(root);
  let config: { providers: string[]; skills: string[]; packs: PackSelection[] };
  if (removing) {
    config = { providers: [], skills: [], packs: [] };
  } else {
    if (!savedConfig) throw new Error('Project configuration is unavailable.');
    config = {
      providers: savedConfig.providers,
      skills: savedConfig.skills,
      packs: savedConfig.packs ?? [
        { id: 'latchkit-core', version: '1.0.0', source: { type: 'bundled' }, pinned: true },
      ],
    };
  }
  const manifest = await readManifest(root);
  const desired = new Map<string, string>();
  const desiredSections = new Map<string, string>();
  const directories = new Set(
    PROVIDERS.filter((p) => config.providers.includes(p.id)).map((p) => p.skillDirectory),
  );
  const packMetadata: PackMetadata[] = [];
  const destinationOwners = new Map<string, string>();
  for (const selection of config.packs) {
    const pack =
      selection.source.type === 'git'
        ? await loadMaterializedGitPack(root, selection)
        : await loadPack(selection);
    if (pack.id !== selection.id || pack.version !== selection.version)
      throw new Error(
        `Requested pack ${selection.id}@${selection.version} does not match source ${pack.id}@${pack.version}.`,
      );
    if (!pack.compatibility.configSchemaVersions.includes(CURRENT_CONFIG_SCHEMA_VERSION))
      throw new Error(
        `Pack ${pack.id}@${pack.version} does not support configuration schema ${CURRENT_CONFIG_SCHEMA_VERSION}.`,
      );
    const unsupported = config.providers.filter((id) => !pack.compatibility.providers.includes(id));
    if (unsupported.length)
      throw new Error(
        `Pack ${pack.id}@${pack.version} does not support selected providers: ${unsupported.join(', ')}.`,
      );
    packMetadata.push({
      id: pack.id,
      version: pack.version,
      source: selection.source,
      pinned: selection.pinned,
      provenance: pack.provenance,
      ...(pack.author === undefined ? {} : { author: pack.author }),
      ...(pack.license === undefined ? {} : { license: pack.license }),
      ...(selection.source.type === 'git' ? { resolvedCommit: selection.source.commit } : {}),
      files: pack.files.map((file) => ({ path: file.path, sha256: hash(file.bytes) })),
    });
    for (const file of pack.files) {
      const parts = file.path.split('/');
      if (parts.length < 3 || parts[0] !== 'skills')
        throw new Error(`Pack ${pack.id} resource is not inside a portable skill: ${file.path}`);
      if (!parts[1]) throw new Error(`Pack ${pack.id} has an invalid skill path: ${file.path}`);
    }
    // A top-level `skills/<folder>/` with its own `SKILL.md` is a selectable
    // skill; every other top-level folder (for example `skills/references/`)
    // is a shared resource collection with no independent selection of its
    // own. Deselecting one skill can never drop a resource another selected
    // skill's `SKILL.md` still reaches through a relative Markdown link,
    // because inclusion is the union of every currently selected skill's
    // resolved dependencies, recomputed on every plan.
    const { primarySkills, dependencies } = resolvePackResourceDependencies(pack);
    const selectedSkillFolders =
      pack.id === 'latchkit-core'
        ? new Set(
            [...primarySkills].filter((folder) =>
              config.skills.includes(folder.replace(/^latchkit-/, '')),
            ),
          )
        : primarySkills;
    const neededResources = new Set<string>();
    for (const folder of selectedSkillFolders)
      for (const resourcePath of dependencies.get(folder) ?? []) neededResources.add(resourcePath);
    for (const file of pack.files) {
      const parts = file.path.split('/');
      const skillName = parts[1]!;
      const skillRelative = parts.slice(2).join('/');
      const isPrimarySkillFile = primarySkills.has(skillName);
      if (
        isPrimarySkillFile ? !selectedSkillFolders.has(skillName) : !neededResources.has(file.path)
      )
        continue;
      for (const directory of directories) {
        const relative = `${directory}/${skillName}/${skillRelative}`;
        const owner = destinationOwners.get(relative);
        if (owner) throw new Error(`Pack collision at ${relative}: ${owner} and ${pack.id}.`);
        destinationOwners.set(relative, pack.id);
        desired.set(relative, file.bytes.toString('utf8'));
      }
    }
  }
  const ruleExport: {
    model: ProjectInstructionModel;
    desiredFiles: Map<string, string>;
    desiredSections: Map<string, string>;
    warnings: RuleExportWarning[];
  } = removing
    ? {
        model: {
          schemaVersion: 1,
          provenance: {
            generator: 'latchkit',
            basis: 'explicit-project-manifests',
            execution: 'not-run',
          },
          scopes: [],
        },
        desiredFiles: new Map<string, string>(),
        desiredSections,
        warnings: [] as RuleExportWarning[],
      }
    : await buildProjectRuleExports(root, config.providers);
  for (const [relative, content] of ruleExport.desiredFiles) {
    if (desired.has(relative)) throw new Error(`Managed resource collision at ${relative}.`);
    desired.set(relative, content);
  }
  for (const [relative, content] of ruleExport.desiredSections)
    desiredSections.set(relative, content);
  const changes: SyncChange[] = [],
    conflicts: SyncConflict[] = [];
  for (const relative of [...new Set([...Object.keys(manifest.files), ...desired.keys()])].sort()) {
    let current: string | null;
    try {
      current = await readOptional(root, relative);
    } catch (error) {
      conflicts.push({ path: relative, reason: errorMessage(error) });
      continue;
    }
    const ownedHash = manifest.files[relative];
    if (current !== null && !ownedHash) {
      conflicts.push({ path: relative, reason: 'An existing file is not managed by Latchkit.' });
      continue;
    }
    if (current !== null && hash(current) !== ownedHash) {
      conflicts.push({
        path: relative,
        reason: 'Managed file has local edits; preserve or move it before syncing.',
      });
      continue;
    }
    const next = desired.get(relative);
    const action =
      next === undefined
        ? 'remove'
        : current === null
          ? 'create'
          : current === next
            ? 'unchanged'
            : 'update';
    changes.push({ action, path: relative });
  }
  const renderedSections = new Map<string, string | null>();
  const sectionHashes = new Map<string, string>();
  for (const relative of [
    ...new Set([...Object.keys(manifest.sections), ...desiredSections.keys()]),
  ].sort()) {
    let current: string | null;
    try {
      current = await readOptional(root, relative);
    } catch (error) {
      conflicts.push({ path: relative, reason: errorMessage(error) });
      continue;
    }
    const owned = manifest.sections[relative];
    let existing: ReturnType<typeof findManagedSection>;
    try {
      existing = current === null ? null : findManagedSection(current);
    } catch (error) {
      conflicts.push({ path: relative, reason: errorMessage(error) });
      continue;
    }
    if (existing && !owned) {
      conflicts.push({
        path: relative,
        reason:
          'Latchkit markers exist but are not recorded as owned; remove or reconcile them manually.',
      });
      continue;
    }
    if (owned && (!existing || ruleDigest(existing.content) !== owned.sha256)) {
      conflicts.push({
        path: relative,
        reason:
          'Managed project instruction section has local edits or is missing; preserve or reconcile it before syncing.',
      });
      continue;
    }
    const body = desiredSections.get(relative);
    const importLine = body?.trim();
    if (
      !owned &&
      !existing &&
      importLine?.startsWith('@') &&
      current?.split(/\r?\n/).some((line) => line.trim() === importLine)
    ) {
      desiredSections.delete(relative);
      changes.push({
        action: 'unchanged',
        path: relative,
        resource: 'existing-project-instructions',
      });
      continue;
    }
    if (importLine === '@AGENTS.md') {
      const scopePrefix = relative.includes('/')
        ? relative.slice(0, relative.lastIndexOf('/') + 1)
        : '';
      const agents = await readOptional(root, `${scopePrefix}AGENTS.md`);
      const reverseImport = `@${relative.slice(scopePrefix.length)}`;
      if (agents?.split(/\r?\n/).some((line) => line.trim() === reverseImport)) {
        conflicts.push({
          path: relative,
          reason: `Adding ${importLine} would create an import cycle with ${scopePrefix}AGENTS.md.`,
        });
        continue;
      }
    }
    let next;
    if (body === undefined) {
      next = current === null ? null : removeManagedSection(current);
      if (next === '') next = null;
    } else {
      next = mergeManagedSection(current ?? '', body);
      const section = findManagedSection(next);
      if (!section) throw new Error(`Unable to render project instruction section: ${relative}`);
      sectionHashes.set(relative, ruleDigest(section.content));
    }
    renderedSections.set(relative, next);
    const action =
      next === null
        ? 'remove'
        : current === null
          ? 'create'
          : current === next
            ? 'unchanged'
            : 'update';
    changes.push({
      action,
      path: relative,
      resource: 'project-instructions',
      ...(body === undefined ? {} : { content: body }),
    });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  const duplicateDiscovery =
    directories.has('.claude/skills') && directories.has('.agents/skills')
      ? [
          {
            providers: config.providers,
            reason:
              'Claude and shared-root skills can both be discovered by Cursor; Latchkit will not remove either root.',
          },
        ]
      : [];
  return {
    changes,
    conflicts,
    desired,
    desiredSections,
    renderedSections,
    sectionHashes,
    manifest,
    packMetadata,
    duplicateDiscovery,
    ruleModel: ruleExport.model,
    ruleWarnings: ruleExport.warnings,
  };
}

export async function planSync(root: Root): Promise<SyncDescription> {
  root = await projectRoot(root);
  const plan = await makePlan(root);
  return describeSyncPlan(root, plan);
}

async function describeSyncPlan(root: Root, plan: ManagedPlan): Promise<SyncDescription> {
  const paths = [
    ...new Set([
      ...Object.keys(plan.manifest.files),
      ...Object.keys(plan.manifest.sections),
      ...plan.desired.keys(),
      ...plan.desiredSections.keys(),
    ]),
  ].sort();
  const current: Array<[string, string | null]> = await Promise.all(
    paths.map(async (relative) => {
      const bytes = await readOptional(root, relative);
      return [relative, bytes === null ? null : hash(bytes)];
    }),
  );
  const config = await readOptional(root, configPath);
  const manifest = await readOptional(root, manifestPath);
  const publicPlan = {
    changes: plan.changes,
    conflicts: plan.conflicts,
    installedPacks: plan.manifest.packs,
    desiredPacks: plan.packMetadata,
    duplicateDiscovery: plan.duplicateDiscovery,
    projectInstructions: plan.ruleModel,
    ruleWarnings: plan.ruleWarnings,
  };
  return {
    ...publicPlan,
    configRevision: configRevision(config ?? ''),
    planId: `sha256:${hash(JSON.stringify({ root, config, manifest, current, publicPlan }))}`,
  };
}

async function applySync(
  root: Root,
  removing: boolean,
  options: SyncOptions = {},
): Promise<SyncDescription> {
  root = await projectRoot(root);
  return withLock(root, async () => {
    const plan = await makePlan(root, removing);
    const described = await describeSyncPlan(root, plan);
    if (options.planId && options.planId !== described.planId) {
      throw Object.assign(
        new Error('The reviewed sync preview is stale. Refresh the preview before applying.'),
        {
          code: 'SYNC_PLAN_STALE',
          planId: described.planId,
          configRevision: described.configRevision,
        },
      );
    }
    if (plan.conflicts.length) {
      throw Object.assign(
        new Error(
          `Sync blocked: ${plan.conflicts.map((c) => `${c.path}: ${c.reason}`).join('\n')}`,
        ),
        { conflicts: plan.conflicts },
      );
    }
    const transactionChanges: Array<{ resourceId: string; bytes: string | null }> = [];
    const nextManifest = {
      schemaVersion: 3,
      files: { ...plan.manifest.files },
      packs: plan.packMetadata,
      sections: { ...plan.manifest.sections },
    };
    for (const change of plan.changes.filter((item) => item.resource !== 'project-instructions')) {
      if (change.action === 'unchanged') continue;
      const current = await readOptional(root, change.path);
      const recorded = plan.manifest.files[change.path];
      if (current !== null && (!recorded || hash(current) !== recorded))
        throw new Error(`File changed during sync: ${change.path}`);
      if (change.action === 'remove') {
        transactionChanges.push({ resourceId: resourceIdForPath(change.path), bytes: null });
        delete nextManifest.files[change.path];
      } else {
        const content = plan.desired.get(change.path);
        if (content === undefined) throw new Error(`Missing desired content: ${change.path}`);
        transactionChanges.push({ resourceId: resourceIdForPath(change.path), bytes: content });
        nextManifest.files[change.path] = hash(content);
      }
    }
    for (const change of plan.changes.filter(
      (item) => item.resource === 'project-instructions' && item.action !== 'unchanged',
    )) {
      const current = await readOptional(root, change.path);
      const owned = plan.manifest.sections[change.path];
      const existing = current === null ? null : findManagedSection(current);
      if (owned && (!existing || ruleDigest(existing.content) !== owned.sha256))
        throw new Error(`Project instruction section changed during sync: ${change.path}`);
      transactionChanges.push({
        resourceId: resourceIdForPath(change.path),
        bytes: plan.renderedSections.get(change.path) ?? null,
      });
      if (plan.desiredSections.has(change.path)) {
        const sha256 = plan.sectionHashes.get(change.path);
        if (!sha256) throw new Error(`Missing rendered section digest: ${change.path}`);
        nextManifest.sections[change.path] = {
          id: 'project-instructions',
          sha256,
        };
      } else delete nextManifest.sections[change.path];
    }
    if (transactionChanges.length) {
      const registry = await registryFor(root, plan.manifest, plan.desired, plan.desiredSections);
      await applyRegisteredTransaction(root, {
        operation: removing ? 'remove' : 'sync',
        registry,
        changes: transactionChanges,
        manifest: `${JSON.stringify(nextManifest, null, 2)}\n`,
        faultBoundary: options.faultBoundary,
      });
    }
    const next = await describeSyncPlan(root, await makePlan(root, removing));
    return {
      ...described,
      planId: next.planId,
      configRevision: next.configRevision,
    };
  });
}

export const syncProject = (root: Root, options?: SyncOptions) => applySync(root, false, options);
export const removeProjectSkills = (root: Root, options?: SyncOptions) =>
  applySync(root, true, options);

/**
 * Explicitly fetch one selected immutable Git source into the project-local cache.
 * Configuration reads and synchronization consume only this cache and never invoke Git.
 */
export async function materializePackSource(root: Root, options: MaterializePackOptions = {}) {
  root = await projectRoot(root);
  return withLock(root, async () => {
    const config = await readConfig(root);
    const selected = config.packs ?? [];
    const matches = selected.filter(
      (pack) => pack.source.type === 'git' && (options.id === undefined || pack.id === options.id),
    );
    if (options.id && !matches.length)
      throw new Error(`No selected immutable Git pack has ID ${options.id}.`);
    if (!matches.length)
      return { materialized: [], message: 'No selected immutable Git pack sources.' };
    const manifestRaw = await readOptional(root, manifestPath);
    const manifest = await readManifest(root);
    const materialized = [];
    for (const selection of matches) {
      const fetched = await materializeGitPack(selection);
      const registry = createResourceRegistry([fetched.resource]);
      await applyRegisteredTransaction(root, {
        operation: 'pack-fetch',
        registry,
        changes: [{ resourceId: fetched.resource.id, bytes: fetched.bytes }],
        manifest:
          manifestRaw ?? `${JSON.stringify({ ...manifest, packs: manifest.packs }, null, 2)}\n`,
        faultBoundary: options.faultBoundary,
      });
      if (selection.source.type !== 'git')
        throw new Error('Selected source changed while materializing Git pack.');
      materialized.push({
        id: fetched.pack.id,
        version: fetched.pack.version,
        repository: selection.source.repository,
        commit: selection.source.commit,
        cachePath: fetched.resource.path,
        files: fetched.pack.files.map((file) => ({ path: file.path, sha256: hash(file.bytes) })),
      });
    }
    return { materialized };
  });
}

export async function inspectRecovery(root: Root) {
  root = await projectRoot(root);
  const manifest = await readManifest(root);
  const plan = await makePlan(root).catch(() => ({
    desired: new Map<string, string>(),
    desiredSections: new Map<string, string>(),
  }));
  const registry = await registryFor(root, manifest, plan.desired, plan.desiredSections);
  return {
    lock: await inspectProjectLock(root),
    transaction: await inspectTransaction(root, registry),
  };
}

export async function recoverProject(root: Root) {
  root = await projectRoot(root);
  const inspection = await inspectProjectLock(root);
  if (inspection.state === 'live') {
    throw Object.assign(
      new Error('A live Latchkit operation owns the project lock; recovery was not started.'),
      { code: 'RECOVERY_LOCK_BLOCKED' },
    );
  }
  if (inspection.state === 'invalid')
    throw Object.assign(new Error(inspection.reason), { code: 'RECOVERY_LOCK_BLOCKED' });
  let cleanedLock = false;
  if (inspection.state === 'stale') {
    await removeProvenStaleLock(root, inspection);
    cleanedLock = true;
  }
  const manifest = await readManifest(root);
  const plan = await makePlan(root).catch(() => ({
    desired: new Map(),
    desiredSections: new Map(),
  }));
  const registry = await registryFor(root, manifest, plan.desired, plan.desiredSections);
  const result = await withProjectLock(root, () => recoverTransaction(root, registry));
  return { ...result, cleanedLock };
}

async function findExecutable(command: string): Promise<string | null> {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), `${command}${suffix}`);
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        const resolved = await realpath(candidate);
        if ((await lstat(resolved)).isFile()) return candidate;
      } catch {
        /* Missing or inaccessible executable; continue searching PATH. */
      }
    }
  }
  return null;
}

export async function doctor(root: Root) {
  const wsl =
    process.platform === 'linux' &&
    (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()));
  return {
    platform: process.platform,
    runtime: wsl ? 'WSL' : 'native',
    node: process.version,
    project: await projectRoot(root),
    providers: await Promise.all(
      PROVIDERS.map(async (provider) => {
        const executable = await findExecutable(provider.command);
        return {
          ...provider,
          verification: {
            ...provider.verification,
            installed: executable ? 'verified' : 'unverified',
          },
          detected: Boolean(executable),
          path: executable,
        };
      }),
    ),
  };
}
