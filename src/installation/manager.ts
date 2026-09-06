import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
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
  bamlVersion: '0.17.0';
  files: BundleFile[];
}
export interface InstallationInspection {
  root: string;
  active: string | null;
  versions: string[];
  launchers: string[];
  retained: string[];
}
export interface HookHandlerBinding {
  id: string;
  relativeHandler: string;
}
interface LauncherOwnership {
  schemaVersion: 1;
  files: Record<string, string>;
}

const DEFAULT_HOOKS: readonly HookHandlerBinding[] = [
  { id: 'codex', relativeHandler: 'app/dist/src/providers/codex-handler.js' },
  { id: 'claude', relativeHandler: 'app/dist/src/providers/claude-hook.js' },
  { id: 'cursor', relativeHandler: 'app/dist/src/providers/cursor-ide-hook.cjs' },
];

const ACTIVE = 'current';
const LAUNCHERS = '.launchers.json';
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

async function rejectSymlinkAncestors(location: string): Promise<void> {
  const resolved = path.resolve(location);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Refusing symlink or junction: ${current}`);
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
    candidate.bamlVersion !== '0.17.0' ||
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
    bamlVersion: '0.17.0',
    files,
  };
}

async function ensureRegular(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Bundle contains a non-regular file: ${file}`);
}

async function verifyBundle(bundle: string, target: string): Promise<BundleManifest> {
  const source = path.resolve(bundle);
  await rejectSymlinkAncestors(source);
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
    await rejectSymlinkAncestors(filename);
    await ensureRegular(filename);
    const bytes = await readFile(filename);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
      throw new Error(`Bundle integrity check failed: ${entry.path}`);
  }
  for (const required of [
    `runtime/${executable()}`,
    'app/dist/src/cli.js',
    'app/dist/src/baml_sdk/index.js',
  ]) {
    if (!manifest.files.some((entry) => entry.path === required))
      throw new Error(`Bundle is missing required runtime content: ${required}`);
  }
  return manifest;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await rejectSymlinkAncestors(path.dirname(file));
  await mkdir(path.dirname(file), { recursive: true });
  await writeDurable(path.dirname(file), path.basename(file), content);
}

async function launcherOwnership(root: string): Promise<LauncherOwnership> {
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

async function writeOwnedLauncher(
  root: string,
  relative: string,
  content: string,
  mode?: number,
): Promise<void> {
  const ownership = await launcherOwnership(root);
  const destination = path.join(root, ...relative.split('/'));
  try {
    const current = await readFile(destination);
    if (!ownership.files[relative] || digest(current) !== ownership.files[relative])
      throw new Error(`Refusing to overwrite an unowned launcher: ${relative}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeAtomic(destination, content);
  if (mode !== undefined) await chmod(destination, mode);
  ownership.files[relative] = digest(Buffer.from(content));
  await writeAtomic(path.join(root, LAUNCHERS), `${JSON.stringify(ownership, null, 2)}\n`);
}

async function removeOwnedLauncher(root: string, relative: string): Promise<void> {
  const ownership = await launcherOwnership(root);
  if (!ownership.files[relative]) return;
  const destination = path.join(root, ...relative.split('/'));
  try {
    if (digest(await readFile(destination)) !== ownership.files[relative])
      throw new Error(`Refusing to delete changed launcher: ${relative}`);
    await rm(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  delete ownership.files[relative];
  await writeAtomic(path.join(root, LAUNCHERS), `${JSON.stringify(ownership, null, 2)}\n`);
}

async function withInstallationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await rejectSymlinkAncestors(root);
  await mkdir(root, { recursive: true });
  // Reuse the challenged ownership lock inside the installation root. A PID
  // lookup failure alone cannot establish that another installer is absent.
  return withTaskStateLock(root, operation);
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
  const baml = await run(
    [
      '--input-type=module',
      '-e',
      "import {policy_version_async} from './dist/src/baml_sdk/index.js'; process.stdout.write(await policy_version_async());",
    ],
    path.join(versionDirectory, 'app'),
  );
  if (baml !== 'latchkit-workflow-v1')
    throw new Error('Bundle BAML smoke returned an unexpected policy version.');
}

export async function createStableLaunchers(root: string, target: string): Promise<string[]> {
  if (!validTarget(target)) throw new Error(`Unsupported launcher target: ${target}`);
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
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
    `#!/bin/sh\nset -eu\nversion= handler=\nwhile [ "$#" -gt 0 ]; do case "$1" in --version) [ "$#" -ge 2 ] || exit 2; version=$2; shift 2;; --handler) [ "$#" -ge 2 ] || exit 2; handler=$2; shift 2;; *) break;; esac; done\ncase "$version" in ''|*[!A-Za-z0-9.-]*) echo 'Invalid hook version binding.' >&2; exit 2;; *-win32-x64|*-win32-arm64|*-linux-x64|*-linux-arm64|*-darwin-x64|*-darwin-arm64) ;; *) echo 'Invalid hook version binding.' >&2; exit 2;; esac\ncase "$handler" in\n${cases}\n*) echo 'Unknown hook handler.' >&2; exit 2;; esac\nesac\nexec '${root.replaceAll("'", "'\\''")}/versions/'"$version"'/runtime/node' '${root.replaceAll("'", "'\\''")}/versions/'"$version"'/$script "$@"\n`,
    0o755,
  );
  return [path.join(root, 'bin', 'latchkit-hook')];
}

export async function installBundle(
  request: Omit<InstallationRequest, 'command'>,
): Promise<InstallationInspection> {
  if (!request.bundle) throw new Error('A verified extracted bundle path is required.');
  const bundle = request.bundle;
  const root = path.resolve(request.root);
  await rejectSymlinkAncestors(root);
  const target = request.target ?? targetOf();
  const manifest = await verifyBundle(bundle, target);
  if (request.version && request.version !== manifest.version)
    throw new Error('Requested version does not match bundle version.');
  return withInstallationLock(root, async () => {
    const key = versionKey(manifest);
    const versions = path.join(root, 'versions');
    const destination = path.join(versions, key);
    try {
      const existing = await lstat(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink())
        throw new Error(`Installed version is invalid: ${key}`);
      const existingManifest = await verifyBundle(destination, target);
      const inventoryDigest = (files: BundleFile[]) =>
        digest(
          Buffer.from(
            JSON.stringify([...files].sort((left, right) => left.path.localeCompare(right.path))),
          ),
        );
      if (inventoryDigest(existingManifest.files) !== inventoryDigest(manifest.files))
        throw new Error(
          `An immutable version with different bundle content already exists: ${key}`,
        );
      await smoke(destination, manifest.version);
      await createStableLaunchers(root, target);
      await createStableHookLaunchers(root, target, DEFAULT_HOOKS);
      await writeAtomic(path.join(root, ACTIVE), `${key}\n`);
      return inspectInstallation(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const staged = path.join(versions, `.${key}.${randomUUID()}.staging`);
    await mkdir(staged, { recursive: true });
    try {
      await copyVerifiedBundle(path.resolve(bundle), staged, manifest);
      if (!target.startsWith('win32-')) await chmod(path.join(staged, 'runtime', 'node'), 0o755);
      await smoke(staged, manifest.version);
      await createStableLaunchers(root, target);
      await rename(staged, destination);
      await createStableHookLaunchers(root, target, DEFAULT_HOOKS);
      await writeAtomic(path.join(root, ACTIVE), `${key}\n`);
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error;
    }
    return inspectInstallation(root);
  });
}

export async function rollbackInstallation(
  root: string,
  version: string,
  target = targetOf(),
): Promise<InstallationInspection> {
  const resolved = path.resolve(root);
  if (!validVersion(version) || !validTarget(target))
    throw new Error('Invalid rollback version or target.');
  return withInstallationLock(resolved, async () => {
    const key = `${version}-${target}`;
    const directory = path.join(resolved, 'versions', key);
    if (!(await lstat(directory)).isDirectory())
      throw new Error(`Installed version is unavailable: ${key}`);
    const manifest = await verifyBundle(directory, target);
    await smoke(directory, manifest.version);
    await createStableLaunchers(resolved, target);
    await writeAtomic(path.join(resolved, ACTIVE), `${key}\n`);
    return inspectInstallation(resolved);
  });
}

export async function uninstallInstallation(root: string): Promise<InstallationInspection> {
  const resolved = path.resolve(root);
  return withInstallationLock(resolved, async () => {
    await rm(path.join(resolved, ACTIVE), { force: true });
    await removeOwnedLauncher(resolved, 'bin/latchkit.cmd');
    await removeOwnedLauncher(resolved, 'bin/latchkit.ps1');
    await removeOwnedLauncher(resolved, 'bin/latchkit');
    return inspectInstallation(resolved);
  });
}

export async function inspectInstallation(root: string): Promise<InstallationInspection> {
  const resolved = path.resolve(root);
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
