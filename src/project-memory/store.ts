import type { ProjectMemoryState } from './contracts.js';
import { randomUUID } from 'node:crypto';
import {
  parseProjectMemory,
  PROJECT_MEMORY_SCHEMA_VERSION,
  validateProjectMemory,
} from './contracts.js';
import { readOptional, writeAtomic } from '../storage.js';

export const PROJECT_MEMORY_PATH = '.latchkit/memory/state-v1.json';
const now = (clock: () => Date) => clock().toISOString();
export function emptyProjectMemory(clock = () => new Date()): ProjectMemoryState {
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
export async function readProjectMemory(
  root: string,
  { clock }: { clock?: () => Date } = {},
): Promise<ProjectMemoryState> {
  const raw = await readOptional(root, PROJECT_MEMORY_PATH);
  return raw === null ? emptyProjectMemory(clock) : parseProjectMemory(raw);
}
export async function writeProjectMemory(root: string, state: ProjectMemoryState) {
  validateProjectMemory(state);
  await writeAtomic(root, PROJECT_MEMORY_PATH, `${JSON.stringify(state, null, 2)}\n`);
}
