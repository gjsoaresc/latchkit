import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withTaskStateLock } from '../task-state/lock.js';
import { writeAtomic as writeDurable } from '../storage.js';

export type InstallationCommand = 'install' | 'upgrade' | 'rollback' | 'uninstall' | 'inspect';
export interface InstallationRequest {
  command: InstallationCommand;
  root: string;
  bundle?: string;
  version?: string;
  target?: string;
  force?: boolean;
}
export interface BundleFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface BundleManifest {
  schemaVersion: 1;
  package: 'latchkit';
  version: string;
  target: string;
  nodeVersion: string;
  files: BundleFile[];
}
export interface InstallationInspection {
  root: string;
  active: string | null;
  versions: string[];
  launchers: string[];
  retained: string[];
}
/**
 * Result of staging a verified bundle into its immutable `versions/<key>`
 * directory without touching `current`, the managed launchers, or the
 * runtime any already-running or newly launched process resolves. Consumers
 * that need to activate a staged version later reuse the existing
 * `rollbackInstallation` primitive (see `src/installation/updates/service.ts`),
 * which re-verifies and re-smokes the target directory before flipping
 * `current` — the same "point current at an existing immutable version
 * directory" operation, whether the version is new or previously installed.
 */
export interface StagedBundleRecord {
  root: string;
  version: string;
  target: string;
  key: string;
  directory: string;
  manifest: BundleManifest;
}
export interface HookHandlerBinding {
  id: string;
  relativeHandler: string;
}
interface LauncherOwnership {
  schemaVersion: 1;
  files: Record<string, string>;
}
interface LauncherIntent {
  schemaVersion: 1;
  relative: string;
  previousHash: string | null;
  nextHash: string;
}

const DEFAULT_HOOKS: readonly HookHandlerBinding[] = [
  { id: 'codex', relativeHandler: 'app/dist/src/providers/codex-handler.js' },
  { id: 'claude', relativeHandler: 'app/dist/src/providers/claude-hook.js' },
  { id: 'cursor', relativeHandler: 'app/dist/src/providers/cursor-ide-hook.cjs' },
];

const ACTIVE = 'current';
const LAUNCHERS = '.launchers.json';
const LAUNCHER_INTENT = '.launchers.intent.json';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const targetOf = () => `${process.platform}-${process.arch}`;
const executable = () => (process.platform === 'win32' ? 'node.exe' : 'node');

function validTarget(value: unknown): value is string {
  return typeof value === 'string' && /^(win32-x64|linux-x64|darwin-x64|darwin-arm64)$/.test(value);
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION.test(value);
}

function within(root: string, location: string): boolean {
  const relative = path.relative(root, location);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Resolve existing parent aliases such as macOS /var and /tmp, but never accept a linked final root. */
async function canonicalLocation(location: string): Promise<string> {
  let current = path.resolve(location);
  const missing: string[] = [];
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isDirectory()) return path.join(await realpath(current), ...missing.reverse());
      if (info.isSymbolicLink() && missing.length > 0)
        return path.join(await realpath(current), ...missing.reverse());
      throw new Error(`Refusing symlink or non-directory path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function ensureRoot(root: string): Promise<string> {
  const canonical = await canonicalLocation(root);
  await mkdir(canonical, { recursive: true });
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Installation root is not a real directory: ${canonical}`);
  const resolved = await realpath(canonical);
  if (resolved !== canonical)
    throw new Error(`Installation root escaped its canonical path: ${canonical}`);
  return resolved;
}

async function ensureDirectoryWithinRoot(root: string, relative: string): Promise<string> {
  const destination = path.resolve(root, relative);
  if (!within(root, destination))
    throw new Error(`Managed path escapes installation root: ${relative}`);
  let current = root;
  for (const segment of path.relative(root, destination).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Refusing symlink or non-directory managed ancestor: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Refusing symlink or non-directory managed ancestor: ${current}`);
    }
  }
  return destination;
}

async function rejectSymlinksWithin(root: string, location: string): Promise<void> {
  const destination = path.resolve(location);
  if (!within(root, destination)) throw new Error(`Path escapes verified root: ${location}`);
  let current = root;
  const segments = path.relative(root, destination).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink or junction: ${current}`);
      if (index < segments.length - 1 && !info.isDirectory())
        throw new Error(`Expected a directory ancestor: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
}

function safeRelative(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes(':') &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

function versionKey(manifest: BundleManifest): string {
  return `${manifest.version}-${manifest.target}`;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function validateManifest(value: unknown): BundleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Bundle manifest must be an object.');
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.package !== 'latchkit' ||
    typeof candidate.version !== 'string' ||
    !VERSION.test(candidate.version) ||
    typeof candidate.target !== 'string' ||
    typeof candidate.nodeVersion !== 'string' ||
    !Array.isArray(candidate.files)
  )
    throw new Error('Bundle manifest is invalid.');
  const seen = new Set<string>();
  const files = candidate.files.map((file): BundleFile => {
    if (!file || typeof file !== 'object' || Array.isArray(file))
      throw new Error('Bundle manifest file entry is invalid.');
    const entry = file as Record<string, unknown>;
    if (
      !safeRelative(entry.path) ||
      typeof entry.bytes !== 'number' ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256) ||
      seen.has(entry.path)
    )
      throw new Error('Bundle manifest file entry is invalid.');
    seen.add(entry.path);
    return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
  });
  return {
    schemaVersion: 1,
    package: 'latchkit',
    version: candidate.version,
    target: candidate.target,
    nodeVersion: candidate.nodeVersion,
    files,
  };
}

async function ensureRegular(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Bundle contains a non-regular file: ${file}`);
}

async function verifyBundle(bundle: string, target: string): Promise<BundleManifest> {
  const source = await canonicalLocation(bundle);
  const rootInfo = await lstat(source);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Bundle must be a real directory.');
  const manifestFile = path.join(source, 'bundle-manifest.json');
  await ensureRegular(manifestFile);
  const manifest = validateManifest(await readJson(manifestFile));
  if (!validTarget(target) || manifest.target !== target || target !== targetOf())
    throw new Error(`Unsupported bundle target: ${manifest.target}.`);
  for (const entry of manifest.files) {
    const filename = path.join(source, ...entry.path.split('/'));
    await rejectSymlinksWithin(source, filename);
    await ensureRegular(filename);
    const bytes = await readFile(filename);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
      throw new Error(`Bundle integrity check failed: ${entry.path}`);
  }
  for (const required of [
    `runtime/${executable()}`,
    'app/dist/src/cli.js',
    'app/dist/src/workflows/policy.js',
  ]) {
    if (!manifest.files.some((entry) => entry.path === required))
      throw new Error(`Bundle is missing required runtime content: ${required}`);
  }
  return manifest;
}

async function writeAtomic(root: string, relative: string, content: string): Promise<void> {
  if (!safeRelative(relative)) throw new Error(`Invalid managed relative path: ${relative}`);
  const parentRelative = path.posix.dirname(relative);
  const parent = await ensureDirectoryWithinRoot(
    root,
    parentRelative === '.' ? '' : parentRelative,
  );
  const destination = path.join(root, ...relative.split('/'));
  try {
    if ((await lstat(destination)).isSymbolicLink())
      throw new Error(`Refusing symlink or junction: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeDurable(parent, path.basename(destination), content);
}

async function readLauncherOwnership(root: string): Promise<LauncherOwnership> {
  try {
    const value = JSON.parse(await readFile(path.join(root, LAUNCHERS), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid launcher ownership record.');
    const record = value as { schemaVersion?: unknown; files?: unknown };
    if (
      record.schemaVersion !== 1 ||
      !record.files ||
      typeof record.files !== 'object' ||
      Array.isArray(record.files)
    )
      throw new Error('Invalid launcher ownership record.');
    return { schemaVersion: 1, files: record.files as Record<string, string> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, files: {} };
    throw error;
  }
}

async function writeLauncherOwnership(root: string, ownership: LauncherOwnership): Promise<void> {
  await writeAtomic(root, LAUNCHERS, `${JSON.stringify(ownership, null, 2)}\n`);
}

async function recoverLauncherIntent(root: string): Promise<void> {
  let intent: LauncherIntent;
  try {
    const value = JSON.parse(await readFile(path.join(root, LAUNCHER_INTENT), 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid launcher ownership intent.');
    const candidate = value as Partial<LauncherIntent>;
    if (
      candidate.schemaVersion !== 1 ||
      !safeRelative(candidate.relative) ||
      (candidate.previousHash !== null && !SHA256.test(candidate.previousHash ?? '')) ||
      !SHA256.test(candidate.nextHash ?? '')
    )
      throw new Error('Invalid launcher ownership intent.');
    intent = candidate as LauncherIntent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const ownership = await readLauncherOwnership(root);
  const destination = path.join(root, ...intent.relative.split('/'));
  let currentHash: string | null = null;
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Refusing symlink or non-regular launcher: ${intent.relative}`);
    currentHash = digest(await readFile(destination));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (currentHash === intent.nextHash) {
    ownership.files[intent.relative] = intent.nextHash;
    await writeLauncherOwnership(root, ownership);
  }
  await rm(path.join(root, LAUNCHER_INTENT), { force: true });
}

async function launcherOwnership(root: string): Promise<LauncherOwnership> {
  await recoverLauncherIntent(root);
  return readLauncherOwnership(root);
}

async function writeOwnedLauncher(
  root: string,
  relative: string,
  content: string,
  mode?: number,
): Promise<void> {
  const ownership = await launcherOwnership(root);
  const destination = path.join(root, ...relative.split('/'));
  let previousHash: string | null = null;
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Refusing symlink or non-regular launcher: ${relative}`);
    const current = await readFile(destination);
    previousHash = digest(current);
    if (!ownership.files[relative] || previousHash !== ownership.files[relative])
      throw new Error(`Refusing to overwrite an unowned launcher: ${relative}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const nextHash = digest(Buffer.from(content));
  await writeAtomic(
    root,
    LAUNCHER_INTENT,
    `${JSON.stringify({ schemaVersion: 1, relative, previousHash, nextHash } satisfies LauncherIntent)}\n`,
  );
  await writeAtomic(root, relative, content);
  if (mode !== undefined) await chmod(destination, mode);
  ownership.files[relative] = nextHash;
  await writeLauncherOwnership(root, ownership);
  await rm(path.join(root, LAUNCHER_INTENT), { force: true });
}

async function removeOwnedLauncher(root: string, relative: string): Promise<void> {
  const ownership = await launcherOwnership(root);
  if (!ownership.files[relative]) return;
  const destination = path.join(root, ...relative.split('/'));
  try {
    await rejectSymlinksWithin(root, destination);
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Refusing symlink or non-regular launcher: ${relative}`);
    if (digest(await readFile(destination)) !== ownership.files[relative])
      throw new Error(`Refusing to delete changed launcher: ${relative}`);
    await rm(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  delete ownership.files[relative];
  await writeLauncherOwnership(root, ownership);
}

async function preflightManagedRemoval(root: string, relatives: readonly string[]): Promise<void> {
  for (const relative of relatives) {
    const destination = path.join(root, ...relative.split('/'));
    await rejectSymlinksWithin(root, destination);
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`Refusing symlink or non-regular managed file: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function withInstallationLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  await ensureRoot(root);
  // Reuse the challenged ownership lock inside the installation root. A PID
  // lookup failure alone cannot establish that another installer is absent.
  return withTaskStateLock(root, operation);
}

/**
 * Canonicalize and prepare an installation root for reuse by other
 * installation-local modules (for example the update service's settings and
 * staged-record stores), so every reader/writer of installation-scoped state
 * agrees on the same real directory and shares the same installation lock
 * via `withInstallationLock`.
 */
export async function resolveInstallationRoot(root: string): Promise<string> {
  return ensureRoot(root);
}

async function copyVerifiedBundle(
  bundle: string,
  destination: string,
  manifest: BundleManifest,
): Promise<void> {
  for (const entry of manifest.files) {
    const source = path.join(bundle, ...entry.path.split('/'));
    const target = path.join(destination, ...entry.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    const bytes = await readFile(target);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
      throw new Error(`Staged bundle integrity check failed: ${entry.path}`);
  }
  await copyFile(
    path.join(bundle, 'bundle-manifest.json'),
    path.join(destination, 'bundle-manifest.json'),
  );
}

async function smoke(versionDirectory: string, expectedVersion: string): Promise<void> {
  const node = path.join(versionDirectory, 'runtime', executable());
  await ensureRegular(node);
  const { spawn } = await import('node:child_process');
  const run = (args: string[], cwd?: string) =>
    new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(node, args, { cwd, windowsHide: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Bundle smoke timed out.'));
      }, 30_000);
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Bundle smoke failed (${code}): ${stderr}`));
      });
    });
  const output = await run([
    path.join(versionDirectory, 'app', 'dist', 'src', 'cli.js'),
    '--version',
  ]);
  if (output !== expectedVersion)
    throw new Error(`Bundle CLI reported ${output}, expected ${expectedVersion}.`);
  const policy = await run(
    [
      '--input-type=module',
      '-e',
      "import {policy_version_async} from './dist/src/workflows/policy.js'; process.stdout.write(await policy_version_async());",
    ],
    path.join(versionDirectory, 'app'),
  );
  if (policy !== 'latchkit-workflow-v1')
    throw new Error('Bundle workflow policy smoke returned an unexpected policy version.');
}

export async function createStableLaunchers(root: string, target: string): Promise<string[]> {
  if (!validTarget(target)) throw new Error(`Unsupported launcher target: ${target}`);
  root = await ensureRoot(root);
  const bin = await ensureDirectoryWithinRoot(root, 'bin');
  const active = path.join(root, ACTIVE);
  const node = target.startsWith('win32-') ? 'node.exe' : 'node';
  const cli = 'app/dist/src/cli.js';
  const created: string[] = [];
  if (target.startsWith('win32-')) {
    const command = path.join(bin, 'latchkit.cmd');
    await writeOwnedLauncher(
      root,
      'bin/latchkit.cmd',
      `@echo off\r\nsetlocal\r\nfor %%I in ("%~dp0..") do set "LATCHKIT_INSTALL_ROOT=%%~fI"\r\nset /p LK_CURRENT=<"%LATCHKIT_INSTALL_ROOT%\\current"\r\n"%LATCHKIT_INSTALL_ROOT%\\versions\\%LK_CURRENT%\\runtime\\${node}" "%LATCHKIT_INSTALL_ROOT%\\versions\\%LK_CURRENT%\\${cli.replaceAll('/', '\\')}" %*\r\nset "LK_EXIT=%ERRORLEVEL%"\r\nendlocal & exit /b %LK_EXIT%\r\n`,
    );
    const powershell = path.join(bin, 'latchkit.ps1');
    await writeOwnedLauncher(
      root,
      'bin/latchkit.ps1',
      `$root = Split-Path -Path $PSScriptRoot -Parent\n$env:LATCHKIT_INSTALL_ROOT = $root\n$current = (Get-Content -LiteralPath (Join-Path $root 'current') -Raw).Trim()\nif ($current -notmatch '^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?-(win32|linux|darwin)-(x64|arm64)$') { throw 'Invalid Latchkit activation pointer.' }\n& (Join-Path $root "versions/$current/runtime/${node}") (Join-Path $root "versions/$current/${cli}") @args\nexit $LASTEXITCODE\n`,
    );
    created.push(command, powershell);
  } else {
    const command = path.join(bin, 'latchkit');
    await writeOwnedLauncher(
      root,
      'bin/latchkit',
      `#!/bin/sh\nset -eu\nexport LATCHKIT_INSTALL_ROOT='${root.replaceAll("'", "'\\''")}'\ncurrent=$(cat '${active.replaceAll("'", "'\\''")}')\ncase "$current" in [0-9]*.[0-9]*.[0-9]*-*-*) ;; *) echo 'Invalid Latchkit activation pointer.' >&2; exit 1;; esac\nexec '${root.replaceAll("'", "'\\''")}/versions/'"$current"'/runtime/${node}' '${root.replaceAll("'", "'\\''")}/versions/'"$current"'/${cli}' "$@"\n`,
      0o755,
    );
    created.push(command);
  }
  return created;
}

/** Create immutable hook dispatchers. Providers bind `--version` and `--handler`; dispatch never follows `current`. */
export async function createStableHookLaunchers(
  root: string,
  target: string,
  handlers: readonly HookHandlerBinding[],
): Promise<string[]> {
  if (
    !validTarget(target) ||
    handlers.some(
      (handler) => !/^[a-z][a-z0-9-]*$/.test(handler.id) || !safeRelative(handler.relativeHandler),
    )
  )
    throw new Error('Invalid hook dispatcher binding.');
  root = await ensureRoot(root);
  const allowed = new Map(handlers.map((handler) => [handler.id, handler.relativeHandler]));
  if (allowed.size !== handlers.length) throw new Error('Duplicate hook dispatcher binding.');
  if (target.startsWith('win32-')) {
    const cases = handlers
      .map(
        (handler) =>
          `if ($handler -eq '${handler.id}') { $script = '${handler.relativeHandler.replaceAll("'", "''")}' }`,
      )
      .join('\n');
    await writeOwnedLauncher(
      root,
      'bin/latchkit-hook.ps1',
      `$version=''; $handler=''; $remaining=@(); for($i=0;$i -lt $args.Length;$i++){ if($args[$i] -eq '--version' -and $i+1 -lt $args.Length){$version=$args[++$i]} elseif($args[$i] -eq '--handler' -and $i+1 -lt $args.Length){$handler=$args[++$i]} else {$remaining += $args[$i]} }\nif($version -notmatch '^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?-(win32|linux|darwin)-(x64|arm64)$'){throw 'Invalid hook version binding.'}\n$script=$null\n${cases}\nif(-not $script){throw 'Unknown hook handler.'}\n$root=Split-Path -Path $PSScriptRoot -Parent; $env:LATCHKIT_INSTALL_ROOT=$root; & (Join-Path $root "versions/$version/runtime/node.exe") (Join-Path $root "versions/$version/$script") @remaining; exit $LASTEXITCODE\n`,
    );
    return [path.join(root, 'bin', 'latchkit-hook.ps1')];
  }
  const cases = handlers
    .map(
      (handler) => `${handler.id}) script='${handler.relativeHandler.replaceAll("'", "'\\''")}' ;;`,
    )
    .join('\n');
  await writeOwnedLauncher(
    root,
    'bin/latchkit-hook',
    `#!/bin/sh\nset -eu\nversion= handler=\nwhile [ "$#" -gt 0 ]; do case "$1" in --version) [ "$#" -ge 2 ] || exit 2; version=$2; shift 2;; --handler) [ "$#" -ge 2 ] || exit 2; handler=$2; shift 2;; *) break;; esac; done\ncase "$version" in ''|*[!A-Za-z0-9.-]*) echo 'Invalid hook version binding.' >&2; exit 2;; *-win32-x64|*-win32-arm64|*-linux-x64|*-linux-arm64|*-darwin-x64|*-darwin-arm64) ;; *) echo 'Invalid hook version binding.' >&2; exit 2;; esac\ncase "$handler" in\n${cases}\n*) echo 'Unknown hook handler.' >&2; exit 2;; esac\nexec '${root.replaceAll("'", "'\\''")}/versions/'"$version"'/runtime/node' '${root.replaceAll("'", "'\\''")}/versions/'"$version"/"$script" "$@"\n`,
    0o755,
  );
  return [path.join(root, 'bin', 'latchkit-hook')];
}

async function promoteStagedVersion(root: string, staged: string, destination: string) {
  // A just-exited private Node process or a Windows scanner can briefly retain
  // a handle in the staged directory. Retry only these bounded sharing failures.
  const delays = [50, 100, 200, 400, 800, 1000, 1000, 1000, 1000, 1000];
  for (let attempt = 0; ; attempt += 1) {
    await rejectSymlinksWithin(root, staged);
    await rejectSymlinksWithin(root, destination);
    try {
      await lstat(destination);
      throw new Error('Installation destination became occupied during activation.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(staged, destination);
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (
        process.platform !== 'win32' ||
        delay === undefined ||
        !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Verify and stage a bundle into its immutable `versions/<key>` directory.
 * Deliberately does not touch `current`, the managed launchers, or create
 * any hook dispatcher — a prepared update must not change what a new launch
 * resolves to. Must run inside `withInstallationLock`. Idempotent: retrying
 * with the same bundle content re-verifies and re-smokes an already-staged
 * directory instead of erroring or re-copying.
 */
async function stageVerifiedBundle(
  root: string,
  bundle: string,
  manifest: BundleManifest,
  target: string,
): Promise<StagedBundleRecord> {
  const key = versionKey(manifest);
  const versions = await ensureDirectoryWithinRoot(root, 'versions');
  const destination = path.join(versions, key);
  try {
    const existing = await lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error(`Installed version is invalid: ${key}`);
    await rejectSymlinksWithin(root, destination);
    const existingManifest = await verifyBundle(destination, target);
    const inventoryDigest = (files: BundleFile[]) =>
      digest(
        Buffer.from(
          JSON.stringify([...files].sort((left, right) => left.path.localeCompare(right.path))),
        ),
      );
    if (inventoryDigest(existingManifest.files) !== inventoryDigest(manifest.files))
      throw new Error(`An immutable version with different bundle content already exists: ${key}`);
    await smoke(destination, manifest.version);
    return {
      root,
      version: manifest.version,
      target,
      key,
      directory: destination,
      manifest: existingManifest,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staged = path.join(versions, `.${key}.${randomUUID()}.staging`);
  try {
    await mkdir(staged);
    const stagedInfo = await lstat(staged);
    if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink())
      throw new Error(`Refusing symlink or non-directory staging path: ${staged}`);
    await copyVerifiedBundle(bundle, staged, manifest);
    if (!target.startsWith('win32-')) await chmod(path.join(staged, 'runtime', 'node'), 0o755);
    await smoke(staged, manifest.version);
    await promoteStagedVersion(root, staged, destination);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  return { root, version: manifest.version, target, key, directory: destination, manifest };
}

/**
 * Activate an already-staged immutable version directory: (re)create the
 * managed launchers and hook dispatchers, then atomically flip `current`.
 * Must run inside `withInstallationLock`. This is the only step that changes
 * what a new launch resolves to.
 */
async function activateStagedUnlocked(
  root: string,
  key: string,
  target: string,
): Promise<InstallationInspection> {
  await createStableLaunchers(root, target);
  await createStableHookLaunchers(root, target, DEFAULT_HOOKS);
  await writeAtomic(root, ACTIVE, `${key}\n`);
  return inspectInstallation(root);
}

/**
 * Verify and stage a bundle without activating it. Exposed for the update
 * service (issue #139 slice 1): staging (download/verify/copy/smoke) and
 * activation (switching `current`) are deliberately separate operations so a
 * prepared update can be inspected, retried, or abandoned without ever
 * changing what a new launch resolves to. `installBundle` below composes
 * this with `activateStagedUnlocked` inside one lock to preserve the
 * existing combined `self install`/`self upgrade` behavior exactly.
 */
export async function stageBundle(
  request: Omit<InstallationRequest, 'command'>,
): Promise<StagedBundleRecord> {
  if (!request.bundle) throw new Error('A verified extracted bundle path is required.');
  const bundle = await canonicalLocation(request.bundle);
  const root = await ensureRoot(request.root);
  const target = request.target ?? targetOf();
  const manifest = await verifyBundle(bundle, target);
  if (request.version && request.version !== manifest.version)
    throw new Error('Requested version does not match bundle version.');
  return withInstallationLock(root, () => stageVerifiedBundle(root, bundle, manifest, target));
}

export async function installBundle(
  request: Omit<InstallationRequest, 'command'>,
): Promise<InstallationInspection> {
  if (!request.bundle) throw new Error('A verified extracted bundle path is required.');
  const bundle = await canonicalLocation(request.bundle);
  const root = await ensureRoot(request.root);
  const target = request.target ?? targetOf();
  const manifest = await verifyBundle(bundle, target);
  if (request.version && request.version !== manifest.version)
    throw new Error('Requested version does not match bundle version.');
  return withInstallationLock(root, async () => {
    const staged = await stageVerifiedBundle(root, bundle, manifest, target);
    return activateStagedUnlocked(root, staged.key, target);
  });
}

export async function rollbackInstallation(
  root: string,
  version: string,
  target = targetOf(),
): Promise<InstallationInspection> {
  const resolved = await canonicalLocation(root);
  if (!validVersion(version) || !validTarget(target))
    throw new Error('Invalid rollback version or target.');
  return withInstallationLock(resolved, async () => {
    const key = `${version}-${target}`;
    const versions = await ensureDirectoryWithinRoot(resolved, 'versions');
    const directory = path.join(versions, key);
    if (!(await lstat(directory)).isDirectory())
      throw new Error(`Installed version is unavailable: ${key}`);
    await rejectSymlinksWithin(resolved, directory);
    const manifest = await verifyBundle(directory, target);
    await smoke(directory, manifest.version);
    await createStableLaunchers(resolved, target);
    await writeAtomic(resolved, ACTIVE, `${key}\n`);
    return inspectInstallation(resolved);
  });
}

export async function uninstallInstallation(root: string): Promise<InstallationInspection> {
  const resolved = await canonicalLocation(root);
  return withInstallationLock(resolved, async () => {
    await preflightManagedRemoval(resolved, [
      ACTIVE,
      'bin/latchkit.cmd',
      'bin/latchkit.ps1',
      'bin/latchkit',
    ]);
    await rm(path.join(resolved, ACTIVE), { force: true });
    await removeOwnedLauncher(resolved, 'bin/latchkit.cmd');
    await removeOwnedLauncher(resolved, 'bin/latchkit.ps1');
    await removeOwnedLauncher(resolved, 'bin/latchkit');
    return inspectInstallation(resolved);
  });
}

export async function inspectInstallation(root: string): Promise<InstallationInspection> {
  const resolved = await canonicalLocation(root);
  const active = await readFile(path.join(resolved, ACTIVE), 'utf8')
    .then((value) => {
      const current = value.trim();
      return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?-(win32|linux|darwin)-(x64|arm64)$/.test(
        current,
      )
        ? current
        : null;
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
  const versionRoot = path.join(resolved, 'versions');
  const versions = await readdir(versionRoot, { withFileTypes: true })
    .then((items) =>
      items
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => item.name)
        .sort(),
    )
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
  const launchers = await readdir(path.join(resolved, 'bin'), { withFileTypes: true })
    .then((items) =>
      items
        .filter((item) => item.isFile())
        .map((item) => item.name)
        .sort(),
    )
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
  return {
    root: resolved,
    active,
    versions,
    launchers,
    retained: versions.filter((version) => version !== active),
  };
}

export async function runInstallationManager(
  request: InstallationRequest,
): Promise<InstallationInspection> {
  if (!request.root) throw new Error('Installation root is required.');
  if (request.command === 'inspect') return inspectInstallation(request.root);
  if (request.command === 'uninstall') return uninstallInstallation(request.root);
  if (request.command === 'rollback') {
    if (!request.version) throw new Error('Rollback requires a version.');
    return rollbackInstallation(request.root, request.version, request.target);
  }
  return installBundle(request);
}

export function defaultInstallationRoot(): string {
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'Latchkit',
    );
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'latchkit',
  );
}
