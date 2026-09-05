import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const bundledRoot = fileURLToPath(new URL('../../skills/', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const reservedWindows = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class PackContractError extends Error {
  constructor(message, code = 'PACK_INVALID') {
    super(message);
    this.name = 'PackContractError';
    this.code = code;
  }
}

function safePart(part) {
  return (
    part &&
    part !== '.' &&
    part !== '..' &&
    !reservedWindows.test(part) &&
    !/[<>:"|?*\\]/.test(part) &&
    ![...part].some((character) => character.codePointAt(0) < 32)
  );
}

export function validatePackPath(relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative !== relative.normalize('NFC') ||
    relative.split('/').some((part) => !safePart(part))
  )
    throw new PackContractError(`Unsafe pack file path: ${relative}`, 'PACK_PATH_INVALID');
  return relative;
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PackContractError('Pack manifest must be an object.');
  const expected = new Set([
    'schemaVersion',
    'id',
    'version',
    'provenance',
    'compatibility',
    'files',
  ]);
  for (const key of Object.keys(value))
    if (!expected.has(key)) throw new PackContractError(`Unknown pack manifest field: ${key}`);
  if (value.schemaVersion !== 1 || !ID.test(value.id) || !VERSION.test(value.version))
    throw new PackContractError(
      'Pack manifest requires schemaVersion 1, a portable ID, and a semantic version.',
    );
  if (typeof value.provenance !== 'string' || !value.provenance.trim())
    throw new PackContractError('Pack manifest requires provenance text.');
  if (
    !value.compatibility ||
    typeof value.compatibility !== 'object' ||
    Array.isArray(value.compatibility)
  )
    throw new PackContractError('Pack manifest requires a compatibility object.');
  const { configSchemaVersions, providers } = value.compatibility;
  if (
    !Array.isArray(configSchemaVersions) ||
    !configSchemaVersions.every(Number.isInteger) ||
    !Array.isArray(providers) ||
    !providers.every((id) => typeof id === 'string')
  )
    throw new PackContractError(
      'Pack compatibility must declare config schema versions and provider IDs.',
    );
  if (!Array.isArray(value.files) || !value.files.length)
    throw new PackContractError('Pack manifest requires files.');
  const paths = new Set();
  const files = value.files.map((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
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
    provenance: value.provenance,
    compatibility: { configSchemaVersions: [...configSchemaVersions], providers: [...providers] },
    files,
  };
}

async function regularFile(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new PackContractError(
      `Pack file must be a regular file: ${filename}`,
      'PACK_FILE_INVALID',
    );
}

export async function loadLocalPack(source) {
  const root = await realpath(path.resolve(source));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new PackContractError(
      'Local pack source must be a real directory.',
      'PACK_SOURCE_INVALID',
    );
  const manifestFile = path.join(root, 'latchkit-pack.json');
  await regularFile(manifestFile);
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(await readFile(manifestFile, 'utf8')));
  } catch (error) {
    if (error instanceof PackContractError) throw error;
    throw new PackContractError(`Invalid pack manifest JSON: ${error.message}`);
  }
  const files = [];
  for (const file of manifest.files) {
    const absolute = path.resolve(root, ...file.path.split('/'));
    if (
      path.relative(root, absolute).startsWith('..') ||
      path.isAbsolute(path.relative(root, absolute))
    )
      throw new PackContractError(`Pack file escapes source: ${file.path}`, 'PACK_PATH_INVALID');
    await regularFile(absolute);
    const bytes = await readFile(absolute);
    if (digest(bytes) !== file.sha256)
      throw new PackContractError(`Checksum mismatch: ${file.path}`, 'PACK_INTEGRITY_FAILED');
    files.push({ path: file.path, bytes });
  }
  return { ...manifest, source: { type: 'local', path: root }, files };
}

export async function loadBundledPack() {
  const files = [];
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
      providers: ['claude', 'codex', 'gemini', 'cursor', 'cursor-cli'],
    },
    source: { type: 'bundled' },
    files,
  };
}

export async function loadPack(selection) {
  if (selection.source.type === 'bundled') return loadBundledPack();
  return loadLocalPack(selection.source.path);
}
