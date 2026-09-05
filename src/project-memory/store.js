import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import {
  parseProjectMemory,
  PROJECT_MEMORY_SCHEMA_VERSION,
  validateProjectMemory,
} from './contracts.js';
import { readOptional, safePath } from '../storage.js';

export const PROJECT_MEMORY_PATH = '.latchkit/memory/state-v1.json';
const now = (clock) => clock().toISOString();
export function emptyProjectMemory(clock = () => new Date()) {
  const createdAt = now(clock);
  return {
    schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}` },
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    memories: [],
  };
}
export async function readProjectMemory(root, { clock } = {}) {
  const raw = await readOptional(root, PROJECT_MEMORY_PATH);
  return raw === null ? emptyProjectMemory(clock) : parseProjectMemory(raw);
}
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}
export async function writeProjectMemory(root, state) {
  validateProjectMemory(state);
  const target = await safePath(root, PROJECT_MEMORY_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    committed = true;
    await syncDirectory(path.dirname(target));
  } finally {
    if (!committed)
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}
