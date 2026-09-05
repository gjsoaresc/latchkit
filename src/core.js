import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', command: 'claude', skillDirectory: '.claude/skills' },
  { id: 'codex', label: 'Codex', command: 'codex', skillDirectory: '.agents/skills' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', skillDirectory: '.agents/skills' },
  { id: 'cursor', label: 'Cursor IDE', command: 'cursor', skillDirectory: '.agents/skills' },
  { id: 'cursor-cli', label: 'Cursor CLI', command: 'agent', skillDirectory: '.agents/skills' },
];
export const SKILLS = [
  { id: 'spec', label: 'Spec & build', description: 'Turn requirements into a scoped plan, implementation, and verification evidence.' },
  { id: 'fix', label: 'Reproduce & fix', description: 'Reproduce a defect, repair its cause, and check for regressions.' },
  { id: 'review', label: 'Review changes', description: 'Inspect a diff for actionable defects and missing verification.' },
  { id: 'handoff', label: 'Save a handoff', description: 'Capture decisions, evidence, and next steps for another session.' },
];
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

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1) throw new Error('Expected config schemaVersion 1.');
  if (Object.keys(config).some(key => !['schemaVersion', 'providers', 'skills'].includes(key))) throw new Error('Unknown configuration field.');
  for (const [key, allowed] of [['providers', PROVIDERS.map(p => p.id)], ['skills', SKILLS.map(s => s.id)]]) {
    if (!Array.isArray(config[key]) || config[key].some(id => typeof id !== 'string' || !allowed.includes(id)) || new Set(config[key]).size !== config[key].length) {
      throw new Error(`Invalid ${key}: use unique values from ${allowed.join(', ')}.`);
    }
  }
  return { schemaVersion: 1, providers: [...config.providers], skills: [...config.skills] };
}

export async function readConfig(root) {
  root = await projectRoot(root);
  const raw = await readOptional(root, configPath);
  if (raw === null) throw new Error('Project is not initialized. Run latchkit init first.');
  return validateConfig(JSON.parse(raw));
}

export async function initProject(root, options = {}) {
  root = await projectRoot(root);
  return withLock(root, async () => {
    const raw = await readOptional(root, configPath);
    if (raw !== null) return validateConfig(JSON.parse(raw));
    const config = validateConfig({ schemaVersion: 1, providers: options.providers ?? PROVIDERS.map(p => p.id), skills: options.skills ?? SKILLS.map(s => s.id) });
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
  const manifest = JSON.parse(raw);
  if (manifest?.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid Latchkit manifest.');
  for (const [relative, digest] of Object.entries(manifest.files)) {
    if (!allSkillPaths.has(relative) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid managed file in manifest.');
  }
  return manifest;
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
