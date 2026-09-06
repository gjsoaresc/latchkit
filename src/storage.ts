import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorCode } from './types.js';

export async function statIfExists(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

export async function safePath(
  root: string,
  relative: string,
  finalType: 'directory' | 'file' = 'file',
) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe managed path: ${relative}`);
  }
  let target = root;
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    target = path.join(target, segments[index]!);
    const stat = await statIfExists(target);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink or junction: ${relative}`);
    if (stat && index < segments.length - 1 && !stat.isDirectory())
      throw new Error(`Expected directory: ${relative}`);
    if (stat && index === segments.length - 1 && finalType === 'file' && !stat.isFile())
      throw new Error(`Expected regular file: ${relative}`);
    if (stat && index === segments.length - 1 && finalType === 'directory' && !stat.isDirectory())
      throw new Error(`Expected directory: ${relative}`);
  }
  return target;
}

export async function resolveProjectRoot(root: string): Promise<string> {
  const resolved = await realpath(path.resolve(root));
  if (!(await lstat(resolved)).isDirectory()) throw new Error('Project must be a directory.');
  return resolved;
}

export function readOptional(
  root: string,
  relative: string,
  encoding: null,
): Promise<Buffer | null>;
export function readOptional(
  root: string,
  relative: string,
  encoding?: BufferEncoding,
): Promise<string | null>;
export async function readOptional(
  root: string,
  relative: string,
  encoding: BufferEncoding | null = 'utf8',
): Promise<string | Buffer | null> {
  const target = await safePath(root, relative);
  try {
    return await readFile(target, encoding);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'ENOTSUP'].includes(errorCode(error) ?? ''))
      throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeAtomic(
  root: string,
  relative: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const target = await safePath(root, relative);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  await safePath(root, relative);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}

export async function removeFile(root: string, relative: string): Promise<void> {
  const target = await safePath(root, relative);
  await unlink(target);
  await syncDirectory(path.dirname(target));
}
