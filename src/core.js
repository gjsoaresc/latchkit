import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, SKILLS } from './catalog.js';
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

export { PROVIDERS, SKILLS, CURRENT_CONFIG_SCHEMA_VERSION, SUPPORTED_CONFIG_SCHEMA_VERSIONS, ConfigContractError };
const stateDirectory = '.latchkit';
const configPath = `${stateDirectory}/config.json`;
const manifestPath = `${stateDirectory}/manifest.json`;
const sourceRoot = fileURLToPath(new URL('../skills/', import.meta.url));
const hash = content => createHash('sha256').update(content).digest('hex');
const allSkillPaths = new Set(PROVIDERS.flatMap(p => SKILLS.map(s => `${p.skillDirectory}/latchkit-${s.id}/SKILL.md`)));
const resourceRegistry = createResourceRegistry([...allSkillPaths].map(relative => ({ id: `skill:${relative}`, path: relative })));
const resourceIdForPath = relative => `skill:${relative}`;
const projectRoot = resolveProjectRoot;
const withLock = withProjectLock;

const contractOptions = {
  providerIds: PROVIDERS.map(provider => provider.id),
  skillIds: SKILLS.map(skill => skill.id),
};

export const validateConfig = config => validateConfigContract(config, contractOptions);
const parseProjectConfig = raw => parseConfig(raw, contractOptions);

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
      providers: options.providers ?? PROVIDERS.map(p => p.id),
      skills: options.skills ?? SKILLS.map(s => s.id),
      providerSettings: options.providerSettings ?? {},
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
  if (raw === null) return { schemaVersion: 1, files: {} };
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) { throw new ConfigContractError(`Invalid JSON (${error.message}).`, '$', 'MANIFEST_INVALID_JSON'); }
  return validateManifest(manifest, allSkillPaths);
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
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json'))
    .map(entry => `${relativeDirectory}/${entry.name}`)
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
      readBackup: relative => readOptional(root, relative),
      writeBackup: (relative, contents) => writeAtomic(root, relative, contents),
      writeConfig: config => writeAtomic(root, configPath, `${JSON.stringify(validateConfig(config), null, 2)}\n`),
    });
  });
}

async function makePlan(root, removing = false) {
  const config = removing ? { providers: [], skills: [] } : await readConfig(root);
  const manifest = await readManifest(root);
  const desired = new Map();
  const directories = new Set(PROVIDERS.filter(p => config.providers.includes(p.id)).map(p => p.skillDirectory));
  for (const id of config.skills) {
    const content = await readFile(path.join(sourceRoot, `latchkit-${id}`, 'SKILL.md'), 'utf8');
    for (const directory of directories) desired.set(`${directory}/latchkit-${id}/SKILL.md`, content);
  }
  const changes = [], conflicts = [];
  for (const relative of [...new Set([...Object.keys(manifest.files), ...desired.keys()])].sort()) {
    let current;
    try { current = await readOptional(root, relative); }
    catch (error) { conflicts.push({ path: relative, reason: error.message }); continue; }
    const ownedHash = manifest.files[relative];
    if (current !== null && !ownedHash) {
      conflicts.push({ path: relative, reason: 'An existing file is not managed by Latchkit.' }); continue;
    }
    if (current !== null && hash(current) !== ownedHash) {
      conflicts.push({ path: relative, reason: 'Managed file has local edits; preserve or move it before syncing.' }); continue;
    }
    const next = desired.get(relative);
    const action = next === undefined ? 'remove' : current === null ? 'create' : current === next ? 'unchanged' : 'update';
    changes.push({ action, path: relative });
  }
  return { changes, conflicts, desired, manifest };
}

export async function planSync(root) {
  root = await projectRoot(root);
  const { changes, conflicts } = await makePlan(root);
  return { changes, conflicts };
}

async function applySync(root, removing, options = {}) {
  root = await projectRoot(root);
  return withLock(root, async () => {
    const plan = await makePlan(root, removing);
    if (plan.conflicts.length) {
      const error = new Error(`Sync blocked: ${plan.conflicts.map(c => `${c.path}: ${c.reason}`).join('\n')}`);
      error.conflicts = plan.conflicts;
      throw error;
    }
    const transactionChanges = [];
    const nextManifest = { schemaVersion: plan.manifest.schemaVersion, files: { ...plan.manifest.files } };
    for (const change of plan.changes) {
      if (change.action === 'unchanged') continue;
      const current = await readOptional(root, change.path);
      const recorded = plan.manifest.files[change.path];
      if (current !== null && (!recorded || hash(current) !== recorded)) throw new Error(`File changed during sync: ${change.path}`);
      if (change.action === 'remove') {
        transactionChanges.push({ resourceId: resourceIdForPath(change.path), bytes: null });
        delete nextManifest.files[change.path];
      } else {
        const content = plan.desired.get(change.path);
        transactionChanges.push({ resourceId: resourceIdForPath(change.path), bytes: content });
        nextManifest.files[change.path] = hash(content);
      }
    }
    if (transactionChanges.length) await applyRegisteredTransaction(root, {
      operation: removing ? 'remove' : 'sync',
      registry: resourceRegistry,
      changes: transactionChanges,
      manifest: `${JSON.stringify(nextManifest, null, 2)}\n`,
      faultBoundary: options.faultBoundary,
    });
    return { changes: plan.changes, conflicts: [] };
  });
}

export const syncProject = (root, options) => applySync(root, false, options);
export const removeProjectSkills = (root, options) => applySync(root, true, options);

export async function inspectRecovery(root) {
  root = await projectRoot(root);
  return { lock: await inspectProjectLock(root), transaction: await inspectTransaction(root, resourceRegistry) };
}

export async function recoverProject(root) {
  root = await projectRoot(root);
  const inspection = await inspectProjectLock(root);
  if (inspection.state === 'live' || inspection.state === 'invalid') {
    const error = new Error(inspection.state === 'live'
      ? 'A live Latchkit operation owns the project lock; recovery was not started.'
      : inspection.reason);
    error.code = 'RECOVERY_LOCK_BLOCKED';
    throw error;
  }
  let cleanedLock = false;
  if (inspection.state === 'stale') {
    await removeProvenStaleLock(root, inspection);
    cleanedLock = true;
  }
  const result = await withProjectLock(root, () => recoverTransaction(root, resourceRegistry));
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
      } catch { /* Missing or inaccessible executable; continue searching PATH. */ }
    }
  }
  return null;
}

export async function doctor(root) {
  const wsl = process.platform === 'linux' && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()));
  return {
    platform: process.platform,
    runtime: wsl ? 'WSL' : 'native',
    node: process.version,
    project: await projectRoot(root),
    providers: await Promise.all(PROVIDERS.map(async provider => {
      const executable = await findExecutable(provider.command);
      return { ...provider, detected: Boolean(executable), path: executable };
    })),
  };
}
