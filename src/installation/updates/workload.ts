/**
 * Installation-wide quiescence (issue #139 slice 2, acceptance criterion 3).
 *
 * Before activation/restart, every one of these must hold across every
 * console/project sharing this installation: no active provider, workflow,
 * review, or check run; no admitted mutating request; and no unsaved
 * console edit. This module answers that question with read-only queries
 * over already-persisted task/workflow/review state (see `listTasks`,
 * `listWorkflows`, and the reviews store's own state file) plus the
 * cross-process activity heartbeat registry (`activity.ts`) for the
 * ephemeral signals persisted state cannot carry. It never mutates
 * anything by itself.
 *
 * `acquireRestartLease` performs the actual "final idle check plus admit"
 * as one atomic step, inside the same installation lock every other
 * mutating installation operation already uses
 * (`withInstallationLock`/`withTaskStateLock`), so two consoles racing to
 * activate at the same moment cannot both observe "idle" and both proceed
 * — the second one to acquire the lock always observes the first's
 * already-written lease.
 */
import { readOptional } from '../../storage.js';
import { errorCode, errorMessage } from '../../types.js';
import { listTasks } from '../../task-state/service.js';
import { listWorkflows } from '../../workflows/store.js';
import { readProjectRegistry } from '../../projects/store.js';
import { REVIEW_STATE_PATH } from '../../reviews/orchestrator.js';
import { withInstallationLock } from '../manager.js';
import { listLiveHeartbeats } from './activity.js';
import {
  isInstallationLeaseActive,
  readInstallationLease,
  writeInstallationLease,
} from './store.js';
import type { InstallationLease } from './contracts.js';

export interface QuiescenceReport {
  busy: boolean;
  reasons: string[];
}

async function projectRunningWork(root: string): Promise<string[]> {
  const reasons: string[] = [];
  try {
    const { tasks } = await listTasks(root);
    const running = tasks.filter((task) => task.state === 'running');
    if (running.length > 0) reasons.push(`${root}: ${running.length} task(s) currently running.`);
  } catch (error) {
    if (errorCode(error) !== 'TASK_STATE_NOT_FOUND')
      reasons.push(
        `${root}: could not verify task activity (${errorMessage(error)}); deferring activation.`,
      );
  }
  try {
    const workflows = await listWorkflows(root);
    const running = workflows.filter((workflow) => workflow.status === 'running');
    if (running.length > 0)
      reasons.push(`${root}: ${running.length} workflow(s) currently running.`);
  } catch (error) {
    reasons.push(
      `${root}: could not verify workflow activity (${errorMessage(error)}); deferring activation.`,
    );
  }
  try {
    const raw = await readOptional(root, REVIEW_STATE_PATH);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      const reviews =
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { reviews?: unknown }).reviews)
          ? ((parsed as { reviews: unknown[] }).reviews as { state?: unknown }[])
          : [];
      const running = reviews.filter((review) => review.state === 'running');
      if (running.length > 0)
        reasons.push(`${root}: ${running.length} review(s) currently running.`);
    }
  } catch (error) {
    reasons.push(
      `${root}: could not verify review activity (${errorMessage(error)}); deferring activation.`,
    );
  }
  return reasons;
}

async function projectRootsSharingThisInstallation(
  projectsRegistryRoot: string,
  currentRoot: string,
): Promise<string[]> {
  const roots = new Set<string>([currentRoot]);
  try {
    const registry = await readProjectRegistry(projectsRegistryRoot);
    for (const project of registry.projects) roots.add(project.root);
  } catch {
    // The registry is best-effort everywhere else in this codebase (see
    // src/server.ts's `touchProject`); an unreadable registry must not by
    // itself block updating the one project this server actually serves.
  }
  return [...roots];
}

export interface AssessQuiescenceOptions {
  installRoot: string;
  projectsRegistryRoot: string;
  currentRoot: string;
  /** This server's own heartbeat id, excluded when scanning other
   * consoles' heartbeats (its own live state is passed explicitly below). */
  ownServerId: string;
  ownMutating: number;
  ownDirty: boolean;
}

export async function assessInstallationQuiescence(
  options: AssessQuiescenceOptions,
): Promise<QuiescenceReport> {
  const reasons: string[] = [];
  const lease = await readInstallationLease(options.installRoot);
  if (lease && isInstallationLeaseActive(lease) && lease.ownerId !== options.ownServerId)
    reasons.push('Another update is already restarting on this installation.');
  if (options.ownMutating > 0)
    reasons.push(`This console has ${options.ownMutating} in-flight request(s).`);
  if (options.ownDirty) reasons.push('This console has an unsaved edit.');
  const heartbeats = await listLiveHeartbeats(options.installRoot);
  for (const heartbeat of heartbeats) {
    if (heartbeat.serverId === options.ownServerId) continue;
    if (heartbeat.dirty) reasons.push(`${heartbeat.root}: another console has an unsaved edit.`);
    if (heartbeat.mutating > 0)
      reasons.push(`${heartbeat.root}: ${heartbeat.mutating} in-flight request(s).`);
  }
  const roots = await projectRootsSharingThisInstallation(
    options.projectsRegistryRoot,
    options.currentRoot,
  );
  for (const root of roots) reasons.push(...(await projectRunningWork(root)));
  return { busy: reasons.length > 0, reasons };
}

export interface AcquireRestartLeaseOptions extends AssessQuiescenceOptions {
  reason: string;
  fromVersion: string;
  toVersion: string;
  /** Bounds automatic recovery: a crashed holder can never lock the
   * installation out past this window. Defaults to 3 minutes, comfortably
   * above the restart-handoff timeout in `restart.ts`. */
  ttlMs?: number;
  clock?: () => Date;
}

export type AcquireRestartLeaseResult =
  { ok: true; lease: InstallationLease } | { ok: false; reasons: string[] };

/**
 * Atomically re-check quiescence and, if clear, write the `restarting`
 * lease — the admission barrier itself — all inside one installation-lock
 * critical section so a concurrent activation from another console cannot
 * race the final idle check (acceptance criterion 5).
 */
export async function acquireRestartLease(
  options: AcquireRestartLeaseOptions,
): Promise<AcquireRestartLeaseResult> {
  return withInstallationLock(options.installRoot, async () => {
    const quiescence = await assessInstallationQuiescence(options);
    if (quiescence.busy) return { ok: false, reasons: quiescence.reasons };
    const clock = options.clock ?? (() => new Date());
    const acquiredAt = clock();
    const lease: InstallationLease = {
      schemaVersion: 1,
      state: 'restarting',
      ownerId: options.ownServerId,
      reason: options.reason,
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + (options.ttlMs ?? 180_000)).toISOString(),
    };
    await writeInstallationLease(lease, options.installRoot);
    return { ok: true, lease };
  });
}
