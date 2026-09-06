import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyQualificationFailure,
  observeClaudeOutcome,
  observeProviderProcess,
} from '../dist/scripts/qualification-classification.js';

test('qualification classification separates non-secret failure classes', () => {
  assert.equal(
    classifyQualificationFailure({
      process: { status: 'exited', exitCode: 1, permissionLike: true },
    }),
    'provider-permission-or-auth-refusal',
  );
  assert.equal(
    classifyQualificationFailure({ outcome: 'malformed' }),
    'workflow-json-contract-malformed',
  );
  assert.equal(classifyQualificationFailure({ outcome: 'needs-input' }), 'workflow-needs-input');
  assert.equal(
    classifyQualificationFailure({ outcome: 'ready', planChecksMatch: false }),
    'workflow-plan-check-mismatch',
  );
});

test('harness observations retain the first permission signal and classify structured outcomes', () => {
  let observation = observeProviderProcess(
    {},
    { status: 'exited', exitCode: 1, stderr: 'permission denied' },
  );
  observation = observeProviderProcess(observation, { status: 'exited', exitCode: 0, stderr: '' });
  assert.equal(classifyQualificationFailure(observation), 'provider-permission-or-auth-refusal');
  const envelope = (result) => JSON.stringify({ result: JSON.stringify(result) });
  assert.equal(
    classifyQualificationFailure(observeClaudeOutcome({}, 'not json', '{}')),
    'workflow-json-contract-malformed',
  );
  assert.equal(
    classifyQualificationFailure(
      observeClaudeOutcome({}, envelope({ status: 'needs-input' }), '{}'),
    ),
    'workflow-needs-input',
  );
  assert.equal(
    classifyQualificationFailure(
      observeClaudeOutcome(
        {},
        envelope({ status: 'ready', checks_json: '{"different":true}' }),
        '{"expected":true}',
      ),
    ),
    'workflow-plan-check-mismatch',
  );
});
