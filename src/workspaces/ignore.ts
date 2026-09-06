import path from 'node:path';
import { readOptional, writeAtomic } from '../storage.js';

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(
    relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative),
  );
}

/** Adds one owned exclusion line for an in-project path (such as the default
 * worktree root) to the project's `.gitignore`, so it never appears in `git
 * status`, staging, or discovery. A no-op for a target outside the project
 * root (nothing to ignore there) or one already covered by an identical
 * line. Existing content, including unrelated user patterns, is preserved
 * verbatim; only one line is ever appended.
 *
 * This is deliberately an explicit, configuration-time action — called from
 * project initialization and from explicitly changing the persisted worktree
 * root — and is never invoked as a side effect of creating a worktree.
 * Worktree creation must never modify the source checkout. */
export async function ensureProjectPathIgnored(
  projectRoot: string,
  absoluteTarget: string,
): Promise<void> {
  if (!isContained(projectRoot, absoluteTarget)) return;
  const relative = path.relative(projectRoot, absoluteTarget).split(path.sep).join('/');
  if (!relative) return;
  const pattern = `${relative}/`;
  const raw = (await readOptional(projectRoot, '.gitignore')) ?? '';
  const alreadyIgnored = (raw.length ? raw.split(/\r?\n/) : []).some((line) => {
    const trimmed = line.trim();
    return (
      trimmed === pattern ||
      trimmed === relative ||
      trimmed === `/${pattern}` ||
      trimmed === `/${relative}`
    );
  });
  if (alreadyIgnored) return;
  const withTrailingNewline = raw.length === 0 || raw.endsWith('\n') ? raw : `${raw}\n`;
  await writeAtomic(projectRoot, '.gitignore', `${withTrailingNewline}${pattern}\n`);
}
