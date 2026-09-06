/** Optional adapter for colbymchenry/codegraph. It never installs or configures CodeGraph. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { withProjectLock } from '../../installer/lock.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  type ResourceRegistry,
} from '../../installer/transactions.js';
import { readOptional, safePath, statIfExists } from '../../storage.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const CONFIG = '.latchkit/codegraph-v1.json';
const RECEIPT = '.codegraph/latchkit-source.sha256';
const MANIFEST = '.latchkit/manifest.json';
const MAX_QUERY = 500;
const MAX_OUTPUT = 256 * 1024;
const MAX_DIAGNOSTIC = 512;
const MAX_FILES = 2_000;
const MAX_BYTES = 32 * 1024 * 1024;
const INDEX_FILES = ['.codegraph/codegraph.db', '.codegraph/codegraph.db-wal'] as const;
const EMPTY_MANIFEST = '{"schemaVersion":3,"files":{},"packs":[],"sections":{}}\n';
const CODEGRAPH_RESOURCES = [
  { id: 'codegraph:settings', path: CONFIG },
  { id: 'codegraph:receipt', path: RECEIPT },
] as const;
export const CODEGRAPH_RESOURCE_DESCRIPTORS = CODEGRAPH_RESOURCES;
const resourceRegistry: ResourceRegistry = createResourceRegistry(CODEGRAPH_RESOURCES);

export const CODEGRAPH_CONTRACT = Object.freeze({
  upstream: 'https://github.com/colbymchenry/codegraph',
  package: '@colbymchenry/codegraph',
  version: '1.6.0',
  license: 'MIT',
  cli: ['init', 'status', 'explore', 'sync'],
  documentation: 'https://github.com/colbymchenry/codegraph#cli-reference',
});

export interface CodegraphSettings {
  schemaVersion: 1;
  enabled: boolean;
  exclusions: string[];
}

const defaults = (): CodegraphSettings => ({
  schemaVersion: 1,
  enabled: false,
  exclusions: ['.git/**', '.codegraph/**', '.latchkit/**', 'node_modules/**'],
});

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const diagnostic = (value: unknown) =>
  String(value ?? 'unknown error')
    .replace(/[\0\r\n]+/g, ' ')
    .slice(0, MAX_DIAGNOSTIC);

function validExclusion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('..') &&
    !/[\\\0\r\n]/.test(value)
  );
}

export async function readCodegraphSettings(root: string): Promise<CodegraphSettings> {
  const raw = await readOptional(root, CONFIG);
  if (raw === null) return defaults();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid CodeGraph settings.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid CodeGraph settings.');
  const item = value as Partial<CodegraphSettings>;
  if (
    item.schemaVersion !== 1 ||
    typeof item.enabled !== 'boolean' ||
    !Array.isArray(item.exclusions) ||
    !item.exclusions.every(validExclusion) ||
    Object.keys(item).length !== 3 ||
    !['schemaVersion', 'enabled', 'exclusions'].every((key) => Object.hasOwn(item, key))
  )
    throw new Error('Invalid CodeGraph settings.');
  return { schemaVersion: 1, enabled: item.enabled, exclusions: [...item.exclusions] };
}

export async function saveCodegraphSettings(
  root: string,
  settings: CodegraphSettings,
): Promise<CodegraphSettings> {
  if (!settings.exclusions.every(validExclusion)) throw new Error('Invalid CodeGraph exclusions.');
  const project = await realpath(root);
  const bytes = `${JSON.stringify(settings, null, 2)}\n`;
  await withProjectLock(project, async () => {
    const manifest = (await readOptional(project, MANIFEST)) ?? EMPTY_MANIFEST;
    await applyRegisteredTransaction(project, {
      operation: 'codegraph-settings',
      registry: resourceRegistry,
      changes: [{ resourceId: 'codegraph:settings', bytes }],
      manifest,
    });
  });
  return settings;
}

interface CodegraphCommand {
  executable: string;
  args: string[];
}

async function resolveCodegraphCommand(): Promise<CodegraphCommand | null> {
  try {
    const packageJson = require.resolve('@colbymchenry/codegraph/package.json') as string;
    const metadata = JSON.parse(await readFile(packageJson, 'utf8')) as {
      version?: unknown;
      license?: unknown;
    };
    if (metadata.version !== CODEGRAPH_CONTRACT.version || metadata.license !== 'MIT') return null;
    const shim = path.join(path.dirname(packageJson), 'npm-shim.js');
    const stat = await lstat(shim);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { executable: process.execPath, args: [shim] };
  } catch {
    return null;
  }
}

async function runCodegraph(
  cwd: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) {
  const command = await resolveCodegraphCommand();
  if (!command) throw new Error('Pinned @colbymchenry/codegraph 1.6.0 is not installed locally.');
  return run(command.executable, [...command.args, ...args], {
    cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
    env: {
      ...process.env,
      DO_NOT_TRACK: '1',
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_NO_DOWNLOAD: '1',
    },
  });
}

async function executableCapability(cwd: string): Promise<{
  status: 'ready' | 'missing' | 'unsupported';
  version?: string;
  reason?: string;
}> {
  try {
    const { stdout } = await runCodegraph(cwd, ['--version'], {
      timeout: 3_000,
      maxBuffer: 4 * 1024,
    });
    const version = stdout.trim();
    return /^\D*1\.6\.0\b/.test(version)
      ? { status: 'ready', version }
      : {
          status: 'unsupported',
          version,
          reason: 'The installed CLI reported an unsupported version.',
        };
  } catch (error) {
    return {
      status: 'missing',
      reason: diagnostic(error instanceof Error ? error.message : error),
    };
  }
}

async function sourceFingerprint(root: string, exclusions: readonly string[]): Promise<string> {
  const rows: string[] = [];
  let files = 0;
  let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/');
      if (
        exclusions.some(
          (x) =>
            rel === x.replace('/**', '') || (x.endsWith('/**') && rel.startsWith(x.slice(0, -2))),
        )
      )
        continue;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
      else if (entry.isFile()) {
        const stat = await lstat(path.join(directory, entry.name));
        if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES)
          throw new Error('CodeGraph freshness scan exceeds 2,000 files or 32 MiB.');
        rows.push(`${rel}:${digest(await readFile(path.join(directory, entry.name)))}`);
      }
    }
  }
  await walk(root);
  return digest(rows.sort().join('\n'));
}

export interface CodegraphIndexFileReceipt {
  path: string;
  exists: boolean;
  size: number;
  sha256: string | null;
}

async function readIndexRound(root: string): Promise<CodegraphIndexFileReceipt[]> {
  const files: CodegraphIndexFileReceipt[] = [];
  for (const relative of INDEX_FILES) {
    const target = await safePath(root, relative);
    const stat = await statIfExists(target);
    if (stat === null) {
      files.push({ path: relative, exists: false, size: 0, sha256: null });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Unsafe CodeGraph index path: ${relative}`);
    const bytes = await readFile(target);
    const after = await lstat(target);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error(`CodeGraph index changed while reading: ${relative}`);
    files.push({ path: relative, exists: true, size: bytes.length, sha256: digest(bytes) });
  }
  return files;
}

function sameIndexRound(
  left: readonly CodegraphIndexFileReceipt[],
  right: readonly CodegraphIndexFileReceipt[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface IndexSnapshot {
  state: 'present' | 'missing' | 'unsafe';
  digest: string | null;
  files: CodegraphIndexFileReceipt[];
  reason?: string;
}

async function indexSnapshot(root: string): Promise<IndexSnapshot> {
  try {
    let files: CodegraphIndexFileReceipt[] | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = await readIndexRound(root);
      const second = await readIndexRound(root);
      if (sameIndexRound(first, second)) {
        files = second;
        break;
      }
      if (attempt === 2) throw new Error('CodeGraph index changed while being inspected.');
    }
    if (!files) throw new Error('CodeGraph index snapshot was not captured.');
    const database = files.find((file) => file.path === INDEX_FILES[0]);
    if (!database?.exists) return { state: 'missing', digest: null, files };
    return {
      state: 'present',
      digest: digest(
        files
          .map((file) => `${file.path}:${file.exists ? `${file.size}:${file.sha256}` : 'missing'}`)
          .join('\n'),
      ),
      files,
    };
  } catch (error) {
    return {
      state: 'unsafe',
      digest: null,
      files: [],
      reason: diagnostic(error instanceof Error ? error.message : error),
    };
  }
}

interface CodegraphReceipt {
  schemaVersion: 1;
  sourceFingerprint: string;
  indexDigest: string;
  index: CodegraphIndexFileReceipt[];
}

function parseReceipt(value: string | null): CodegraphReceipt | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CodegraphReceipt>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.sourceFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.sourceFingerprint) ||
      typeof parsed.indexDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(parsed.indexDigest) ||
      !Array.isArray(parsed.index) ||
      parsed.index.length !== INDEX_FILES.length ||
      parsed.index.some(
        (item) =>
          !item ||
          typeof item.path !== 'string' ||
          !INDEX_FILES.includes(item.path as (typeof INDEX_FILES)[number]) ||
          typeof item.exists !== 'boolean' ||
          typeof item.size !== 'number' ||
          !Number.isInteger(item.size) ||
          item.size < 0 ||
          (item.exists && item.sha256 === null) ||
          (!item.exists && (item.size !== 0 || item.sha256 !== null)) ||
          (item.sha256 !== null &&
            (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))),
      )
    )
      return null;
    return parsed as CodegraphReceipt;
  } catch {
    return null;
  }
}

async function readReceipt(root: string): Promise<CodegraphReceipt | null> {
  return parseReceipt(await readOptional(root, RECEIPT).catch(() => null));
}

export async function inspectCodegraph(root: string): Promise<Record<string, unknown>> {
  const project = await realpath(root);
  const settings = await readCodegraphSettings(project);
  const executable = await executableCapability(project);
  const indexSnapshotValue = await indexSnapshot(project);
  const index = indexSnapshotValue.state;
  let fingerprint: string | null = null;
  let scanError: string | null = null;
  try {
    fingerprint = await sourceFingerprint(project, settings.exclusions);
  } catch (error) {
    scanError = error instanceof Error ? error.message : 'CodeGraph source scan failed.';
  }
  const receipt = await readReceipt(project);
  const current =
    index === 'present' &&
    typeof fingerprint === 'string' &&
    receipt?.sourceFingerprint === fingerprint &&
    receipt.indexDigest === indexSnapshotValue.digest &&
    sameIndexRound(receipt.index, indexSnapshotValue.files);
  return {
    contract: CODEGRAPH_CONTRACT,
    project,
    enabled: settings.enabled,
    exclusions: settings.exclusions,
    executable,
    index,
    freshness: scanError
      ? 'bounded-fallback'
      : index !== 'present'
        ? index
        : current
          ? 'current'
          : 'stale',
    sourceFingerprint: fingerprint,
    indexDigest: indexSnapshotValue.digest,
    indexFiles: indexSnapshotValue.files,
    receipt: receipt
      ? { sourceFingerprint: receipt.sourceFingerprint, indexDigest: receipt.indexDigest }
      : null,
    ...(scanError ? { scanError } : {}),
    ...(indexSnapshotValue.reason ? { indexError: indexSnapshotValue.reason } : {}),
    fallback:
      'ordinary bounded source search remains required when CodeGraph is disabled, missing, stale, or fails; graph output is advisory only.',
  };
}

export async function syncCodegraph(root: string): Promise<Record<string, unknown>> {
  const project = await realpath(root);
  return withProjectLock(project, async () => {
    const before = await inspectCodegraph(project);
    if (!before.enabled || (before.executable as { status?: string }).status !== 'ready')
      return { ...before, result: 'fallback', reason: 'CodeGraph is not enabled and supported.' };
    if (before.index === 'unsafe')
      return { ...before, result: 'fallback', reason: 'CodeGraph index path is unsafe.' };
    try {
      await runCodegraph(before.project as string, ['sync'], {
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT,
      });
      const after = await inspectCodegraph(project);
      if (after.sourceFingerprint !== before.sourceFingerprint)
        return { ...after, result: 'fallback', reason: 'CodeGraph source changed during sync.' };
      if (
        after.index !== 'present' ||
        after.freshness === 'bounded-fallback' ||
        typeof after.sourceFingerprint !== 'string' ||
        typeof after.indexDigest !== 'string' ||
        !Array.isArray(after.indexFiles)
      )
        return {
          ...after,
          result: 'fallback',
          reason: 'CodeGraph sync did not produce a safe bounded local index snapshot.',
        };
      const receipt: CodegraphReceipt = {
        schemaVersion: 1,
        sourceFingerprint: after.sourceFingerprint,
        indexDigest: after.indexDigest,
        index: after.indexFiles as CodegraphIndexFileReceipt[],
      };
      const current = await inspectCodegraph(project);
      if (
        current.sourceFingerprint !== receipt.sourceFingerprint ||
        current.indexDigest !== receipt.indexDigest ||
        !sameIndexRound(current.indexFiles as CodegraphIndexFileReceipt[], receipt.index)
      )
        return {
          ...current,
          result: 'fallback',
          reason: 'CodeGraph source or index changed before the sync receipt was committed.',
        };
      const manifest = (await readOptional(project, MANIFEST)) ?? EMPTY_MANIFEST;
      await applyRegisteredTransaction(project, {
        operation: 'codegraph-sync-receipt',
        registry: resourceRegistry,
        changes: [
          { resourceId: 'codegraph:receipt', bytes: `${JSON.stringify(receipt, null, 2)}\n` },
        ],
        manifest,
      });
      const result = await inspectCodegraph(project);
      return result.freshness === 'current'
        ? { ...result, result: 'synced' }
        : {
            ...result,
            result: 'fallback',
            reason: 'CodeGraph source or index changed during sync.',
          };
    } catch (error) {
      return {
        ...before,
        result: 'fallback',
        reason: `CodeGraph sync failed: ${diagnostic(error instanceof Error ? error.message : error)}`,
      };
    }
  });
}

export async function exploreCodegraph(
  root: string,
  query: string,
): Promise<Record<string, unknown>> {
  if (!query || query.length > MAX_QUERY)
    throw new Error(`--query must be 1-${MAX_QUERY} characters.`);
  const project = await realpath(root);
  const status = await inspectCodegraph(project);
  if (
    !status.enabled ||
    (status.executable as { status?: string }).status !== 'ready' ||
    status.index !== 'present' ||
    status.freshness !== 'current'
  )
    return { ...status, result: 'fallback', reason: 'CodeGraph is not ready.' };
  try {
    const result = await runCodegraph(status.project as string, ['explore', query], {
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT,
    });
    const revalidated = await inspectCodegraph(project);
    if (
      revalidated.index !== 'present' ||
      revalidated.freshness !== 'current' ||
      revalidated.sourceFingerprint !== status.sourceFingerprint ||
      revalidated.indexDigest !== status.indexDigest ||
      !sameIndexRound(
        revalidated.indexFiles as CodegraphIndexFileReceipt[],
        status.indexFiles as CodegraphIndexFileReceipt[],
      )
    )
      return {
        ...revalidated,
        result: 'fallback',
        reason: 'CodeGraph source or index changed while the query was running.',
      };
    return {
      ...revalidated,
      result: 'graph',
      output: result.stdout.slice(0, MAX_OUTPUT),
      truncated: result.stdout.length > MAX_OUTPUT,
    };
  } catch (error) {
    return {
      ...status,
      result: 'fallback',
      reason: `CodeGraph query failed: ${diagnostic(error instanceof Error ? error.message : error)}`,
    };
  }
}
