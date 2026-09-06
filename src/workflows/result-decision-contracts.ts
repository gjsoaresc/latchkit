import { sha256, WorkflowError } from './contracts.js';

/**
 * Durable state for the end-of-execution result decision offered after a
 * build/fix task finishes: approve the result, request changes with notes,
 * or review later. This is additive to (not a replacement for) the typed
 * delivery workflow in `contracts.ts`/`service.ts` and to the end-of-spec
 * decision in `spec-decision-contracts.ts` (#97); it reuses that module's
 * SHA-256 digest primitive so an approval is bound to the exact reviewed
 * result snapshot it was granted against, the same way `WorkflowApproval`
 * binds to a plan digest and `SpecDecisionApproval` binds to a plan digest.
 *
 * Unlike the spec decision (where "notes" already carries the revised plan
 * content in the same call), a result decision's notes are feedback that
 * precedes a correction: the record moves to `changes-requested` and keeps
 * its current `resultDigest` until the caller re-presents an updated result
 * (a new digest) after routing the notes through the existing bounded
 * build/fix flow. See `result-decision-service.ts`.
 */
export const RESULT_DECISION_SCHEMA_VERSION = 1;
export const RESULT_DECISION_STATE_PATH = '.latchkit/workflows/result-decisions-v1.json';
export const MAX_RESULT_DECISION_TEXT_BYTES = 8 * 1024;
const MAX_REF_BYTES = 2 * 1024;
const MAX_REFS = 64;
const MAX_CRITERIA = 128;
const MAX_NOTES = 64;
const MAX_EVENTS = 256;

export type ResultDecisionStatus = 'pending' | 'changes-requested' | 'approved';
export type ResultDecisionChangeScope = 'in-scope' | 'new-scope';

export type ResultDecisionScopeAuthorization = { scope: string; reference: string };

export type ResultDecisionNote = {
  id: string;
  text: string;
  /**
   * Whether the requested change is judged to fit the task's existing
   * authorization ('in-scope', the default routing into the existing
   * bounded build/fix flow) or is materially new scope. A 'new-scope' note
   * must carry its own `scopeAuthorization` rather than silently reuse the
   * task's original authorization.
   */
  changeScope: ResultDecisionChangeScope;
  scopeAuthorization: ResultDecisionScopeAuthorization | null;
  resultDigestBefore: string;
  resultRevisionBefore: number;
  createdAt: string;
};

export type ResultDecisionApproval = {
  resultDigest: string;
  resultRevision: number;
  /** Optional free-form acceptance note, e.g. accepting a known limitation. */
  note: string;
  approvedAt: string;
};

export type ResultDecisionEvent = {
  id: string;
  type: 'presented' | 'approved' | 'notes-added' | 'deferred';
  requestHash: string;
  revision: number;
  createdAt: string;
};

export type ResultDecisionRecord = {
  schemaVersion: 1;
  decisionId: string;
  taskId: string;
  revision: number;
  status: ResultDecisionStatus;
  /** Primary link/path to the reviewable diff or result location. */
  resultRef: string;
  /** Additional links to relevant diff/artifacts. */
  artifactRefs: string[];
  /** SHA-256 digest of the exact reviewed snapshot (diff plus evidence summary). */
  resultDigest: string;
  resultRevision: number;
  /** Concise summary of what changed. */
  summary: string;
  /** Completed acceptance criteria as of this snapshot. */
  completedCriteria: string[];
  /** Actual verification results as of this snapshot (never rewritten by approval). */
  verificationResults: string;
  /** Remaining gaps as of this snapshot; empty string means none declared. */
  remainingGaps: string;
  notes: ResultDecisionNote[];
  approval: ResultDecisionApproval | null;
  deferredAt: string | null;
  events: ResultDecisionEvent[];
  createdAt: string;
  updatedAt: string;
};

export class ResultDecisionError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code = 'RESULT_DECISION_INVALID', details?: unknown) {
    super(message);
    this.name = 'ResultDecisionError';
    this.code = code;
    this.details = details;
  }
}

const digestPattern = /^[a-f0-9]{64}$/;
const boundedText = (value: unknown, maximum = MAX_RESULT_DECISION_TEXT_BYTES): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum;
const boundedOptionalText = (
  value: unknown,
  maximum = MAX_RESULT_DECISION_TEXT_BYTES,
): value is string => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum;
const boundedTextArray = (
  value: unknown,
  maxItems: number,
  maxItemBytes: number,
): value is string[] =>
  Array.isArray(value) &&
  value.length <= maxItems &&
  value.every((item) => boundedText(item, maxItemBytes));

function exactKeys(candidate: object, expected: readonly string[]): boolean {
  const actual = Object.keys(candidate).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validScopeAuthorization(value: unknown): value is ResultDecisionScopeAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const authorization = value as Partial<ResultDecisionScopeAuthorization>;
  return (
    exactKeys(value, ['scope', 'reference']) &&
    boundedText(authorization.scope) &&
    boundedText(authorization.reference)
  );
}

function validNote(value: unknown): value is ResultDecisionNote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const note = value as Partial<ResultDecisionNote>;
  if (
    !exactKeys(value, [
      'id',
      'text',
      'changeScope',
      'scopeAuthorization',
      'resultDigestBefore',
      'resultRevisionBefore',
      'createdAt',
    ]) ||
    !/^note_[0-9a-f-]{36}$/i.test(note.id ?? '') ||
    !boundedText(note.text) ||
    !['in-scope', 'new-scope'].includes(note.changeScope ?? '') ||
    !digestPattern.test(note.resultDigestBefore ?? '') ||
    !Number.isInteger(note.resultRevisionBefore) ||
    (note.resultRevisionBefore ?? 0) < 1 ||
    !isIsoDate(note.createdAt)
  )
    return false;
  if (note.changeScope === 'new-scope') return validScopeAuthorization(note.scopeAuthorization);
  return note.scopeAuthorization === null;
}

function validApproval(value: unknown): value is ResultDecisionApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const approval = value as Partial<ResultDecisionApproval>;
  return (
    exactKeys(value, ['resultDigest', 'resultRevision', 'note', 'approvedAt']) &&
    digestPattern.test(approval.resultDigest ?? '') &&
    Number.isInteger(approval.resultRevision) &&
    (approval.resultRevision ?? 0) >= 1 &&
    boundedOptionalText(approval.note) &&
    isIsoDate(approval.approvedAt)
  );
}

function validEvent(value: unknown): value is ResultDecisionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<ResultDecisionEvent>;
  return (
    exactKeys(value, ['id', 'type', 'requestHash', 'revision', 'createdAt']) &&
    /^event_[0-9a-f-]{36}$/i.test(event.id ?? '') &&
    ['presented', 'approved', 'notes-added', 'deferred'].includes(event.type ?? '') &&
    digestPattern.test(event.requestHash ?? '') &&
    Number.isInteger(event.revision) &&
    (event.revision ?? 0) >= 1 &&
    isIsoDate(event.createdAt)
  );
}

export function assertResultDecisionRecord(value: unknown): asserts value is ResultDecisionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ResultDecisionError(
      'Result decision record must be an object.',
      'RESULT_DECISION_STATE_INVALID',
    );
  const item = value as Partial<ResultDecisionRecord>;
  if (
    !exactKeys(value, [
      'schemaVersion',
      'decisionId',
      'taskId',
      'revision',
      'status',
      'resultRef',
      'artifactRefs',
      'resultDigest',
      'resultRevision',
      'summary',
      'completedCriteria',
      'verificationResults',
      'remainingGaps',
      'notes',
      'approval',
      'deferredAt',
      'events',
      'createdAt',
      'updatedAt',
    ]) ||
    item.schemaVersion !== 1 ||
    !/^resultdecision_[0-9a-f-]{36}$/i.test(item.decisionId ?? '') ||
    !/^task_[0-9a-f-]{36}$/i.test(item.taskId ?? '') ||
    !Number.isInteger(item.revision) ||
    (item.revision ?? 0) < 1 ||
    !['pending', 'changes-requested', 'approved'].includes(item.status ?? '') ||
    !boundedText(item.resultRef) ||
    !boundedTextArray(item.artifactRefs, MAX_REFS, MAX_REF_BYTES) ||
    !digestPattern.test(item.resultDigest ?? '') ||
    !Number.isInteger(item.resultRevision) ||
    (item.resultRevision ?? 0) < 1 ||
    !boundedText(item.summary) ||
    !boundedTextArray(item.completedCriteria, MAX_CRITERIA, MAX_REF_BYTES) ||
    !boundedText(item.verificationResults) ||
    !boundedOptionalText(item.remainingGaps) ||
    !Array.isArray(item.notes) ||
    item.notes.length > MAX_NOTES ||
    !item.notes.every(validNote) ||
    item.approval === undefined ||
    (item.approval !== null && !validApproval(item.approval)) ||
    (item.deferredAt !== null && !isIsoDate(item.deferredAt)) ||
    !Array.isArray(item.events) ||
    item.events.length > MAX_EVENTS ||
    !item.events.every(validEvent) ||
    !isIsoDate(item.createdAt) ||
    !isIsoDate(item.updatedAt)
  )
    throw new ResultDecisionError(
      'Result decision record has an unsupported shape.',
      'RESULT_DECISION_STATE_INVALID',
    );
  if (item.status === 'approved' && !item.approval)
    throw new ResultDecisionError(
      'An approved result decision requires an approval.',
      'RESULT_DECISION_STATE_INVALID',
    );
  if (item.status !== 'approved' && item.approval)
    throw new ResultDecisionError(
      'Only an approved result decision can carry an approval.',
      'RESULT_DECISION_STATE_INVALID',
    );
  if (
    item.approval &&
    (item.approval.resultDigest !== item.resultDigest ||
      item.approval.resultRevision !== item.resultRevision)
  )
    throw new ResultDecisionError(
      'Result decision approval is stale.',
      'RESULT_DECISION_STATE_INVALID',
    );
  if (new Set(item.events.map((event) => event.id)).size !== item.events.length)
    throw new ResultDecisionError(
      'Result decision event IDs must be unique.',
      'RESULT_DECISION_STATE_INVALID',
    );
  if (new Set(item.notes.map((note) => note.id)).size !== item.notes.length)
    throw new ResultDecisionError(
      'Result decision note IDs must be unique.',
      'RESULT_DECISION_STATE_INVALID',
    );
}

export function resultDecisionRequestHash(value: object): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (input && typeof input === 'object') {
      return `{${Object.entries(input as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
        .join(',')}}`;
    }
    const serialized = JSON.stringify(input);
    if (serialized === undefined)
      throw new WorkflowError(
        'Result decision value is not JSON serializable.',
        'WORKFLOW_INPUT_INVALID',
      );
    return serialized;
  };
  return sha256(canonical(value));
}

export { sha256 as resultDecisionSha256 };
export {
  MAX_REF_BYTES as RESULT_DECISION_MAX_REF_BYTES,
  MAX_REFS as RESULT_DECISION_MAX_REFS,
  MAX_CRITERIA as RESULT_DECISION_MAX_CRITERIA,
};
