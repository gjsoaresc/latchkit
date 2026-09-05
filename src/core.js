import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
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

export { PROVIDERS, SKILLS, CURRENT_CONFIG_SCHEMA_VERSION, SUPPORTED_CONFIG_SCHEMA_VERSIONS, ConfigContractError };
const stateDirectory = '.latchkit';
const configPath = `${stateDirectory}/config.json`;
const manifestPath = `${stateDirectory}/manifest.json`;
const sourceRoot = fileURLToPath(new URL('../skills/', import.meta.url));
const hash = content => createHash('sha256').update(content).digest('hex');
const allSkillPaths = new Set(PROVIDERS.flatMap(p => SKILLS.map(s => `${p.skillDirectory}/latchkit-${s.id}/SKILL.md`)));

async function statIfExists(target) {
  try { return await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Only write beneath a real project root; reject junctions/symlinks in managed paths.
async function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe managed path: ${relative}`);
  }
  let target = root;
  const segments = relative.split('/');
  for (let i = 0; i < segments.length; i++) {
    target = path.join(target, segments[i]);
    const stat = await statIfExists(target);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink or junction: ${relative}`);
    if (stat && i < segments.length - 1 && !stat.isDirectory()) throw new Error(`Expected directory: ${relative}`);
    if (stat && i === segments.length - 1 && !stat.isFile()) throw new Error(`Expected regular file: ${relative}`);
  }
  return target;
}

async function projectRoot(root) {
  const resolved = await realpath(path.resolve(root));
  if (!(await lstat(resolved)).isDirectory()) throw new Error('Project must be a directory.');
  return resolved;
}

async function readOptional(root, relative) {
  const target = await safePath(root, relative);
  try { return await readFile(target, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeAtomic(root, relative, content) {
  const target = await safePath(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await safePath(root, relative);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await (await open(temporary, 'wx', 0o600)).close();
    const handle = await open(temporary, 'w');
    try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
    await rename(temporary, target);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function withLock(root, operation) {
  const lockPath = await safePath(root, `${stateDirectory}/lock`);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another Latchkit operation holds .latchkit/lock. If a previous process crashed, verify it stopped before deleting that lock.');
    throw error;
  }
  try { await lock.writeFile(`${process.pid}\n`); return await operation(); }
  finally { await lock.close(); await unlink(lockPath); }
}

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

async function applySync(root, removing) {
  root = await projectRoot(root);
  return withLock(root, async () => {
    const plan = await makePlan(root, removing);
    if (plan.conflicts.length) {
      const error = new Error(`Sync blocked: ${plan.conflicts.map(c => `${c.path}: ${c.reason}`).join('\n')}`);
      error.conflicts = plan.conflicts;
      throw error;
    }
    // Record each successful change, so partial I/O failures retain ownership information.
    for (const change of plan.changes) {
      if (change.action === 'unchanged') continue;
      const current = await readOptional(root, change.path);
      const recorded = plan.manifest.files[change.path];
      if (current !== null && (!recorded || hash(current) !== recorded)) throw new Error(`File changed during sync: ${change.path}`);
      if (change.action === 'remove') {
        if (current !== null) await unlink(await safePath(root, change.path));
        delete plan.manifest.files[change.path];
      } else {
        const content = plan.desired.get(change.path);
        await writeAtomic(root, change.path, content);
        plan.manifest.files[change.path] = hash(content);
      }
      try {
        await writeAtomic(root, manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);
      } catch (error) {
        // Keep ownership and file contents aligned when metadata cannot be persisted.
        try {
          if (current === null) {
            const target = await safePath(root, change.path);
            if (await statIfExists(target)) await unlink(target);
          } else await writeAtomic(root, change.path, current);
        } catch (rollbackError) {
          throw new Error(`Manifest update failed (${error.message}); recovery also failed for ${change.path}: ${rollbackError.message}. Inspect this file before syncing again.`, { cause: error });
        }
        throw new Error(`Manifest update failed; restored ${change.path}. ${error.message}`, { cause: error });
      }
    }
    return { changes: plan.changes, conflicts: [] };
  });
}

export const syncProject = root => applySync(root, false);
export const removeProjectSkills = root => applySync(root, true);

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
