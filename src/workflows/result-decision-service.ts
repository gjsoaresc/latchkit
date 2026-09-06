import { randomUUID } from 'node:crypto';
import {
  MAX_RESULT_DECISION_TEXT_BYTES,
  ResultDecisionError,
  resultDecisionRequestHash,
  type ResultDecisionChangeScope,
  type ResultDecisionEvent,
  type ResultDecisionRecord,
  type ResultDecisionScopeAuthorization,
} from './result-decision-contracts.js';
import {
  listResultDecisions as listResultDecisionsUnfiltered,
  upsertResultDecision,
  type ResultDecisionMutationResult,
} from './result-decision-store.js';

export { readResultDecision as inspectResultDecision } from './result-decision-store.js';
export const listResultDecisions = listResultDecisionsUnfiltered;
export {
  selectResultDecisionPresentation,
  type ResultDecisionPresentation,
  type ResultDecisionPresentationMode,
} from './result-decision-presentation.js';
export type {
  ResultDecisionRecord,
  ResultDecisionStatus,
  ResultDecisionChangeScope,
  ResultDecisionApproval,
  ResultDecisionNote,
  ResultDecisionScopeAuthorization,
} from './result-decision-contracts.js';
export { ResultDecisionError } from './result-decision-contracts.js';

const TASK_ID_PATTERN = /^task_[0-9a-f-]{36}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_NOTES = 64;
const MAX_REFS = 64;
const MAX_CRITERIA = 128;
const MAX_REF_BYTES = 2 * 1024;

export type ResultDecisionMutationOptions = { clock?: () => Date };

function iso(clock: () => Date) {
  return clock().toISOString();
}

function normalizeMutationId(value?: string): string {
  if (value === undefined) return `event_${randomUUID()}`;
  if (!/^event_[0-9a-f-]{36}$/i.test(value))
    throw new ResultDecisionError(
      'mutationId must be a stable event ID.',
      'RESULT_DECISION_INVALID',
    );
  return value;
}

function requireTaskId(taskId: string) {
  if (!TASK_ID_PATTERN.test(taskId))
    throw new ResultDecisionError('taskId must be a stable task ID.', 'RESULT_DECISION_INVALID');
}

function requireDigest(value: string, field: string) {
  if (!DIGEST_PATTERN.test(value))
    throw new ResultDecisionError(
      `${field} must be a lowercase SHA-256 digest.`,
      'RESULT_DECISION_INVALID',
    );
}

function requireText(value: string, field: string, maximum = MAX_RESULT_DECISION_TEXT_BYTES) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum)
    throw new ResultDecisionError(`${field} is required and bounded.`, 'RESULT_DECISION_INVALID');
}

function optionalText(
  value: string | undefined,
  field: string,
  maximum = MAX_RESULT_DECISION_TEXT_BYTES,
): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum)
    throw new ResultDecisionError(`${field} must be bounded text.`, 'RESULT_DECISION_INVALID');
  return value;
}

function optionalTextArray(
  value: string[] | undefined,
  field: string,
  maxItems: number,
  maxItemBytes: number,
): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every(
      (item) => typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= maxItemBytes,
    )
  )
    throw new ResultDecisionError(
      `${field} must be a bounded array of bounded text.`,
      'RESULT_DECISION_INVALID',
    );
  return value;
}

function requireRevision(value: number) {
  if (!Number.isInteger(value) || value < 1)
    throw new ResultDecisionError(
      'expectedRevision must be a positive integer.',
      'RESULT_DECISION_INVALID',
    );
}

function appendEvent(
  events: ResultDecisionEvent[],
  event: ResultDecisionEvent,
): ResultDecisionEvent[] {
  return [...events, event];
}

/**
 * Track a mutation ID against a record that is otherwise left unchanged (no
 * new user decision, no snapshot change). This still has to be persisted: a
 * mutation ID is only safe to reuse for idempotent replay once it is on the
 * record's event ledger, so a later call reusing this exact ID with
 * *different* input can still be caught by `checkReplay` as a conflict
 * instead of being silently applied. The record's `revision` is left
 * unchanged because nothing observable changed for callers to react to.
 */
function recordSeenEvent(
  existing: ResultDecisionRecord,
  mutationId: string,
  hash: string,
  type: ResultDecisionEvent['type'],
  at: string,
): ResultDecisionRecord {
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
  existing: ResultDecisionRecord,
  mutationId: string,
  hash: string,
): ResultDecisionRecord | undefined {
  const event = existing.events.find((item) => item.id === mutationId);
  if (!event) return undefined;
  if (event.requestHash !== hash)
    throw new ResultDecisionError(
      'mutationId was already committed with different input.',
      'RESULT_DECISION_IDEMPOTENCY_CONFLICT',
    );
  return existing;
}

function requireExisting(
  existing: ResultDecisionRecord | null,
  taskId: string,
): asserts existing is ResultDecisionRecord {
  if (!existing)
    throw new ResultDecisionError(
      `No result decision is recorded for task ${taskId}.`,
      'RESULT_DECISION_NOT_FOUND',
    );
}

function requireCurrentRevision(existing: ResultDecisionRecord, expectedRevision: number) {
  if (existing.revision !== expectedRevision)
    throw new ResultDecisionError(
      'Result decision revision changed.',
      'RESULT_DECISION_REVISION_CONFLICT',
      {
        expectedRevision,
        actualRevision: existing.revision,
      },
    );
}

export type PresentResultDecisionInput = {
  taskId: string;
  /** Primary link/path to the reviewable diff or result location. */
  resultRef: string;
  /** SHA-256 digest of the exact reviewed snapshot (diff plus evidence summary). */
  resultDigest: string;
  /** Concise summary of what changed. */
  summary: string;
  /** Additional links to relevant diff/artifacts. */
  artifactRefs?: string[];
  /** Completed acceptance criteria as of this snapshot. */
  completedCriteria?: string[];
  /** Actual verification results as of this snapshot; never rewritten by approval. */
  verificationResults: string;
  /** Remaining gaps as of this snapshot; omit or pass '' when none are known. */
  remainingGaps?: string;
  mutationId?: string;
};

/**
 * Record (or idempotently re-record) that an execution completed and a
 * reviewable result should be offered: approve, request changes, or review
 * later. Safe to call repeatedly for the same completion event (same
 * `mutationId`) or for the same unchanged result (a valid current approval
 * is preserved and no new prompt/correction is implied) — see
 * `docs/workflows.md`. A changed `resultDigest` always invalidates any prior
 * approval, whatever else changed.
 */
export async function presentResultDecision(
  root: string,
  input: PresentResultDecisionInput,
  options: ResultDecisionMutationOptions = {},
): Promise<ResultDecisionRecord> {
  requireTaskId(input.taskId);
  requireDigest(input.resultDigest, 'resultDigest');
  requireText(input.resultRef, 'resultRef');
  requireText(input.summary, 'summary');
  requireText(input.verificationResults, 'verificationResults');
  const artifactRefs = optionalTextArray(
    input.artifactRefs,
    'artifactRefs',
    MAX_REFS,
    MAX_REF_BYTES,
  );
  const completedCriteria = optionalTextArray(
    input.completedCriteria,
    'completedCriteria',
    MAX_CRITERIA,
    MAX_REF_BYTES,
  );
  const remainingGaps = optionalText(input.remainingGaps, 'remainingGaps');
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = resultDecisionRequestHash({
    type: 'present',
    taskId: input.taskId,
    resultRef: input.resultRef,
    resultDigest: input.resultDigest,
    summary: input.summary,
    artifactRefs,
    completedCriteria,
    verificationResults: input.verificationResults,
    remainingGaps,
    mutationId,
  });
  return upsertResultDecision(root, input.taskId, (existing): ResultDecisionMutationResult => {
    if (existing) {
      const replay = checkReplay(existing, mutationId, hash);
      if (replay) return { record: replay, persist: false };
    }
    const at = iso(clock);
    if (!existing) {
      const record: ResultDecisionRecord = {
        schemaVersion: 1,
        decisionId: `resultdecision_${randomUUID()}`,
        taskId: input.taskId,
        revision: 1,
        status: 'pending',
        resultRef: input.resultRef,
        artifactRefs,
        resultDigest: input.resultDigest,
        resultRevision: 1,
        summary: input.summary,
        completedCriteria,
        verificationResults: input.verificationResults,
        remainingGaps,
        notes: [],
        approval: null,
        deferredAt: null,
        events: [
          { id: mutationId, type: 'presented', requestHash: hash, revision: 1, createdAt: at },
        ],
        createdAt: at,
        updatedAt: at,
      };
      return { record, persist: true };
    }
    if (existing.resultDigest === input.resultDigest) {
      // Same exact reviewed snapshot already on record.
      if (existing.status === 'approved') {
        // A valid current approval already covers this content: no new
        // decision is needed and nothing is re-prompted. The mutation ID is
        // still tracked so a later reuse with different input is caught as
        // a conflict instead of silently applied.
        return {
          record: recordSeenEvent(existing, mutationId, hash, 'presented', at),
          persist: true,
        };
      }
      const unchanged =
        existing.resultRef === input.resultRef &&
        existing.summary === input.summary &&
        existing.verificationResults === input.verificationResults &&
        existing.remainingGaps === remainingGaps &&
        JSON.stringify(existing.artifactRefs) === JSON.stringify(artifactRefs) &&
        JSON.stringify(existing.completedCriteria) === JSON.stringify(completedCriteria);
      if (unchanged)
        return {
          record: recordSeenEvent(existing, mutationId, hash, 'presented', at),
          persist: true,
        };
      // Cosmetic update to the same reviewed snapshot: update the recap
      // text but preserve status/approval, since the identity of the
      // reviewed content (the digest) has not changed.
      const record: ResultDecisionRecord = {
        ...existing,
        resultRef: input.resultRef,
        artifactRefs,
        summary: input.summary,
        completedCriteria,
        verificationResults: input.verificationResults,
        remainingGaps,
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
    // The result changed since the last decision point (a correction landed,
    // or a later run produced a different snapshot): any existing approval
    // is stale for this new content, so the decision is re-presented fresh.
    const record: ResultDecisionRecord = {
      ...existing,
      status: 'pending',
      resultRef: input.resultRef,
      artifactRefs,
      resultDigest: input.resultDigest,
      resultRevision: existing.resultRevision + 1,
      summary: input.summary,
      completedCriteria,
      verificationResults: input.verificationResults,
      remainingGaps,
      approval: null,
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

export type ApproveResultDecisionInput = {
  taskId: string;
  expectedRevision: number;
  /** Must equal the result digest currently on record; otherwise rejected as stale. */
  resultDigest: string;
  /** Optional free-form note, e.g. accepting a known limitation. */
  note?: string;
  mutationId?: string;
};

/**
 * Approve the reviewed result: records acceptance bound to the exact result
 * digest current at approval time, reusing the same SHA-256 digest-binding
 * approach as `WorkflowApproval` and `SpecDecisionApproval`. Rejects with
 * `RESULT_DECISION_SNAPSHOT_STALE` when the supplied digest no longer
 * matches the current result (a correction landed since this approval was
 * prepared). Never modifies `verificationResults`, `completedCriteria`, or
 * `remainingGaps` — approval records user acceptance, it cannot rewrite
 * evidence as passing, and a failed or incomplete check stays visible
 * afterward. Approval accepts the task result only; it grants no merge,
 * publication, deployment, or destructive-cleanup authorization.
 */
export async function approveResultDecision(
  root: string,
  input: ApproveResultDecisionInput,
  options: ResultDecisionMutationOptions = {},
): Promise<ResultDecisionRecord> {
  requireTaskId(input.taskId);
  requireRevision(input.expectedRevision);
  requireDigest(input.resultDigest, 'resultDigest');
  const note = optionalText(input.note, 'note');
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = resultDecisionRequestHash({
    type: 'approve',
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    resultDigest: input.resultDigest,
    note,
    mutationId,
  });
  return upsertResultDecision(root, input.taskId, (existing): ResultDecisionMutationResult => {
    requireExisting(existing, input.taskId);
    const replay = checkReplay(existing, mutationId, hash);
    if (replay) return { record: replay, persist: false };
    requireCurrentRevision(existing, input.expectedRevision);
    if (existing.resultDigest !== input.resultDigest)
      throw new ResultDecisionError(
        'This approval no longer matches the current result; re-read the updated result before approving.',
        'RESULT_DECISION_SNAPSHOT_STALE',
        { currentResultDigest: existing.resultDigest, suppliedResultDigest: input.resultDigest },
      );
    const at = iso(clock);
    if (
      existing.status === 'approved' &&
      existing.approval &&
      existing.approval.resultDigest === input.resultDigest &&
      existing.approval.note === note
    ) {
      // Already granted and still valid for the current result: preserve it
      // rather than asking for a duplicate confirmation, while still
      // tracking this mutation ID against replay-with-different-input.
      return { record: recordSeenEvent(existing, mutationId, hash, 'approved', at), persist: true };
    }
    const record: ResultDecisionRecord = {
      ...existing,
      status: 'approved',
      approval: {
        resultDigest: input.resultDigest,
        resultRevision: existing.resultRevision,
        note,
        approvedAt: at,
      },
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

export type AddResultDecisionNotesInput = {
  taskId: string;
  expectedRevision: number;
  /** Free-form feedback / requested corrections. */
  notes: string;
  /** Must equal the result digest the feedback is reacting to; rejected as stale otherwise. */
  resultDigest: string;
  /**
   * Whether the requested change fits the task's existing authorization
   * ('in-scope', the default) or is materially new scope. 'new-scope'
   * requires `scopeAuthorization` so a correction can never silently expand
   * the task under the original grant.
   */
  changeScope?: ResultDecisionChangeScope;
  scopeAuthorization?: ResultDecisionScopeAuthorization;
  mutationId?: string;
};

/**
 * Attach feedback to the task's current reviewed result and move it to
 * `changes-requested`, clearing any prior approval — a stale approval can
 * never authorize a result that is now under revision. Unlike the end-of-spec
 * decision's notes (#97), this does not itself update the result content:
 * the caller routes `notes` into the existing bounded build/fix flow for the
 * same task with this context, then calls `presentResultDecision` again with
 * the corrected result's new digest, which re-presents it for a fresh
 * decision. This function never touches `verificationResults`,
 * `completedCriteria`, or `remainingGaps` — recording feedback does not
 * rewrite evidence.
 *
 * An 'in-scope' note preserves the task's existing authorization; a
 * 'new-scope' note requires its own `scopeAuthorization` rather than
 * silently expanding the task or resetting any repair budget owned by the
 * typed delivery workflow or the invoking skill's own bounded loop — this
 * module never touches those counters.
 */
export async function addResultDecisionNotes(
  root: string,
  input: AddResultDecisionNotesInput,
  options: ResultDecisionMutationOptions = {},
): Promise<ResultDecisionRecord> {
  requireTaskId(input.taskId);
  requireRevision(input.expectedRevision);
  requireText(input.notes, 'notes');
  requireDigest(input.resultDigest, 'resultDigest');
  const changeScope: ResultDecisionChangeScope = input.changeScope ?? 'in-scope';
  if (!['in-scope', 'new-scope'].includes(changeScope))
    throw new ResultDecisionError(
      'changeScope must be in-scope or new-scope.',
      'RESULT_DECISION_INVALID',
    );
  if (changeScope === 'new-scope') {
    if (
      !input.scopeAuthorization ||
      typeof input.scopeAuthorization.scope !== 'string' ||
      !input.scopeAuthorization.scope.trim() ||
      typeof input.scopeAuthorization.reference !== 'string' ||
      !input.scopeAuthorization.reference.trim()
    )
      throw new ResultDecisionError(
        'New-scope feedback requires explicit scopeAuthorization (scope and reference); it cannot silently expand the task.',
        'RESULT_DECISION_NEW_SCOPE_AUTHORIZATION_REQUIRED',
      );
  } else if (input.scopeAuthorization !== undefined)
    throw new ResultDecisionError(
      'scopeAuthorization is only accepted for new-scope feedback.',
      'RESULT_DECISION_INVALID',
    );
  const scopeAuthorization: ResultDecisionScopeAuthorization | null =
    changeScope === 'new-scope'
      ? { scope: input.scopeAuthorization!.scope, reference: input.scopeAuthorization!.reference }
      : null;
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = resultDecisionRequestHash({
    type: 'notes',
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    notes: input.notes,
    resultDigest: input.resultDigest,
    changeScope,
    scopeAuthorization,
    mutationId,
  });
  return upsertResultDecision(root, input.taskId, (existing): ResultDecisionMutationResult => {
    requireExisting(existing, input.taskId);
    const replay = checkReplay(existing, mutationId, hash);
    if (replay) return { record: replay, persist: false };
    requireCurrentRevision(existing, input.expectedRevision);
    if (existing.resultDigest !== input.resultDigest)
      throw new ResultDecisionError(
        'This feedback no longer matches the current result; re-read the current result before adding notes.',
        'RESULT_DECISION_SNAPSHOT_STALE',
        { currentResultDigest: existing.resultDigest, suppliedResultDigest: input.resultDigest },
      );
    if (existing.notes.length >= MAX_NOTES)
      throw new ResultDecisionError(
        'Result decision note history is full.',
        'RESULT_DECISION_INVALID',
      );
    const at = iso(clock);
    const record: ResultDecisionRecord = {
      ...existing,
      status: 'changes-requested',
      approval: null,
      notes: [
        ...existing.notes,
        {
          id: `note_${randomUUID()}`,
          text: input.notes,
          changeScope,
          scopeAuthorization,
          resultDigestBefore: existing.resultDigest,
          resultRevisionBefore: existing.resultRevision,
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

export type DeferResultDecisionInput = {
  taskId: string;
  expectedRevision: number;
  mutationId?: string;
};

/**
 * Explicit "review later". Dismissing the prompt or leaving it unanswered
 * needs no call at all — the record already stays exactly as presented,
 * leaving review pending — this is only for recording an explicit defer
 * choice for audit/resume display.
 */
export async function deferResultDecision(
  root: string,
  input: DeferResultDecisionInput,
  options: ResultDecisionMutationOptions = {},
): Promise<ResultDecisionRecord> {
  requireTaskId(input.taskId);
  requireRevision(input.expectedRevision);
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(input.mutationId);
  const hash = resultDecisionRequestHash({
    type: 'defer',
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    mutationId,
  });
  return upsertResultDecision(root, input.taskId, (existing): ResultDecisionMutationResult => {
    requireExisting(existing, input.taskId);
    const replay = checkReplay(existing, mutationId, hash);
    if (replay) return { record: replay, persist: false };
    requireCurrentRevision(existing, input.expectedRevision);
    const at = iso(clock);
    const record: ResultDecisionRecord = {
      ...existing,
      deferredAt: at,
      revision: existing.revision + 1,
      events: appendEvent(existing.events, {
        id: mutationId,
        type: 'deferred',
        requestHash: hash,
        revision: existing.revision + 1,
        createdAt: at,
      }),
      updatedAt: at,
    };
    return { record, persist: true };
  });
}
