import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateScenario,
  evaluateSuite,
  loadEvaluationSpecs,
} from '../dist/src/evaluations/runner.js';

const fixturesRoot = path.resolve('test/fixtures/skill-evaluations');
const fixedNow = () => '2026-01-02T03:04:05.000Z';
const feature = {
  schemaVersion: 1,
  id: 'false-completion',
  kind: 'feature-delivery',
  title: 'Feature with independently checked evidence',
  fixture: 'starter',
  instructions: 'Implement the requested behavior.',
  environment: { requirements: ['node'] },
  expectations: {
    requiredFiles: ['delivered.txt'],
    execution: { required: true },
    evidence: { required: true },
  },
};

test('false all-tests-passed prose fails without independent execution evidence', async () => {
  const result = await evaluateScenario({
    spec: feature,
    fixturesRoot,
    now: fixedNow,
    execute: async () => ({ response: 'All tests passed.' }),
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.checks.filter((item) => !item.passed).map((item) => item.check),
    ['required-file:delivered.txt', 'execution-evidence', 'task-evidence'],
  );
});

test('isolates fixture copies, scores observable outputs, and removes them after a run', async () => {
  let workspace;
  const result = await evaluateScenario({
    spec: feature,
    fixturesRoot,
    now: fixedNow,
    execute: async ({ workspace: root }) => {
      workspace = root;
      await writeFile(path.join(root, 'delivered.txt'), 'done');
      return {
        execution: { status: 'exited', exitCode: 0 },
        taskEvidence: [{ outcome: 'passed' }],
      };
    },
  });
  assert.equal(result.status, 'passed');
  await assert.rejects(() => access(workspace));
  await assert.rejects(() => access(path.join(fixturesRoot, 'starter', 'delivered.txt')));
});

test('timeout, missing artifact, and explicit provider skip are not passing results', async () => {
  const timedOut = await evaluateScenario({
    spec: feature,
    fixturesRoot,
    timeoutMs: 10,
    now: fixedNow,
    execute: async () => new Promise(() => {}),
  });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.execution.status, 'timed-out');
  const skipped = await evaluateScenario({
    spec: feature,
    fixturesRoot,
    now: fixedNow,
    execute: async () => ({ skip: 'Provider credentials unavailable.' }),
  });
  assert.equal(skipped.status, 'skipped');
});

test('fixture suite covers each workflow boundary and report ordering is deterministic', async () => {
  const specs = await loadEvaluationSpecs(fixturesRoot);
  assert.deepEqual(
    new Set(specs.map((item) => item.kind)),
    new Set([
      'feature-delivery',
      'fix',
      'requirements-only',
      'review-only',
      'handoff-resume',
      'interrupted-verification',
      'unsupported-capability',
      'authorization-conflict',
    ]),
  );
  const report = await evaluateSuite({
    specs: [specs[1], specs[0]],
    fixturesRoot,
    now: fixedNow,
    metadata: { token: 'secret-value' },
    execute: async ({ workspace, scenario }) => {
      for (const file of scenario.expectations.requiredFiles ?? [])
        await writeFile(path.join(workspace, file), 'ok');
      for (const item of scenario.expectations.requiredContent ?? [])
        await writeFile(path.join(workspace, item.path), item.includes);
      return {
        execution: scenario.expectations.execution ? { status: 'exited', exitCode: 0 } : undefined,
        taskEvidence: scenario.expectations.evidence ? [{ outcome: 'passed' }] : [],
        response: 'observable result',
      };
    },
  });
  assert.deepEqual(
    report.scenarios.map((item) => item.id),
    ['feature-delivery', 'reproduction-fix'],
  );
  assert.equal(report.generatedAt, fixedNow());
  assert.equal(report.metadata.token, '[REDACTED]');
});
