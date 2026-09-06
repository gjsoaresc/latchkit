import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PLAN_ARTIFACT_PATH_PATTERN, TaskStateError } from './contracts.js';
import { errorCode } from '../types.js';
import { resolveProjectRoot, safePath, statIfExists, writeAtomic } from '../storage.js';

/** Default durable location for new specifications and technical plans. */
export const PLAN_DIRECTORY = 'docs/plans';
/** Legacy durable location. Reads remain supported; it is never chosen for new plans. */
export const LEGACY_NOTE_DIRECTORY = '.latchkit/notes';

const LEGACY_PLAN_PATTERN = /^\.latchkit\/notes\/.+\.md$/;
const NEW_PLAN_PATTERN = /^docs\/plans\/.+\.md$/;
const MAX_COLLISION_ATTEMPTS = 1000;

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** True for a path already accepted as a durable plan location (new or legacy). */
export function isDurablePlanPath(relative: string): boolean {
  return PLAN_ARTIFACT_PATH_PATTERN.test(relative.replaceAll('\\', '/'));
}

/**
 * Turn a title into a portable, readable filename stem: Unicode is normalized and
 * transliterated to ASCII where possible, and anything left is lowercase letters, digits, and
 * single hyphens. Falls back to "plan" so a caller always receives a usable stem.
 */
export function slugifyPlanTitle(title: string): string {
  const normalized = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'plan';
}

/**
 * Resolve a collision-safe relative path under `docs/plans/` for a new durable plan. An existing
 * file at the candidate path is never reused or overwritten: a numeric suffix is appended until a
 * free name is found.
 */
export async function resolveCollisionSafePlanPath(
  root: string,
  title: string,
  {
    extension = '.md',
    directory = PLAN_DIRECTORY,
  }: { extension?: string; directory?: string } = {},
): Promise<string> {
  root = await resolveProjectRoot(root);
  const stem = slugifyPlanTitle(title);
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = `${directory}/${attempt === 0 ? stem : `${stem}-${attempt + 1}`}${extension}`;
    const target = await safePath(root, candidate);
    if (!(await statIfExists(target))) return candidate;
  }
  throw new TaskStateError(
    `Could not find a free plan filename for "${title}" after ${MAX_COLLISION_ATTEMPTS} attempts.`,
    'PLAN_PATH_EXHAUSTED',
    '$.title',
  );
}

export type PlanMigrationResult = {
  from: string;
  to: string;
  sha256: string;
  action: 'migrated' | 'current';
};

/**
 * Explicitly migrate one legacy `.latchkit/notes/` plan to `docs/plans/`. This never runs
 * implicitly: a caller (skill, CLI, or API) must name the exact source file. The legacy file is
 * preserved byte-for-byte and is never deleted or overwritten, and an existing destination file
 * blocks the migration unless its content already matches (making a repeated call idempotent).
 */
export async function migrateLegacyPlan(
  root: string,
  input: { from: string; to?: string; dryRun?: boolean },
): Promise<PlanMigrationResult> {
  root = await resolveProjectRoot(root);
  const from = input.from?.replaceAll('\\', '/');
  if (typeof from !== 'string' || !LEGACY_PLAN_PATTERN.test(from)) {
    throw new TaskStateError(
      'Plan migration source must be an existing Markdown note under .latchkit/notes/.',
      'PLAN_MIGRATION_INVALID',
      '$.from',
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(await safePath(root, from));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new TaskStateError(
        `Migration source does not exist: ${from}.`,
        'PLAN_MIGRATION_SOURCE_MISSING',
        '$.from',
      );
    }
    throw error;
  }
  let to = input.to?.replaceAll('\\', '/');
  if (to !== undefined && !NEW_PLAN_PATTERN.test(to)) {
    throw new TaskStateError(
      'Plan migration destination must be a Markdown plan under docs/plans/.',
      'PLAN_MIGRATION_INVALID',
      '$.to',
    );
  }
  if (to === undefined) {
    // Preserve the original filename verbatim so a repeated migration of the same source is
    // deterministic and idempotent. A caller who wants a cleaner, collision-safe name can compute
    // one first (for example via `resolveCollisionSafePlanPath`) and pass it explicitly as `to`.
    const basename = from.slice(LEGACY_NOTE_DIRECTORY.length + 1);
    to = `${PLAN_DIRECTORY}/${basename}`;
  }
  const existing = await readFile(await safePath(root, to)).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  const sha256 = digest(bytes);
  if (existing !== null) {
    if (Buffer.compare(existing, bytes) === 0) return { from, to, sha256, action: 'current' };
    throw new TaskStateError(
      `Plan migration destination already exists with different content: ${to}.`,
      'PLAN_MIGRATION_TARGET_CONFLICT',
      '$.to',
    );
  }
  if (!input.dryRun) await writeAtomic(root, to, bytes, 0o600);
  return { from, to, sha256, action: 'migrated' };
}
