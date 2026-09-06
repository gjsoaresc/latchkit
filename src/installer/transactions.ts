import { chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { errorMessage, isRecord } from '../types.js';
import { readOptional, removeFile, safePath, statIfExists, writeAtomic } from '../storage.js';

export const JOURNAL_PATH = '.latchkit/transaction.json';
const MANIFEST_PATH = '.latchkit/manifest.json';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ResourceDescriptor {
  id: string;
  path: string;
}
export type ResourceRegistry = Map<string, Readonly<ResourceDescriptor>>;
export interface TransactionChange {
  resourceId: string;
  bytes: string | Uint8Array | null;
  mode?: number;
}
export interface TransactionInput {
  operation: string;
  registry: ResourceRegistry;
  changes: readonly TransactionChange[];
  manifest: string;
  faultBoundary?: (boundary: string, journal: TransactionJournal) => Promise<void> | void;
}
export interface SnapshotMissing {
  exists: false;
}
export interface SnapshotPresent {
  exists: true;
  bytes: string;
  sha256: string;
  mode: number;
}
export type Snapshot = SnapshotMissing | SnapshotPresent;
interface JournalManifest {
  path: typeof MANIFEST_PATH;
  before: Snapshot;
  after: Snapshot;
}
interface JournalResource {
  resourceId: string;
  path: string;
  before: Snapshot;
  after: Snapshot;
}
export interface TransactionJournal {
  schemaVersion: 1;
  transactionId: string;
  operation: string;
  createdAt: string;
  manifest: JournalManifest;
  resources: JournalResource[];
}
type ResourceState = 'before' | 'after' | 'conflict';
interface ClassifiedResource {
  entry: JournalResource;
  actual: Snapshot;
  state: ResourceState;
}
interface ClassifiedTransaction {
  manifestState: ResourceState;
  resources: ClassifiedResource[];
  conflicts: TransactionConflict[];
}
export interface TransactionConflict {
  path: string;
  reason: string;
}
export interface TransactionAction {
  action: 'restore' | 'finalize' | 'remove';
  path: string;
}
export interface TransactionInspection {
  state: 'none' | 'invalid' | 'pending' | 'committed' | 'conflict';
  transactionId?: string;
  operation?: string;
  actions: TransactionAction[];
  conflicts: TransactionConflict[];
}

const digest = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');

function validateRelativePath(relative: unknown): asserts relative is string {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative.startsWith('/') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe registered resource path: ${String(relative)}`);
  }
}

export function createResourceRegistry(
  descriptors: readonly ResourceDescriptor[],
): ResourceRegistry {
  const registry: ResourceRegistry = new Map();
  const paths = new Set<string>();
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id)
      throw new Error('Registered resources require a stable ID.');
    validateRelativePath(descriptor.path);
    if (registry.has(descriptor.id) || paths.has(descriptor.path))
      throw new Error(`Duplicate registered resource: ${descriptor.id}.`);
    registry.set(descriptor.id, Object.freeze({ id: descriptor.id, path: descriptor.path }));
    paths.add(descriptor.path);
  }
  return registry;
}

async function snapshot(root: string, relative: string): Promise<Snapshot> {
  const target = await safePath(root, relative);
  const stat = await statIfExists(target);
  if (stat === null) return { exists: false };
  const bytes = await readOptional(root, relative, null);
  if (bytes === null)
    throw new Error(`File disappeared while reading transaction state: ${relative}`);
  return {
    exists: true,
    bytes: bytes.toString('base64'),
    sha256: digest(bytes),
    mode: stat.mode & 0o777,
  };
}

function desiredSnapshot(bytes: TransactionChange['bytes'], mode: number): Snapshot {
  if (bytes === null) return { exists: false };
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { exists: true, bytes: buffer.toString('base64'), sha256: digest(buffer), mode };
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return (
    left.exists === right.exists &&
    (!left.exists ||
      (left.bytes === (right as SnapshotPresent).bytes &&
        left.sha256 === (right as SnapshotPresent).sha256))
  );
}

async function restoreSnapshot(root: string, relative: string, state: Snapshot): Promise<void> {
  if (!state.exists) {
    if (await statIfExists(await safePath(root, relative))) await removeFile(root, relative);
    return;
  }
  await writeAtomic(root, relative, Buffer.from(state.bytes, 'base64'), state.mode);
  try {
    await chmod(await safePath(root, relative), state.mode);
  } catch (error) {
    if (!['ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
}

function validSnapshot(state: unknown): state is Snapshot {
  if (!isRecord(state) || typeof state.exists !== 'boolean') return false;
  if (!state.exists) return Object.keys(state).length === 1;
  const mode = state.mode;
  if (
    Object.keys(state).length !== 4 ||
    typeof state.bytes !== 'string' ||
    typeof state.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.sha256) ||
    typeof mode !== 'number' ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o777
  )
    return false;
  try {
    return digest(Buffer.from(state.bytes, 'base64')) === state.sha256;
  } catch {
    return false;
  }
}

function validateJournal(journal: unknown, registry: ResourceRegistry): TransactionJournal {
  const fields = [
    'schemaVersion',
    'transactionId',
    'operation',
    'createdAt',
    'manifest',
    'resources',
  ];
  if (
    !isRecord(journal) ||
    Object.keys(journal).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(journal, field)) ||
    journal.schemaVersion !== 1 ||
    typeof journal.transactionId !== 'string' ||
    !UUID_PATTERN.test(journal.transactionId) ||
    typeof journal.operation !== 'string' ||
    !journal.operation ||
    typeof journal.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(journal.createdAt)) ||
    !isRecord(journal.manifest) ||
    !validSnapshot(journal.manifest.before) ||
    !validSnapshot(journal.manifest.after) ||
    Object.keys(journal.manifest).length !== 3 ||
    journal.manifest.path !== MANIFEST_PATH ||
    !Array.isArray(journal.resources)
  ) {
    throw new Error('Transaction journal is malformed. Inspect it before manual recovery.');
  }
  const ids = new Set<string>();
  for (const entry of journal.resources) {
    if (!isRecord(entry) || typeof entry.resourceId !== 'string' || typeof entry.path !== 'string')
      throw new Error('Transaction journal contains an unknown or malformed resource.');
    const registered = registry.get(entry.resourceId);
    if (
      !registered ||
      registered.path !== entry.path ||
      ids.has(entry.resourceId) ||
      Object.keys(entry).length !== 4 ||
      !validSnapshot(entry.before) ||
      !validSnapshot(entry.after)
    )
      throw new Error('Transaction journal contains an unknown or malformed resource.');
    ids.add(entry.resourceId);
  }
  return journal as unknown as TransactionJournal;
}

export async function readTransactionJournal(
  root: string,
  registry: ResourceRegistry,
): Promise<TransactionJournal | null> {
  const raw = await readOptional(root, JOURNAL_PATH);
  if (raw === null) return null;
  let journal: unknown;
  try {
    journal = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Transaction journal is not valid JSON. Inspect it before manual recovery.');
  }
  return validateJournal(journal, registry);
}

async function classify(root: string, journal: TransactionJournal): Promise<ClassifiedTransaction> {
  const manifest = await snapshot(root, MANIFEST_PATH);
  const resources: ClassifiedResource[] = [];
  for (const entry of journal.resources) {
    const actual = await snapshot(root, entry.path);
    const state: ResourceState = sameSnapshot(actual, entry.before)
      ? 'before'
      : sameSnapshot(actual, entry.after)
        ? 'after'
        : 'conflict';
    resources.push({ entry, actual, state });
  }
  const manifestState: ResourceState = sameSnapshot(manifest, journal.manifest.before)
    ? 'before'
    : sameSnapshot(manifest, journal.manifest.after)
      ? 'after'
      : 'conflict';
  const conflicts = resources
    .filter((item) => item.state === 'conflict')
    .map((item) => ({
      path: item.entry.path,
      reason: 'File differs from both recorded transaction states.',
    }));
  if (manifestState === 'conflict')
    conflicts.push({
      path: MANIFEST_PATH,
      reason: 'Manifest differs from both recorded transaction states.',
    });
  return { manifestState, resources, conflicts };
}

export async function inspectTransaction(
  root: string,
  registry: ResourceRegistry,
): Promise<TransactionInspection> {
  let journal: TransactionJournal | null;
  try {
    journal = await readTransactionJournal(root, registry);
  } catch (error) {
    return {
      state: 'invalid',
      actions: [],
      conflicts: [{ path: JOURNAL_PATH, reason: errorMessage(error) }],
    };
  }
  if (journal === null) return { state: 'none', actions: [], conflicts: [] };
  const classified = await classify(root, journal);
  const state: TransactionInspection['state'] = classified.conflicts.length
    ? 'conflict'
    : classified.manifestState === 'after'
      ? 'committed'
      : 'pending';
  const actions: TransactionAction[] =
    state === 'pending'
      ? classified.resources
          .filter((item) => item.state === 'after')
          .map((item) => ({ action: 'restore', path: item.entry.path }))
      : state === 'committed'
        ? [{ action: 'finalize', path: JOURNAL_PATH }]
        : [];
  return {
    state,
    transactionId: journal.transactionId,
    operation: journal.operation,
    actions,
    conflicts: classified.conflicts,
  };
}

export async function recoverTransaction(
  root: string,
  registry: ResourceRegistry,
): Promise<{
  state: 'none' | 'finalized' | 'rolled-back';
  transactionId?: string;
  actions: TransactionAction[];
  conflicts: TransactionConflict[];
}> {
  const journal = await readTransactionJournal(root, registry);
  if (journal === null) return { state: 'none', actions: [], conflicts: [] };
  const classified = await classify(root, journal);
  if (classified.conflicts.length)
    throw Object.assign(
      new Error('Recovery blocked by files changed outside the recorded transaction.'),
      { code: 'RECOVERY_CONFLICT', conflicts: classified.conflicts },
    );
  const actions: TransactionAction[] = [];
  if (classified.manifestState === 'before') {
    for (const item of classified.resources)
      if (item.state === 'after') {
        await restoreSnapshot(root, item.entry.path, item.entry.before);
        actions.push({ action: 'restore', path: item.entry.path });
      }
  } else if (classified.manifestState !== 'after')
    throw new Error('Recovery cannot determine whether the manifest committed.');
  await removeFile(root, JOURNAL_PATH);
  actions.push({ action: 'remove', path: JOURNAL_PATH });
  return {
    state: classified.manifestState === 'after' ? 'finalized' : 'rolled-back',
    transactionId: journal.transactionId,
    actions,
    conflicts: [],
  };
}

export async function applyRegisteredTransaction(
  root: string,
  { operation, registry, changes, manifest, faultBoundary = async () => {} }: TransactionInput,
): Promise<{ transactionId: string }> {
  if ((await readOptional(root, JOURNAL_PATH)) !== null)
    throw new Error('An interrupted transaction requires latchkit recover before mutation.');
  const resources: JournalResource[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const descriptor = registry.get(change.resourceId);
    if (!descriptor) throw new Error(`Unknown registered resource: ${change.resourceId}.`);
    if (seen.has(change.resourceId))
      throw new Error(`Duplicate transaction resource: ${change.resourceId}.`);
    seen.add(change.resourceId);
    const before = await snapshot(root, descriptor.path);
    const mode = before.exists ? before.mode : (change.mode ?? 0o600);
    resources.push({
      resourceId: descriptor.id,
      path: descriptor.path,
      before,
      after: desiredSnapshot(change.bytes, mode),
    });
  }
  const manifestBefore = await snapshot(root, MANIFEST_PATH);
  const manifestAfter = desiredSnapshot(
    Buffer.from(manifest),
    manifestBefore.exists ? manifestBefore.mode : 0o600,
  );
  const journal: TransactionJournal = {
    schemaVersion: 1,
    transactionId: randomUUID(),
    operation,
    createdAt: new Date().toISOString(),
    manifest: { path: MANIFEST_PATH, before: manifestBefore, after: manifestAfter },
    resources,
  };
  await writeAtomic(root, JOURNAL_PATH, `${JSON.stringify(journal, null, 2)}\n`);
  await faultBoundary('journal', journal);
  try {
    for (let index = 0; index < resources.length; index += 1) {
      const entry = resources[index];
      if (!entry) continue;
      const actual = await snapshot(root, entry.path);
      if (!sameSnapshot(actual, entry.before))
        throw new Error(`File changed during transaction: ${entry.path}`);
      await restoreSnapshot(root, entry.path, entry.after);
      await faultBoundary(`resource:${index}`, journal);
    }
    await restoreSnapshot(root, MANIFEST_PATH, manifestAfter);
    await faultBoundary('manifest', journal);
    await removeFile(root, JOURNAL_PATH);
    return { transactionId: journal.transactionId };
  } catch (error) {
    try {
      await recoverTransaction(root, registry);
    } catch (recoveryError) {
      throw new Error(
        `${errorMessage(error)} Recovery remains required: ${errorMessage(recoveryError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}
