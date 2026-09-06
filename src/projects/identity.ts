import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { errorCode } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * A project's identity, resolved live from the filesystem/Git rather than trusted from a
 * cached registry field. `kind: 'git'` carries Git's own common directory as the stable
 * group key so a main checkout and its linked worktrees are recognized as one project
 * (see docs/projects.md#identity-and-grouping); `kind: 'plain'` covers a non-Git directory,
 * keyed by its own resolved path; `kind: 'unavailable'` covers a moved, missing, or
 * unreadable root.
 */
export type ProjectIdentity =
  | { kind: 'unavailable'; reason: 'missing' | 'not-directory' }
  | { kind: 'plain'; root: string }
  | {
      kind: 'git';
      root: string;
      commonDir: string;
      mainRoot: string;
      isMainCheckout: boolean;
      bare: boolean;
    };

export type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
};

/** Case-insensitive comparison on Windows only, matching src/workspaces/git.ts's convention. */
export function canonicalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** The stable grouping key for a resolved identity, or null when the root itself is
 * unavailable (an unavailable project is never merged into another project's group). */
export function identityGroupKey(identity: ProjectIdentity): string | null {
  if (identity.kind === 'git') return `git:${canonicalizeForComparison(identity.commonDir)}`;
  if (identity.kind === 'plain') return `plain:${canonicalizeForComparison(identity.root)}`;
  return null;
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function gitRaw(root: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

/** The main worktree's resolved path, read from Git's own worktree listing (its first entry
 * is always the main worktree) rather than assumed from the queried checkout. Falls back to
 * the queried root when the listing is unavailable or unparsable (for example a bare
 * repository with no working tree of its own). */
async function mainCheckoutRoot(root: string): Promise<string> {
  const worktrees = await listRepositoryWorktrees(root);
  const first = worktrees[0];
  if (!first) return root;
  return first.path;
}

/** Every worktree (main checkout first, then linked worktrees) Git currently knows about for
 * the repository containing `anyRootInRepo`. Reflects ordinary `git worktree` state, not only
 * worktrees Latchkit itself created (see src/workspaces/git.ts for the separate task-owned
 * worktree registry). Returns an empty array when Git is unavailable or the listing fails. */
export async function listRepositoryWorktrees(anyRootInRepo: string): Promise<WorktreeInfo[]> {
  const output = await gitRaw(anyRootInRepo, ['worktree', 'list', '--porcelain']);
  if (output === null) return [];
  const blocks = output.split(/\r?\n\r?\n/).filter((block) => block.trim());
  const result: WorktreeInfo[] = [];
  for (const [index, block] of blocks.entries()) {
    let worktreePath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (!worktreePath) continue;
    let resolved: string;
    try {
      resolved = await realpath(worktreePath);
    } catch {
      resolved = worktreePath;
    }
    result.push({ path: resolved, branch, head, isMain: index === 0 });
  }
  return result;
}

/**
 * Resolve a registered root's live identity. Never trusts a cached registry field: a moved
 * or deleted directory resolves to `unavailable` here even if it was valid when registered.
 */
export async function resolveProjectIdentity(inputRoot: string): Promise<ProjectIdentity> {
  let real: string;
  try {
    real = await realpath(path.resolve(inputRoot));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      return { kind: 'unavailable', reason: 'missing' };
    throw error;
  }
  let info;
  try {
    info = await lstat(real);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'unavailable', reason: 'missing' };
    throw error;
  }
  if (!info.isDirectory()) return { kind: 'unavailable', reason: 'not-directory' };
  const toplevel = await git(real, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return { kind: 'plain', root: real };
  let resolvedToplevel: string;
  try {
    resolvedToplevel = await realpath(toplevel);
  } catch {
    return { kind: 'plain', root: real };
  }
  const commonRaw = await git(resolvedToplevel, ['rev-parse', '--git-common-dir']);
  if (!commonRaw) return { kind: 'plain', root: real };
  let commonDir: string;
  try {
    commonDir = await realpath(path.resolve(resolvedToplevel, commonRaw));
  } catch {
    return { kind: 'plain', root: real };
  }
  const bare = (await git(resolvedToplevel, ['rev-parse', '--is-bare-repository'])) === 'true';
  const mainRoot = await mainCheckoutRoot(resolvedToplevel);
  return {
    kind: 'git',
    root: real,
    commonDir,
    mainRoot,
    isMainCheckout: canonicalizeForComparison(real) === canonicalizeForComparison(mainRoot),
    bare,
  };
}
