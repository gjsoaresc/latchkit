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
};
type Document = { schemaVersion: 1; associations: ContractAssociation[] };
const empty = (): Document => ({ schemaVersion: 1, associations: [] });
async function read(root: string): Promise<Document> {
  const raw = await readOptional(root, PATH);
  if (!raw) return empty();
  const value = JSON.parse(raw) as Document;
  if (value.schemaVersion !== 1 || !Array.isArray(value.associations))
    throw new TaskStateError(
      'Contract association store is malformed.',
      'TASK_STATE_INVALID',
      PATH,
    );
  return value;
}
async function write(root: string, document: Document) {
  await writeAtomic(root, PATH, `${JSON.stringify(document, null, 2)}\n`);
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
    for (const id of input.criterionIds)
      if (!producer.criteria.some((c) => c.id === id))
        throw new TaskStateError(
          `Criterion ${id} is not on the producer task.`,
          'TASK_STATE_INVALID',
          '$.criterionIds',
        );
    const document = await read(root);
    const digest = recordDigest(state, input.producerTaskId, input.producerRecordId);
    const existing = document.associations.find(
      (a) =>
        a.producerTaskId === input.producerTaskId &&
        a.consumerTaskId === input.consumerTaskId &&
        a.producerRecordId === input.producerRecordId &&
        a.consumerRecordId === input.consumerRecordId,
    );
    if (existing) return structuredClone(existing);
    const now = new Date().toISOString();
    const association: ContractAssociation = {
      id: `contract_${randomUUID()}`,
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
    };
    await writeAtomic(
      root,
      JOURNAL,
      `${JSON.stringify({ schemaVersion: 1, operation: 'create', associationId: association.id })}\n`,
    );
    document.associations.push(association);
    await write(root, document);
    await writeAtomic(
      root,
      JOURNAL,
      `${JSON.stringify({ schemaVersion: 1, operation: 'committed', associationId: association.id })}\n`,
    );
    return structuredClone(association);
  });
}
export async function proposeContractRevision(
  root: string,
  input: {
    associationId: string;
    expectedProducerRevision: number;
    provenance: string;
    accept?: boolean;
  },
) {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readTaskState(root, { allowMissing: false });
    const document = await read(root);
    const a = document.associations.find((x) => x.id === input.associationId);
    if (!a)
      throw new TaskStateError(
        'Contract association was not found.',
        'TASK_NOT_FOUND',
        '$.associationId',
      );
    if (task(state, a.producerTaskId).revision !== input.expectedProducerRevision)
      throw new TaskStateError(
        'Producer revision changed.',
        'TASK_REVISION_CONFLICT',
        '$.expectedProducerRevision',
      );
    const digest = recordDigest(state, a.producerTaskId, a.producerRecordId);
    const current = a.versions.at(-1)!;
    if (current.digest === digest && input.accept !== false) return structuredClone(a);
    current.status = 'superseded';
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
    await writeAtomic(
      root,
      JOURNAL,
      `${JSON.stringify({ schemaVersion: 1, operation: 'revise', associationId: a.id })}\n`,
    );
    await write(root, document);
    await writeAtomic(
      root,
      JOURNAL,
      `${JSON.stringify({ schemaVersion: 1, operation: 'committed', associationId: a.id })}\n`,
    );
    return structuredClone(a);
  });
}
/** Records only that the existing consumer controller received this exact producer contract.
 * It never changes a task, approves a result, or establishes that the consumer is correct. */
export async function acknowledgeContractReceipt(
  root: string,
  input: { associationId: string; expectedConsumerRevision: number; contractDigest: string },
) {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readTaskState(root, { allowMissing: false });
    const document = await read(root);
    const association = document.associations.find((item) => item.id === input.associationId);
    if (!association)
      throw new TaskStateError(
        'Contract association was not found.',
        'TASK_NOT_FOUND',
        '$.associationId',
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
    association.consumerAcknowledgedRevision = consumer.revision;
    association.reconciliation = version.status === 'accepted' ? 'current' : 'pending';
    association.updatedAt = new Date().toISOString();
    await write(root, document);
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
    }));
}
