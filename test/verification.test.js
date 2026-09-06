import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildVerificationPlan,
  DEFAULT_VERIFICATION_MODE,
  DEFAULT_FAST_MAX_EXECUTIONS,
  DEFAULT_FAST_TIME_BUDGET_MS,
  evaluateEvidenceReuse,
  isBudgetExceeded,
  isCheckAffected,
  isVerificationMode,
  sourceEqual,
  VERIFICATION_MODES,
  validateVerificationSettingsState,
} from '../dist/src/verification/contracts.js';
import {
  configureVerification,
  inspectVerificationSettings,
} from '../dist/src/verification/service.js';

async function tempProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-verification-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

const source = (revision, dirtyFingerprint = null) => ({ revision, dirtyFingerprint });
const criterion = (id = 'criterion_00000000-0000-4000-8000-000000000001', revision = 1) => ({
  id,
  revision,
});
const evidenceItem = (overrides = {}) => ({
  id: 'evidence_00000000-0000-4000-8000-000000000001',
  criterionId: 'criterion_00000000-0000-4000-8000-000000000001',
  criterionRevision: 1,
  kind: 'check',
  outcome: 'passed',
  source: source('deadbeef'),
  ...overrides,
});

test('defaults, mode constants, and defensive parsing', () => {
  assert.deepEqual([...VERIFICATION_MODES], ['fast', 'standard']);
  assert.equal(DEFAULT_VERIFICATION_MODE, 'standard');
  assert.equal(isVerificationMode('fast'), true);
  assert.equal(isVerificationMode('standard'), true);
  assert.equal(isVerificationMode('turbo'), false);
  assert.equal(isVerificationMode(undefined), false);
  assert.ok(DEFAULT_FAST_TIME_BUDGET_MS > 0);
  assert.ok(DEFAULT_FAST_MAX_EXECUTIONS > 0);
});

test('sourceEqual and isCheckAffected match the existing quality-gates watchPaths semantics', () => {
  assert.equal(sourceEqual(source('a', 'b'), source('a', 'b')), true);
  assert.equal(sourceEqual(source('a', 'b'), source('a', 'c')), false);
  assert.equal(sourceEqual(source(null, null), source(null, null)), true);

  const check = { id: 'c1', criterionId: 'criterion_x', watchPaths: ['src/module'] };
  assert.equal(isCheckAffected(check), true, 'no changedPaths conservatively means affected');
  assert.equal(
    isCheckAffected(check, []),
    true,
    'empty changedPaths conservatively means affected',
  );
  assert.equal(isCheckAffected(check, ['docs/readme.md']), false);
  assert.equal(isCheckAffected(check, ['src/module/file.ts']), true);
  assert.equal(isCheckAffected(check, ['src/module']), true);
  assert.equal(
    isCheckAffected({ id: 'c2', criterionId: 'criterion_x' }, ['docs/readme.md']),
    true,
    'a check without declared watchPaths conservatively reruns for any change',
  );
});

test('evaluateEvidenceReuse: standard-mode inputs never influence a fast-mode decision by themselves', () => {
  const unknown = evaluateEvidenceReuse({
    check: { id: 'c1', criterionId: 'criterion_x' },
    criterion: undefined,
    evidence: [],
    currentSource: source('a'),
  });
  assert.equal(unknown.reusable, false);
  assert.equal(unknown.reason, 'unknown-criterion');

  const noEvidence = evaluateEvidenceReuse({
    check: { id: 'c1', criterionId: criterion().id },
    criterion: criterion(),
    evidence: [],
    currentSource: source('a'),
  });
  assert.equal(noEvidence.reusable, false);
  assert.equal(noEvidence.reason, 'no-prior-evidence');

  const failedPrior = evaluateEvidenceReuse({
    check: { id: 'c1', criterionId: criterion().id },
    criterion: criterion(),
    evidence: [evidenceItem({ outcome: 'failed' })],
    currentSource: source('deadbeef'),
  });
  assert.equal(failedPrior.reusable, false);
  assert.equal(failedPrior.reason, 'prior-outcome-failed');
});

test('evaluateEvidenceReuse without changedPaths requires a byte-identical source', () => {
  const same = evaluateEvidenceReuse({
    check: { id: 'c1', criterionId: criterion().id },
    criterion: criterion(),
    evidence: [evidenceItem({ source: source('rev', 'fp1') })],
    currentSource: source('rev', 'fp1'),
  });
  assert.equal(same.reusable, true);
  assert.equal(same.reason, 'source-unchanged');

  const changed = evaluateEvidenceReuse({
    check: { id: 'c1', criterionId: criterion().id },
    criterion: criterion(),
    evidence: [evidenceItem({ source: source('rev', 'fp1') })],
    currentSource: source('rev', 'fp2'),
  });
  assert.equal(changed.reusable, false);
  assert.equal(changed.reason, 'source-changed');
});

test('evaluateEvidenceReuse with changedPaths reuses only checks unaffected by the declared change', () => {
  const scoped = { id: 'c1', criterionId: criterion().id, watchPaths: ['src/module'] };
  const unaffected = evaluateEvidenceReuse({
    check: scoped,
    criterion: criterion(),
    evidence: [evidenceItem()],
    currentSource: source('deadbeef', 'ffff'),
    changedPaths: ['docs/readme.md'],
  });
  assert.equal(unaffected.reusable, true);
  assert.equal(unaffected.reason, 'unaffected-by-change');

  const affected = evaluateEvidenceReuse({
    check: scoped,
    criterion: criterion(),
    evidence: [evidenceItem()],
    currentSource: source('deadbeef', 'ffff'),
    changedPaths: ['src/module/file.ts'],
  });
  assert.equal(affected.reusable, false);
  assert.equal(affected.reason, 'changed-dependency');

  const unscoped = { id: 'c2', criterionId: criterion().id };
  const conservative = evaluateEvidenceReuse({
    check: unscoped,
    criterion: criterion(),
    evidence: [evidenceItem()],
    currentSource: source('deadbeef', 'ffff'),
    changedPaths: ['docs/readme.md'],
  });
  assert.equal(conservative.reusable, false);
  assert.equal(conservative.reason, 'unscoped-check-conservative-rerun');

  const noDeclaredChanges = evaluateEvidenceReuse({
    check: unscoped,
    criterion: criterion(),
    evidence: [evidenceItem()],
    currentSource: source('deadbeef', 'ffff'),
    changedPaths: [],
  });
  assert.equal(noDeclaredChanges.reusable, true);
  assert.equal(noDeclaredChanges.reason, 'no-declared-changes');
});

test('buildVerificationPlan: standard mode always selects every check and reuses nothing', () => {
  const plan = buildVerificationPlan({
    mode: 'standard',
    checks: [
      { id: 'c1', criterionId: criterion().id },
      { id: 'c2', criterionId: criterion().id },
    ],
    criteria: [criterion()],
    evidence: [evidenceItem()],
    currentSource: source('deadbeef'),
  });
  assert.equal(plan.mode, 'standard');
  assert.equal(plan.entries.length, 2);
  assert.ok(plan.entries.every((entry) => entry.selected && !entry.reused));
  assert.ok(plan.entries.every((entry) => entry.reason === 'standard-mode'));
});

test('buildVerificationPlan: fast mode reuses a still-valid check and selects everything else', () => {
  const reusableCheck = { id: 'reusable', criterionId: criterion().id };
  const plan = buildVerificationPlan({
    mode: 'fast',
    checks: [
      reusableCheck,
      { id: 'new', criterionId: 'criterion_00000000-0000-4000-8000-000000000002' },
    ],
    criteria: [criterion(), criterion('criterion_00000000-0000-4000-8000-000000000002')],
    evidence: [evidenceItem({ source: source('deadbeef') })],
    currentSource: source('deadbeef'),
  });
  const reused = plan.entries.find((entry) => entry.checkId === 'reusable');
  const fresh = plan.entries.find((entry) => entry.checkId === 'new');
  assert.equal(reused.reused, true);
  assert.equal(reused.selected, false);
  assert.equal(reused.evidenceId, evidenceItem().id);
  assert.equal(fresh.reused, false);
  assert.equal(fresh.selected, true);
  assert.equal(fresh.reason, 'no-prior-evidence');
});

test('isBudgetExceeded only ever bounds fast mode', () => {
  const budget = { timeBudgetMs: 1000, maxExecutions: 2 };
  assert.equal(isBudgetExceeded('standard', Date.now() - 10_000_000, 100, budget), false);
  assert.equal(isBudgetExceeded('fast', Date.now(), 0, budget), false);
  assert.equal(isBudgetExceeded('fast', Date.now(), 2, budget), true, 'execution count bound');
  assert.equal(isBudgetExceeded('fast', Date.now() - 5000, 0, budget), true, 'time bound');
});

test('verification settings state validation rejects unsupported values', () => {
  const valid = {
    schemaVersion: 1,
    project: { id: 'project_00000000-0000-4000-8000-000000000000' },
    revision: 0,
    settings: { defaultMode: 'fast' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.deepEqual(validateVerificationSettingsState(valid), valid);
  assert.throws(
    () => validateVerificationSettingsState({ ...valid, settings: { defaultMode: 'turbo' } }),
    (error) => {
      assert.equal(error.code, 'VERIFICATION_INVALID');
      assert.equal(error.path, '$.settings.defaultMode');
      return true;
    },
  );
});

test('project verification settings default to standard and persist an explicit change', async (t) => {
  const root = await tempProject(t);
  const inspected = await inspectVerificationSettings(root);
  assert.equal(inspected.settings.defaultMode, 'standard');
  assert.equal(inspected.revision, 0);

  const configured = await configureVerification(root, { defaultMode: 'fast' });
  assert.equal(configured.settings.defaultMode, 'fast');

  const after = await inspectVerificationSettings(root);
  assert.equal(after.settings.defaultMode, 'fast');
  assert.equal(after.revision, 1);

  await assert.rejects(configureVerification(root, { defaultMode: 'turbo' }), (error) => {
    assert.equal(error.code, 'VERIFICATION_INVALID');
    return true;
  });
  assert.equal((await inspectVerificationSettings(root)).settings.defaultMode, 'fast');
});
