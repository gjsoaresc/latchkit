import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { applyRegisteredTransaction, createResourceRegistry } from '../installer/transactions.js';
import { readOptional, statIfExists, writeAtomic } from '../storage.js';

const FCC_COMMIT = 'c9b75088b09cbd3251d1e828b710cfdcd1ff3c5a';
const FCC_VERSION = '5.22.8';
const FCC_ARCHIVE_SHA256 = '7de379974935a29a59419b96665464205ea847f010cbb5684d098edf139686df';
const STATE = 'fcc-state.json';
const ACTIVE = 'active.json';
const CONFIG = 'fcc-defaults.json';
const REGISTRY = createResourceRegistry([
  { id: 'fcc-state', path: STATE },
  { id: 'fcc-active', path: ACTIVE },
  { id: 'fcc-defaults', path: CONFIG },
]);
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? 'without a code'}`)),
    );
  });
}

export const FCC = Object.freeze({
  id: 'fcc',
  commit: FCC_COMMIT,
  version: FCC_VERSION,
  archiveSha256: FCC_ARCHIVE_SHA256,
});
export const FCC_START_ENVIRONMENT = Object.freeze({
  HOST: '127.0.0.1',
  MESSAGING_PLATFORM: 'none',
  PROXY_AUTH_ENABLED: 'true',
  FCC_DISABLE_PAID_FALLBACK: '1',
  MODEL_FALLBACKS: '',
});
export type FccState = {
  schemaVersion: 1;
  tool: 'fcc';
  version: string;
  commit: string;
  installedAt: string;
  installId: string;
  sourceArchiveSha256: string;
  python: string;
  runtimeDirectory: string;
  ownsFccHome: boolean;
  previousRuntime?: string;
};
export type FccOptions = {
  root?: string;
  home?: string;
  archive?: string;
  python?: string;
  uv?: string;
};

function defaultHome(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}
export function defaultFccRoot(home = defaultHome()): string {
  return path.join(home, 'AppData', 'Local', 'Latchkit', 'tools', 'fcc');
}
function fccHome(home: string): string {
  return path.join(home, '.fcc');
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function safeMember(name: string): boolean {
  return (
    !!name &&
    !name.includes('\\') &&
    !name.startsWith('/') &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split('/').some((part) => !part || part === '.' || part === '..')
  );
}
type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  directory: boolean;
};
function zipEntries(bytes: Buffer): ZipEntry[] {
  const min = 22;
  let end = -1;
  for (let i = bytes.length - min; i >= Math.max(0, bytes.length - 0x10016); i -= 1)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('FCC archive has no ZIP central directory.');
  const count = bytes.readUInt16LE(end + 10);
  const central = bytes.readUInt32LE(end + 16);
  if (central >= bytes.length)
    throw new Error('FCC archive central directory is outside the archive.');
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = central;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('FCC archive central directory is malformed.');
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!safeMember(name.replace(/\/$/, '')))
      throw new Error(`FCC archive contains an unsafe member: ${name}`);
    if (names.has(name)) throw new Error(`FCC archive contains duplicate member: ${name}`);
    names.add(name);
    if (![0, 8].includes(method))
      throw new Error(`FCC archive uses unsupported compression for ${name}.`);
    if (uncompressedSize > 128 * 1024 * 1024)
      throw new Error(`FCC archive member is too large: ${name}`);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      offset,
      directory: name.endsWith('/'),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!entries.length) throw new Error('FCC archive is empty.');
  return entries;
}
function zipContent(bytes: Buffer, entry: ZipEntry): Buffer {
  if (entry.offset + 30 > bytes.length || bytes.readUInt32LE(entry.offset) !== 0x04034b50)
    throw new Error(`FCC archive member header is malformed: ${entry.name}`);
  const nameLength = bytes.readUInt16LE(entry.offset + 26);
  const extraLength = bytes.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize)
    throw new Error(`FCC archive member is truncated: ${entry.name}`);
  const output = entry.method === 0 ? raw : inflateRawSync(raw);
  if (output.length !== entry.uncompressedSize)
    throw new Error(`FCC archive member size mismatch: ${entry.name}`);
  return output;
}
async function readState(root: string): Promise<FccState | null> {
  const raw = await readOptional(root, STATE);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('FCC managed state is not valid JSON.');
  }
  const state = value as Partial<FccState>;
  if (
    state.schemaVersion !== 1 ||
    state.tool !== 'fcc' ||
    state.commit !== FCC_COMMIT ||
    typeof state.runtimeDirectory !== 'string' ||
    typeof state.python !== 'string'
  )
    throw new Error('FCC managed state is malformed or belongs to another pin.');
  return state as FccState;
}
export function validateFccArchive(
  bytes: Buffer,
  expectedSha256 = FCC_ARCHIVE_SHA256,
): { members: string[] } {
  if (sha256(bytes) !== expectedSha256)
    throw new Error('FCC archive SHA-256 does not match the pinned source.');
  return { members: zipEntries(bytes).map((entry) => entry.name) };
}
async function archivePlan(archive: string): Promise<{ bytes: Buffer; entries: ZipEntry[] }> {
  const bytes = await (await import('node:fs/promises')).readFile(archive);
  validateFccArchive(bytes);
  return { bytes, entries: zipEntries(bytes) };
}
async function pythonReadiness(
  python?: string,
): Promise<{ state: 'available' | 'unavailable'; path?: string; reason?: string }> {
  if (!python)
    return {
      state: 'unavailable',
      reason:
        'Choose an explicit Python 3.14+ runtime; Latchkit will not select one automatically.',
    };
  const entry = await statIfExists(python);
  if (!entry?.isFile())
    return { state: 'unavailable', reason: 'The selected Python runtime does not exist.' };
  return { state: 'available', path: python };
}
async function uvReadiness(
  uv?: string,
): Promise<{ state: 'available' | 'unavailable'; path?: string; reason?: string }> {
  if (!uv)
    return {
      state: 'unavailable',
      reason: "Choose an explicit uv 0.11.16+ executable to apply FCC's pinned uv.lock.",
    };
  const entry = await statIfExists(uv);
  if (!entry?.isFile())
    return { state: 'unavailable', reason: 'The selected uv executable does not exist.' };
  return { state: 'available', path: uv };
}
export async function inspectFcc(options: FccOptions = {}) {
  const home = options.home ?? defaultHome();
  const root = options.root ?? defaultFccRoot(home);
  const state = await readState(root);
  const existing = await statIfExists(fccHome(home));
  const active = await readOptional(root, ACTIVE);
  return {
    tool: FCC,
    root,
    state: state ? 'managed' : existing ? 'attachable' : 'absent',
    managed: state,
    existingFccHome: existing !== null,
    active: active === null ? null : JSON.parse(active),
    python: await pythonReadiness(options.python),
    uv: await uvReadiness(options.uv),
  };
}
export async function previewFccInstall(options: FccOptions) {
  const inspected = await inspectFcc(options);
  if (!options.archive)
    return {
      ...inspected,
      action: 'blocked',
      reason: 'Provide the pinned FCC archive path to preview installation.',
    };
  const archive = await archivePlan(options.archive);
  if (inspected.state === 'managed')
    return { ...inspected, action: 'none', archiveMembers: archive.entries.length };
  if (inspected.existingFccHome)
    return {
      ...inspected,
      action: 'attach',
      archiveMembers: archive.entries.length,
      reason: 'Existing ~/.fcc is preserved and is never silently adopted.',
    };
  return {
    ...inspected,
    action: 'install',
    archiveMembers: archive.entries.length,
    python: await pythonReadiness(options.python),
    uv: await uvReadiness(options.uv),
    changes: [STATE, ACTIVE, CONFIG],
    security: {
      bind: '127.0.0.1',
      inferenceProxyAuthentication: true,
      messaging: 'disabled',
      paidFallback: 'disabled',
      credentials: 'FCC Admin UI only',
    },
  };
}
async function extractToStage(bytes: Buffer, entries: ZipEntry[], stage: string): Promise<string> {
  await mkdir(stage, { recursive: true });
  const first = entries[0]?.name.split('/')[0];
  if (!first) throw new Error('FCC archive has no root directory.');
  for (const entry of entries) {
    const relative = entry.name.replace(new RegExp(`^${first}/?`), '');
    if (!relative) continue;
    const target = path.join(stage, relative);
    if (!path.resolve(target).startsWith(`${path.resolve(stage)}${path.sep}`))
      throw new Error(`Unsafe FCC archive member: ${entry.name}`);
    if (entry.directory) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(stage, relative, zipContent(bytes, entry), 0o600);
    }
  }
  return stage;
}
export async function installFcc(options: FccOptions) {
  if (!options.archive) throw new Error('FCC installation requires a local pinned archive.');
  const preview = await previewFccInstall(options);
  if (preview.action === 'attach' || preview.action === 'none') return preview;
  const ready = await pythonReadiness(options.python);
  if (ready.state !== 'available' || !ready.path)
    throw new Error(ready.reason ?? 'An explicit Python runtime is required.');
  const uv = await uvReadiness(options.uv);
  if (uv.state !== 'available' || !uv.path)
    throw new Error(uv.reason ?? 'An explicit uv executable is required.');
  const home = options.home ?? defaultHome();
  const root = options.root ?? defaultFccRoot(home);
  const { bytes, entries } = await archivePlan(options.archive);
  await mkdir(root, { recursive: true });
  const stage = path.join(root, `.stage-${randomUUID()}`);
  const runtime = path.join(root, `runtime-${FCC_COMMIT}`);
  const previous = await readState(root);
  try {
    await extractToStage(bytes, entries, stage);
    const venv = path.join(stage, 'venv');
    await run(ready.path, ['-m', 'venv', venv], stage);
    const lock = path.join(stage, 'uv.lock');
    if (!(await statIfExists(lock))?.isFile())
      throw new Error('Pinned FCC archive is missing uv.lock.');
    await run(uv.path, ['sync', '--frozen', '--no-dev', '--active'], stage, {
      ...process.env,
      VIRTUAL_ENV: venv,
    });
    if (await statIfExists(runtime))
      throw new Error('Pinned FCC runtime path already exists; inspect it before retrying.');
    await rename(stage, runtime);
    const state: FccState = {
      schemaVersion: 1,
      tool: 'fcc',
      version: FCC_VERSION,
      commit: FCC_COMMIT,
      installedAt: new Date().toISOString(),
      installId: randomUUID(),
      sourceArchiveSha256: FCC_ARCHIVE_SHA256,
      python: ready.path,
      runtimeDirectory: path.basename(runtime),
      ownsFccHome: false,
      ...(previous ? { previousRuntime: previous.runtimeDirectory } : {}),
    };
    const active = {
      schemaVersion: 1,
      runtimeDirectory: state.runtimeDirectory,
      activatedAt: state.installedAt,
    };
    const defaults = {
      schemaVersion: 1,
      bind: '127.0.0.1',
      inferenceProxyAuthentication: true,
      messaging: false,
      paidFallback: false,
      credentialEntry: 'FCC Admin UI',
    };
    await applyRegisteredTransaction(root, {
      operation: 'install-fcc',
      registry: REGISTRY,
      changes: [
        { resourceId: 'fcc-state', bytes: `${JSON.stringify(state, null, 2)}\n` },
        { resourceId: 'fcc-active', bytes: `${JSON.stringify(active, null, 2)}\n` },
        { resourceId: 'fcc-defaults', bytes: `${JSON.stringify(defaults, null, 2)}\n` },
      ],
      manifest: `${JSON.stringify({ schemaVersion: 1, tool: 'fcc', files: [STATE, ACTIVE, CONFIG] }, null, 2)}\n`,
    });
    return { ...(await inspectFcc({ ...options, root, home })), action: 'installed' };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
function commandFor(state: FccState, root: string): string {
  return process.platform === 'win32'
    ? path.join(root, state.runtimeDirectory, 'venv', 'Scripts', 'fcc-server.exe')
    : path.join(root, state.runtimeDirectory, 'venv', 'bin', 'fcc-server');
}
export async function startFcc(options: FccOptions) {
  const home = options.home ?? defaultHome();
  const root = options.root ?? defaultFccRoot(home);
  const state = await readState(root);
  if (!state) throw new Error('FCC is not managed by Latchkit.');
  const command = commandFor(state, root);
  if (!(await statIfExists(command))) throw new Error('Managed FCC server command is missing.');
  const child = spawn(command, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...FCC_START_ENVIRONMENT,
      ANTHROPIC_AUTH_TOKEN: randomBytes(32).toString('base64url'),
    },
  });
  child.unref();
  const active = {
    schemaVersion: 1,
    runtimeDirectory: state.runtimeDirectory,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    bind: '127.0.0.1',
  };
  await applyRegisteredTransaction(root, {
    operation: 'start-fcc',
    registry: REGISTRY,
    changes: [{ resourceId: 'fcc-active', bytes: `${JSON.stringify(active, null, 2)}\n` }],
    manifest: `${JSON.stringify({ schemaVersion: 1, tool: 'fcc', files: [STATE, ACTIVE, CONFIG] }, null, 2)}\n`,
  });
  return { action: 'started', active };
}
export async function stopFcc(options: FccOptions) {
  const home = options.home ?? defaultHome();
  const root = options.root ?? defaultFccRoot(home);
  const activeRaw = await readOptional(root, ACTIVE);
  if (activeRaw === null) return { action: 'not-running' };
  const active = JSON.parse(activeRaw) as { pid?: number };
  if (Number.isInteger(active.pid) && active.pid! > 0) {
    try {
      process.kill(active.pid!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  await applyRegisteredTransaction(root, {
    operation: 'stop-fcc',
    registry: REGISTRY,
    changes: [{ resourceId: 'fcc-active', bytes: null }],
    manifest: `${JSON.stringify({ schemaVersion: 1, tool: 'fcc', files: [STATE, CONFIG] }, null, 2)}\n`,
  });
  return { action: 'stopped' };
}
export async function removeFcc(options: FccOptions) {
  const home = options.home ?? defaultHome();
  const root = options.root ?? defaultFccRoot(home);
  const state = await readState(root);
  if (!state) return { action: 'not-managed' };
  await stopFcc({ ...options, root, home });
  await applyRegisteredTransaction(root, {
    operation: 'remove-fcc',
    registry: REGISTRY,
    changes: [
      { resourceId: 'fcc-state', bytes: null },
      { resourceId: 'fcc-defaults', bytes: null },
    ],
    manifest: `${JSON.stringify({ schemaVersion: 1, tool: 'fcc', files: [] }, null, 2)}\n`,
  });
  await rm(path.join(root, state.runtimeDirectory), { recursive: true, force: true });
  return {
    action: 'removed',
    preservedFccHome: true,
    previousRuntime: state.previousRuntime ?? null,
  };
}
