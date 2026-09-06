import { lstat, readFile, readdir } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { errorCode, isRecord, type UnknownRecord } from '../types.js';
import type { DeclaredCommand, ProjectFact, ProjectScope } from './types.js';

const MAX_MANIFEST_BYTES = 256 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', '.latchkit', 'node_modules', 'vendor', 'target']);

interface RuleDiscoveryIo {
  lstat(filename: string): Promise<Stats>;
  readFile(filename: string, encoding: 'utf8'): Promise<string>;
  readdir(filename: string, options: { withFileTypes: true }): Promise<Dirent[]>;
}

interface RuleDiscoveryOptions {
  io?: RuleDiscoveryIo;
  scopes?: readonly string[];
}

const portable = (value: string): string => value.split(path.sep).join('/');

async function readBoundedFile(filename: string, io: RuleDiscoveryIo): Promise<string | null> {
  let stat: Stats;
  try {
    stat = await io.lstat(filename);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return null;
  return io.readFile(filename, 'utf8');
}

async function isRegularFile(filename: string, io: RuleDiscoveryIo): Promise<boolean> {
  try {
    const stat = await io.lstat(filename);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function command(
  name: string,
  executable: string,
  args: string[],
  sourcePath: string,
): DeclaredCommand {
  return {
    name,
    executable,
    args,
    sourcePath,
    provenance: 'declared',
    verified: false,
  };
}

function nodeFacts(relative: string, parsed: UnknownRecord): ProjectFact[] {
  const facts: ProjectFact[] = [
    { kind: 'language', value: 'JavaScript/Node.js', sourcePath: relative },
  ];
  if (typeof parsed.name === 'string' && parsed.name)
    facts.push({ kind: 'package', value: parsed.name, sourcePath: relative });
  const engines = isRecord(parsed.engines) ? parsed.engines : null;
  if (typeof engines?.node === 'string')
    facts.push({
      kind: 'toolchain',
      value: `Node.js ${engines.node}`,
      sourcePath: relative,
    });
  return facts;
}

function nodeCommands(relative: string, parsed: UnknownRecord): DeclaredCommand[] {
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : null;
  if (!scripts) return [];
  return ['build', 'test', 'lint']
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => command(name, 'npm', ['run', name], relative));
}

function parseTomlScalar(raw: string, key: string): string | null {
  const match = raw.match(
    new RegExp(`^\\s*${key.replace('.', '\\.')}\\s*=\\s*["']([^"']+)["']`, 'm'),
  );
  return match?.[1] ?? null;
}

async function inspectScope(
  root: string,
  scopePath: string,
  io: RuleDiscoveryIo,
): Promise<ProjectScope> {
  const absolute = path.join(root, ...scopePath.split('/').filter(Boolean));
  const facts: ProjectFact[] = [];
  const commands: DeclaredCommand[] = [];
  const sources: string[] = [];
  const existingInstructions: string[] = [];
  const packageRelative = scopePath ? `${scopePath}/package.json` : 'package.json';
  const packageRaw = await readBoundedFile(path.join(absolute, 'package.json'), io);
  if (packageRaw !== null) {
    let parsed;
    try {
      parsed = JSON.parse(packageRaw);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed)) {
      sources.push(packageRelative);
      facts.push(...nodeFacts(packageRelative, parsed));
      commands.push(...nodeCommands(packageRelative, parsed));
    }
  }

  const pyprojectRelative = scopePath ? `${scopePath}/pyproject.toml` : 'pyproject.toml';
  const pyproject = await readBoundedFile(path.join(absolute, 'pyproject.toml'), io);
  if (pyproject !== null) {
    sources.push(pyprojectRelative);
    facts.push({ kind: 'language', value: 'Python', sourcePath: pyprojectRelative });
    const requiresPython = parseTomlScalar(pyproject, 'requires-python');
    if (requiresPython)
      facts.push({
        kind: 'toolchain',
        value: `Python ${requiresPython}`,
        sourcePath: pyprojectRelative,
      });
    if (/^\s*\[tool\.pytest\./m.test(pyproject) || /^\s*\[tool\.pytest\]/m.test(pyproject))
      commands.push(command('test', 'python', ['-m', 'pytest'], pyprojectRelative));
    if (/^\s*\[tool\.ruff(?:\.|\])/m.test(pyproject))
      commands.push(command('lint', 'python', ['-m', 'ruff', 'check', '.'], pyprojectRelative));
  }

  const goRelative = scopePath ? `${scopePath}/go.mod` : 'go.mod';
  const goMod = await readBoundedFile(path.join(absolute, 'go.mod'), io);
  if (goMod !== null) {
    sources.push(goRelative);
    facts.push({ kind: 'language', value: 'Go', sourcePath: goRelative });
    const version = goMod.match(/^go\s+([^\s]+)$/m)?.[1];
    if (version) facts.push({ kind: 'toolchain', value: `Go ${version}`, sourcePath: goRelative });
    commands.push(command('test', 'go', ['test', './...'], goRelative));
  }

  const cargoRelative = scopePath ? `${scopePath}/Cargo.toml` : 'Cargo.toml';
  const cargo = await readBoundedFile(path.join(absolute, 'Cargo.toml'), io);
  if (cargo !== null) {
    sources.push(cargoRelative);
    facts.push({ kind: 'language', value: 'Rust', sourcePath: cargoRelative });
    commands.push(command('build', 'cargo', ['build'], cargoRelative));
    commands.push(command('test', 'cargo', ['test'], cargoRelative));
  }

  for (const filename of ['.nvmrc', '.node-version']) {
    const relative = scopePath ? `${scopePath}/${filename}` : filename;
    const raw = await readBoundedFile(path.join(absolute, filename), io);
    const version = raw?.trim();
    if (version) {
      sources.push(relative);
      facts.push({ kind: 'toolchain', value: `Node.js ${version}`, sourcePath: relative });
    }
  }
  const rustToolchainRelative = scopePath
    ? `${scopePath}/rust-toolchain.toml`
    : 'rust-toolchain.toml';
  const rustToolchain = await readBoundedFile(path.join(absolute, 'rust-toolchain.toml'), io);
  if (rustToolchain !== null) {
    sources.push(rustToolchainRelative);
    const channel = parseTomlScalar(rustToolchain, 'channel');
    if (channel)
      facts.push({
        kind: 'toolchain',
        value: `Rust ${channel}`,
        sourcePath: rustToolchainRelative,
      });
  }

  const scopeParts = scopePath.split('/').filter(Boolean);
  for (let depth = 0; depth <= scopeParts.length; depth += 1) {
    const directoryParts = scopeParts.slice(0, depth);
    for (const filename of ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      const relative = [...directoryParts, filename].join('/');
      if (await isRegularFile(path.join(root, ...directoryParts, filename), io))
        existingInstructions.push(relative);
    }
  }

  return {
    path: scopePath,
    sources: [...new Set(sources)].sort(),
    facts: facts.sort((left, right) =>
      `${left.kind}:${left.value}:${left.sourcePath}`.localeCompare(
        `${right.kind}:${right.value}:${right.sourcePath}`,
      ),
    ),
    commands: commands.sort((left, right) => left.name.localeCompare(right.name)),
    existingInstructions: [...new Set(existingInstructions)].sort(),
  };
}

function workspacePatterns(parsed: unknown): string[] {
  const object = isRecord(parsed) ? parsed : {};
  const workspaceRecord = isRecord(object.workspaces) ? object.workspaces : {};
  const workspaces = Array.isArray(object.workspaces)
    ? object.workspaces
    : Array.isArray(workspaceRecord.packages)
      ? workspaceRecord.packages
      : [];
  return workspaces.filter(
    (item) => typeof item === 'string' && item && !item.includes('..') && !path.isAbsolute(item),
  );
}

async function expandWorkspacePattern(
  root: string,
  pattern: string,
  io: RuleDiscoveryIo,
): Promise<string[]> {
  const normalized = portable(path.normalize(pattern)).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized.includes('*')) return [normalized];
  const parts = normalized.split('/');
  if (
    parts.filter((part) => part === '*').length !== 1 ||
    parts.some((part) => part.includes('*') && part !== '*')
  )
    return [];
  const wildcard = parts.indexOf('*');
  const parentParts = parts.slice(0, wildcard);
  const suffix = parts.slice(wildcard + 1);
  let entries: Dirent[];
  try {
    entries = await io.readdir(path.join(root, ...parentParts), { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name),
    )
    .map((entry) => [...parentParts, entry.name, ...suffix].join('/'))
    .sort();
}

export async function discoverProjectFacts(
  root: string,
  options: RuleDiscoveryOptions = {},
): Promise<ProjectScope[]> {
  const io = options.io ?? { lstat, readFile, readdir };
  const rootPackageRaw = await readBoundedFile(path.join(root, 'package.json'), io);
  let patterns: string[] = [];
  if (rootPackageRaw !== null) {
    try {
      patterns = workspacePatterns(JSON.parse(rootPackageRaw));
    } catch {
      patterns = [];
    }
  }
  const discovered = new Set(['']);
  for (const pattern of patterns)
    for (const scopePath of await expandWorkspacePattern(root, pattern, io))
      discovered.add(scopePath);
  const selected: Set<string> = options.scopes === undefined ? discovered : new Set<string>();
  for (const explicit of options.scopes ?? []) {
    if (
      typeof explicit !== 'string' ||
      path.isAbsolute(explicit) ||
      explicit.includes('\\') ||
      explicit.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error(`Unsafe rule scope: ${explicit}`);
    selected.add(explicit);
  }

  const scopes = [];
  for (const scopePath of [...selected].sort()) {
    const scope = await inspectScope(root, scopePath, io);
    if (scope.sources.length || options.scopes?.includes(scopePath)) scopes.push(scope);
  }
  return scopes;
}
