import { sha256, WorkflowError } from './contracts.js';

/**
 * Durable state for the end-of-spec decision offered after a spec-only flow:
 * approve and build, add revision notes, or keep the plan for later. This is
 * additive to (not a replacement for) the typed delivery workflow in
 * `contracts.ts`/`service.ts`; it reuses that module's SHA-256 digest
 * primitive so an approval is bound to the exact plan content it was granted
 * against, the same way `WorkflowApproval` binds to a plan digest.
 */
export const SPEC_DECISION_SCHEMA_VERSION = 1;
export const SPEC_DECISION_STATE_PATH = '.latchkit/workflows/spec-decisions-v1.json';
export const MAX_SPEC_DECISION_TEXT_BYTES = 8 * 1024;
const MAX_NOTES = 64;
const MAX_EVENTS = 256;

export type SpecDecisionStatus = 'pending' | 'approved';

export type SpecDecisionNote = {
  id: string;
  text: string;
  planDigestBefore: string;
  planRevisionBefore: number;
  createdAt: string;
};

export type SpecDecisionApproval = {
  planDigest: string;
  planRevision: number;
  scope: string;
  reference: string;
  approvedAt: string;
};

export type SpecDecisionEvent = {
  id: string;
  type: 'presented' | 'approved' | 'notes-added' | 'paused' | 'build-started';
  requestHash: string;
  revision: number;
  createdAt: string;
};

export type SpecDecisionRecord = {
  schemaVersion: 1;
  decisionId: string;
  taskId: string;
  revision: number;
  status: SpecDecisionStatus;
  planRef: string;
  planDigest: string;
  planRevision: number;
  summary: string;
  notes: SpecDecisionNote[];
  approval: SpecDecisionApproval | null;
  buildStarted: boolean;
  buildStartedAt: string | null;
  pausedAt: string | null;
  events: SpecDecisionEvent[];
  createdAt: string;
  updatedAt: string;
};

export class SpecDecisionError extends Error {
  code: string;
  details?: unknown;

  constructor(message: string, code = 'SPEC_DECISION_INVALID', details?: unknown) {
    super(message);
    this.name = 'SpecDecisionError';
    this.code = code;
    this.details = details;
  }
}

const digestPattern = /^[a-f0-9]{64}$/;
const boundedText = (value: unknown, maximum = MAX_SPEC_DECISION_TEXT_BYTES): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum;

function exactKeys(candidate: object, expected: readonly string[]): boolean {
  const actual = Object.keys(candidate).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validNote(value: unknown): value is SpecDecisionNote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const note = value as Partial<SpecDecisionNote>;
  return (
    exactKeys(value, ['id', 'text', 'planDigestBefore', 'planRevisionBefore', 'createdAt']) &&
    /^note_[0-9a-f-]{36}$/i.test(note.id ?? '') &&
    boundedText(note.text) &&
    digestPattern.test(note.planDigestBefore ?? '') &&
    Number.isInteger(note.planRevisionBefore) &&
    (note.planRevisionBefore ?? 0) >= 1 &&
    isIsoDate(note.createdAt)
  );
}

function validApproval(value: unknown): value is SpecDecisionApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const approval = value as Partial<SpecDecisionApproval>;
  return (
    exactKeys(value, ['planDigest', 'planRevision', 'scope', 'reference', 'approvedAt']) &&
    digestPattern.test(approval.planDigest ?? '') &&
    Number.isInteger(approval.planRevision) &&
    (approval.planRevision ?? 0) >= 1 &&
    boundedText(approval.scope) &&
    boundedText(approval.reference) &&
    isIsoDate(approval.approvedAt)
  );
}

function validEvent(value: unknown): value is SpecDecisionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<SpecDecisionEvent>;
  return (
    exactKeys(value, ['id', 'type', 'requestHash', 'revision', 'createdAt']) &&
    /^event_[0-9a-f-]{36}$/i.test(event.id ?? '') &&
    ['presented', 'approved', 'notes-added', 'paused', 'build-started'].includes(
      event.type ?? '',
    ) &&
    digestPattern.test(event.requestHash ?? '') &&
    Number.isInteger(event.revision) &&
    (event.revision ?? 0) >= 1 &&
    isIsoDate(event.createdAt)
  );
}

export function assertSpecDecisionRecord(value: unknown): asserts value is SpecDecisionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SpecDecisionError(
      'Spec decision record must be an object.',
      'SPEC_DECISION_STATE_INVALID',
    );
  const item = value as Partial<SpecDecisionRecord>;
  if (
    !exactKeys(value, [
      'schemaVersion',
      'decisionId',
      'taskId',
      'revision',
      'status',
      'planRef',
      'planDigest',
      'planRevision',
      'summary',
      'notes',
      'approval',
      'buildStarted',
      'buildStartedAt',
      'pausedAt',
      'events',
      'createdAt',
      'updatedAt',
    ]) ||
    item.schemaVersion !== 1 ||
    !/^decision_[0-9a-f-]{36}$/i.test(item.decisionId ?? '') ||
    !/^task_[0-9a-f-]{36}$/i.test(item.taskId ?? '') ||
    !Number.isInteger(item.revision) ||
    (item.revision ?? 0) < 1 ||
    !['pending', 'approved'].includes(item.status ?? '') ||
    !boundedText(item.planRef) ||
    !digestPattern.test(item.planDigest ?? '') ||
    !Number.isInteger(item.planRevision) ||
    (item.planRevision ?? 0) < 1 ||
    !boundedText(item.summary, MAX_SPEC_DECISION_TEXT_BYTES) ||
    !Array.isArray(item.notes) ||
    item.notes.length > MAX_NOTES ||
    !item.notes.every(validNote) ||
    item.approval === undefined ||
    (item.approval !== null && !validApproval(item.approval)) ||
    typeof item.buildStarted !== 'boolean' ||
    (item.buildStartedAt !== null && !isIsoDate(item.buildStartedAt)) ||
    (item.pausedAt !== null && !isIsoDate(item.pausedAt)) ||
    !Array.isArray(item.events) ||
    item.events.length > MAX_EVENTS ||
    !item.events.every(validEvent) ||
    !isIsoDate(item.createdAt) ||
    !isIsoDate(item.updatedAt)
  )
    throw new SpecDecisionError(
      'Spec decision record has an unsupported shape.',
      'SPEC_DECISION_STATE_INVALID',
    );
  if (item.status === 'approved' && !item.approval)
    throw new SpecDecisionError(
      'An approved spec decision requires an approval.',
      'SPEC_DECISION_STATE_INVALID',
    );
  if (item.status === 'pending' && item.approval)
    throw new SpecDecisionError(
      'A pending spec decision cannot carry an approval.',
      'SPEC_DECISION_STATE_INVALID',
    );
  if (
    item.approval &&
    (item.approval.planDigest !== item.planDigest ||
      item.approval.planRevision !== item.planRevision)
  )
    throw new SpecDecisionError('Spec decision approval is stale.', 'SPEC_DECISION_STATE_INVALID');
  if (item.buildStarted && item.status !== 'approved')
    throw new SpecDecisionError(
      'Build can only start for an approved spec decision.',
      'SPEC_DECISION_STATE_INVALID',
    );
  if (item.buildStarted !== Boolean(item.buildStartedAt))
    throw new SpecDecisionError(
      'buildStartedAt must be set exactly when buildStarted is true.',
      'SPEC_DECISION_STATE_INVALID',
    );
  if (new Set(item.events.map((event) => event.id)).size !== item.events.length)
    throw new SpecDecisionError(
      'Spec decision event IDs must be unique.',
      'SPEC_DECISION_STATE_INVALID',
    );
  if (new Set(item.notes.map((note) => note.id)).size !== item.notes.length)
    throw new SpecDecisionError(
      'Spec decision note IDs must be unique.',
      'SPEC_DECISION_STATE_INVALID',
    );
}

export function specDecisionRequestHash(value: object): string {
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
        'Spec decision value is not JSON serializable.',
        'WORKFLOW_INPUT_INVALID',
      );
    return serialized;
  };
  return sha256(canonical(value));
}

export { sha256 as specDecisionSha256 };
