/**
 * Pending-work compatibility preflight (issue #139 slice 2, acceptance
 * criterion 4).
 *
 * Scans persisted workflow state — including interrupted, awaiting-input,
 * awaiting-approval, and blocked workflows with no active process — across
 * every project sharing this installation, and compares the workflow
 * policy version those pending workflows were started under against the
 * staged candidate's own policy version. A mismatch means the old phase
 * prompts/schema this pending work depends on may not resume correctly
 * under the new version, so it must block *manual* activation with an
 * explicit, actionable reason rather than silently letting it proceed —
 * never faking migration, deleting the approval, or resuming anything
 * itself. Reuses the exact "spawn the staged runtime and ask it its own
 * policy version" technique `src/installation/manager.ts`'s internal
 * `smoke()` already performs during staging/activation, so this reads a
 * real, already-meaningful version marker rather than inventing one.
 */
import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { listWorkflows } from '../../workflows/store.js';
import { POLICY_VERSION } from '../../workflows/policy.js';
import { readProjectRegistry } from '../../projects/store.js';
import { errorMessage } from '../../types.js';

const PENDING_WORKFLOW_STATUSES = new Set([
  'awaiting-input',
  'awaiting-approval',
  'blocked',
  'interrupted',
]);

export interface CompatibilityPreflightResult {
  blocked: boolean;
  blockers: string[];
  pendingCount: number;
}

async function pendingWorkflowCounts(
  projectsRegistryRoot: string,
  currentRoot: string,
): Promise<{ total: number; byRoot: Map<string, number> }> {
  const roots = new Set<string>([currentRoot]);
  try {
    const registry = await readProjectRegistry(projectsRegistryRoot);
    for (const project of registry.projects) roots.add(project.root);
  } catch {
    /* Best-effort: an unreadable registry never blocks the one project this
     * server actually serves from being scanned below. */
  }
  const byRoot = new Map<string, number>();
  let total = 0;
  for (const root of roots) {
    let count = 0;
    try {
      const workflows = await listWorkflows(root);
      count = workflows.filter((workflow) => PENDING_WORKFLOW_STATUSES.has(workflow.status)).length;
    } catch {
      /* Unreadable project state counts as no pending workflows here; the caller's own
       * quiescence check treats an unreadable *task* state far more conservatively. */
    }
    if (count > 0) byRoot.set(root, count);
    total += count;
  }
  return { total, byRoot };
}

/** Spawn the staged candidate's own bundled runtime and ask it its policy
 * version, exactly like `manager.ts`'s internal `smoke()` does. Never loads
 * candidate code into this process. Returns `null` (never throws) on any
 * failure — an unreadable candidate policy version is itself surfaced as a
 * blocker by the caller rather than crashing the whole preflight. */
async function stagedPolicyVersion(
  stagedDirectory: string,
  target: string,
): Promise<string | null> {
  const node = path.join(
    stagedDirectory,
    'runtime',
    target.startsWith('win32-') ? 'node.exe' : 'node',
  );
  try {
    await lstat(node);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(
      node,
      [
        '--input-type=module',
        '-e',
        "import {policy_version_async} from './dist/src/workflows/policy.js'; process.stdout.write(await policy_version_async());",
      ],
      { cwd: path.join(stagedDirectory, 'app'), windowsHide: true },
    );
    const timeout = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0 && stdout.trim() ? stdout.trim() : null);
    });
  });
}

export interface CheckPendingWorkCompatibilityOptions {
  projectsRegistryRoot: string;
  currentRoot: string;
  stagedDirectory: string;
  target: string;
}

export async function checkPendingWorkCompatibility(
  options: CheckPendingWorkCompatibilityOptions,
): Promise<CompatibilityPreflightResult> {
  const { total, byRoot } = await pendingWorkflowCounts(
    options.projectsRegistryRoot,
    options.currentRoot,
  );
  if (total === 0) return { blocked: false, blockers: [], pendingCount: 0 };
  let candidatePolicy: string | null;
  try {
    candidatePolicy = await stagedPolicyVersion(options.stagedDirectory, options.target);
  } catch (error) {
    return {
      blocked: true,
      blockers: [
        `Could not verify the staged update's workflow policy version (${errorMessage(error)}); ${total} pending workflow(s) exist, so activation is blocked until this can be confirmed.`,
      ],
      pendingCount: total,
    };
  }
  if (candidatePolicy === null)
    return {
      blocked: true,
      blockers: [
        `The staged update's workflow policy version could not be determined; ${total} pending workflow(s) exist, so activation is blocked until this can be confirmed.`,
      ],
      pendingCount: total,
    };
  if (candidatePolicy === POLICY_VERSION)
    return { blocked: false, blockers: [], pendingCount: total };
  const blockers = [...byRoot.entries()].map(
    ([root, count]) =>
      `${root}: ${count} pending workflow(s) were started under policy "${POLICY_VERSION}"; the staged update uses policy "${candidatePolicy}". Resolve, complete, or cancel this pending work before installing this update.`,
  );
  return { blocked: true, blockers, pendingCount: total };
}
