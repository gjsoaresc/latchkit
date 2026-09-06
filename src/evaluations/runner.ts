import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from '../diagnostics/redact.js';
import {
  applyTaskReconciliation,
  createTask,
  previewTaskReconciliation,
  recordTaskRecord,
  transitionTaskRecord,
} from '../task-state/service.js';
import {
  REQUIREMENT_CHANGE_METRICS,
  SKILL_EVALUATION_V2_VERSION,
  SKILL_EVALUATION_VERSION,
  validateEvaluationSpec,
  validateRequirementChangeSpec,
  type AcceptanceSummary,
  type CorrectnessGateResult,
  type EvaluationCheck,
  type EvaluationResult,
  type EvaluationScenarioResult,
  type EvaluationSpec,
  type MetricAvailability,
  type RequirementChangeArmResult,
  type RequirementChangeLog,
  type RequirementChangeMetricResult,
  type RequirementChangeScenario,
  type RequirementChangeScenarioResult,
  type RequirementChangeSuiteResult,
} from './contracts.js';

interface EvaluationRun {
  skip?: unknown;
  execution?: { status?: string; exitCode?: number };
  taskEvidence?: Array<{ outcome?: string }>;
  response?: unknown;
}
interface EvaluationExecutionInput {
  workspace: string;
  instructions: string;
  scenario: EvaluationSpec;
  signal: AbortSignal;
}
type Execute = (input: EvaluationExecutionInput) => Promise<EvaluationRun> | EvaluationRun;
interface FileCheck extends EvaluationCheck {
  file?: string;
  includes?: string;
}
interface ScenarioOptions {
  spec: unknown;
  fixturesRoot: string;
  execute: Execute;
  timeoutMs?: number;
  now?: () => string;
}
interface SuiteOptions {
  specs: readonly unknown[];
  fixturesRoot: string;
  execute: Execute;
  metadata?: unknown;
  now?: () => string;
  timeoutMs?: number;
}

const safe = (relative: unknown): string => {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes('..')
  )
    throw new TypeError('Evaluation paths must be safe relative paths.');
  return relative;
};
const present = async (root: string, relative: string): Promise<boolean> => {
  try {
    return (await stat(path.join(root, safe(relative)))).isFile();
  } catch {
    return false;
  }
};
const boundedText = (value: unknown) => String(value ?? '').slice(0, 16 * 1024);

function score(
  spec: EvaluationSpec,
  run: EvaluationRun,
  workspace: string,
): Promise<EvaluationCheck[]> {
  const checks: FileCheck[] = [];
  const expect = spec.expectations;
  for (const file of expect.requiredFiles ?? [])
    checks.push({ check: `required-file:${file}`, passed: false, actual: 'missing', file });
  for (const file of expect.forbiddenFiles ?? [])
    checks.push({ check: `forbidden-file:${file}`, passed: false, actual: 'present', file });
  for (const item of expect.requiredContent ?? [])
    checks.push({
      check: `required-content:${item.path}`,
      passed: false,
      actual: 'missing',
      file: item.path,
      includes: item.includes,
    });
  return Promise.all(
    checks.map(async (check) => {
      const file = check.file;
      if (!file) throw new TypeError(`Evaluation check is missing a file: ${check.check}`);
      const exists = await present(workspace, file);
      if (check.check.startsWith('required-content')) {
        const content = exists ? await readFile(path.join(workspace, file), 'utf8') : '';
        check.passed = content.includes(check.includes ?? '');
        check.actual = exists ? (check.passed ? 'matched' : 'mismatch') : 'missing';
        delete check.includes;
      } else {
        check.passed = check.check.startsWith('required') ? exists : !exists;
        check.actual = exists ? 'present' : 'missing';
      }
      delete check.file;
      return check;
    }),
  ).then(async (fileChecks) => {
    const all = [...fileChecks];
    if (expect.execution?.required) {
      const passed = run.execution?.status === 'exited' && run.execution.exitCode === 0;
      all.push({ check: 'execution-evidence', passed, actual: run.execution?.status ?? 'absent' });
    }
    if (expect.evidence?.required) {
      const passed =
        Array.isArray(run.taskEvidence) &&
        run.taskEvidence.some((item) => item.outcome === 'passed');
      all.push({
        check: 'task-evidence',
        passed,
        actual: passed ? 'passing' : 'absent-or-nonpassing',
      });
    }
    if (expect.response?.required) {
      const passed = typeof run.response === 'string' && run.response.trim().length > 0;
      all.push({ check: 'response', passed, actual: passed ? 'present' : 'absent' });
    }
    return all;
  });
}

/**
 * Evaluate a single run in a fresh copy of an original fixture. `execute` is
 * deliberately injected: default CI never starts a provider or spends tokens.
 */
export async function evaluateScenario({
  spec,
  fixturesRoot,
  execute,
  timeoutMs = 30_000,
  now = () => new Date().toISOString(),
}: ScenarioOptions): Promise<EvaluationScenarioResult> {
  const scenario = validateEvaluationSpec(spec);
  if (typeof execute !== 'function')
    throw new TypeError('evaluateScenario requires an execute function.');
  const source = path.resolve(fixturesRoot, safe(scenario.fixture));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'latchkit-evaluation-'));
  try {
    await cp(source, workspace, { recursive: true, force: false, errorOnExist: false });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
      throw new TypeError('timeoutMs must be positive.');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run: EvaluationRun =
      (await Promise.race([
        Promise.resolve(
          execute({
            workspace,
            instructions: scenario.instructions,
            scenario,
            signal: controller.signal,
          }),
        ),
        new Promise<EvaluationRun>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({
              execution: { status: 'timed-out' },
              response: 'Evaluation execution timed out.',
            });
          }, timeoutMs);
        }),
      ])) ?? {};
    clearTimeout(timer);
    if (run.skip)
      return {
        id: scenario.id,
        kind: scenario.kind,
        status: 'skipped',
        reason: boundedText(redact(run.skip)),
        checks: [],
        execution: redact(run.execution ?? null),
        taskEvidence: [],
        response: boundedText(redact(run.response ?? '')),
        completedAt: now(),
      };
    const checks = await score(scenario, run, workspace);
    return {
      id: scenario.id,
      kind: scenario.kind,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      execution: redact(run.execution ?? null),
      taskEvidence: redact(run.taskEvidence ?? []),
      response: boundedText(redact(run.response ?? '')),
      completedAt: now(),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function evaluateSuite({
  specs,
  fixturesRoot,
  execute,
  metadata = {},
  now,
  timeoutMs,
}: SuiteOptions): Promise<EvaluationResult> {
  if (!Array.isArray(specs) || !specs.length)
    throw new TypeError('Evaluation suite needs at least one scenario.');
  const scenarios: EvaluationScenarioResult[] = [];
  for (const spec of [...specs].sort((left, right) => left.id.localeCompare(right.id)))
    scenarios.push(await evaluateScenario({ spec, fixturesRoot, execute, now, timeoutMs }));
  const counts = {
    passed: scenarios.filter((item) => item.status === 'passed').length,
    failed: scenarios.filter((item) => item.status === 'failed').length,
    skipped: scenarios.filter((item) => item.status === 'skipped').length,
  };
  return {
    schemaVersion: SKILL_EVALUATION_VERSION,
    generatedAt: now ? now() : new Date().toISOString(),
    metadata: redact(metadata),
    counts,
    scenarios,
  };
}

export async function loadEvaluationSpecs(directory: string): Promise<EvaluationSpec[]> {
  const index = JSON.parse(await readFile(path.join(directory, 'scenarios.json'), 'utf8'));
  if (!Array.isArray(index)) throw new TypeError('scenarios.json must be an array.');
  return index.map(validateEvaluationSpec);
}

export function renderEvaluationMarkdown(result: EvaluationResult): string {
  const lines = [
    '# Latchkit skill evaluation',
    '',
    `Generated: ${result.generatedAt}`,
    '',
    '| Scenario | Kind | Result |',
    '| --- | --- | --- |',
    ...result.scenarios.map((item) => `| ${item.id} | ${item.kind} | ${item.status} |`),
    '',
    `Passed: ${result.counts.passed}; failed: ${result.counts.failed}; skipped: ${result.counts.skipped}.`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Requirement-change evaluations (issue #116). See `src/evaluations/contracts.ts` for the
 * versioned scenario/result shape, the metric definitions, and their limitations.
 *
 * A scenario's fixture is copied into an isolated temporary workspace exactly like the
 * version-1 harness above. The scripted-controller arm then runs an injected, deterministic
 * `applyChange` function (by default, the fixture's own bundled `apply-change.mjs`) that
 * mechanically applies the scenario's seeded change and records a change log. The runner
 * hashes every workspace file before and after that call — it does not rely solely on the
 * change log's self-report — then grades the result against the deterministic correctness
 * gate and the fixed metric set. The reconciliation arm (the #110-#112 intent/reconciliation
 * flow) is always reported as an explicit, schema-level "unavailable" result: this increment
 * does not stub a fake outcome for work that has not merged yet.
 */
export interface ApplyChangeInput {
  workspace: string;
  scenario: RequirementChangeScenario;
}
export interface ApplyChangeOutcome {
  skip?: unknown;
  response?: string;
  changeLog?: RequirementChangeLog;
}
export type ApplyChange = (
  input: ApplyChangeInput,
) => Promise<ApplyChangeOutcome> | ApplyChangeOutcome;

export interface AcceptanceRunInput {
  workspace: string;
  scenario: RequirementChangeScenario;
}
export interface AcceptanceRunOutcome {
  results?: Record<string, boolean>;
  response?: string;
}
export type RunAcceptance = (
  input: AcceptanceRunInput,
) => Promise<AcceptanceRunOutcome> | AcceptanceRunOutcome;

interface RequirementChangeScenarioOptions {
  spec: unknown;
  fixturesRoot: string;
  applyChange?: ApplyChange;
  runAcceptance?: RunAcceptance;
  now?: () => string;
}
interface RequirementChangeSuiteOptions {
  specs: readonly unknown[];
  fixturesRoot: string;
  applyChange?: ApplyChange;
  runAcceptance?: RunAcceptance;
  metadata?: unknown;
  now?: () => string;
}

const RECONCILIATION_UNAVAILABLE_REASON =
  'The intent/reconciliation flow depends on issues #110 (decision/assumption/observation ' +
  'identities), #111 (amend intent, inspect impact, invalidate stale evidence), and #112 ' +
  '(bounded resume brief). None of those are available in this repository slice, so this arm ' +
  'is an explicit schema-level placeholder rather than a stubbed or fabricated result. It will ' +
  'be filled in once #110-#112 merge.';

/** The second arm from issue #116 acceptance criterion 4: explicit and schema-level, never a stub. */
export function unavailableReconciliationArm(
  reason: string = RECONCILIATION_UNAVAILABLE_REASON,
): RequirementChangeArmResult {
  return { arm: 'reconciliation', status: 'unavailable', reason, metrics: [] };
}

async function collectWorkspaceFiles(root: string, base: string = root): Promise<string[]> {
  const entries = await readdir(base, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) files.push(...(await collectWorkspaceFiles(root, full)));
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return files;
}
async function hashWorkspaceFile(file: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  } catch {
    return null;
  }
}
async function hashWorkspaceFiles(
  root: string,
  files: readonly string[],
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    files.map(async (file): Promise<[string, string | null]> => [
      file,
      await hashWorkspaceFile(path.join(root, file)),
    ]),
  );
  return Object.fromEntries(entries);
}

function hasDefaultExport(value: unknown): value is { default: unknown } {
  return typeof value === 'object' && value !== null && 'default' in value;
}
const defaultApplyChange: ApplyChange = async ({ workspace, scenario }) => {
  const imported: unknown = await import(
    pathToFileURL(path.join(workspace, 'apply-change.mjs')).href
  );
  const candidate = hasDefaultExport(imported) ? imported.default : undefined;
  if (typeof candidate !== 'function')
    throw new TypeError(`Fixture "${scenario.fixture}" has no default apply-change export.`);
  return (candidate as ApplyChange)({ workspace, scenario });
};
const defaultRunAcceptance: RunAcceptance = async ({ workspace, scenario }) => {
  const imported: unknown = await import(
    pathToFileURL(path.join(workspace, safe(scenario.acceptance.module))).href
  );
  const candidate = hasDefaultExport(imported) ? imported.default : undefined;
  if (typeof candidate !== 'function')
    throw new TypeError(`Fixture "${scenario.fixture}" has no default acceptance export.`);
  return (candidate as RunAcceptance)({ workspace, scenario });
};

const RESUME_CONTEXT_UNAVAILABLE =
  'Issue #112 is not merged: this offline arm does not fabricate a provider resume-context result.';

async function runReconciliationArm(input: {
  source: string;
  scenario: RequirementChangeScenario;
  applyChange: ApplyChange;
  runAcceptance: RunAcceptance;
}): Promise<RequirementChangeArmResult> {
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-reconciliation-')),
  );
  try {
    await cp(input.source, workspace, { recursive: true, force: false, errorOnExist: false });
    const preFiles = await collectWorkspaceFiles(workspace);
    const preHashes = await hashWorkspaceFiles(workspace, preFiles);
    const authorization = {
      source: 'user' as const,
      scope: 'apply changed requirement',
      reference: 'seeded requirement change',
    };
    let task = await createTask(workspace, {
      title: input.scenario.title,
      authorization,
      criteria: input.scenario.mandatoryConstraints.map((description) => ({ description })),
    });
    task = await recordTaskRecord(workspace, {
      taskId: task.id,
      expectedRevision: task.revision,
      kind: 'decision',
      text: input.scenario.initialRequirement,
      provenance: { kind: 'direct-user', reference: 'seeded initial requirement' },
    });
    const oldDecision = task.records?.at(-1);
    if (!oldDecision) throw new Error('Failed to seed the initial requirement decision.');
    task = await transitionTaskRecord(workspace, {
      taskId: task.id,
      expectedRevision: task.revision,
      recordId: oldDecision.id,
      recordRevision: oldDecision.revision,
      status: 'accepted',
      reason: 'seeded initial authorization',
      authorization,
    });
    const accepted = task.records?.find((record) => record.id === oldDecision.id);
    if (!accepted) throw new Error('Failed to accept the seeded requirement decision.');
    // A declared dependent makes the impact graph inspectable; it is a question rather than an
    // authority, so the fixture's deliberately misleading memory never becomes task intent.
    task = await recordTaskRecord(workspace, {
      taskId: task.id,
      expectedRevision: task.revision,
      kind: 'question',
      text: input.scenario.unknownImpactDependencies[0]?.note ?? 'Unknown impact requires review.',
      provenance: { kind: 'agent-inferred', reference: 'seeded unknown dependency' },
      links: [{ type: 'record', recordId: accepted.id, recordRevision: accepted.revision }],
    });
    const patch = {
      recordOps: [
        {
          op: 'supersede' as const,
          recordId: accepted.id,
          recordRevision: accepted.revision,
          kind: 'decision' as const,
          text: input.scenario.changedRequirement,
          provenance: { kind: 'direct-user' as const, reference: 'seeded changed requirement' },
          authorization,
        },
      ],
    };
    const preview = await previewTaskReconciliation(workspace, { taskId: task.id, patch });
    // Mutate after preview, then prove the digest fence rejects the stale review before retrying.
    task = await recordTaskRecord(workspace, {
      taskId: task.id,
      expectedRevision: task.revision,
      kind: 'observation',
      text: 'Pre-apply review recorded.',
      provenance: { kind: 'agent-inferred', reference: 'evaluation stale-preview probe' },
    });
    let stalePreviewRejected = false;
    try {
      await applyTaskReconciliation(workspace, {
        taskId: task.id,
        expectedRevision: task.revision,
        patch,
        previewDigest: preview.digest,
      });
    } catch (error) {
      stalePreviewRejected = (error as { code?: string }).code === 'TASK_RECONCILE_PREVIEW_STALE';
    }
    const freshPreview = await previewTaskReconciliation(workspace, { taskId: task.id, patch });
    const applied = await applyTaskReconciliation(workspace, {
      taskId: task.id,
      expectedRevision: task.revision,
      patch,
      previewDigest: freshPreview.digest,
    });
    const started = process.hrtime.bigint();
    const controllerResult = await Promise.resolve(
      input.applyChange({ workspace, scenario: input.scenario }),
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const changeLog: RequirementChangeLog = controllerResult.changeLog ?? {};
    const postFiles = await collectWorkspaceFiles(workspace);
    const postHashes = await hashWorkspaceFiles(workspace, [
      ...new Set([...preFiles, ...postFiles]),
    ]);
    const acceptanceResults =
      (await Promise.resolve(input.runAcceptance({ workspace, scenario: input.scenario })))
        .results ?? {};
    const gate = evaluateRequirementChangeGate({
      scenario: input.scenario,
      changeLog,
      acceptanceResults,
      preHashes,
      postHashes,
    });
    return {
      arm: 'reconciliation',
      status: 'completed',
      controller: 'scripted',
      metrics: computeRequirementChangeMetrics({
        scenario: input.scenario,
        changeLog,
        preHashes,
        postHashes,
        elapsedMs,
        acceptanceResults,
      }),
      correctnessGate: gate,
      acceptance: summarizeRequirementChangeAcceptance(input.scenario, acceptanceResults),
      flaggedDependencies: redact(changeLog.flaggedDependencies ?? []) as string[],
      reconciliationEvidence: {
        intentSuperseded:
          applied.task.records?.find((record) => record.id === accepted.id)?.status ===
          'superseded',
        stalePreviewRejected,
        unknownImpactExplicit:
          freshPreview.impact.some((entry) => entry.classification === 'declared-dependent') &&
          freshPreview.uncertainties.length >= 0,
        preservedArtifacts: input.scenario.preserveArtifacts.every(
          (file) => preHashes[file] === postHashes[file],
        ),
        resumeContext: { status: 'unavailable', reason: RESUME_CONTEXT_UNAVAILABLE },
      },
    };
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

interface GateInput {
  scenario: RequirementChangeScenario;
  changeLog: RequirementChangeLog;
  acceptanceResults: Record<string, boolean>;
  preHashes: Record<string, string | null>;
  postHashes: Record<string, string | null>;
}

/**
 * The deterministic correctness gate for the scripted-controller arm (issue #116, acceptance
 * criterion 3). Zero tolerance for stale completion, unauthorized intent promotion, dropped
 * mandatory constraints, and silently lost work. `uncertain` lists the scenario's seeded
 * unknown-impact dependencies and is never folded into pass/fail: unknown semantic impact
 * stays unknown, it is not coerced into affected/unaffected. `regressions` lists
 * pre-existing (unrelated to the new requirement) assertions that broke as a side effect of
 * the change.
 */
export function evaluateRequirementChangeGate({
  scenario,
  changeLog,
  acceptanceResults,
  preHashes,
  postHashes,
}: GateInput): CorrectnessGateResult {
  const failures: CorrectnessGateResult['failures'] = [];
  const regressions: string[] = [];
  let denominator = 0;

  const mandatoryAssertions = scenario.acceptance.assertions.filter((item) => item.mandatory);
  for (const assertion of mandatoryAssertions) {
    denominator += 1;
    if (acceptanceResults[assertion.id] !== true)
      failures.push({
        rule: 'dropped-mandatory-constraint',
        detail: `Assertion "${assertion.id}" (${assertion.description}) did not pass.`,
      });
  }
  for (const assertion of scenario.acceptance.assertions.filter(
    (item) => item.tag === 'preexisting',
  ))
    if (acceptanceResults[assertion.id] !== true)
      regressions.push(`${assertion.id}: ${assertion.description}`);

  const touchedFiles = changeLog.touchedFiles ?? [];
  for (const file of scenario.preserveArtifacts) {
    denominator += 1;
    const before = preHashes[file] ?? null;
    const after = postHashes[file] ?? null;
    if (before !== after && !touchedFiles.includes(file))
      failures.push({
        rule: 'silently-lost-work',
        detail: `"${file}" changed without appearing in the recorded change log.`,
      });
  }

  denominator += 1;
  const authorized =
    changeLog.requirementApplied === scenario.changedRequirement && changeLog.authorized === true;
  if (!authorized)
    failures.push({
      rule: 'unauthorized-intent-promotion',
      detail:
        'No explicit, authorized change-log record binds the applied change to the declared new requirement.',
    });

  denominator += 1;
  const anyMandatoryFailed = failures.some((item) => item.rule === 'dropped-mandatory-constraint');
  if (changeLog.claimsComplete === true && anyMandatoryFailed)
    failures.push({
      rule: 'stale-completion',
      detail:
        'The change log claims completion while a mandatory acceptance assertion is still failing.',
    });

  const flagged = changeLog.flaggedDependencies ?? [];
  const uncertain = scenario.unknownImpactDependencies.map(
    (dependency) =>
      `${dependency.id} (${dependency.path}): impact intentionally seeded as unknown; ${
        flagged.includes(dependency.id)
          ? 'flagged for review'
          : 'not flagged — remains unresolved and unreviewed'
      }.`,
  );

  return { denominator, failures, uncertain, regressions, passed: failures.length === 0 };
}

function requirementChangeMetric(
  id: string,
  availability: MetricAvailability,
  value: number | boolean | null,
  detail: string,
): RequirementChangeMetricResult {
  return { id, availability, value, detail };
}

function computeRequirementChangeMetrics(input: {
  scenario: RequirementChangeScenario;
  changeLog: RequirementChangeLog;
  preHashes: Record<string, string | null>;
  postHashes: Record<string, string | null>;
  elapsedMs: number;
  acceptanceResults: Record<string, boolean>;
}): RequirementChangeMetricResult[] {
  const { scenario, changeLog, preHashes, postHashes, elapsedMs, acceptanceResults } = input;
  const changedFiles = new Set(
    Object.keys(postHashes).filter((file) => postHashes[file] !== (preHashes[file] ?? null)),
  );
  const mandatoryAssertions = scenario.acceptance.assertions.filter((item) => item.mandatory);
  const omitted = mandatoryAssertions.filter((item) => acceptanceResults[item.id] !== true).length;
  const finalSuccess = mandatoryAssertions.length > 0 && omitted === 0;
  const flagged = changeLog.flaggedDependencies ?? [];
  const detectedUnknown = scenario.unknownImpactDependencies.filter((item) =>
    flagged.includes(item.id),
  ).length;
  const missedUnknown = scenario.unknownImpactDependencies.length - detectedUnknown;
  const touchedFiles = changeLog.touchedFiles ?? [];
  const preserveChanged = scenario.preserveArtifacts.filter((file) => changedFiles.has(file));
  const discarded = preserveChanged.length;
  const retained = scenario.preserveArtifacts.length - discarded;
  const unnecessaryInvalidation = preserveChanged.filter((file) =>
    touchedFiles.includes(file),
  ).length;
  const alwaysExpected = new Set<string>([
    ...scenario.changeTargets,
    'requirement.md',
    'apply-change.mjs',
    scenario.acceptance.module,
    'change-log.json',
  ]);
  const rework = [...changedFiles].filter(
    (file) => !alwaysExpected.has(file) && !scenario.preserveArtifacts.includes(file),
  ).length;

  return [
    requirementChangeMetric(
      'finalBehavioralSuccess',
      'measured',
      finalSuccess,
      `${mandatoryAssertions.length - omitted}/${mandatoryAssertions.length} mandatory assertions passed.`,
    ),
    requirementChangeMetric(
      'falseCompletion',
      'measured',
      changeLog.claimsComplete === true && omitted > 0,
      changeLog.claimsComplete === true
        ? 'Change log claimed completion.'
        : 'Change log did not claim completion.',
    ),
    requirementChangeMetric(
      'staleResultAcceptance',
      'measured',
      changeLog.requirementApplied !== scenario.changedRequirement,
      `Recorded applied requirement: ${JSON.stringify(changeLog.requirementApplied ?? null)}.`,
    ),
    requirementChangeMetric(
      'omittedRequiredConstraints',
      'measured',
      omitted,
      `${omitted} of ${mandatoryAssertions.length} mandatory assertions failed.`,
    ),
    requirementChangeMetric(
      'detectedSeededDependencies',
      'measured',
      detectedUnknown,
      `${detectedUnknown} of ${scenario.unknownImpactDependencies.length} unknown-impact dependencies were flagged.`,
    ),
    requirementChangeMetric(
      'missedSeededDependencies',
      'measured',
      missedUnknown,
      `${missedUnknown} of ${scenario.unknownImpactDependencies.length} unknown-impact dependencies were not flagged.`,
    ),
    requirementChangeMetric(
      'unnecessaryInvalidation',
      'measured',
      unnecessaryInvalidation,
      `${unnecessaryInvalidation} preserved artifact(s) changed and were declared in the change log.`,
    ),
    requirementChangeMetric(
      'retainedWork',
      'measured',
      retained,
      `${retained} of ${scenario.preserveArtifacts.length} preserved artifacts are byte-identical.`,
    ),
    requirementChangeMetric(
      'discardedWork',
      'measured',
      discarded,
      `${discarded} of ${scenario.preserveArtifacts.length} preserved artifacts changed.`,
    ),
    requirementChangeMetric(
      'reworkAfterChange',
      'measured',
      rework,
      `${rework} file(s) changed outside the seeded change targets and preserved set.`,
    ),
    requirementChangeMetric(
      'totalElapsedTimeMs',
      'measured',
      Math.round(elapsedMs),
      'Wall-clock time for the injected controller call only; excludes fixture copy and hashing overhead.',
    ),
    requirementChangeMetric(
      'coordinatorUsage',
      'unavailable',
      null,
      'Usage accounting belongs to issues #32/#92; this harness does not compute or estimate it.',
    ),
    requirementChangeMetric(
      'workerUsage',
      'unavailable',
      null,
      'Usage accounting belongs to issues #32/#92; this harness does not compute or estimate it.',
    ),
  ];
}

function summarizeRequirementChangeAcceptance(
  scenario: RequirementChangeScenario,
  results: Record<string, boolean>,
): AcceptanceSummary {
  const failedIds = scenario.acceptance.assertions
    .filter((item) => results[item.id] !== true)
    .map((item) => item.id);
  return {
    total: scenario.acceptance.assertions.length,
    passed: scenario.acceptance.assertions.length - failedIds.length,
    failedIds,
  };
}

/**
 * Evaluate one requirement-change scenario's scripted-controller (baseline) arm in a fresh
 * fixture copy, and pair it with a separate workspace that exercises the merged task-record and
 * reconciliation APIs. Resume-context delivery remains explicitly unavailable until #112 lands.
 * The mkdtemp root is resolved through `fs.promises.realpath` before use so expected paths
 * remain correct on hosts (including CI) that resolve the OS temp directory to an 8.3 short
 * path.
 */
export async function runRequirementChangeScenario({
  spec,
  fixturesRoot,
  applyChange = defaultApplyChange,
  runAcceptance = defaultRunAcceptance,
  now = () => new Date().toISOString(),
}: RequirementChangeScenarioOptions): Promise<RequirementChangeScenarioResult> {
  const scenario = validateRequirementChangeSpec(spec);
  const source = path.resolve(fixturesRoot, safe(scenario.fixture));
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'latchkit-requirement-change-')),
  );
  try {
    await cp(source, workspace, { recursive: true, force: false, errorOnExist: false });
    const preFiles = await collectWorkspaceFiles(workspace);
    const preHashes = await hashWorkspaceFiles(workspace, preFiles);
    const started = process.hrtime.bigint();
    const applied = await Promise.resolve(applyChange({ workspace, scenario }));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (applied.skip)
      return {
        id: scenario.id,
        kind: 'requirement-change',
        title: scenario.title,
        arms: {
          baseline: {
            arm: 'baseline',
            status: 'unavailable',
            controller: 'scripted',
            reason: boundedText(redact(applied.skip)),
            metrics: [],
          },
          reconciliation: unavailableReconciliationArm(),
        },
        completedAt: now(),
      };
    const changeLog: RequirementChangeLog = applied.changeLog ?? {};
    const postFiles = await collectWorkspaceFiles(workspace);
    const allFiles = [...new Set([...preFiles, ...postFiles])];
    const postHashes = await hashWorkspaceFiles(workspace, allFiles);
    const acceptanceRun = await Promise.resolve(runAcceptance({ workspace, scenario }));
    const acceptanceResults = acceptanceRun.results ?? {};
    const gate = evaluateRequirementChangeGate({
      scenario,
      changeLog,
      acceptanceResults,
      preHashes,
      postHashes,
    });
    const metrics = computeRequirementChangeMetrics({
      scenario,
      changeLog,
      preHashes,
      postHashes,
      elapsedMs,
      acceptanceResults,
    });
    const baseline: RequirementChangeArmResult = {
      arm: 'baseline',
      status: 'completed',
      controller: 'scripted',
      metrics,
      correctnessGate: gate,
      acceptance: summarizeRequirementChangeAcceptance(scenario, acceptanceResults),
      flaggedDependencies: redact(changeLog.flaggedDependencies ?? []) as string[],
    };
    const reconciliation = await runReconciliationArm({
      source,
      scenario,
      applyChange,
      runAcceptance,
    });
    return {
      id: scenario.id,
      kind: 'requirement-change',
      title: scenario.title,
      arms: { baseline, reconciliation },
      completedAt: now(),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function runRequirementChangeSuite({
  specs,
  fixturesRoot,
  applyChange,
  runAcceptance,
  metadata = {},
  now,
}: RequirementChangeSuiteOptions): Promise<RequirementChangeSuiteResult> {
  if (!Array.isArray(specs) || !specs.length)
    throw new TypeError('Requirement-change evaluation suite needs at least one scenario.');
  const scenarios: RequirementChangeScenarioResult[] = [];
  for (const spec of [...specs].sort((left, right) => left.id.localeCompare(right.id)))
    scenarios.push(
      await runRequirementChangeScenario({ spec, fixturesRoot, applyChange, runAcceptance, now }),
    );
  const denominator = scenarios.reduce(
    (sum, item) => sum + (item.arms.baseline.correctnessGate?.denominator ?? 0),
    0,
  );
  const counts = {
    completed: scenarios.filter((item) => item.arms.baseline.status === 'completed').length,
    unavailable: scenarios.filter((item) =>
      [item.arms.baseline, item.arms.reconciliation].some((arm) => arm.status === 'unavailable'),
    ).length,
  };
  return {
    schemaVersion: SKILL_EVALUATION_V2_VERSION,
    generatedAt: now ? now() : new Date().toISOString(),
    metadata: redact(metadata),
    metricDefinitions: [...REQUIREMENT_CHANGE_METRICS],
    denominator,
    counts,
    scenarios,
  };
}

export async function loadRequirementChangeSpecs(
  directory: string,
): Promise<RequirementChangeScenario[]> {
  const index = JSON.parse(
    await readFile(path.join(directory, 'requirement-change-scenarios.json'), 'utf8'),
  );
  if (!Array.isArray(index))
    throw new TypeError('requirement-change-scenarios.json must be an array.');
  return index.map(validateRequirementChangeSpec);
}

export function renderRequirementChangeMarkdown(result: RequirementChangeSuiteResult): string {
  const lines = [
    '# Latchkit requirement-change evaluation',
    '',
    `Generated: ${result.generatedAt}`,
    '',
    '| Scenario | Baseline status | Baseline gate | Reconciliation status |',
    '| --- | --- | --- | --- |',
    ...result.scenarios.map((item) => {
      const gate = item.arms.baseline.correctnessGate;
      const gateText = gate
        ? gate.passed
          ? `passed (${gate.denominator} checks)`
          : `failed (${gate.failures.length}/${gate.denominator})`
        : 'n/a';
      return `| ${item.id} | ${item.arms.baseline.status} | ${gateText} | ${item.arms.reconciliation.status} |`;
    }),
    '',
    `Scenario denominator: ${result.denominator} correctness-gate check(s) across ${result.scenarios.length} scenario(s); baseline arms completed: ${result.counts.completed}, unavailable: ${result.counts.unavailable}.`,
    '',
    'Metric definitions and limitations:',
    ...result.metricDefinitions.map(
      (definition) =>
        `- **${definition.id}** (${definition.unit}): ${definition.label} _${definition.limitation}_`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
