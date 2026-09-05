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
const resourceIdForPath = (relative) => `skill:${relative}`;
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

async function readManifest(root) {
  const raw = await readOptional(root, manifestPath);
  if (raw === null) return { schemaVersion: 2, files: {}, packs: [] };
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
  return { changes, conflicts, desired, manifest, packMetadata, duplicateDiscovery };
}

export async function planSync(root) {
  root = await projectRoot(root);
  const plan = await makePlan(root);
  return {
    changes: plan.changes,
    conflicts: plan.conflicts,
    installedPacks: plan.manifest.packs,
    desiredPacks: plan.packMetadata,
    duplicateDiscovery: plan.duplicateDiscovery,
  };
}

async function applySync(root, removing, options = {}) {
  root = await projectRoot(root);
  return withLock(root, async () => {
    const plan = await makePlan(root, removing);
    if (plan.conflicts.length) {
      const error = new Error(
        `Sync blocked: ${plan.conflicts.map((c) => `${c.path}: ${c.reason}`).join('\n')}`,
      );
      error.conflicts = plan.conflicts;
      throw error;
    }
    const transactionChanges = [];
    const nextManifest = {
      schemaVersion: 2,
      files: { ...plan.manifest.files },
      packs: plan.packMetadata,
    };
    for (const change of plan.changes) {
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
    if (transactionChanges.length) {
      const registry = createResourceRegistry(
        [...new Set([...Object.keys(plan.manifest.files), ...plan.desired.keys()])].map(
          (relative) => ({ id: resourceIdForPath(relative), path: relative }),
        ),
      );
      await applyRegisteredTransaction(root, {
        operation: removing ? 'remove' : 'sync',
        registry,
        changes: transactionChanges,
        manifest: `${JSON.stringify(nextManifest, null, 2)}\n`,
        faultBoundary: options.faultBoundary,
      });
    }
    return {
      changes: plan.changes,
      conflicts: [],
      installedPacks: plan.manifest.packs,
      desiredPacks: plan.packMetadata,
      duplicateDiscovery: plan.duplicateDiscovery,
    };
  });
}

export const syncProject = (root, options) => applySync(root, false, options);
export const removeProjectSkills = (root, options) => applySync(root, true, options);

export async function inspectRecovery(root) {
  root = await projectRoot(root);
  const manifest = await readManifest(root);
  const plan = await makePlan(root).catch(() => ({ desired: new Map() }));
  const registry = createResourceRegistry(
    [...new Set([...Object.keys(manifest.files), ...plan.desired.keys()])].map((relative) => ({
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
  const plan = await makePlan(root).catch(() => ({ desired: new Map() }));
  const registry = createResourceRegistry(
    [...new Set([...Object.keys(manifest.files), ...plan.desired.keys()])].map((relative) => ({
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
