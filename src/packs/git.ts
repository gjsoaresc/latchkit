import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GitPackSource, PackSelection } from '../config/contracts.js';
import { readOptional } from '../storage.js';
import type { ResourceDescriptor } from '../installer/transactions.js';
import {
  PackContractError,
  parsePackManifest,
  type LoadedPack,
  type LoadedPackFile,
} from './index.js';

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/;
const cacheDigest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

interface CachedGitPack {
  schemaVersion: 1;
  source: GitPackSource;
  resolvedCommit: string;
  pack: unknown;
  files: Array<{ path: string; sha256: string; bytes: string }>;
}

function gitSource(selection: PackSelection): GitPackSource {
  if (selection.source.type !== 'git')
    throw new PackContractError('Expected an immutable Git pack source.', 'PACK_SOURCE_INVALID');
  return selection.source;
}

function token(source: GitPackSource): string {
  return cacheDigest(JSON.stringify(source));
}

export function gitCacheResource(selection: PackSelection): ResourceDescriptor | null {
  if (selection.source.type !== 'git') return null;
  return {
    id: `pack-cache:${token(selection.source)}`,
    path: `.latchkit/packs/git/${token(selection.source)}.json`,
  };
}

function sourcePath(source: GitPackSource, relative: string): string {
  return source.path ? `${source.path}/${relative}` : relative;
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFile('git', args, {
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PackContractError(
      `Git source could not be materialized: ${detail}`,
      'PACK_SOURCE_UNAVAILABLE',
    );
  }
}

async function gitBlob(directory: string, commit: string, filename: string): Promise<Buffer> {
  const tree = (await git(['ls-tree', '-l', commit, '--', filename], directory)).trim();
  if (!/^100(?:644|755) blob [a-f0-9]{40,64}\s+\d+\t/.test(tree))
    throw new PackContractError(
      `Git pack resource is missing, non-regular, or linked: ${filename}`,
      'PACK_FILE_INVALID',
    );
  try {
    const result = await execFile('git', ['show', `${commit}:${filename}`], {
      cwd: directory,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
    });
    return result.stdout;
  } catch (error) {
    throw new PackContractError(
      `Git pack resource could not be read: ${filename} (${error instanceof Error ? error.message : String(error)})`,
      'PACK_SOURCE_UNAVAILABLE',
    );
  }
}

async function fetchFromGit(selection: PackSelection): Promise<LoadedPack> {
  const source = gitSource(selection);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'latchkit-pack-fetch-'));
  try {
    await git(['init', '--bare', temporary]);
    await git(['fetch', '--depth=1', '--no-tags', source.repository, source.commit], temporary);
    const resolved = (await git(['rev-parse', 'FETCH_HEAD^{commit}'], temporary)).trim();
    if (resolved !== source.commit)
      throw new PackContractError(
        `Git source resolved ${resolved}, not requested immutable commit ${source.commit}.`,
        'PACK_COMMIT_MISMATCH',
      );
    const manifestBytes = await gitBlob(
      temporary,
      source.commit,
      sourcePath(source, 'latchkit-pack.json'),
    );
    let manifest;
    try {
      manifest = parsePackManifest(JSON.parse(manifestBytes.toString('utf8')) as unknown);
    } catch (error) {
      if (error instanceof PackContractError) throw error;
      throw new PackContractError(
        `Invalid Git pack manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const files: LoadedPackFile[] = [];
    for (const declared of manifest.files) {
      const bytes = await gitBlob(temporary, source.commit, sourcePath(source, declared.path));
      if (cacheDigest(bytes) !== declared.sha256)
        throw new PackContractError(`Checksum mismatch: ${declared.path}`, 'PACK_INTEGRITY_FAILED');
      files.push({ path: declared.path, bytes });
    }
    if (manifest.license !== 'MIT' || !manifest.author)
      throw new PackContractError(
        'Git packs must attest an original author and MIT license in latchkit-pack.json.',
        'PACK_LICENSE_INVALID',
      );
    return { ...manifest, source, files };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function materializeGitPack(selection: PackSelection): Promise<{
  resource: ResourceDescriptor;
  bytes: string;
  pack: LoadedPack;
}> {
  const pack = await fetchFromGit(selection);
  if (pack.id !== selection.id || pack.version !== selection.version)
    throw new PackContractError(
      `Requested pack ${selection.id}@${selection.version} does not match Git source ${pack.id}@${pack.version}.`,
      'PACK_IDENTITY_MISMATCH',
    );
  const resource = gitCacheResource(selection);
  if (!resource) throw new PackContractError('Expected Git pack source.', 'PACK_SOURCE_INVALID');
  const cached: CachedGitPack = {
    schemaVersion: 1,
    source: gitSource(selection),
    resolvedCommit: gitSource(selection).commit,
    pack: {
      schemaVersion: pack.schemaVersion,
      id: pack.id,
      version: pack.version,
      ...(pack.author === undefined ? {} : { author: pack.author }),
      ...(pack.license === undefined ? {} : { license: pack.license }),
      provenance: pack.provenance,
      compatibility: pack.compatibility,
      files: pack.files.map((file) => ({ path: file.path, sha256: cacheDigest(file.bytes) })),
    },
    files: pack.files.map((file) => ({
      path: file.path,
      sha256: cacheDigest(file.bytes),
      bytes: file.bytes.toString('base64'),
    })),
  };
  return { resource, bytes: `${JSON.stringify(cached, null, 2)}\n`, pack };
}

export async function loadMaterializedGitPack(
  root: string,
  selection: PackSelection,
): Promise<LoadedPack> {
  const source = gitSource(selection);
  const resource = gitCacheResource(selection);
  if (!resource) throw new PackContractError('Expected Git pack source.', 'PACK_SOURCE_INVALID');
  const raw = await readOptional(root, resource.path);
  if (raw === null)
    throw new PackContractError(
      `Git pack ${selection.id}@${selection.version} is unavailable locally. Run latchkit pack fetch --id ${selection.id} while ${source.repository} is reachable.`,
      'PACK_SOURCE_UNAVAILABLE',
    );
  let cached: CachedGitPack;
  try {
    cached = JSON.parse(raw) as CachedGitPack;
  } catch {
    throw new PackContractError('Git pack cache is not valid JSON.', 'PACK_CACHE_INVALID');
  }
  if (
    !cached ||
    cached.schemaVersion !== 1 ||
    JSON.stringify(cached.source) !== JSON.stringify(source) ||
    cached.resolvedCommit !== source.commit ||
    !Array.isArray(cached.files)
  )
    throw new PackContractError(
      'Git pack cache does not match the configured immutable source.',
      'PACK_CACHE_INVALID',
    );
  const manifest = parsePackManifest(cached.pack);
  if (manifest.license !== 'MIT' || !manifest.author)
    throw new PackContractError(
      'Git pack cache lacks the required original-author and MIT-license attestation.',
      'PACK_LICENSE_INVALID',
    );
  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  if (cached.files.length !== expected.size)
    throw new PackContractError(
      'Git pack cache has an unexpected resource set.',
      'PACK_CACHE_INVALID',
    );
  const files: LoadedPackFile[] = cached.files.map((file) => {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.sha256 !== 'string' ||
      typeof file.bytes !== 'string' ||
      !SHA256.test(file.sha256)
    )
      throw new PackContractError(
        'Git pack cache has an invalid resource entry.',
        'PACK_CACHE_INVALID',
      );
    const bytes = Buffer.from(file.bytes, 'base64');
    if (cacheDigest(bytes) !== file.sha256 || expected.get(file.path) !== file.sha256)
      throw new PackContractError(
        `Git pack cache integrity failed: ${file.path}`,
        'PACK_INTEGRITY_FAILED',
      );
    expected.delete(file.path);
    return { path: file.path, bytes };
  });
  return { ...manifest, source, files };
}
