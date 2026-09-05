import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SKILLS } from './catalog.js';
import { loadPack } from './packs/index.js';
import { PROVIDERS } from './providers/registry.js';
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  SUPPORTED_CONFIG_SCHEMA_VERSIONS,
  ConfigContractError,
  parseConfig,
  validateConfig as validateConfigContract,
  validateManifest,
} from './config/contracts.js';
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
const hash = (content) => createHash('sha256').update(content).digest('hex');
const configRevision = (content) => `"sha256:${hash(content)}"`;
const resourceIdForPath = (relative) =>
  /^\.(?:agents|claude)\/skills\//.test(relative) ? `skill:${relative}` : `rule:${relative}`;
const projectRoot = resolveProjectRoot;
const withLock = withProjectLock;

const contractOptions = {
  providerIds: PROVIDERS.map((provider) => provider.id),
  skillIds: SKILLS.map((skill) => skill.id),
};

export const validateConfig = (config) => validateConfigContract(config, contractOptions);
const parseProjectConfig = (raw) => parseConfig(raw, contractOptions);

export async function readConfig(root) {
  root = await projectRoot(root);
  const raw = await readOptional(root, configPath);
  if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
  return parseProjectConfig(raw);
}

/** Return the validated configuration plus an opaque revision of its exact stored bytes. */
export async function readConfigSnapshot(root) {
  root = await projectRoot(root);
  const raw = await readOptional(root, configPath);
  if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
  return { config: parseProjectConfig(raw), revision: configRevision(raw) };
}

export async function initProject(root, options = {}) {
  root = await projectRoot(root);
  return withLock(root, async () => {
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

export async function saveConfig(root, config) {
  root = await projectRoot(root);
  const validated = validateConfig(config);
  return withLock(root, async () => {
    await writeAtomic(root, configPath, `${JSON.stringify(validated, null, 2)}\n`);
    return validated;
  });
}

/** Compare and save under the project lock so separate processes cannot lose updates. */
export async function saveConfigIfRevision(root, config, revision) {
  root = await projectRoot(root);
  const validated = validateConfig(config);
  return withLock(root, async () => {
    const raw = await readOptional(root, configPath);
    if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
    const currentRevision = configRevision(raw);
    if (revision !== currentRevision) {
      const error = new Error('Configuration changed in another process. Reload it before saving.');
      error.code = 'CONFIG_REVISION_CONFLICT';
      error.revision = currentRevision;
      throw error;
    }
    const next = `${JSON.stringify(validated, null, 2)}\n`;
    await writeAtomic(root, configPath, next);
    return { config: validated, revision: configRevision(next) };
  });
}

async function readManifest(root) {
  const raw = await readOptional(root, manifestPath);
  if (raw === null) return { schemaVersion: 3, files: {}, packs: [], sections: {} };
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new ConfigContractError(`Invalid JSON (${error.message}).`, '$', 'MANIFEST_INVALID_JSON');
  }
  return validateManifest(manifest);
}

export async function planConfigMigration(root, options = {}) {
  root = await projectRoot(root);
  const raw = await readOptional(root, configPath);
  if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
  const config = parseProjectConfig(raw);
  const toVersion = normalizeMigrationTarget(options.toVersion);
  await refuseDowngrade(root, config.schemaVersion, toVersion);
  return buildMigration(raw, config, toVersion);
}

async function refuseDowngrade(root, fromVersion, toVersion) {
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

export async function migrateConfig(root, options = {}) {
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

async function makePlan(root, removing = false) {
  const savedConfig = removing ? null : await readConfig(root);
  const config = removing
    ? { providers: [], skills: [], packs: [] }
    : {
        ...savedConfig,
        packs: savedConfig.packs ?? [
          { id: 'latchkit-core', version: '1.0.0', source: { type: 'bundled' }, pinned: true },
        ],
      };
  const manifest = await readManifest(root);
  const desired = new Map();
  const desiredSections = new Map();
  const directories = new Set(
    PROVIDERS.filter((p) => config.providers.includes(p.id)).map((p) => p.skillDirectory),
  );
  const packMetadata = [];
  const destinationOwners = new Map();
  for (const selection of config.packs) {
    const pack = await loadPack(selection);
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
    });
    for (const file of pack.files) {
      const parts = file.path.split('/');
      if (parts.length !== 3 || parts[0] !== 'skills' || parts[2] !== 'SKILL.md')
        throw new Error(`Pack ${pack.id} file is not a portable skill: ${file.path}`);
      const skillName = parts[1];
      if (
        pack.id === 'latchkit-core' &&
        !config.skills.includes(skillName.replace(/^latchkit-/, ''))
      )
        continue;
      for (const directory of directories) {
        const relative = `${directory}/${skillName}/SKILL.md`;
        const owner = destinationOwners.get(relative);
        if (owner) throw new Error(`Pack collision at ${relative}: ${owner} and ${pack.id}.`);
        destinationOwners.set(relative, pack.id);
        desired.set(relative, file.bytes.toString('utf8'));
      }
    }
  }
  const ruleExport = removing
    ? {
        model: { schemaVersion: 1, scopes: [] },
        desiredFiles: new Map(),
        desiredSections,
        warnings: [],
      }
    : await buildProjectRuleExports(root, config.providers);
  for (const [relative, content] of ruleExport.desiredFiles) {
    if (desired.has(relative)) throw new Error(`Managed resource collision at ${relative}.`);
    desired.set(relative, content);
  }
  for (const [relative, content] of ruleExport.desiredSections)
    desiredSections.set(relative, content);
  const changes = [],
    conflicts = [];
  for (const relative of [...new Set([...Object.keys(manifest.files), ...desired.keys()])].sort()) {
    let current;
    try {
      current = await readOptional(root, relative);
    } catch (error) {
      conflicts.push({ path: relative, reason: error.message });
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
  const renderedSections = new Map();
  const sectionHashes = new Map();
  for (const relative of [
    ...new Set([...Object.keys(manifest.sections), ...desiredSections.keys()]),
  ].sort()) {
    let current;
    try {
      current = await readOptional(root, relative);
    } catch (error) {
      conflicts.push({ path: relative, reason: error.message });
      continue;
    }
    const owned = manifest.sections[relative];
    let existing;
    try {
      existing = current === null ? null : findManagedSection(current);
    } catch (error) {
      conflicts.push({ path: relative, reason: error.message });
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

export async function planSync(root) {
  root = await projectRoot(root);
  const plan = await makePlan(root);
  return describeSyncPlan(root, plan);
}

async function describeSyncPlan(root, plan) {
  const paths = [
    ...new Set([
      ...Object.keys(plan.manifest.files),
      ...Object.keys(plan.manifest.sections),
      ...plan.desired.keys(),
      ...plan.desiredSections.keys(),
    ]),
  ].sort();
  const current = await Promise.all(
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

async function applySync(root, removing, options = {}) {
  root = await projectRoot(root);
  return withLock(root, async () => {
    const plan = await makePlan(root, removing);
    const described = await describeSyncPlan(root, plan);
    if (options.planId && options.planId !== described.planId) {
      const error = new Error(
        'The reviewed sync preview is stale. Refresh the preview before applying.',
      );
      error.code = 'SYNC_PLAN_STALE';
      error.planId = described.planId;
      error.configRevision = described.configRevision;
      throw error;
    }
    if (plan.conflicts.length) {
      const error = new Error(
        `Sync blocked: ${plan.conflicts.map((c) => `${c.path}: ${c.reason}`).join('\n')}`,
      );
      error.conflicts = plan.conflicts;
      throw error;
    }
    const transactionChanges = [];
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
        bytes: plan.renderedSections.get(change.path),
      });
      if (plan.desiredSections.has(change.path))
        nextManifest.sections[change.path] = {
          id: 'project-instructions',
          sha256: plan.sectionHashes.get(change.path),
        };
      else delete nextManifest.sections[change.path];
    }
    if (transactionChanges.length) {
      const registry = createResourceRegistry(
        [
          ...new Set([
            ...Object.keys(plan.manifest.files),
            ...Object.keys(plan.manifest.sections),
            ...plan.desired.keys(),
            ...plan.desiredSections.keys(),
          ]),
        ].map((relative) => ({ id: resourceIdForPath(relative), path: relative })),
      );
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

export const syncProject = (root, options) => applySync(root, false, options);
export const removeProjectSkills = (root, options) => applySync(root, true, options);

export async function inspectRecovery(root) {
  root = await projectRoot(root);
  const manifest = await readManifest(root);
  const plan = await makePlan(root).catch(() => ({
    desired: new Map(),
    desiredSections: new Map(),
  }));
  const registry = createResourceRegistry(
    [
      ...new Set([
        ...Object.keys(manifest.files),
        ...Object.keys(manifest.sections),
        ...plan.desired.keys(),
        ...plan.desiredSections.keys(),
      ]),
    ].map((relative) => ({
      id: resourceIdForPath(relative),
      path: relative,
    })),
  );
  return {
    lock: await inspectProjectLock(root),
    transaction: await inspectTransaction(root, registry),
  };
}

export async function recoverProject(root) {
  root = await projectRoot(root);
  const inspection = await inspectProjectLock(root);
  if (inspection.state === 'live' || inspection.state === 'invalid') {
    const error = new Error(
      inspection.state === 'live'
        ? 'A live Latchkit operation owns the project lock; recovery was not started.'
        : inspection.reason,
    );
    error.code = 'RECOVERY_LOCK_BLOCKED';
    throw error;
  }
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
  const registry = createResourceRegistry(
    [
      ...new Set([
        ...Object.keys(manifest.files),
        ...Object.keys(manifest.sections),
        ...plan.desired.keys(),
        ...plan.desiredSections.keys(),
      ]),
    ].map((relative) => ({
      id: resourceIdForPath(relative),
      path: relative,
    })),
  );
  const result = await withProjectLock(root, () => recoverTransaction(root, registry));
  return { ...result, cleanedLock };
}

async function findExecutable(command) {
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

export async function doctor(root) {
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
