/**
 * Restart-handoff orchestration (issue #139 slice 2, acceptance criteria
 * 3-6). Ties together the pending-work compatibility preflight
 * (`preflight.ts`), installation-wide quiescence and the admission-barrier
 * lease (`workload.ts`), and the bounded spawn-verify-activate handoff
 * (`restart.ts`) into the one sequence both "activate the staged update"
 * and "roll back/activate an explicit version" share. `src/server.ts`'s
 * update routes call this directly rather than reimplementing any of this
 * ordering themselves.
 *
 * Ordering is deliberately safety-first: `current` is never touched until a
 * replacement running the target version has proven itself healthy over its
 * own authenticated status route. A failure at any step before that leaves
 * the previous installation completely untouched — nothing to roll back.
 * Only once the manager's own re-verify-and-smoke activation
 * (`activateStagedUpdate`/`rollbackUpdate`) succeeds does the lease clear
 * and the caller learn it may drain and close the old server.
 */
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { errorMessage } from '../../types.js';
import type { InstallationInspection } from '../manager.js';
import { checkPendingWorkCompatibility } from './preflight.js';
import { acquireRestartLease } from './workload.js';
import {
  detachReplacement,
  killReplacement,
  spawnReplacementServer,
  verifyReplacementVersion,
} from './restart.js';
import type { SpawnReplacementOptions, VerifyReplacementOptions } from './restart.js';
import { clearInstallationLease, writeUpdateHandoffRecord } from './store.js';
import type { UpdateHandoffStage } from './contracts.js';

export interface HandoffContext {
  installRoot: string;
  projectsRegistryRoot: string;
  projectRoot: string;
  ownServerId: string;
  ownMutating: number;
  ownDirty: boolean;
  fromVersion: string;
  toVersion: string;
  target: string;
  /** The already-staged immutable version directory this handoff will spawn
   * a replacement from (`versions/<version>-<target>`, verified and smoked
   * at staging time by `manager.ts`). */
  stagedDirectory: string;
  /** Performs the actual manager-level activation once the replacement is
   * verified healthy — either `activateStagedUpdate` (clears the staged
   * record too) or `rollbackUpdate` (an explicit already-installed
   * version), both from `service.ts`. */
  activate: () => Promise<InstallationInspection>;
  spawnImpl?: SpawnReplacementOptions['spawnImpl'];
  fetchImpl?: VerifyReplacementOptions['fetchImpl'];
  readyTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  clock?: () => Date;
}

export type HandoffResult =
  | { outcome: 'blocked-preflight'; blockers: string[] }
  | { outcome: 'blocked-quiescence'; reasons: string[] }
  | { outcome: 'failed'; stage: UpdateHandoffStage; reason: string; replacementPid: number | null }
  | {
      outcome: 'succeeded';
      inspection: InstallationInspection;
      replacement: { url: string; port: number; token: string; child: ChildProcess };
    };

function recoveryCommandFor(context: HandoffContext): string {
  return `latchkit update rollback --to ${context.fromVersion} --install-root "${context.installRoot}"`;
}

export async function performActivationHandoff(context: HandoffContext): Promise<HandoffResult> {
  const clock = context.clock ?? (() => new Date());
  const preflight = await checkPendingWorkCompatibility({
    projectsRegistryRoot: context.projectsRegistryRoot,
    currentRoot: context.projectRoot,
    stagedDirectory: context.stagedDirectory,
    target: context.target,
  });
  if (preflight.blocked) return { outcome: 'blocked-preflight', blockers: preflight.blockers };

  const lease = await acquireRestartLease({
    installRoot: context.installRoot,
    projectsRegistryRoot: context.projectsRegistryRoot,
    currentRoot: context.projectRoot,
    ownServerId: context.ownServerId,
    ownMutating: context.ownMutating,
    ownDirty: context.ownDirty,
    reason: `Activating ${context.toVersion}`,
    fromVersion: context.fromVersion,
    toVersion: context.toVersion,
    clock,
  });
  if (!lease.ok) return { outcome: 'blocked-quiescence', reasons: lease.reasons };

  let replacementPid: number | null = null;
  const fail = async (stage: UpdateHandoffStage, error: unknown): Promise<HandoffResult> => {
    const reason = errorMessage(error);
    await writeUpdateHandoffRecord(
      {
        schemaVersion: 1,
        attemptedAt: clock().toISOString(),
        fromVersion: context.fromVersion,
        toVersion: context.toVersion,
        target: context.target,
        outcome: 'failed',
        stage,
        reason,
        replacementPid,
        recoveryCommand: recoveryCommandFor(context),
      },
      context.installRoot,
    ).catch(() => {});
    // Bounded automatic recovery (acceptance criterion 5): release the
    // barrier immediately on failure rather than waiting out the lease TTL,
    // so a failed attempt can never itself cause a restart-loop-shaped
    // lockout for the next explicit try.
    await clearInstallationLease(context.installRoot).catch(() => {});
    return { outcome: 'failed', stage, reason, replacementPid };
  };

  let replacement;
  try {
    replacement = await spawnReplacementServer({
      stagedDirectory: context.stagedDirectory,
      target: context.target,
      projectRoot: context.projectRoot,
      installRoot: context.installRoot,
      readyTimeoutMs: context.readyTimeoutMs,
      spawnImpl: context.spawnImpl,
      extraEnv: context.extraEnv,
    });
    replacementPid = replacement.child.pid ?? null;
  } catch (error) {
    return fail('spawn', error);
  }

  try {
    await verifyReplacementVersion(replacement, context.toVersion, {
      fetchImpl: context.fetchImpl,
    });
  } catch (error) {
    killReplacement(replacement);
    return fail('version-verify', error);
  }

  let inspection: InstallationInspection;
  try {
    inspection = await context.activate();
  } catch (error) {
    killReplacement(replacement);
    return fail('activate', error);
  }

  await writeUpdateHandoffRecord(
    {
      schemaVersion: 1,
      attemptedAt: clock().toISOString(),
      fromVersion: context.fromVersion,
      toVersion: context.toVersion,
      target: context.target,
      outcome: 'succeeded',
      stage: 'complete',
      reason: null,
      replacementPid,
      recoveryCommand: null,
    },
    context.installRoot,
  ).catch(() => {});
  await clearInstallationLease(context.installRoot).catch(() => {});
  detachReplacement(replacement);
  return { outcome: 'succeeded', inspection, replacement };
}

export function stagedVersionDirectory(
  installRoot: string,
  version: string,
  target: string,
): string {
  return path.join(installRoot, 'versions', `${version}-${target}`);
}
