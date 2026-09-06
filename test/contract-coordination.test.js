import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createTask,
  recordTaskRecord,
  transitionTaskRecord,
} from '../dist/src/task-state/service.js';
import {
  acknowledgeContractReceipt,
  createContractAssociation,
  inspectContractImpact,
  proposeContractRevision,
} from '../dist/src/task-state/contract-coordination.js';
import { presentResultDecision } from '../dist/src/workflows/result-decision-service.js';

async function decision(root, task, text) {
  const added = await recordTaskRecord(root, {
    taskId: task.id,
    expectedRevision: task.revision,
    kind: 'decision',
    text,
    provenance: { kind: 'direct-user', reference: 'test' },
  });
  const record = added.records.at(-1);
  const updated = await transitionTaskRecord(root, {
    taskId: task.id,
    expectedRevision: added.revision,
    recordId: record.id,
    recordRevision: record.revision,
    status: 'accepted',
    reason: 'accepted',
    authorization: { source: 'user', scope: 'test', reference: 'test' },
  });
  return { task: updated, record: updated.records.at(-1) };
}

test('explicit association retains accepted history and identifies an old consumer digest without inferring unrelated work', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-contracts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const producer = await createTask(root, {
    title: 'API',
    authorizationRequired: false,
    criteria: [{ description: 'response', required: true }],
  });
  const consumer = await createTask(root, { title: 'client', authorizationRequired: false });
  const p = await decision(root, producer, 'response has name');
  const c = await decision(root, consumer, 'consume name');
  const association = await createContractAssociation(root, {
    producerTaskId: p.task.id,
    consumerTaskId: c.task.id,
    producerRecordId: p.record.id,
    consumerRecordId: c.record.id,
    criterionIds: [p.task.criteria[0].id],
    expectedProducerRevision: p.task.revision,
    expectedConsumerRevision: c.task.revision,
    provenance: 'test',
  });
  assert.equal(association.versions[0].status, 'accepted');
  const pending = await proposeContractRevision(root, {
    associationId: association.id,
    expectedAssociationRevision: association.revision,
    expectedProducerRevision: p.task.revision,
    provenance: 'proposed breaking field',
    accept: false,
  });
  assert.equal(pending.reconciliation, 'pending');
  assert.equal(pending.versions.at(-1).status, 'pending');
  await assert.rejects(
    presentResultDecision(root, {
      taskId: c.task.id,
      resultRef: 'artifacts/client.patch',
      resultDigest: createHash('sha256').update('client result').digest('hex'),
      summary: 'client work remains available',
      verificationResults: 'not admitted as current',
    }),
    { code: 'RESULT_DECISION_CONTRACT_STALE' },
  );
  const accepted = await proposeContractRevision(root, {
    associationId: association.id,
    expectedAssociationRevision: pending.revision,
    expectedProducerRevision: p.task.revision,
    provenance: 'coordinator accepts the proposal',
  });
  assert.equal(accepted.versions.at(-1).status, 'accepted');
  const receipt = await acknowledgeContractReceipt(root, {
    associationId: association.id,
    expectedAssociationRevision: accepted.revision,
    expectedConsumerRevision: c.task.revision,
    contractDigest: accepted.versions.at(-1).digest,
  });
  assert.equal(receipt.reconciliation, 'current');
  const impact = await inspectContractImpact(root, {
    producerTaskId: p.task.id,
    producerRecordId: p.record.id,
  });
  assert.equal(impact.affected.length, 1);
  assert.equal(impact.unknownCoverage.state, 'unknown');
});
