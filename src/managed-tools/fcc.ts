import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  inspectTransaction,
  recoverTransaction,
} from '../installer/transactions.js';
import { readOptional, safePath, statIfExists } from '../storage.js';
import { isRecord } from '../types.js';
import { FCC, digest, parseFccArchive } from './fcc-archive.js';
import type { ArchiveMember } from './fcc-archive.js';
import {
  controllerStatus,
  launchController,
  localRequest,
  runBounded,
  stopController,
  systemEnvironment,
} from './fcc-process.js';
import type { ControllerRecord } from './fcc-process.js';

export { FCC, validateFccArchive } from './fcc-archive.js';
const STATE = 'fcc-state.json';
const ACTIVE = 'active.json';
const LIFECYCLE = 'fcc-lifecycle.json';
const PROFILE = 'fcc-profile.json';
const RECEIPT = 'fcc-runtime-files.json';
const CONFIG = 'profile/.fcc/.env';
const ADMIN_ASSETS = [
  'admin.css',
  'admin.js',
  'app-icon.svg',
  'chat_sessions.css',
  'chat_sessions.js',
  'model_combobox.js',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REGISTRY = createResourceRegistry(
  [STATE, ACTIVE, LIFECYCLE, PROFILE, RECEIPT, CONFIG].map((name) => ({ id: name, path: name })),
);

// Verified against the source pin's settings.py and loader.py. There is no
// FCC_DISABLE_PAID_FALLBACK setting; empty MODEL_FALLBACKS disables fallbacks.
export const FCC_START_ENVIRONMENT = Object.freeze({
  HOST: '127.0.0.1',
  PORT: '8082',
  MESSAGING_PLATFORM: 'none',
  PROXY_AUTH_ENABLED: 'true',
  FCC_OPEN_BROWSER: 'false',
  MODEL_FALLBACKS: '',
  MODEL_FABLE: '',
  MODEL_OPUS: '',
  MODEL_SONNET: '',
  MODEL_HAIKU: '',
});
export type FccState = {
  schemaVersion: 2;
  tool: 'fcc';
  version: string;
  commit: string;
  installedAt: string;
  installId: string;
  sourceArchiveSha256: string;
  python: string;
  pythonVersion: string;
  uvVersion: string;
  runtimeDirectory: string;
  profileDirectory: 'profile';
  ownsFccHome: false;
};
export type FccOptions = {
  root?: string;
  home?: string;
  archive?: string;
  python?: string;
  uv?: string;
};
// A code-only seam for deterministic installer execution tests. HTTP and CLI
// accept FccOptions only and cannot supply executable implementations.
type InstallRuntime = {
  run: typeof runBounded;
  archive: (archive: string) => Promise<ArchiveMember[]>;
};
type Lifecycle = {
  schemaVersion: 2;
  installId: string;
  runtimeDirectory: string;
  phase: 'building' | 'failed' | 'abandoned';
  createdAt: string;
};
type OwnershipManifest = { schemaVersion: 2; tool: 'fcc'; resources: Record<string, string> };

function defaultHome(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}
export function defaultFccRoot(home = defaultHome()): string {
  return path.join(home, '.local', 'share', 'latchkit-tools', 'fcc');
}
function resolveOptions(options: FccOptions) {
  const home = path.resolve(options.home ?? defaultHome());
  return { home, root: path.resolve(options.root ?? defaultFccRoot(home)) };
}
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const runtimeName = (installId: string): string => `runtime-${FCC.commit}-${installId}`;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

async function checkRoot(root: string): Promise<void> {
  let current = path.parse(root).root;
  let existing = current;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await statIfExists(current);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
      throw new Error('FCC tool root contains a symlink, junction or non-directory.');
    if (stat) existing = current;
  }
  const canonical = await realpath(existing);
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (normalize(canonical) !== normalize(existing))
    throw new Error(
      'FCC tool root resolves to another location, including Windows package virtualization. Choose a short canonical home-local tool root.',
    );
}
async function ownedManifest(root: string): Promise<OwnershipManifest> {
  const raw = await readOptional(root, '.latchkit/manifest.json');
  if (raw === null) {
    for (const name of [STATE, ACTIVE, LIFECYCLE, PROFILE, RECEIPT])
      if ((await readOptional(root, name)) !== null)
        throw new Error(
          `FCC has unowned managed records (${name}); preserve and inspect them before installation.`,
        );
    return { schemaVersion: 2, tool: 'fcc', resources: {} };
  }
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.tool !== 'fcc' ||
    !isRecord(value.resources)
  )
    throw new Error('FCC ownership manifest is unsupported; no files were changed.');
  for (const [name, hash] of Object.entries(value.resources)) {
    if (
      !REGISTRY.has(name) ||
      name === CONFIG ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error('FCC ownership manifest is malformed.');
    const bytes = await readOptional(root, name, null);
    if (bytes === null || digest(bytes) !== hash)
      throw new Error(
        `FCC managed record was edited or removed: ${name}. Preserve it and inspect recovery.`,
      );
  }
  for (const name of [STATE, ACTIVE, LIFECYCLE, PROFILE, RECEIPT])
    if (!(name in value.resources) && (await readOptional(root, name)) !== null)
      throw new Error(`FCC record is not owned: ${name}.`);
  return value as OwnershipManifest;
}
async function changeRecords(
  root: string,
  operation: string,
  changes: { resourceId: string; bytes: string | null }[],
): Promise<void> {
  const manifest = await ownedManifest(root);
  for (const change of changes) {
    if (change.resourceId === CONFIG) continue; // FCC owns configuration after initial creation.
    if (change.bytes === null) delete manifest.resources[change.resourceId];
    else manifest.resources[change.resourceId] = digest(Buffer.from(change.bytes));
  }
  await applyRegisteredTransaction(root, {
    operation,
    registry: REGISTRY,
    changes,
    manifest: json(manifest),
  });
}
async function assertMutable(root: string): Promise<void> {
  await checkRoot(root);
  if ((await inspectTransaction(root, REGISTRY)).state !== 'none')
    throw new Error(
      'FCC has an interrupted transaction; run latchkit tool fcc recover before mutation.',
    );
  await ownedManifest(root);
}
async function withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await checkRoot(root);
  await mkdir(root, { recursive: true });
  const lockPath = await safePath(root, '.fcc-operation.lock');
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        'FCC operation lock exists. Another operation may be running; inspect the lock before manually removing a stale lock.',
      );
    throw error;
  }
  await handle.writeFile(json({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath);
  }
}
async function readState(root: string): Promise<FccState | null> {
  const raw = await readOptional(root, STATE);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.tool !== 'fcc' ||
    value.version !== FCC.version ||
    value.commit !== FCC.commit ||
    value.sourceArchiveSha256 !== FCC.archiveSha256 ||
    typeof value.installId !== 'string' ||
    !UUID.test(value.installId) ||
    value.runtimeDirectory !== runtimeName(value.installId) ||
    value.profileDirectory !== 'profile' ||
    value.ownsFccHome !== false ||
    typeof value.python !== 'string' ||
    !path.isAbsolute(value.python) ||
    typeof value.pythonVersion !== 'string' ||
    typeof value.uvVersion !== 'string' ||
    !timestamp(value.installedAt)
  )
    throw new Error('FCC managed state is malformed or belongs to an unsupported pin.');
  await safePath(root, value.runtimeDirectory as string, 'directory');
  await safePath(root, 'profile', 'directory');
  return value as FccState;
}
async function readLifecycle(root: string): Promise<Lifecycle | null> {
  const raw = await readOptional(root, LIFECYCLE);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.installId !== 'string' ||
    !UUID.test(value.installId) ||
    value.runtimeDirectory !== runtimeName(value.installId) ||
    !['building', 'failed', 'abandoned'].includes(String(value.phase)) ||
    !timestamp(value.createdAt)
  )
    throw new Error('FCC lifecycle record is malformed.');
  return value as Lifecycle;
}
async function readActive(root: string): Promise<ControllerRecord | null> {
  const raw = await readOptional(root, ACTIVE);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.installId !== 'string' ||
    !UUID.test(value.installId) ||
    typeof value.controlToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.controlToken) ||
    !Number.isInteger(value.controlPort) ||
    Number(value.controlPort) < 1 ||
    Number(value.controlPort) > 65535 ||
    value.port !== 8082 ||
    !Number.isInteger(value.controllerPid) ||
    Number(value.controllerPid) < 1 ||
    !timestamp(value.startedAt)
  )
    throw new Error('FCC active record is malformed; no process was signalled.');
  return value as ControllerRecord;
}
async function readiness(
  executable: string | undefined,
  kind: 'python' | 'uv',
  runner = runBounded,
) {
  if (!executable || !path.isAbsolute(executable) || !(await statIfExists(executable))?.isFile())
    return {
      state: 'unavailable',
      reason: `Choose an explicit absolute ${kind === 'python' ? 'Python 3.14+' : 'uv 0.11.16+'} executable.`,
    };
  try {
    const output = await runner(
      executable,
      kind === 'python'
        ? ['-I', '-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))']
        : ['--version'],
      path.dirname(executable),
      systemEnvironment(),
    );
    const version = (
      kind === 'python' ? /^(\d+)\.(\d+)\.(\d+)$/ : /^uv (\d+)\.(\d+)\.(\d+)(?: |$)/
    ).exec(output);
    if (
      !version ||
      (kind === 'python'
        ? Number(version[1]) !== 3 || Number(version[2]) < 14
        : Number(version[1]) === 0 &&
          (Number(version[2]) < 11 || (Number(version[2]) === 11 && Number(version[3]) < 16)))
    )
      throw new Error('version');
    return { state: 'available', path: executable, version: version.slice(1, 4).join('.') };
  } catch {
    return {
      state: 'unavailable',
      reason: `The selected ${kind} executable did not report a supported version.`,
    };
  }
}
async function archivePlan(archive: string) {
  const stat = await lstat(archive);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
    throw new Error('FCC requires a regular local archive within its size limit.');
  return parseFccArchive(await readFile(archive));
}
function publicActive(active: ControllerRecord, running: boolean) {
  return {
    state: running ? 'running' : 'unverified',
    installId: active.installId,
    startedAt: active.startedAt,
    bind: '127.0.0.1',
    url: `http://127.0.0.1:${active.port}`,
    adminUrl: `http://127.0.0.1:${active.port}/admin`,
  };
}
export async function inspectFcc(options: FccOptions = {}, runner = runBounded) {
  const { root, home } = resolveOptions(options);
  await checkRoot(root);
  const transaction = await inspectTransaction(root, REGISTRY);
  await ownedManifest(root);
  const state = await readState(root);
  const active = await readActive(root);
  const lifecycle = await readLifecycle(root);
  return {
    tool: FCC,
    root,
    state: state ? 'managed' : 'absent',
    managed: state,
    existingFccHome: (await statIfExists(path.join(home, '.fcc'))) !== null,
    profile: path.join(root, 'profile', '.fcc'),
    active: active ? publicActive(active, await controllerStatus(active)) : null,
    lifecycle,
    transaction,
    python: await readiness(options.python, 'python', runner),
    uv: await readiness(options.uv, 'uv', runner),
    capabilities: {
      install: 'available',
      start: 'authenticated controller',
      stop: 'owned controller only',
      update: 'unsupported: one audited pin',
      attach: 'unsupported: existing FCC stays independent',
      removal: 'deregistration; runtime and profile retained',
      providerVerification: 'not performed',
    },
  };
}
export async function previewFccInstall(
  options: FccOptions,
  runtime: InstallRuntime = { run: runBounded, archive: archivePlan },
) {
  const inspected = await inspectFcc(options, runtime.run);
  if (inspected.managed)
    return {
      ...inspected,
      action: 'none',
      reason: 'The audited pin is already installed; automatic updates are unsupported.',
    };
  if (
    inspected.transaction.state !== 'none' ||
    (inspected.lifecycle && inspected.lifecycle.phase !== 'abandoned')
  )
    return {
      ...inspected,
      action: 'blocked',
      reason:
        'Recover the interrupted installation first; incomplete runtime files will be retained.',
    };
  if (!options.archive)
    return {
      ...inspected,
      action: 'blocked',
      reason: 'Provide the local pinned FCC archive path.',
    };
  const archive = await runtime.archive(options.archive);
  if (inspected.python.state !== 'available' || inspected.uv.state !== 'available')
    return {
      ...inspected,
      action: 'blocked',
      reason: 'Explicit supported Python and uv executables are required.',
      archiveMembers: archive.length,
    };
  return {
    ...inspected,
    action: 'install',
    archiveMembers: archive.length,
    changes: [STATE, LIFECYCLE, PROFILE, RECEIPT, 'unique runtime directory', CONFIG],
    security: {
      bind: '127.0.0.1',
      inferenceProxyAuthentication: true,
      messaging: 'disabled',
      automaticFallbacks: 'disabled',
      credentials: 'private FCC Admin UI',
      profile: 'private; existing user FCC data is preserved',
    },
  };
}
function runtimePython(root: string, state: Pick<FccState, 'runtimeDirectory'>): string {
  return path.join(
    root,
    state.runtimeDirectory,
    'venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
}
function processEnvironment(root: string): NodeJS.ProcessEnv {
  const profile = path.join(root, 'profile');
  return {
    ...systemEnvironment(),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    PYTHONDONTWRITEBYTECODE: '1',
    ...FCC_START_ENVIRONMENT,
  };
}
async function inventory(root: string, directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const queue = [directory];
  let total = 0;
  let count = 0;
  while (queue.length) {
    const parent = queue.shift()!;
    for (const entry of await readdir(await safePath(root, parent, 'directory'), {
      withFileTypes: true,
    })) {
      const relative = `${parent}/${entry.name}`;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error(`FCC runtime contains an unsupported link or special file: ${relative}`);
      if (entry.isDirectory()) queue.push(relative);
      else {
        const file = await safePath(root, relative);
        const stat = await lstat(file);
        total += stat.size;
        count += 1;
        if (stat.size > 256 * 1024 * 1024 || total > 2 * 1024 * 1024 * 1024 || count > 50_000)
          throw new Error(
            'FCC runtime exceeds its inspection size limits; all files were preserved.',
          );
        result[relative] = digest(await readFile(file));
      }
    }
  }
  return result;
}
async function verifyRuntime(root: string, state: FccState): Promise<void> {
  const raw = await readOptional(root, RECEIPT);
  const expected: unknown = raw === null ? null : JSON.parse(raw);
  if (!isRecord(expected) || !isRecord(expected.files) || expected.installId !== state.installId)
    throw new Error('FCC runtime receipt is missing or malformed.');
  const files = expected.files;
  const actual = await inventory(root, state.runtimeDirectory);
  if (
    Object.keys(actual).length !== Object.keys(files).length ||
    Object.entries(actual).some(([name, hash]) => files[name] !== hash)
  )
    throw new Error(
      'FCC runtime files were edited, added or removed; launch is blocked and all files are preserved.',
    );
}
export async function installFcc(
  options: FccOptions,
  installer: InstallRuntime = { run: runBounded, archive: archivePlan },
) {
  const { root, home } = resolveOptions(options);
  return withLock(root, async () => {
    await assertMutable(root);
    const preview = await previewFccInstall(options, installer);
    if (preview.action === 'none') return preview;
    if (preview.action !== 'install' || !options.archive)
      throw new Error('reason' in preview ? preview.reason : 'FCC installation is blocked.');
    const python = await readiness(options.python, 'python', installer.run);
    const uv = await readiness(options.uv, 'uv', installer.run);
    if (!python.path || !python.version || !uv.path || !uv.version)
      throw new Error('FCC prerequisite verification failed.');
    const members = await installer.archive(options.archive);
    if (!members.some((member) => member.name === 'uv.lock'))
      throw new Error('FCC archive is missing uv.lock.');
    const installId = randomUUID();
    const runtimeDirectory = runtimeName(installId);
    const runtime = await safePath(root, runtimeDirectory, 'directory');
    if (await statIfExists(runtime)) throw new Error('FCC runtime directory already exists.');
    const lifecycle: Lifecycle = {
      schemaVersion: 2,
      installId,
      runtimeDirectory,
      phase: 'building',
      createdAt: new Date().toISOString(),
    };
    // Register intent before source materialization or any external package work.
    // Runtime trees never move after a venv exists and are never recursively deleted.
    await changeRecords(root, 'prepare-fcc-runtime', [
      { resourceId: LIFECYCLE, bytes: json(lifecycle) },
    ]);
    try {
      const sourceRegistry = createResourceRegistry(
        members.map((member) => ({ id: member.name, path: `${runtimeDirectory}/${member.name}` })),
      );
      await applyRegisteredTransaction(root, {
        operation: 'materialize-fcc-source',
        registry: sourceRegistry,
        changes: members.map((member) => ({ resourceId: member.name, bytes: member.bytes })),
        manifest: (await readOptional(root, '.latchkit/manifest.json'))!,
      });
      const venv = path.join(runtime, 'venv');
      const installEnv = {
        ...systemEnvironment(),
        UV_PROJECT_ENVIRONMENT: venv,
        UV_CACHE_DIR: path.join(root, 'cache'),
        UV_PYTHON_DOWNLOADS: 'never',
        UV_NO_PROGRESS: '1',
      };
      await installer.run(
        uv.path,
        [
          'sync',
          '--frozen',
          '--no-dev',
          '--no-editable',
          '--no-config',
          '--link-mode',
          'copy',
          '--no-managed-python',
          '--no-python-downloads',
          '--python',
          python.path,
        ],
        runtime,
        installEnv,
        600_000,
      );
      const installedPython = runtimePython(root, { runtimeDirectory });
      const actualVersion = await installer.run(
        installedPython,
        [
          '-I',
          '-B',
          '-c',
          `from importlib.metadata import version; from free_claude_code.api.admin_routes import _asset_path; [_asset_path(name) for name in ${JSON.stringify(ADMIN_ASSETS)}]; print(version("free-claude-code"))`,
        ],
        runtime,
        processEnvironment(root),
      );
      if (actualVersion !== FCC.version)
        throw new Error('Installed FCC package version does not match the audited pin.');
      const receipt = {
        schemaVersion: 2,
        installId,
        files: await inventory(root, runtimeDirectory),
      };
      const state: FccState = {
        schemaVersion: 2,
        tool: 'fcc',
        version: FCC.version,
        commit: FCC.commit,
        installedAt: new Date().toISOString(),
        installId,
        sourceArchiveSha256: FCC.archiveSha256,
        python: python.path,
        pythonVersion: python.version,
        uvVersion: uv.version,
        runtimeDirectory,
        profileDirectory: 'profile',
        ownsFccHome: false,
      };
      const profile = await readOptional(root, PROFILE);
      const profileChanges = [];
      if (profile === null) {
        if (await statIfExists(path.join(root, 'profile')))
          throw new Error(
            'FCC private profile already exists without an ownership marker; it was preserved.',
          );
        const token = randomBytes(32).toString('hex');
        profileChanges.push(
          {
            resourceId: CONFIG,
            bytes: `FCC_CONFIG_SCHEMA=1\nANTHROPIC_AUTH_TOKEN=${token}\nPROXY_AUTH_ENABLED=true\nMODEL=nvidia_nim/nvidia/nemotron-3-super-120b-a12b\nMESSAGING_PLATFORM=none\n`,
          },
          {
            resourceId: PROFILE,
            bytes: json({
              schemaVersion: 2,
              profileDirectory: 'profile',
              createdAt: state.installedAt,
            }),
          },
        );
      }
      await changeRecords(root, 'activate-fcc-runtime', [
        ...profileChanges,
        { resourceId: STATE, bytes: json(state) },
        { resourceId: RECEIPT, bytes: json(receipt) },
        { resourceId: LIFECYCLE, bytes: null },
      ]);
      return {
        ...(await inspectFcc({ ...options, root, home }, installer.run)),
        action: 'installed',
      };
    } catch (error) {
      if ((await inspectTransaction(root, REGISTRY)).state === 'none')
        await changeRecords(root, 'record-fcc-install-failure', [
          { resourceId: LIFECYCLE, bytes: json({ ...lifecycle, phase: 'failed' }) },
        ]);
      throw new Error(
        `FCC installation did not activate. Runtime files were retained at ${runtime}; run latchkit tool fcc recover before retrying. ${error instanceof Error ? error.message : 'Installation failed.'}`,
      );
    }
  });
}

// Original adapter to the pinned public ServerSupervisor API. EOF also handles
// unexpected controller termination and Windows venv launcher indirection.
const SERVER_SCRIPT = [
  'import sys, threading',
  'from free_claude_code.cli.commands import ServerSupervisor',
  'server = ServerSupervisor(console_logging=False)',
  'def watch_owner():',
  '    sys.stdin.readline()',
  '    server.request_stop()',
  'threading.Thread(target=watch_owner, daemon=True).start()',
  'server.run(open_admin_browser=False)',
].join('\n');

export async function startFcc(options: FccOptions) {
  const { root } = resolveOptions(options);
  return withLock(root, async () => {
    await assertMutable(root);
    const state = await readState(root);
    if (!state) throw new Error('FCC is not managed by Latchkit.');
    const previous = await readActive(root);
    if (previous) {
      if (previous.installId !== state.installId)
        throw new Error('FCC active record does not match this installation.');
      if (await controllerStatus(previous))
        return { action: 'already-running', active: publicActive(previous, true) };
      throw new Error(
        'FCC has an unverified active record; run latchkit tool fcc recover. No process was signalled.',
      );
    }
    await verifyRuntime(root, state);
    const env = processEnvironment(root);
    await safePath(root, CONFIG);
    const python = runtimePython(root, state);
    const token = await runBounded(
      python,
      [
        '-I',
        '-B',
        '-c',
        'from free_claude_code.config.loader import get_settings; print(get_settings().proxy_auth_token)',
      ],
      path.join(root, state.runtimeDirectory),
      env,
    );
    if (!token || token.length > 4096 || /[\r\n]/.test(token))
      throw new Error('FCC private proxy token is unavailable or malformed.');
    const launched = await launchController({
      command: python,
      args: ['-I', '-B', '-c', SERVER_SCRIPT],
      cwd: path.join(root, state.runtimeDirectory),
      env,
      proxyToken: token,
      port: 8082,
      timeoutMs: 45_000,
      installId: state.installId,
      requiredAssets: ADMIN_ASSETS.map((name) => `/admin/assets/${FCC.version}/${name}`),
    });
    try {
      await changeRecords(root, 'start-fcc', [
        { resourceId: ACTIVE, bytes: json(launched.record) },
      ]);
      await launched.commit();
    } catch (error) {
      await launched.abort();
      throw error;
    }
    return { action: 'started', active: publicActive(launched.record, true) };
  });
}
async function stopOwned(root: string) {
  const active = await readActive(root);
  if (!active) return { action: 'not-running' };
  const state = await readState(root);
  if (!state || active.installId !== state.installId)
    throw new Error('FCC active record does not match the installation; no process was signalled.');
  await stopController(active);
  await changeRecords(root, 'stop-fcc', [{ resourceId: ACTIVE, bytes: null }]);
  return { action: 'stopped' };
}
export async function stopFcc(options: FccOptions) {
  const { root } = resolveOptions(options);
  return withLock(root, async () => {
    await assertMutable(root);
    return stopOwned(root);
  });
}

/** Internal invocation bridge. Never serialize this callback's environment.
 * The caller retains the installed Claude executable, arguments, permissions,
 * approvals and bounded process runner. This helper changes only the child
 * Anthropic connection environment after proving the owned proxy is ready.
 */
export async function runWithFccClaudeEnvironment<T>(
  options: FccOptions,
  invoke: (environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const { root } = resolveOptions(options);
  await assertMutable(root);
  const state = await readState(root);
  const active = await readActive(root);
  if (
    !state ||
    !active ||
    active.installId !== state.installId ||
    !(await controllerStatus(active))
  )
    throw new Error(
      'An authenticated owned FCC controller must be running before client invocation.',
    );
  await verifyRuntime(root, state);
  await safePath(root, CONFIG);
  const token = await runBounded(
    runtimePython(root, state),
    [
      '-I',
      '-B',
      '-c',
      'from free_claude_code.config.loader import get_settings; print(get_settings().proxy_auth_token)',
    ],
    path.join(root, state.runtimeDirectory),
    processEnvironment(root),
  );
  if (!token || token.length > 4096 || /[\r\n]/.test(token))
    throw new Error('FCC proxy token is malformed.');
  const authorized = await localRequest(active.port, '/v1/messages', 'HEAD', {
    authorization: `Bearer ${token}`,
  });
  const anonymous = await localRequest(active.port, '/v1/messages', 'HEAD');
  if (authorized.status < 200 || authorized.status >= 300 || anonymous.status !== 401)
    throw new Error('FCC authenticated client readiness failed; no client was invoked.');
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('ANTHROPIC_')),
  );
  const bypass = [
    ...new Set(
      `${environment.NO_PROXY ?? ''},${environment.no_proxy ?? ''},127.0.0.1,localhost,::1`
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].join(',');
  return invoke({
    ...environment,
    NO_PROXY: bypass,
    no_proxy: bypass,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${active.port}`,
    ANTHROPIC_AUTH_TOKEN: token,
  });
}

export async function removeFcc(options: FccOptions) {
  const { root } = resolveOptions(options);
  return withLock(root, async () => {
    await assertMutable(root);
    const state = await readState(root);
    if (!state) return { action: 'not-managed' };
    await stopOwned(root);
    await changeRecords(root, 'deregister-fcc', [
      { resourceId: STATE, bytes: null },
      { resourceId: RECEIPT, bytes: null },
    ]);
    return {
      action: 'deregistered',
      preservedFccHome: true,
      preservedProfile: path.join(root, 'profile'),
      preservedRuntime: path.join(root, state.runtimeDirectory),
      reason:
        'Runtime and profile files are retained, including local edits and credentials. No recursive cleanup is performed.',
    };
  });
}
export async function recoverFcc(options: FccOptions) {
  const { root } = resolveOptions(options);
  return withLock(root, async () => {
    // Derive source recovery registrations only from the hash-verified pin and
    // validated lifecycle identity, never from paths supplied by the journal.
    const transaction = await inspectTransaction(root, REGISTRY);
    if (transaction.state === 'invalid') {
      const lifecycle = await readLifecycle(root);
      if (!lifecycle || !options.archive)
        throw new Error(
          'FCC source recovery requires the same pinned archive; runtime files remain preserved.',
        );
      const members = await archivePlan(options.archive);
      const registry = createResourceRegistry(
        members.map((member) => ({
          id: member.name,
          path: `${lifecycle.runtimeDirectory}/${member.name}`,
        })),
      );
      await recoverTransaction(root, registry);
    } else await recoverTransaction(root, REGISTRY);
    await ownedManifest(root);
    const active = await readActive(root);
    if (active) {
      if (await controllerStatus(active))
        return { action: 'running', active: publicActive(active, true) };
      try {
        process.kill(active.controllerPid, 0);
        throw new Error(
          'FCC controller PID still exists but ownership could not be proved. Preserve the active record and inspect the process manually.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await changeRecords(root, 'recover-fcc-stale-controller', [
        { resourceId: ACTIVE, bytes: null },
      ]);
    }
    const lifecycle = await readLifecycle(root);
    if (lifecycle && lifecycle.phase !== 'abandoned')
      await changeRecords(root, 'abandon-fcc-incomplete-runtime', [
        { resourceId: LIFECYCLE, bytes: json({ ...lifecycle, phase: 'abandoned' }) },
      ]);
    return {
      action: 'recovered',
      preservedRuntime: lifecycle ? path.join(root, lifecycle.runtimeDirectory) : null,
      reason:
        'Incomplete runtime files are retained. Installation may be retried in a new directory.',
    };
  });
}
