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
  setContractAssociationFaultHooksForTest,
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

async function linkedFixture(root) {
  const producer = await createTask(root, {
    title: 'API',
    authorizationRequired: false,
    criteria: [{ description: 'response', required: true }],
  });
  const consumer = await createTask(root, { title: 'client', authorizationRequired: false });
  const p = await decision(root, producer, 'response has name');
  const c = await decision(root, consumer, 'consume name');
  return {
    p,
    c,
    input: (mutationId, provenance = 'test') => ({
      producerTaskId: p.task.id,
      consumerTaskId: c.task.id,
      producerRecordId: p.record.id,
      consumerRecordId: c.record.id,
      criterionIds: [p.task.criteria[0].id],
      expectedProducerRevision: p.task.revision,
      expectedConsumerRevision: c.task.revision,
      provenance,
      mutationId,
    }),
  };
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
    mutationId: 'event_11111111-1111-4111-8111-111111111111',
  });
  assert.equal(association.versions[0].status, 'accepted');
  const replay = await createContractAssociation(root, {
    producerTaskId: p.task.id,
    consumerTaskId: c.task.id,
    producerRecordId: p.record.id,
    consumerRecordId: c.record.id,
    criterionIds: [p.task.criteria[0].id],
    expectedProducerRevision: p.task.revision,
    expectedConsumerRevision: c.task.revision,
    provenance: 'test',
    mutationId: 'event_11111111-1111-4111-8111-111111111111',
  });
  assert.equal(replay.id, association.id);
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

test('prepared association journal replays after an interrupted state write and preserves conflicting state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-contracts-'));
  t.after(() => {
    setContractAssociationFaultHooksForTest();
    return fs.rm(root, { recursive: true, force: true });
  });
  const fixture = await linkedFixture(root);
  const input = fixture.input('event_22222222-2222-4222-8222-222222222222');
  setContractAssociationFaultHooksForTest({
    afterPreparedJournal: () => {
      throw new Error('injected prepared failure');
    },
  });
  await assert.rejects(createContractAssociation(root, input), /injected prepared failure/);
  setContractAssociationFaultHooksForTest();
  const replay = await createContractAssociation(root, input);
  assert.equal(replay.producerTaskId, fixture.p.task.id);

  const rootConflict = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-contracts-'));
  t.after(() => fs.rm(rootConflict, { recursive: true, force: true }));
  const conflict = await linkedFixture(rootConflict);
  setContractAssociationFaultHooksForTest({
    afterPreparedJournal: async (projectRoot) => {
      await fs.mkdir(path.join(projectRoot, '.latchkit', 'tasks'), { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, '.latchkit', 'tasks', 'contract-associations-v1.json'),
        '{"schemaVersion":1,"associations":[{"external":true}]}\n',
      );
      throw new Error('injected external writer');
    },
  });
  await assert.rejects(
    createContractAssociation(
      rootConflict,
      conflict.input('event_33333333-3333-4333-8333-333333333333'),
    ),
    /injected external writer/,
  );
  setContractAssociationFaultHooksForTest();
  await assert.rejects(
    createContractAssociation(
      rootConflict,
      conflict.input('event_33333333-3333-4333-8333-333333333333'),
    ),
    { code: 'TASK_CONTRACT_CONFLICT' },
  );
  assert.ok(
    await fs.readFile(
      path.join(rootConflict, '.latchkit', 'tasks', 'contract-associations-v1.journal.json'),
      'utf8',
    ),
  );
});

test('state-written journal finalizes on retry and mutation ids reject different payloads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-contracts-'));
  t.after(() => {
    setContractAssociationFaultHooksForTest();
    return fs.rm(root, { recursive: true, force: true });
  });
  const fixture = await linkedFixture(root);
  const input = fixture.input('event_44444444-4444-4444-8444-444444444444');
  setContractAssociationFaultHooksForTest({
    afterStateWrite: () => {
      throw new Error('injected post-write failure');
    },
  });
  await assert.rejects(createContractAssociation(root, input), /injected post-write failure/);
  setContractAssociationFaultHooksForTest();
  const replay = await createContractAssociation(root, input);
  assert.equal(replay.id.startsWith('contract_'), true);
  await assert.rejects(
    createContractAssociation(root, fixture.input(input.mutationId, 'different payload')),
    { code: 'TASK_CONTRACT_CONFLICT' },
  );
});
