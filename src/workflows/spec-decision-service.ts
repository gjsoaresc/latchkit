import { randomUUID } from 'node:crypto';
import {
  MAX_SPEC_DECISION_TEXT_BYTES,
  SpecDecisionError,
  specDecisionRequestHash,
  type SpecDecisionEvent,
  type SpecDecisionRecord,
} from './spec-decision-contracts.js';
import {
  listSpecDecisions as listSpecDecisionsUnfiltered,
  upsertSpecDecision,
  type SpecDecisionMutationResult,
} from './spec-decision-store.js';

export { readSpecDecision as inspectSpecDecision } from './spec-decision-store.js';
export const listSpecDecisions = listSpecDecisionsUnfiltered;
export {
  selectSpecDecisionPresentation,
  type SpecDecisionPresentation,
  type SpecDecisionPresentationMode,
} from './spec-decision-presentation.js';
export type {
  SpecDecisionRecord,
  SpecDecisionStatus,
  SpecDecisionApproval,
  SpecDecisionNote,
} from './spec-decision-contracts.js';
export { SpecDecisionError } from './spec-decision-contracts.js';

const TASK_ID_PATTERN = /^task_[0-9a-f-]{36}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_NOTES = 64;

export type SpecDecisionMutationOptions = { clock?: () => Date };

function iso(clock: () => Date) {
  return clock().toISOString();
}

function normalizeMutationId(value?: string): string {
  if (value === undefined) return `event_${randomUUID()}`;
  if (!/^event_[0-9a-f-]{36}$/i.test(value))
    throw new SpecDecisionError('mutationId must be a stable event ID.', 'SPEC_DECISION_INVALID');
  return value;
}

function requireTaskId(taskId: string) {
  if (!TASK_ID_PATTERN.test(taskId))
    throw new SpecDecisionError('taskId must be a stable task ID.', 'SPEC_DECISION_INVALID');
}

function requireDigest(value: string, field: string) {
  if (!DIGEST_PATTERN.test(value))
    throw new SpecDecisionError(
      `${field} must be a lowercase SHA-256 digest.`,
      'SPEC_DECISION_INVALID',
    );
}

function requireText(value: string, field: string, maximum = MAX_SPEC_DECISION_TEXT_BYTES) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum)
    throw new SpecDecisionError(`${field} is required and bounded.`, 'SPEC_DECISION_INVALID');
}

function requireRevision(value: number) {
  if (!Number.isInteger(value) || value < 1)
    throw new SpecDecisionError(
      'expectedRevision must be a positive integer.',
      'SPEC_DECISION_INVALID',
    );
}

function appendEvent(events: SpecDecisionEvent[], event: SpecDecisionEvent): SpecDecisionEvent[] {
  return [...events, event];
}

/**
 * Track a mutation ID against a record that is otherwise left unchanged (no
 * new user decision, no plan change). This still has to be persisted: a
 * mutation ID is only safe to reuse for idempotent replay once it is on the
 * record's event ledger, so a later call reusing this exact ID with
 * *different* input can still be caught by `checkReplay` as a conflict
 * instead of being silently applied. The record's `revision` is left
 * unchanged because nothing observable changed for callers to react to.
 */
function recordSeenEvent(
  existing: SpecDecisionRecord,
  mutationId: string,
  hash: string,
  type: SpecDecisionEvent['type'],
  at: string,
): SpecDecisionRecord {
  return {
    ...existing,
    events: appendEvent(existing.events, {
      id: mutationId,
      type,
      requestHash: hash,
      revision: existing.revision,
      createdAt: at,
    }),
  };
}

/** Replay-safe idempotency check shared by every mutating operation below. */
function checkReplay(
  existing: SpecDecisionRecord,
  mutationId: string,
  hash: string,
): SpecDecisionRecord | undefined {
  const event = existing.events.find((item) => item.id === mutationId);
  if (!event) return undefined;
  if (event.requestHash !== hash)
    throw new SpecDecisionError(
      'mutationId was already committed with different input.',
      'SPEC_DECISION_IDEMPOTENCY_CONFLICT',
    );
  return existing;
}

function requireExisting(
  existing: SpecDecisionRecord | null,
  taskId: string,
): asserts existing is SpecDecisionRecord {
  if (!existing)
    throw new SpecDecisionError(
      `No spec decision is recorded for task ${taskId}.`,
      'SPEC_DECISION_NOT_FOUND',
    );
}

function requireCurrentRevision(existing: SpecDecisionRecord, expectedRevision: number) {
  if (existing.revision !== expectedRevision)
    throw new SpecDecisionError(
      'Spec decision revision changed.',
      'SPEC_DECISION_REVISION_CONFLICT',
      {
        expectedRevision,
        actualRevision: existing.revision,
      },
    );
}

export type PresentSpecDecisionInput = {
  taskId: string;
  /** Reference to the plan a user can open — the task's registered plan link, not a hardcoded path. */
  planRef: string;
  /** SHA-256 digest of the exact plan content/revision being presented. */
  planDigest: string;
  /** Concise end-of-spec summary shown alongside the plan link and the three choices. */
  summary: string;
  mutationId?: string;
};

/**
 * Record (or idempotently re-record) that a spec-only flow completed and a
 * decision should be offered: approve and build, add notes, or keep for
 * later. Safe to call repeatedly for the same completion event (same
 * `mutationId`) or for the same unchanged plan (a valid current approval is
 * preserved and no new prompt/task/build is implied) — see
 * `docs/workflows.md`.
 */
export async function presentSpecDecision(
  root: string,
  input: PresentSpecDecisionInput,
  options: SpecDecisionMutationOptions = {},
): Promise<SpecDecisionRecord> {
  requireTaskId(input.taskId);
  requireDigest(input.planDigest, 'planDigest');
  requireText(input.planRef, 'planRef');
  requireText(input.summary, 'summary');
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = specDecisionRequestHash({
    type: 'present',
    taskId: input.taskId,
    planRef: input.planRef,
    planDigest: input.planDigest,
    summary: input.summary,
    mutationId,
  });
  return upsertSpecDecision(root, input.taskId, (existing): SpecDecisionMutationResult => {
    if (existing) {
      const replay = checkReplay(existing, mutationId, hash);
      if (replay) return { record: replay, persist: false };
    }
    const at = iso(clock);
    if (!existing) {
      const record: SpecDecisionRecord = {
        schemaVersion: 1,
        decisionId: `decision_${randomUUID()}`,
        taskId: input.taskId,
        revision: 1,
        status: 'pending',
        planRef: input.planRef,
        planDigest: input.planDigest,
        planRevision: 1,
        summary: input.summary,
        notes: [],
        approval: null,
        buildStarted: false,
        buildStartedAt: null,
        pausedAt: null,
        events: [
          { id: mutationId, type: 'presented', requestHash: hash, revision: 1, createdAt: at },
        ],
        createdAt: at,
        updatedAt: at,
      };
      return { record, persist: true };
    }
    if (existing.planDigest === input.planDigest) {
      // Same exact plan content already on record.
      if (existing.status === 'approved') {
        // A valid current approval already covers this content: no new
        // decision is needed and nothing is re-prompted or rebuilt. The
        // mutation ID is still tracked so a later reuse with different
        // input is caught as a conflict instead of silently applied.
        return {
          record: recordSeenEvent(existing, mutationId, hash, 'presented', at),
          persist: true,
        };
      }
      const unchanged = existing.planRef === input.planRef && existing.summary === input.summary;
      if (unchanged)
        return {
          record: recordSeenEvent(existing, mutationId, hash, 'presented', at),
          persist: true,
        };
      const record: SpecDecisionRecord = {
        ...existing,
        planRef: input.planRef,
        summary: input.summary,
        revision: existing.revision + 1,
        events: appendEvent(existing.events, {
          id: mutationId,
          type: 'presented',
          requestHash: hash,
          revision: existing.revision + 1,
          createdAt: at,
        }),
        updatedAt: at,
      };
      return { record, persist: true };
    }
    // The plan changed since the last decision point: any existing approval
    // is stale for this new content, so the decision is re-presented fresh.
    const record: SpecDecisionRecord = {
      ...existing,
      status: 'pending',
      planRef: input.planRef,
      planDigest: input.planDigest,
      planRevision: existing.planRevision + 1,
      summary: input.summary,
      approval: null,
      buildStarted: false,
      buildStartedAt: null,
      revision: existing.revision + 1,
      events: appendEvent(existing.events, {
        id: mutationId,
        type: 'presented',
        requestHash: hash,
        revision: existing.revision + 1,
        createdAt: at,
      }),
      updatedAt: at,
    };
    return { record, persist: true };
  });
}

export type ApproveSpecDecisionInput = {
  taskId: string;
  expectedRevision: number;
  /** Must equal the plan digest currently on record; otherwise the approval is rejected as stale. */
  planDigest: string;
  scope: string;
  reference: string;
  mutationId?: string;
};

/**
 * Approve-and-build: records approval bound to the exact plan digest current
 * at approval time, reusing the same SHA-256 digest-binding approach as
 * `WorkflowApproval` in `contracts.ts`. Rejects with `SPEC_DECISION_PLAN_STALE`
 * when the supplied digest no longer matches the current plan (for example,
 * because notes were added and the plan was revised after this approval was
 * prepared).
 */
export async function approveSpecDecision(
  root: string,
  input: ApproveSpecDecisionInput,
  options: SpecDecisionMutationOptions = {},
): Promise<SpecDecisionRecord> {
  requireTaskId(input.taskId);
  requireRevision(input.expectedRevision);
  requireDigest(input.planDigest, 'planDigest');
  requireText(input.scope, 'scope');
  requireText(input.reference, 'reference');
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = specDecisionRequestHash({
    type: 'approve',
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    planDigest: input.planDigest,
    scope: input.scope,
    reference: input.reference,
    mutationId,
  });
  return upsertSpecDecision(root, input.taskId, (existing): SpecDecisionMutationResult => {
    requireExisting(existing, input.taskId);
    const replay = checkReplay(existing, mutationId, hash);
    if (replay) return { record: replay, persist: false };
    requireCurrentRevision(existing, input.expectedRevision);
    if (existing.planDigest !== input.planDigest)
      throw new SpecDecisionError(
        'This approval no longer matches the current plan; re-read the revised plan before approving.',
        'SPEC_DECISION_PLAN_STALE',
        { currentPlanDigest: existing.planDigest, suppliedPlanDigest: input.planDigest },
      );
    const at = iso(clock);
    if (
      existing.status === 'approved' &&
      existing.approval &&
      existing.approval.planDigest === input.planDigest &&
      existing.approval.scope === input.scope &&
      existing.approval.reference === input.reference
    ) {
      // Already granted and still valid for the current plan: preserve it
      // rather than asking for a duplicate confirmation, while still
      // tracking this mutation ID against replay-with-different-input.
      return { record: recordSeenEvent(existing, mutationId, hash, 'approved', at), persist: true };
    }
    const record: SpecDecisionRecord = {
      ...existing,
      status: 'approved',
      approval: {
        planDigest: input.planDigest,
        planRevision: existing.planRevision,
        scope: input.scope,
        reference: input.reference,
        approvedAt: at,
      },
      buildStarted: false,
      buildStartedAt: null,
      revision: existing.revision + 1,
      events: appendEvent(existing.events, {
        id: mutationId,
        type: 'approved',
        requestHash: hash,
        revision: existing.revision + 1,
        createdAt: at,
      }),
      updatedAt: at,
    };
    return { record, persist: true };
  });
}

export type AddSpecDecisionNotesInput = {
  taskId: string;
  expectedRevision: number;
  /** Free-form revision notes / requested changes. */
  notes: string;
  /** Updated plan digest after the plan was revised to reflect the notes. */
  planDigest: string;
  /** Updated plan reference, if it changed; defaults to the current planRef. */
  planRef?: string;
  mutationId?: string;
};

/**
 * Attach revision notes to the task's current plan, update the plan
 * reference/digest to the revised content, and clear any prior approval —
 * a stale approval can never authorize a changed plan. The caller (the
 * `latchkit-spec` skill) is expected to have already revised the plan note
 * before calling this; re-present the returned (now-pending) record and the
 * three choices again.
 */
export async function addSpecDecisionNotes(
  root: string,
  input: AddSpecDecisionNotesInput,
  options: SpecDecisionMutationOptions = {},
): Promise<SpecDecisionRecord> {
  requireTaskId(input.taskId);
  requireRevision(input.expectedRevision);
  requireText(input.notes, 'notes');
  requireDigest(input.planDigest, 'planDigest');
  if (input.planRef !== undefined) requireText(input.planRef, 'planRef');
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = specDecisionRequestHash({
    type: 'notes',
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    notes: input.notes,
    planDigest: input.planDigest,
    planRef: input.planRef ?? null,
    mutationId,
  });
  return upsertSpecDecision(root, input.taskId, (existing): SpecDecisionMutationResult => {
    requireExisting(existing, input.taskId);
    const replay = checkReplay(existing, mutationId, hash);
    if (replay) return { record: replay, persist: false };
    requireCurrentRevision(existing, input.expectedRevision);
    if (existing.notes.length >= MAX_NOTES)
      throw new SpecDecisionError('Spec decision note history is full.', 'SPEC_DECISION_INVALID');
    const at = iso(clock);
    const record: SpecDecisionRecord = {
      ...existing,
      status: 'pending',
      approval: null,
      buildStarted: false,
      buildStartedAt: null,
      planRef: input.planRef ?? existing.planRef,
      planDigest: input.planDigest,
      planRevision: existing.planRevision + 1,
      notes: [
        ...existing.notes,
        {
          id: `note_${randomUUID()}`,
          text: input.notes,
          planDigestBefore: existing.planDigest,
          planRevisionBefore: existing.planRevision,
          createdAt: at,
        },
      ],
      revision: existing.revision + 1,
      events: appendEvent(existing.events, {
        id: mutationId,
        type: 'notes-added',
        requestHash: hash,
        revision: existing.revision + 1,
        createdAt: at,
      }),
      updatedAt: at,
    };
    return { record, persist: true };
  });
}

export type PauseSpecDecisionInput = {
  taskId: string;
  expectedRevision: number;
  mutationId?: string;
};

/**
 * Explicit pause / "keep for later". Dismissing the prompt or leaving it
 * unanswered needs no call at all — the record already stays `pending`
 * without launching implementation — this is only for recording an explicit
 * pause choice for audit/resume display.
 */
export async function pauseSpecDecision(
  root: string,
  input: PauseSpecDecisionInput,
  options: SpecDecisionMutationOptions = {},
): Promise<SpecDecisionRecord> {
  requireTaskId(input.taskId);
  requireRevision(input.expectedRevision);
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = specDecisionRequestHash({
    type: 'pause',
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    mutationId,
  });
  return upsertSpecDecision(root, input.taskId, (existing): SpecDecisionMutationResult => {
    requireExisting(existing, input.taskId);
    const replay = checkReplay(existing, mutationId, hash);
    if (replay) return { record: replay, persist: false };
    requireCurrentRevision(existing, input.expectedRevision);
    const at = iso(clock);
    const record: SpecDecisionRecord = {
      ...existing,
      pausedAt: at,
      revision: existing.revision + 1,
      events: appendEvent(existing.events, {
        id: mutationId,
        type: 'paused',
        requestHash: hash,
        revision: existing.revision + 1,
        createdAt: at,
      }),
      updatedAt: at,
    };
    return { record, persist: true };
  });
}

export type MarkSpecBuildStartedInput = {
  taskId: string;
  expectedRevision: number;
  mutationId?: string;
};

/**
 * Marks that the approved plan's build/implementation continuation has
 * started, so a repeated completion or lifecycle event cannot trigger a
 * second build for the same approval. Requires a current `approved` status;
 * an already-started build is returned unchanged (idempotent no-op) rather
 * than erroring, so a retried caller never double-launches implementation.
 */
export async function markSpecBuildStarted(
  root: string,
  input: MarkSpecBuildStartedInput,
  options: SpecDecisionMutationOptions = {},
): Promise<SpecDecisionRecord> {
  requireTaskId(input.taskId);
  requireRevision(input.expectedRevision);
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = specDecisionRequestHash({
    type: 'build-started',
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    mutationId,
  });
  return upsertSpecDecision(root, input.taskId, (existing): SpecDecisionMutationResult => {
    requireExisting(existing, input.taskId);
    const replay = checkReplay(existing, mutationId, hash);
    if (replay) return { record: replay, persist: false };
    if (existing.status !== 'approved')
      throw new SpecDecisionError(
        'Build can only start for an approved spec decision.',
        'SPEC_DECISION_NOT_APPROVED',
      );
    if (existing.buildStarted)
      return {
        record: recordSeenEvent(existing, mutationId, hash, 'build-started', iso(clock)),
        persist: true,
      };
    requireCurrentRevision(existing, input.expectedRevision);
    const at = iso(clock);
    const record: SpecDecisionRecord = {
      ...existing,
      buildStarted: true,
      buildStartedAt: at,
      revision: existing.revision + 1,
      events: appendEvent(existing.events, {
        id: mutationId,
        type: 'build-started',
        requestHash: hash,
        revision: existing.revision + 1,
        createdAt: at,
      }),
      updatedAt: at,
    };
    return { record, persist: true };
  });
}
