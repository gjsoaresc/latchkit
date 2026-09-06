import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { compareWorkflowChecks, fixturePlanScopeProof } from '../scripts/workflow-plan-proof.js';
import { workflowFailureEvidence } from '../scripts/workflow-evidence-proof.js';
import { validateAcceptanceDocument } from '../dist/src/acceptance/contracts.js';
import { digestJson } from '../dist/src/workflows/contracts.js';

function checks() {
  return validateAcceptanceDocument({
    schemaVersion: 1,
    checks: [
      {
        id: 'multiply-node-test',
        criterionId: 'criterion_fixture',
        label: 'Run immutable multiply test',
        type: 'cli',
        timeoutMs: 30000,
        outputLimitBytes: 262144,
        plan: { executable: process.execPath, args: ['--test'], cwd: process.cwd() },
      },
    ],
  });
}

test('qualification compares the same exact JSON contract before and after workflow persistence', () => {
  const expected = checks();
  const persisted = JSON.parse(JSON.stringify(expected));
  assert.ok(Object.hasOwn(expected.checks[0], 'fixture'));
  assert.equal(Object.hasOwn(persisted.checks[0], 'fixture'), false);
  assert.equal(isDeepStrictEqual(expected, persisted), false);
  assert.equal(digestJson(expected), digestJson(persisted));
  const proof = compareWorkflowChecks(expected, persisted);
  assert.equal(proof.equal, true);
  assert.equal(proof.representationOnlyDifference, true);
  assert.deepEqual(proof.checks, []);
});

test('changed arguments, limits, targets, criteria, or additional fields still fail exact comparison without exposing values', () => {
  const expected = checks();
  for (const [field, change] of [
    [
      'plan.args',
      (value) => {
        value.plan.args.push('test-only-sensitive-value');
      },
    ],
    [
      'plan.cwd',
      (value) => {
        value.plan.cwd = 'test-only-sensitive-value';
      },
    ],
    [
      'timeoutMs',
      (value) => {
        value.timeoutMs += 1;
      },
    ],
    [
      'criterionId',
      (value) => {
        value.criterionId = 'test-only-sensitive-value';
      },
    ],
    [
      'fixture',
      (value) => {
        value.fixture = null;
      },
    ],
    [
      'other',
      (value) => {
        value['test-only-sensitive-value'] = 'test-only-sensitive-value';
      },
    ],
  ]) {
    const actual = JSON.parse(JSON.stringify(expected));
    change(actual.checks[0]);
    const proof = compareWorkflowChecks(expected, actual);
    assert.equal(proof.equal, false);
    assert.ok(proof.checks[0].differingFields.includes(field));
    assert.equal(JSON.stringify(proof).includes('test-only-sensitive-value'), false);
  }
});

test('plan prose guard retains its existing boundaries and reports only structural reasons', () => {
  assert.equal(
    fixturePlanScopeProof(
      'Implement multiply in src/calculator.js. Never modify test/calculator.test.js.',
    ).fits,
    true,
  );
  const rejected = fixturePlanScopeProof(
    'Implement multiply in src/calculator.js. Modify test/calculator.test.js with test-only-sensitive-value.',
  );
  assert.equal(rejected.fits, false);
  assert.equal(rejected.protectedMutationSentences, 1);
  assert.equal(fixturePlanScopeProof('Implement multiply.').mentionsImplementationPath, false);
  assert.equal(JSON.stringify(rejected).includes('test-only-sensitive-value'), false);
});

test('failure categories preserve bounded structural diagnostics and strip extra raw fields', () => {
  const diagnostics = {
    checks: compareWorkflowChecks(checks(), checks()),
    scope: fixturePlanScopeProof('Implement multiply in src/calculator.js.'),
  };
  diagnostics.artifact = 'test-only-sensitive-value';
  diagnostics.checks.checks.push({
    index: 0,
    differingFields: ['plan.args', 'test-only-sensitive-value'],
    actualArgumentCount: 2,
    rawArgs: ['test-only-sensitive-value'],
  });
  const evidence = workflowFailureEvidence({
    stage: 'plan-scope',
    failureCategory: 'plan-checks-mismatch',
    planDiagnostics: diagnostics,
  });
  assert.equal(evidence.failure.category, 'plan-checks-mismatch');
  assert.deepEqual(evidence.failure.plan.checks.checks[0].differingFields, ['plan.args']);
  assert.equal(JSON.stringify(evidence).includes('test-only-sensitive-value'), false);
});
