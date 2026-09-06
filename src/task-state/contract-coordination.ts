/**
 * Explicit, local producer/consumer contract coordination.  This is deliberately a small
 * sidecar to task state: ordinary record edits cannot manufacture cross-task edges, and the
 * task-state lock serializes the association journal with every task mutation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readOptional, writeAtomic, resolveProjectRoot } from '../storage.js';
import { withTaskStateLock } from './lock.js';
import { readTaskState } from './store.js';
import { TaskStateError, validateStableId } from './contracts.js';
import { computeIntentDigest } from './records.js';

const PATH = '.latchkit/tasks/contract-associations-v1.json';
const JOURNAL = '.latchkit/tasks/contract-associations-v1.journal.json';
const MAX_HISTORY = 20;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type ContractVersion = {
  revision: number;
  digest: string;
  status: 'accepted' | 'pending' | 'superseded';
  proposedAt: string;
  provenance: string;
};
export type ContractAssociation = {
  id: string;
  revision: number;
  producerTaskId: string;
  consumerTaskId: string;
  producerRecordId: string;
  consumerRecordId: string;
  criterionIds: string[];
  versions: ContractVersion[];
  consumerAcknowledgedDigest: string | null;
  /** Receipt is deliberately not correctness, acceptance, authorization, or verification. */
  consumerAcknowledgedRevision: number | null;
  reconciliation: 'current' | 'pending';
  createdAt: string;
  updatedAt: string;
  mutations: Array<{ id: string; requestDigest: string }>;
};
type Document = { schemaVersion: 1; associations: ContractAssociation[] };
type Journal = {
  schemaVersion: 1;
  state: 'prepared' | 'committed';
  operation: 'create' | 'revise' | 'acknowledge';
  associationId: string;
  requestDigest: string;
  baseDigest: string;
  target: Document;
};
const empty = (): Document => ({ schemaVersion: 1, associations: [] });
async function readDocument(root: string): Promise<Document> {
  const raw = await readOptional(root, PATH);
  if (!raw) return empty();
  const value = JSON.parse(raw) as Document;
  if (value.schemaVersion !== 1 || !Array.isArray(value.associations))
    throw new TaskStateError(
      'Contract association store is malformed.',
      'TASK_STATE_INVALID',
      PATH,
    );
  for (const association of value.associations) {
    // Additive v1 field: old sidecars stay readable without an implicit write.
    association.mutations ??= [];
    if (!Array.isArray(association.mutations))
      throw new TaskStateError(
        'Contract association mutation ledger is malformed.',
        'TASK_STATE_INVALID',
        PATH,
      );
  }
  return value;
}
async function recover(root: string): Promise<void> {
  const raw = await readOptional(root, JOURNAL);
  if (!raw) return;
  let journal: Journal;
  try {
    journal = JSON.parse(raw) as Journal;
  } catch {
    throw new TaskStateError('Contract association journal is malformed.', 'TASK_STATE_INVALID', JOURNAL);
  }
  if (
    journal.schemaVersion !== 1 || !['prepared', 'committed'].includes(journal.state) ||
    !['create', 'revise', 'acknowledge'].includes(journal.operation) ||
    typeof journal.associationId !== 'string' ||
    typeof journal.requestDigest !== 'string' ||
    typeof journal.baseDigest !== 'string' ||
    !journal.target || journal.target.schemaVersion !== 1 || !Array.isArray(journal.target.associations)
  )
    throw new TaskStateError('Contract association journal has an unsupported shape.', 'TASK_STATE_INVALID', JOURNAL);
  const current = await readDocument(root);
  const currentDigest = hash(current);
  if (journal.state === 'committed') return;
  if (currentDigest === hash(journal.target)) {
    await writeAtomic(root, JOURNAL, `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`);
    return;
  }
  if (currentDigest !== journal.baseDigest)
    throw new TaskStateError(
      'Contract association recovery found conflicting external state; preserve the journal for inspection.',
      'TASK_CONTRACT_CONFLICT',
      JOURNAL,
    );
  await write(root, journal.target);
}
async function read(root: string): Promise<Document> {
  await recover(root);
  return readDocument(root);
}
async function write(root: string, document: Document) {
  await writeAtomic(root, PATH, `${JSON.stringify(document, null, 2)}\n`);
}
async function commit(
  root: string,
  journal: Omit<Journal, 'state' | 'baseDigest' | 'target'>,
  base: Document,
  target: Document,
) {
  await writeAtomic(
    root,
    JOURNAL,
    `${JSON.stringify({ ...journal, state: 'prepared', baseDigest: hash(base), target }, null, 2)}\n`,
  );
  await write(root, target);
  await writeAtomic(
    root,
    JOURNAL,
    `${JSON.stringify({ ...journal, state: 'committed', baseDigest: hash(base), target }, null, 2)}\n`,
  );
}
function task(state: Awaited<ReturnType<typeof readTaskState>>, taskId: string) {
  const found = state.tasks.find((item) => item.id === taskId);
  if (!found)
    throw new TaskStateError(`Task ${taskId} does not exist.`, 'TASK_NOT_FOUND', '$.taskId');
  return found;
}
function recordDigest(
  state: Awaited<ReturnType<typeof readTaskState>>,
  taskId: string,
  recordId: string,
) {
  const owner = task(state, taskId);
  const record = owner.records?.find((item) => item.id === recordId);
  if (!record)
    throw new TaskStateError(
      `Record ${recordId} does not exist on task ${taskId}.`,
      'TASK_RECORD_NOT_FOUND',
      '$.recordId',
    );
  return hash({
    taskId,
    recordId,
    revision: record.revision,
    status: record.status,
    text: record.text,
    intent: computeIntentDigest(owner.records ?? []),
  });
}
export async function createContractAssociation(
  root: string,
  input: {
    producerTaskId: string;
    consumerTaskId: string;
    producerRecordId: string;
    consumerRecordId: string;
    criterionIds: string[];
    expectedProducerRevision: number;
    expectedConsumerRevision: number;
    provenance: string;
    mutationId?: string;
  },
) {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readTaskState(root, { allowMissing: false });
    const producer = task(state, input.producerTaskId),
      consumer = task(state, input.consumerTaskId);
    if (
      producer.revision !== input.expectedProducerRevision ||
      consumer.revision !== input.expectedConsumerRevision
    )
      throw new TaskStateError(
        'A linked task revision changed; rebuild the association request.',
        'TASK_REVISION_CONFLICT',
        '$.expectedRevision',
      );
    validateStableId(input.producerRecordId, 'record');
    validateStableId(input.consumerRecordId, 'record');
    if (!producer.records?.some((item) => item.id === input.producerRecordId))
      throw new TaskStateError(
        'Producer record does not exist on the producer task.',
        'TASK_RECORD_NOT_FOUND',
        '$.producerRecordId',
      );
    if (!consumer.records?.some((item) => item.id === input.consumerRecordId))
      throw new TaskStateError(
        'Consumer record does not exist on the consumer task.',
        'TASK_RECORD_NOT_FOUND',
        '$.consumerRecordId',
      );
    for (const id of input.criterionIds)
      if (!producer.criteria.some((c) => c.id === id))
        throw new TaskStateError(
          `Criterion ${id} is not on the producer task.`,
          'TASK_STATE_INVALID',
          '$.criterionIds',
        );
    const document = await read(root);
    const base = structuredClone(document);
    const digest = recordDigest(state, input.producerTaskId, input.producerRecordId);
    const existing = document.associations.find(
      (a) =>
        a.producerTaskId === input.producerTaskId &&
        a.consumerTaskId === input.consumerTaskId &&
        a.producerRecordId === input.producerRecordId &&
        a.consumerRecordId === input.consumerRecordId,
    );
    if (existing) {
      const requestDigest = hash(input);
      const replay = existing.mutations.find((item) => item.id === input.mutationId);
      if (replay && replay.requestDigest === requestDigest) return structuredClone(existing);
      throw new TaskStateError(
        'This contract association already exists with a different request; inspect it before retrying.',
        'TASK_CONTRACT_CONFLICT',
        '$.mutationId',
      );
    }
    const now = new Date().toISOString();
    const association: ContractAssociation = {
      id: `contract_${randomUUID()}`,
      revision: 1,
      producerTaskId: input.producerTaskId,
      consumerTaskId: input.consumerTaskId,
      producerRecordId: input.producerRecordId,
      consumerRecordId: input.consumerRecordId,
      criterionIds: [...new Set(input.criterionIds)].sort(),
      versions: [
        { revision: 1, digest, status: 'accepted', proposedAt: now, provenance: input.provenance },
      ],
      consumerAcknowledgedDigest: null,
      consumerAcknowledgedRevision: null,
      reconciliation: 'current',
      createdAt: now,
      updatedAt: now,
      mutations: input.mutationId ? [{ id: input.mutationId, requestDigest: hash(input) }] : [],
    };
    document.associations.push(association);
    await commit(root, { schemaVersion: 1, operation: 'create', associationId: association.id, requestDigest: hash(input) }, base, document);
    return structuredClone(association);
  });
}
export async function proposeContractRevision(
  root: string,
  input: {
    associationId: string;
    expectedAssociationRevision: number;
    expectedProducerRevision: number;
    provenance: string;
    accept?: boolean;
    mutationId?: string;
  },
) {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readTaskState(root, { allowMissing: false });
    const document = await read(root);
    const base = structuredClone(document);
    const a = document.associations.find((x) => x.id === input.associationId);
    if (!a)
      throw new TaskStateError(
        'Contract association was not found.',
        'TASK_NOT_FOUND',
        '$.associationId',
      );
    const requestDigest = hash(input);
    const replay = a.mutations.find((item) => item.id === input.mutationId);
    if (replay) {
      if (replay.requestDigest === requestDigest) return structuredClone(a);
      throw new TaskStateError(
        'mutationId was already used with different input.',
        'TASK_CONTRACT_CONFLICT',
        '$.mutationId',
      );
    }
    if (a.revision !== input.expectedAssociationRevision)
      throw new TaskStateError(
        'Contract association revision changed.',
        'TASK_REVISION_CONFLICT',
        '$.expectedAssociationRevision',
      );
    if (task(state, a.producerTaskId).revision !== input.expectedProducerRevision)
      throw new TaskStateError(
        'Producer revision changed.',
        'TASK_REVISION_CONFLICT',
        '$.expectedProducerRevision',
      );
    const digest = recordDigest(state, a.producerTaskId, a.producerRecordId);
    const current = a.versions.at(-1)!;
    // A coordinator may explicitly accept the pending proposal. Receipt still has to be
    // recorded separately by the consumer before a new dispatch is permitted.
    if (current.digest === digest && current.status === 'pending' && input.accept !== false) {
      current.status = 'accepted';
      a.revision += 1;
      a.reconciliation = 'pending';
      a.updatedAt = new Date().toISOString();
      if (input.mutationId) a.mutations.push({ id: input.mutationId, requestDigest });
      await commit(root, { schemaVersion: 1, operation: 'revise', associationId: a.id, requestDigest }, base, document);
      return structuredClone(a);
    }
    if (current.digest === digest && input.accept !== false) return structuredClone(a);
    current.status = 'superseded';
    a.revision += 1;
    const now = new Date().toISOString();
    a.versions.push({
      revision: current.revision + 1,
      digest,
      status: input.accept === false ? 'pending' : 'accepted',
      proposedAt: now,
      provenance: input.provenance,
    });
    if (a.versions.length > MAX_HISTORY) a.versions.splice(0, a.versions.length - MAX_HISTORY);
    a.reconciliation = 'pending';
    a.consumerAcknowledgedDigest = null;
    a.consumerAcknowledgedRevision = null;
    a.updatedAt = now;
    if (input.mutationId) a.mutations.push({ id: input.mutationId, requestDigest });
    await commit(root, { schemaVersion: 1, operation: 'revise', associationId: a.id, requestDigest }, base, document);
    return structuredClone(a);
  });
}
/** Records only that the existing consumer controller received this exact producer contract.
 * It never changes a task, approves a result, or establishes that the consumer is correct. */
export async function acknowledgeContractReceipt(
  root: string,
  input: {
    associationId: string;
    expectedAssociationRevision: number;
    expectedConsumerRevision: number;
    contractDigest: string;
    mutationId?: string;
  },
) {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readTaskState(root, { allowMissing: false });
    const document = await read(root);
    const base = structuredClone(document);
    const association = document.associations.find((item) => item.id === input.associationId);
    if (!association)
      throw new TaskStateError(
        'Contract association was not found.',
        'TASK_NOT_FOUND',
        '$.associationId',
      );
    const requestDigest = hash(input);
    const replay = association.mutations.find((item) => item.id === input.mutationId);
    if (replay) {
      if (replay.requestDigest === requestDigest) return structuredClone(association);
      throw new TaskStateError(
        'mutationId was already used with different input.',
        'TASK_CONTRACT_CONFLICT',
        '$.mutationId',
      );
    }
    if (association.revision !== input.expectedAssociationRevision)
      throw new TaskStateError(
        'Contract association revision changed.',
        'TASK_REVISION_CONFLICT',
        '$.expectedAssociationRevision',
      );
    const consumer = task(state, association.consumerTaskId);
    if (consumer.revision !== input.expectedConsumerRevision)
      throw new TaskStateError(
        'Consumer revision changed.',
        'TASK_REVISION_CONFLICT',
        '$.expectedConsumerRevision',
      );
    const version = association.versions.at(-1)!;
    if (version.digest !== input.contractDigest)
      throw new TaskStateError(
        'Contract digest changed; acknowledge the current revision.',
        'TASK_CONTRACT_STALE',
        '$.contractDigest',
      );
    association.consumerAcknowledgedDigest = version.digest;
    association.revision += 1;
    association.consumerAcknowledgedRevision = consumer.revision;
    association.reconciliation = version.status === 'accepted' ? 'current' : 'pending';
    association.updatedAt = new Date().toISOString();
    if (input.mutationId) association.mutations.push({ id: input.mutationId, requestDigest });
    await commit(root, { schemaVersion: 1, operation: 'acknowledge', associationId: association.id, requestDigest }, base, document);
    return structuredClone(association);
  });
}
export async function inspectContractImpact(
  root: string,
  input: { producerTaskId: string; producerRecordId: string },
) {
  root = await resolveProjectRoot(root);
  const [state, document] = await Promise.all([
    readTaskState(root, { allowMissing: false }),
    read(root),
  ]);
  const digest = recordDigest(state, input.producerTaskId, input.producerRecordId);
  const affected = document.associations
    .filter(
      (a) =>
        a.producerTaskId === input.producerTaskId && a.producerRecordId === input.producerRecordId,
    )
    .map((a) => ({
      associationId: a.id,
      consumerTaskId: a.consumerTaskId,
      consumerRecordId: a.consumerRecordId,
      criterionIds: a.criterionIds,
      consumedDigest: a.versions.at(-1)!.digest,
      currentDigest: digest,
      status: a.versions.at(-1)!.digest === digest ? 'current' : 'stale',
      reason:
        a.versions.at(-1)!.digest === digest
          ? 'declared consumer matches accepted producer revision'
          : 'declared consumer consumed an older producer revision',
      reconciliation: a.reconciliation,
    }));
  return {
    schemaVersion: 1,
    producerTaskId: input.producerTaskId,
    producerRecordId: input.producerRecordId,
    currentDigest: digest,
    affected,
    unknownCoverage: {
      state: 'unknown',
      reason:
        'Only explicit opt-in associations are known; absent edges and different paths/worktrees do not establish independence.',
    },
  };
}
export async function contractFreshness(root: string, consumerTaskId: string) {
  root = await resolveProjectRoot(root);
  const [state, document] = await Promise.all([
    readTaskState(root, { allowMissing: false }),
    read(root),
  ]);
  return document.associations
    .filter((a) => a.consumerTaskId === consumerTaskId)
    .map((a) => ({
      associationId: a.id,
      expected: a.versions.at(-1)!.digest,
      actual: recordDigest(state, a.producerTaskId, a.producerRecordId),
      reconciliation: a.reconciliation,
      acknowledged:
        a.consumerAcknowledgedDigest === a.versions.at(-1)!.digest &&
        a.consumerAcknowledgedRevision === task(state, a.consumerTaskId).revision,
    }));
}
