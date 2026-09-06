// Shared helpers for keeping a generated-output directory in sync with the
// exact set of files its current producing step wrote. A plain `cp` or
// per-file compiler emission only ever adds or overwrites files; it never
// notices a source file that was deleted or renamed, so re-running a build
// without a full `--clean` layers new output over stale copies indefinitely.
// These helpers make that reconciliation an explicit, testable step instead
// of relying on callers to remember to clean first.
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type ReconcileOptions = {
  ignore?: readonly string[];
  dryRun?: boolean;
};

export type ReconcileResult = { removed: string[]; bytesReclaimed: number };

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

// Recursively lists the files under `root` as POSIX-style paths relative to
// `root`. Symbolic links and junctions are never traversed or reported, so a
// reconciliation boundary can never be told to "keep" something reached
// through a link. Returns an empty array when `root` does not exist.
export async function listFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) results.push(relative);
    }
  }
  await walk(root, '');
  return results;
}

// Removes every file under `root` whose POSIX-relative path is not present
// in `keep`, then prunes directories left empty by that removal. `root`
// itself is never removed. Entries under any relative path in `ignore`
// (matched as an exact segment or a "prefix/" match) are left untouched and
// not recursed into, so callers can carve out a sibling subtree that has its
// own, independently computed keep set. Symbolic links and junctions are
// never followed or removed by this pass; an owner that wants them gone must
// remove the link itself, not have it silently deleted by inference.
//
// With `dryRun: true`, nothing is removed; the same `{ removed,
// bytesReclaimed }` shape reports what an apply pass would do.
export async function reconcileDirectory(
  root: string,
  keep: Iterable<string>,
  { ignore = [], dryRun = false }: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const keepSet = keep instanceof Set ? keep : new Set(keep);
  const ignored = (relative: string): boolean =>
    ignore.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
  const removed: string[] = [];
  let bytesReclaimed = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored(relative)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        if (!dryRun) {
          try {
            await rmdir(absolute);
          } catch (error) {
            if (!isNodeError(error) || (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT'))
              throw error;
          }
        }
        continue;
      }
      if (!entry.isFile() || keepSet.has(relative)) continue;
      const size = (await stat(absolute)).size;
      if (!dryRun) await rm(absolute, { force: true });
      removed.push(relative);
      bytesReclaimed += size;
    }
  }
  await walk(path.resolve(root), '');
  return { removed, bytesReclaimed };
}

export { toPosix };
