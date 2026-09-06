import { digestJson, type WorkflowActionJournal, type WorkflowRecord } from './contracts.js';
import { mutateWorkflowUnlocked, readWorkflowUnlocked } from './store.js';

/**
 * The small reconciliation helper referenced in issue #111's intended implementation surfaces:
 * task-intent reconciliation (`src/task-state/reconcile.ts` and the `previewTaskReconciliation`/
 * `applyTaskReconciliation` orchestration in `src/task-state/service.ts`) needs two things from
 * the workflow store that only belong here — a live check for an owned in-flight effect, and an
 * idempotent, best-effort acknowledgment — without pulling in `./service.ts`'s full controller
 * (adapters, provider launch, review orchestration: none of that is reconciliation's concern, and
 * importing it would pull workflow execution into a pure state-mutation path). This module
 * therefore depends only on `./store.js` and `./contracts.js`, never on `./service.js` or anything
 * under `../task-state/`, so `../task-state/service.ts` can import it with no cycle.
 *
 * The actual approval-freshness guarantee does not depend on anything in this file: a workflow's
 * `approval.criteriaDigest`/`approval.intentDigest` are compared against the task's *current*
 * criteria/adopted-intent on every `next_step` evaluation in `./service.ts` (`approvalValid`), so
 * a task-state commit that changes criteria or adopted intent makes a mismatched approval unusable
 * immediately and on its own — whether or not the acknowledgment below ever runs. It exists purely
 * as an audit/idempotency breadcrumb.
 */

export { readWorkflowUnlocked };

/**
 * Conservative liveness check for a workflow's pending action, reusing the same cross-process PID
 * probe `./service.ts`'s private `actionOwnerIsLive` uses. Unlike that private helper, this one has
 * no access to the in-process `LIVE_ACTION_OWNERS` registry (a workflow controller may not even be
 * running in this process), so a pending action whose owner PID matches *this* process is treated
 * as live rather than guessed at — the safe default per "reject an owned in-flight effect... do not
 * silently cancel, restart, fork, or take ownership of it".
 */
function isActionOwnerLive(action: WorkflowActionJournal): boolean {
  if (action.ownerPid === process.pid) return true;
  try {
    process.kill(action.ownerPid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'ESRCH'
    );
  }
}

export function isWorkflowEffectActive(record: WorkflowRecord): boolean {
  return Boolean(record.pendingAction) && isActionOwnerLive(record.pendingAction!);
}

/**
 * Idempotent, best-effort secondary bookkeeping: records that a task reconciliation happened by
 * reusing the workflow's existing `mutations` idempotency ledger (the same mechanism `approve`/
 * `resume`/`cancel` already use in `./service.ts`), so a retried apply with the same `mutationId`
 * observes the acknowledgment already present rather than double-recording it, and a different
 * reconciliation reusing that ID is rejected rather than silently applied. Callers must already
 * hold the shared task-state lock (see `readWorkflowUnlocked`); this never acquires it. Returns
 * `false` (a no-op) when the task has no workflow — callers should skip calling this in that case,
 * but it degrades safely if they do not.
 */
export async function acknowledgeTaskReconciliationUnlocked(
  root: string,
  taskId: string,
  input: { mutationId: string; reconciliationId: string; digest: string },
): Promise<boolean> {
  const existing = await readWorkflowUnlocked(root, taskId);
  if (!existing) return false;
  const payloadDigest = digestJson({
    reconciliationId: input.reconciliationId,
    digest: input.digest,
  });
  await mutateWorkflowUnlocked(root, taskId, undefined, (record) => {
    const prior = record.mutations.find((item) => item.id === input.mutationId);
    if (prior) return false; // Already acknowledged by an earlier attempt at this same mutation.
    record.mutations.push({
      id: input.mutationId,
      digest: payloadDigest,
      revision: record.revision + 1,
    });
  });
  return true;
}
