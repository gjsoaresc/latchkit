import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PackSelection } from '../config/contracts.js';
import { errorMessage, isRecord } from '../types.js';

const bundledRoot = fileURLToPath(new URL('../../skills/', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const reservedWindows = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface PackFile {
  path: string;
  sha256: string;
}
export interface PackCompatibility {
  configSchemaVersions: number[];
  providers: string[];
}
export interface PackManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  author?: string;
  license?: 'MIT';
  provenance: string;
  compatibility: PackCompatibility;
  files: PackFile[];
}
export interface LoadedPackFile {
  path: string;
  bytes: Buffer;
}
export interface LoadedPack extends Omit<PackManifest, 'files'> {
  source: PackSelection['source'];
  files: LoadedPackFile[];
}

export class PackContractError extends Error {
  readonly code: string;
  constructor(message: string, code = 'PACK_INVALID') {
    super(message);
    this.name = 'PackContractError';
    this.code = code;
  }
}

function safePart(part: string): boolean {
  return (
    part !== '' &&
    part !== '.' &&
    part !== '..' &&
    !reservedWindows.test(part) &&
    !/[<>:"|?*\\]/.test(part) &&
    ![...part].some((character) => (character.codePointAt(0) ?? 0) < 32)
  );
}

export function validatePackPath(relative: unknown): string {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative !== relative.normalize('NFC') ||
    relative.split('/').some((part) => !safePart(part))
  )
    throw new PackContractError(`Unsafe pack file path: ${String(relative)}`, 'PACK_PATH_INVALID');
  return relative;
}

export function parsePackManifest(value: unknown): PackManifest {
  if (!isRecord(value)) throw new PackContractError('Pack manifest must be an object.');
  const expected = new Set([
    'schemaVersion',
    'id',
    'version',
    'author',
    'license',
    'provenance',
    'compatibility',
    'files',
  ]);
  for (const key of Object.keys(value))
    if (!expected.has(key)) throw new PackContractError(`Unknown pack manifest field: ${key}`);
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== 'string' ||
    !ID.test(value.id) ||
    typeof value.version !== 'string' ||
    !VERSION.test(value.version)
  )
    throw new PackContractError(
      'Pack manifest requires schemaVersion 1, a portable ID, and a semantic version.',
    );
  if (typeof value.provenance !== 'string' || !value.provenance.trim())
    throw new PackContractError('Pack manifest requires provenance text.');
  if (value.author !== undefined && (typeof value.author !== 'string' || !value.author.trim()))
    throw new PackContractError('Pack author must be non-empty text when declared.');
  if (value.license !== undefined && value.license !== 'MIT')
    throw new PackContractError(
      'Only original or MIT-compatible packs may declare license MIT.',
      'PACK_LICENSE_INVALID',
    );
  if (!isRecord(value.compatibility))
    throw new PackContractError('Pack manifest requires a compatibility object.');
  const { configSchemaVersions, providers } = value.compatibility;
  if (
    !Array.isArray(configSchemaVersions) ||
    !configSchemaVersions.every(
      (version) => typeof version === 'number' && Number.isInteger(version),
    ) ||
    !Array.isArray(providers) ||
    !providers.every((id) => typeof id === 'string')
  )
    throw new PackContractError(
      'Pack compatibility must declare config schema versions and provider IDs.',
    );
  if (!Array.isArray(value.files) || !value.files.length)
    throw new PackContractError('Pack manifest requires files.');
  const paths = new Set<string>();
  const files = value.files.map((file): PackFile => {
    if (
      !isRecord(file) ||
      Object.keys(file).length !== 2 ||
      typeof file.path !== 'string' ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256)
    )
      throw new PackContractError('Each pack file requires a path and lowercase SHA-256.');
    validatePackPath(file.path);
    if (paths.has(file.path)) throw new PackContractError(`Duplicate pack file: ${file.path}`);
    paths.add(file.path);
    return { path: file.path, sha256: file.sha256 };
  });
  return {
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    ...(value.author === undefined ? {} : { author: value.author }),
    ...(value.license === undefined ? {} : { license: value.license }),
    provenance: value.provenance,
    compatibility: { configSchemaVersions: [...configSchemaVersions], providers: [...providers] },
    files,
  };
}

async function regularFile(filename: string): Promise<void> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new PackContractError(
      `Pack file must be a regular file: ${filename}`,
      'PACK_FILE_INVALID',
    );
}

export async function loadLocalPack(source: string): Promise<LoadedPack> {
  const root = await realpath(path.resolve(source));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new PackContractError(
      'Local pack source must be a real directory.',
      'PACK_SOURCE_INVALID',
    );
  const manifestFile = path.join(root, 'latchkit-pack.json');
  await regularFile(manifestFile);
  let manifest: PackManifest;
  try {
    manifest = parsePackManifest(JSON.parse(await readFile(manifestFile, 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof PackContractError) throw error;
    throw new PackContractError(`Invalid pack manifest JSON: ${errorMessage(error)}`);
  }
  const files: LoadedPackFile[] = [];
  for (const file of manifest.files) {
    const absolute = path.resolve(root, ...file.path.split('/'));
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new PackContractError(`Pack file escapes source: ${file.path}`, 'PACK_PATH_INVALID');
    await regularFile(absolute);
    const bytes = await readFile(absolute);
    if (digest(bytes) !== file.sha256)
      throw new PackContractError(`Checksum mismatch: ${file.path}`, 'PACK_INTEGRITY_FAILED');
    files.push({ path: file.path, bytes });
  }
  return { ...manifest, source: { type: 'local', path: root }, files };
}

export async function loadBundledPack(): Promise<LoadedPack> {
  const files: LoadedPackFile[] = [];
  for (const id of ['requirements', 'spec', 'build', 'fix', 'review', 'handoff', 'setup']) {
    const sourceRelative = `latchkit-${id}/SKILL.md`;
    const bytes = await readFile(path.join(bundledRoot, ...sourceRelative.split('/')));
    files.push({ path: `skills/${sourceRelative}`, bytes });
  }
  return {
    schemaVersion: 1,
    id: 'latchkit-core',
    version: '1.0.0',
    provenance: 'Bundled original MIT Latchkit workflow skills.',
    compatibility: {
      configSchemaVersions: [3],
      providers: ['claude', 'codex', 'antigravity', 'cursor', 'cursor-cli'],
    },
    source: { type: 'bundled' },
    files,
  };
}

export async function loadPack(selection: PackSelection): Promise<LoadedPack> {
  if (selection.source.type === 'bundled') return loadBundledPack();
  if (selection.source.type === 'git')
    throw new PackContractError(
      `Git pack ${selection.id}@${selection.version} is not materialized. Run latchkit pack fetch --id ${selection.id}.`,
      'PACK_SOURCE_UNAVAILABLE',
    );
  return loadLocalPack(selection.source.path);
}
