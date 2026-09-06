import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  AgentOutcome,
  WorkflowOutcome,
  WorkflowSnapshot,
  next_step,
  next_step_async,
  parse_agent_outcome,
  parse_agent_outcome_async,
  policy_artifact_digest,
  policy_version,
} from '../dist/src/workflows/policy.js';

function fixture(phase, approved = false, repairs = 0) {
  return new WorkflowSnapshot({
    phase,
    cancelled: false,
    approval_valid: approved,
    repair_attempts: repairs,
    policy_version: policy_version(),
    capability_ready: true,
    context: 'fixture',
  });
}

test('plan requires human approval', () => {
  const decision = next_step(
    fixture('plan'),
    new WorkflowOutcome({ status: 'passed', summary: 'plan' }),
  );
  assert.equal(decision.kind, 'await-approval');
});

test('approved plan enters implementation', async () => {
  const decision = await next_step_async(
    fixture('plan', true),
    new WorkflowOutcome({ status: 'passed', summary: 'plan' }),
  );
  assert.equal(decision.phase, 'implementation');
  assert.equal(decision.kind, 'invoke');
});

test('repair limit survives resume', () => {
  const failed = new WorkflowOutcome({ status: 'failed', summary: 'check failed' });
  assert.equal(next_step(fixture('verification', true, 2), failed).repair, true);
  assert.equal(next_step(fixture('verification', true, 3), failed).kind, 'blocked');
});

test('changed approval prevents implementation', () => {
  assert.equal(
    next_step(fixture('implementation'), new WorkflowOutcome({ status: 'none', summary: '' })).kind,
    'await-approval',
  );
});

test('provider errors do not consume repair budget', () => {
  const decision = next_step(
    fixture('implementation', true),
    new WorkflowOutcome({ status: 'error', summary: 'login required' }),
  );
  assert.equal(decision.kind, 'blocked');
  assert.equal(decision.repair, false);
});

test('handoff requests host verified completion', () => {
  assert.equal(
    next_step(fixture('handoff', true), new WorkflowOutcome({ status: 'passed', summary: 'ready' }))
      .kind,
    'complete',
  );
});

test('agent outcome parser accepts only the exact runtime schema', async () => {
  const raw = JSON.stringify({
    status: 'ready',
    summary: 'done',
    artifact: 'artifact',
    questions: [],
    checks_json: '',
  });
  assert.deepEqual(parse_agent_outcome(raw), new AgentOutcome(JSON.parse(raw)));
  assert.deepEqual(await parse_agent_outcome_async(raw), new AgentOutcome(JSON.parse(raw)));
  for (const invalid of [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...JSON.parse(raw), extra: true }),
    JSON.stringify({ ...JSON.parse(raw), status: 'complete' }),
    JSON.stringify({ ...JSON.parse(raw), status: ['ready'] }),
    JSON.stringify({ ...JSON.parse(raw), questions: [1] }),
  ]) {
    assert.throws(() => parse_agent_outcome(invalid));
    await assert.rejects(parse_agent_outcome_async(invalid));
  }
});

test('policy digest binds the exact emitted implementation and prompt metadata', async () => {
  const policyUrl = new URL('../dist/src/workflows/policy.js', import.meta.url);
  const serviceUrl = new URL('../dist/src/workflows/service.js', import.meta.url);
  const reviewUrl = new URL('../dist/src/reviews/orchestrator.js', import.meta.url);
  const bytes = await readFile(policyUrl);
  assert.equal(policy_artifact_digest(), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(
    policy_artifact_digest([serviceUrl, reviewUrl]),
    createHash('sha256')
      .update(bytes)
      .update(await readFile(serviceUrl))
      .update(await readFile(reviewUrl))
      .digest('hex'),
  );
});
