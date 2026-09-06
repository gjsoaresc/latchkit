import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadRequirementChangeSpecs,
  renderRequirementChangeMarkdown,
  runRequirementChangeScenario,
  runRequirementChangeSuite,
  unavailableReconciliationArm,
} from '../dist/src/evaluations/runner.js';
import {
  SKILL_EVALUATION_V2_VERSION,
  validateRequirementChangeResult,
  validateRequirementChangeSpec,
} from '../dist/src/evaluations/contracts.js';

const fixturesRoot = path.resolve('test/fixtures/skill-evaluations');
const fixedNow = () => '2026-01-02T03:04:05.000Z';

async function loadScenario(id) {
  const specs = await loadRequirementChangeSpecs(fixturesRoot);
  const scenario = specs.find((item) => item.id === id);
  assert.ok(scenario, `fixture scenario "${id}" must exist`);
  return scenario;
}

/** Runs the fixture's own bundled scripted controller, exactly like the default. */
async function realApplyChange({ workspace, scenario }) {
  const imported = await import(pathToFileURL(path.join(workspace, 'apply-change.mjs')).href);
  return imported.default({ workspace, scenario });
}

test('loadRequirementChangeSpecs exposes both original requirement-change fixtures', async () => {
  const specs = await loadRequirementChangeSpecs(fixturesRoot);
  assert.deepEqual(specs.map((item) => item.id).sort(), [
    'export-visibility',
    'notification-opt-out',
  ]);
  for (const spec of specs) {
    assert.equal(spec.schemaVersion, SKILL_EVALUATION_V2_VERSION);
    assert.equal(spec.kind, 'requirement-change');
    assert.equal(validateRequirementChangeSpec(spec).id, spec.id);
  }
});

test('scripted-controller arm passes the deterministic correctness gate on the original fixtures', async () => {
  for (const id of ['export-visibility', 'notification-opt-out']) {
    const scenario = await loadScenario(id);
    const result = await runRequirementChangeScenario({
      spec: scenario,
      fixturesRoot,
      now: fixedNow,
    });
    const baseline = result.arms.baseline;
    assert.equal(baseline.status, 'completed');
    assert.equal(baseline.controller, 'scripted');
    assert.equal(baseline.correctnessGate.passed, true, JSON.stringify(baseline.correctnessGate));
    assert.deepEqual(baseline.correctnessGate.failures, []);
    assert.ok(baseline.correctnessGate.denominator > 0);
    assert.equal(baseline.acceptance.failedIds.length, 0);
    assert.equal(baseline.metrics.find((item) => item.id === 'finalBehavioralSuccess').value, true);
    assert.equal(
      baseline.metrics.find((item) => item.id === 'coordinatorUsage').availability,
      'unavailable',
    );
    assert.equal(
      baseline.metrics.find((item) => item.id === 'workerUsage').availability,
      'unavailable',
    );
  }
});

test('unknown-impact dependency is flagged, not resolved, and never coerced to a pass/fail verdict', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
  });
  const gate = result.arms.baseline.correctnessGate;
  assert.equal(gate.uncertain.length, 1);
  assert.match(gate.uncertain[0], /order-access/);
  assert.match(gate.uncertain[0], /flagged for review/);
  assert.equal(
    result.arms.baseline.metrics.find((item) => item.id === 'detectedSeededDependencies').value,
    1,
  );
});

test('reconciliation arm exercises #110-#112 and hands the real context brief to its next controller', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
  });
  const reconciliation = result.arms.reconciliation;
  assert.equal(reconciliation.status, 'completed');
  assert.equal(reconciliation.controller, 'scripted');
  assert.equal(reconciliation.correctnessGate.passed, true);
  assert.equal(reconciliation.reconciliationEvidence.intentSuperseded, true);
  assert.equal(reconciliation.reconciliationEvidence.stalePreviewRejected, true);
  assert.equal(reconciliation.reconciliationEvidence.unknownImpactExplicit, true);
  assert.equal(reconciliation.reconciliationEvidence.preservedArtifacts, true);
  const resumeContext = reconciliation.reconciliationEvidence.resumeContext;
  assert.equal(resumeContext.status, 'delivered');
  assert.match(resumeContext.digest, /^[a-f0-9]{64}$/);
  assert.equal(resumeContext.schemaVersion, 1);
  assert.ok(resumeContext.bytes > 0);
  assert.equal(resumeContext.nextAction, 'ordinary-task');
  assert.equal(resumeContext.delivery, 'scripted-controller-handoff');
  assert.equal(unavailableReconciliationArm().arm, 'reconciliation');
});

test('reconciliation passes the current #112 projection into the scripted-controller handoff', async () => {
  const scenario = await loadScenario('export-visibility');
  let delivered;
  await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async (input) => {
      delivered = input.resumeContext;
      return realApplyChange(input);
    },
  });
  assert.ok(delivered);
  assert.equal(delivered.nextAction.kind, 'ordinary-task');
  assert.ok(
    delivered.acceptedDecisions.some((item) => item.text === scenario.changedRequirement),
    'the handoff must project the reconciled requirement rather than the superseded one',
  );
  assert.ok(
    delivered.openQuestions.some((item) => item.text.includes('Shared order-listing helper')),
    'the handoff must retain the unresolved dependency question',
  );
});

test('reconciliation evidence does not claim unknown impact without the seeded dependency proof', async () => {
  const scenario = structuredClone(await loadScenario('export-visibility'));
  scenario.unknownImpactDependencies = [];
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
  });
  assert.equal(result.arms.reconciliation.status, 'completed');
  assert.equal(result.arms.reconciliation.reconciliationEvidence.unknownImpactExplicit, false);
});

test('gate fails a mandatory constraint that a no-op controller drops', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async ({ scenario: spec }) => ({
      changeLog: {
        requirementApplied: spec.changedRequirement,
        authorized: true,
        claimsComplete: false,
        touchedFiles: [],
        flaggedDependencies: [],
      },
    }),
  });
  const gate = result.arms.baseline.correctnessGate;
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.some((item) => item.rule === 'dropped-mandatory-constraint'));
  assert.ok(!gate.failures.some((item) => item.rule === 'stale-completion'));
});

test('gate fails stale completion when a no-op controller claims the task is done anyway', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async ({ scenario: spec }) => ({
      changeLog: {
        requirementApplied: spec.changedRequirement,
        authorized: true,
        claimsComplete: true,
        touchedFiles: [],
        flaggedDependencies: [],
      },
    }),
  });
  const gate = result.arms.baseline.correctnessGate;
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.some((item) => item.rule === 'dropped-mandatory-constraint'));
  assert.ok(gate.failures.some((item) => item.rule === 'stale-completion'));
  assert.equal(
    result.arms.baseline.metrics.find((item) => item.id === 'falseCompletion').value,
    true,
  );
});

test('gate fails unauthorized intent promotion when the change log does not authorize the applied requirement', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async (input) => {
      const outcome = await realApplyChange(input);
      return { ...outcome, changeLog: { ...outcome.changeLog, authorized: false } };
    },
  });
  const gate = result.arms.baseline.correctnessGate;
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.some((item) => item.rule === 'unauthorized-intent-promotion'));
});

test('gate fails silently lost work when a preserved artifact changes without appearing in the change log', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async (input) => {
      const outcome = await realApplyChange(input);
      await writeFile(path.join(input.workspace, 'src', 'csvFormat.js'), '// corrupted\n');
      return outcome;
    },
  });
  const gate = result.arms.baseline.correctnessGate;
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.some((item) => item.rule === 'silently-lost-work'));
  assert.equal(result.arms.baseline.metrics.find((item) => item.id === 'discardedWork').value, 1);
});

test('a declared (not silent) preserve-artifact change is a metric, not a gate failure', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async (input) => {
      const outcome = await realApplyChange(input);
      await writeFile(path.join(input.workspace, 'src', 'csvFormat.js'), '// declared change\n');
      return {
        ...outcome,
        changeLog: {
          ...outcome.changeLog,
          touchedFiles: [...outcome.changeLog.touchedFiles, 'src/csvFormat.js'],
        },
      };
    },
  });
  const gate = result.arms.baseline.correctnessGate;
  assert.ok(!gate.failures.some((item) => item.rule === 'silently-lost-work'));
  assert.equal(
    result.arms.baseline.metrics.find((item) => item.id === 'unnecessaryInvalidation').value,
    1,
  );
});

test('a missed unknown-impact dependency lowers the detected/missed metrics but never fails the gate', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async (input) => {
      const outcome = await realApplyChange(input);
      return { ...outcome, changeLog: { ...outcome.changeLog, flaggedDependencies: [] } };
    },
  });
  assert.equal(result.arms.baseline.correctnessGate.passed, true);
  assert.equal(
    result.arms.baseline.metrics.find((item) => item.id === 'detectedSeededDependencies').value,
    0,
  );
  assert.equal(
    result.arms.baseline.metrics.find((item) => item.id === 'missedSeededDependencies').value,
    1,
  );
  assert.match(result.arms.baseline.correctnessGate.uncertain[0], /not flagged/);
});

test('an explicit provider skip makes the baseline arm unavailable, never a fabricated pass', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async () => ({ skip: 'Provider credentials unavailable.' }),
  });
  assert.equal(result.arms.baseline.status, 'unavailable');
  assert.equal(result.arms.baseline.reason, 'Provider credentials unavailable.');
  assert.equal(result.arms.reconciliation.status, 'unavailable');
});

test('regression assertions tagged preexisting are reported separately from the new requirement', async () => {
  const scenario = await loadScenario('export-visibility');
  const result = await runRequirementChangeScenario({
    spec: scenario,
    fixturesRoot,
    now: fixedNow,
    applyChange: async ({ workspace, scenario: spec }) => {
      const outcome = await realApplyChange({ workspace, scenario: spec });
      // Corrupt the CSV header the fixture's own acceptance module checks, and
      // declare the change so this exercises "regressions" rather than the
      // silently-lost-work gate rule.
      const formatPath = path.join(workspace, 'src', 'csvFormat.js');
      const original = await readFile(formatPath, 'utf8');
      await writeFile(formatPath, original.replace("'id,customerId,total'", "'broken-header'"));
      return {
        ...outcome,
        changeLog: {
          ...outcome.changeLog,
          touchedFiles: [...outcome.changeLog.touchedFiles, 'src/csvFormat.js'],
        },
      };
    },
  });
  const gate = result.arms.baseline.correctnessGate;
  assert.ok(gate.regressions.some((item) => item.startsWith('csv-still-has-header')));
});

test('suite run reports the full scenario denominator, redacts metadata, and produces a schema-valid result', async () => {
  const specs = await loadRequirementChangeSpecs(fixturesRoot);
  const result = await runRequirementChangeSuite({
    specs,
    fixturesRoot,
    now: fixedNow,
    metadata: { note: 'offline harness run', token: 'secret-value' },
  });
  assert.equal(result.schemaVersion, SKILL_EVALUATION_V2_VERSION);
  assert.equal(result.scenarios.length, 2);
  assert.equal(result.counts.completed, 2);
  assert.equal(result.counts.unavailable, 0);
  assert.ok(result.denominator > 0);
  assert.equal(result.metadata.token, '[REDACTED]');
  assert.equal(result.metadata.note, 'offline harness run');
  assert.equal(result.metricDefinitions.length, 14);
  const validated = validateRequirementChangeResult(result);
  assert.equal(validated.scenarios.length, 2);
  const markdown = renderRequirementChangeMarkdown(result);
  assert.match(markdown, /export-visibility/);
  assert.match(markdown, /notification-opt-out/);
  assert.match(markdown, /passed \(\d+ checks\)/);
});

test('runRequirementChangeSuite refuses an empty scenario list', async () => {
  await assert.rejects(
    () => runRequirementChangeSuite({ specs: [], fixturesRoot, now: fixedNow }),
    /at least one scenario/,
  );
});
