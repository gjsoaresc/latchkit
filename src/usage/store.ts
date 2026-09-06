import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { errorCode } from '../types.js';
import { readOptional, safePath } from '../storage.js';
import {
  parseUsageState,
  USAGE_PATH,
  USAGE_SCHEMA_VERSION,
  validateUsageState,
} from './contracts.js';
import type { UsageState } from './contracts.js';

const now = (clock: () => Date) => clock().toISOString();
export { USAGE_PATH };
export function emptyUsageState(clock = () => new Date()): UsageState {
  const createdAt = now(clock);
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    project: { id: `project_${randomUUID()}` },
    revision: 0,
    settings: { enabled: false, retentionDays: 30 },
    createdAt,
    updatedAt: createdAt,
    records: [],
  };
}
export async function readUsageState(root: string, { clock }: { clock?: () => Date } = {}) {
  const raw = await readOptional(root, USAGE_PATH);
  return raw === null ? emptyUsageState(clock) : parseUsageState(raw);
}
async function syncDirectory(directory: string) {
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
export async function writeUsageState(root: string, state: UsageState) {
  validateUsageState(state);
  const target = await safePath(root, USAGE_PATH);
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
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}
