import { isRecord, type JsonObject, type JsonValue } from '../types.js';

export const SKILL_EVALUATION_VERSION = 1;
const KINDS = new Set([
  'feature-delivery',
  'fix',
  'requirements-only',
  'review-only',
  'handoff-resume',
  'interrupted-verification',
  'unsupported-capability',
  'authorization-conflict',
]);
export type EvaluationKind =
  | 'feature-delivery'
  | 'fix'
  | 'requirements-only'
  | 'review-only'
  | 'handoff-resume'
  | 'interrupted-verification'
  | 'unsupported-capability'
  | 'authorization-conflict';
export interface EvaluationExpectations {
  requiredFiles?: string[];
  forbiddenFiles?: string[];
  requiredContent?: Array<{ path: string; includes: string }>;
  execution?: JsonObject;
  evidence?: JsonObject;
  response?: JsonObject;
}
export interface EvaluationSpec {
  schemaVersion: typeof SKILL_EVALUATION_VERSION;
  id: string;
  kind: EvaluationKind;
  title: string;
  fixture: string;
  instructions: string;
  environment: JsonObject & { requirements: JsonValue[] };
  expectations: EvaluationExpectations;
}
export interface EvaluationScenarioResult {
  id: string;
  kind: EvaluationKind;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  checks: EvaluationCheck[];
  execution: unknown;
  taskEvidence: unknown;
  response: string;
  completedAt: string;
}
export interface EvaluationCheck {
  check: string;
  passed: boolean;
  actual: string;
}
export interface EvaluationResult {
  schemaVersion: typeof SKILL_EVALUATION_VERSION;
  generatedAt: string;
  metadata: unknown;
  counts: Record<'passed' | 'failed' | 'skipped', number>;
  scenarios: EvaluationScenarioResult[];
}

function text(value: unknown, location: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${location} must be non-empty text.`);
}
function paths(value: unknown, location: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item || item.includes('..'))
  )
    throw new TypeError(`${location} must be an array of safe relative paths.`);
}

export function validateEvaluationSpec(value: unknown): EvaluationSpec {
  if (!isRecord(value)) throw new TypeError('Evaluation specification must be an object.');
  if (value.schemaVersion !== SKILL_EVALUATION_VERSION)
    throw new TypeError(
      `Unsupported evaluation specification version: ${String(value.schemaVersion)}.`,
    );
  text(value.id, '$.id');
  if (typeof value.kind !== 'string' || !KINDS.has(value.kind))
    throw new TypeError(`Unsupported evaluation kind: ${String(value.kind)}.`);
  text(value.title, '$.title');
  text(value.fixture, '$.fixture');
  text(value.instructions, '$.instructions');
  if (!isRecord(value.environment) || !Array.isArray(value.environment.requirements))
    throw new TypeError('$.environment must be an object with requirements.');
  if (!isRecord(value.expectations)) throw new TypeError('$.expectations must be an object.');
  const expectations = value.expectations;
  if (expectations.requiredFiles !== undefined)
    paths(expectations.requiredFiles, '$.expectations.requiredFiles');
  if (expectations.requiredContent !== undefined) {
    if (
      !Array.isArray(expectations.requiredContent) ||
      expectations.requiredContent.some(
        (item) =>
          !isRecord(item) || typeof item.path !== 'string' || typeof item.includes !== 'string',
      )
    )
      throw new TypeError('$.expectations.requiredContent must contain path/includes objects.');
    paths(
      expectations.requiredContent.map((item) => (item as JsonObject).path),
      '$.expectations.requiredContent',
    );
  }
  if (expectations.forbiddenFiles !== undefined)
    paths(expectations.forbiddenFiles, '$.expectations.forbiddenFiles');
  for (const key of ['execution', 'evidence', 'response'] as const)
    if (expectations[key] !== undefined && !isRecord(expectations[key]))
      throw new TypeError(`$.expectations.${key} must be an object.`);
  return {
    schemaVersion: SKILL_EVALUATION_VERSION,
    id: value.id,
    kind: value.kind as EvaluationKind,
    title: value.title,
    fixture: value.fixture,
    instructions: value.instructions,
    environment: structuredClone(value.environment) as EvaluationSpec['environment'],
    expectations: {
      ...(expectations.requiredFiles ? { requiredFiles: [...expectations.requiredFiles] } : {}),
      ...(expectations.forbiddenFiles ? { forbiddenFiles: [...expectations.forbiddenFiles] } : {}),
      ...(expectations.requiredContent
        ? {
            requiredContent: expectations.requiredContent.map((item) => ({
              path: (item as JsonObject).path as string,
              includes: (item as JsonObject).includes as string,
            })),
          }
        : {}),
      ...(isRecord(expectations.execution)
        ? { execution: structuredClone(expectations.execution) as JsonObject }
        : {}),
      ...(isRecord(expectations.evidence)
        ? { evidence: structuredClone(expectations.evidence) as JsonObject }
        : {}),
      ...(isRecord(expectations.response)
        ? { response: structuredClone(expectations.response) as JsonObject }
        : {}),
    },
  };
}

export function validateEvaluationResult(value: unknown): EvaluationResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SKILL_EVALUATION_VERSION ||
    !Array.isArray(value.scenarios)
  )
    throw new TypeError('Evaluation result has an unsupported schema version.');
  return structuredClone(value) as unknown as EvaluationResult;
}

/**
 * Requirement-change evaluations (issue #116, first foundation slice of the
 * #109 epic). This is a versioned, additive extension of the skill-evaluation
 * contract family: it introduces a new scenario/result shape (schemaVersion
 * 2, published as `schemas/skill-evaluation-v2.schema.json` and
 * `schemas/skill-evaluation-result-v2.schema.json`) without changing the
 * existing version-1 behavioral scenarios above. A requirement-change
 * scenario seeds a starting tree, a late requirement change, a dependency
 * with unknown impact, a memory record that becomes misleading after the
 * change, and an implementation component that must be preserved untouched.
 * Independently authored acceptance assertions and expected-impact seeds are
 * derived from the scenario requirement text, not from the fixture
 * implementation, so grading does not become circular.
 */
export const SKILL_EVALUATION_V2_VERSION = 2;

export type MetricAvailability = 'measured' | 'unavailable';

export interface MetricDefinition {
  id: string;
  label: string;
  unit: string;
  limitation: string;
}

/**
 * Metric definitions and their limitations, fixed before any comparative run
 * (issue #116 acceptance criterion 2). `coordinatorUsage`/`workerUsage` are
 * always reported unavailable: usage accounting is owned by issues #32/#92
 * and this harness does not invent a second savings ledger. Every other
 * metric is measured deterministically from the scripted-controller arm's
 * recorded change log and the fixture's own file hashes.
 */
export const REQUIREMENT_CHANGE_METRICS: readonly MetricDefinition[] = Object.freeze([
  {
    id: 'finalBehavioralSuccess',
    label: 'Every mandatory acceptance assertion passed after the change was applied.',
    unit: 'boolean',
    limitation:
      'Reflects only the seeded assertions written for this fixture, not general correctness.',
  },
  {
    id: 'falseCompletion',
    label: 'The arm recorded the task as complete while a mandatory assertion was still failing.',
    unit: 'boolean',
    limitation:
      'Detected only through the recorded change log and this run’s acceptance results; a completion claim made through a channel this harness does not observe cannot be seen.',
  },
  {
    id: 'staleResultAcceptance',
    label:
      'The recorded change log does not bind its applied requirement text to the scenario’s declared new requirement.',
    unit: 'boolean',
    limitation:
      'One pre-change and one post-change run only; staleness introduced across additional intermediate runs is not observable.',
  },
  {
    id: 'omittedRequiredConstraints',
    label: 'Count of mandatory constraints whose acceptance assertion failed after the change.',
    unit: 'count',
    limitation:
      'Bounded by the fixture author’s constraint list; an unlisted implicit constraint cannot be scored.',
  },
  {
    id: 'detectedSeededDependencies',
    label:
      'Count of seeded unknown-impact dependencies the controller explicitly flagged for review.',
    unit: 'count',
    limitation:
      'Read from the controller’s self-reported change log; a blanket flag of every file would satisfy this metric without genuine investigation.',
  },
  {
    id: 'missedSeededDependencies',
    label: 'Count of seeded unknown-impact dependencies left unflagged.',
    unit: 'count',
    limitation:
      'Same self-report caveat as detectedSeededDependencies; impact itself stays unknown either way and is never coerced to affected/unaffected.',
  },
  {
    id: 'unnecessaryInvalidation',
    label:
      'Count of preserve-artifact files changed and declared in the change log, even though preservation was required.',
    unit: 'count',
    limitation:
      'A change the controller could justify against a constraint this fixture does not capture would still be counted.',
  },
  {
    id: 'retainedWork',
    label: 'Count of preserve-artifact files whose bytes are unchanged after the run.',
    unit: 'count',
    limitation:
      'Byte identity cannot distinguish an untouched file from a coincidental round-trip reformat that restored the same bytes.',
  },
  {
    id: 'discardedWork',
    label: 'Count of preserve-artifact files whose bytes changed after the run.',
    unit: 'count',
    limitation: 'Byte difference cannot distinguish a cosmetic reformat from a semantic rewrite.',
  },
  {
    id: 'reworkAfterChange',
    label: 'Count of files changed outside the seeded change targets and the preserve set.',
    unit: 'count',
    limitation:
      'A legitimately necessary but unseeded file change is indistinguishable from unnecessary rework by this metric alone.',
  },
  {
    id: 'totalElapsedTimeMs',
    label: 'Wall-clock milliseconds spent in the injected controller call only.',
    unit: 'milliseconds',
    limitation:
      'Excludes fixture copy, task-state reconciliation, hashing, and acceptance checks. It is not total workflow latency, human/model effort, productivity, or cost, and must not be compared across arms as one.',
  },
  {
    id: 'coordinatorUsage',
    label: 'Coordinator token or session usage during the arm.',
    unit: 'unavailable',
    limitation:
      'Usage accounting belongs to issues #32/#92; this harness always reports it unavailable rather than estimating it.',
  },
  {
    id: 'workerUsage',
    label: 'Worker token or session usage during the arm.',
    unit: 'unavailable',
    limitation:
      'Usage accounting belongs to issues #32/#92; this harness always reports it unavailable rather than estimating it.',
  },
]);

export interface UnknownImpactDependency {
  id: string;
  path: string;
  note: string;
}
export interface MemoryRecordSeed {
  id: string;
  text: string;
  misleadingAfterChange: boolean;
}
export interface AcceptanceAssertionSeed {
  id: string;
  description: string;
  mandatory: boolean;
  tag: 'new-requirement' | 'preexisting';
}
export interface RequirementChangeAcceptance {
  module: string;
  assertions: AcceptanceAssertionSeed[];
}
export interface RequirementChangePoint {
  after: string;
  description: string;
}
export interface RequirementChangeScenario {
  schemaVersion: typeof SKILL_EVALUATION_V2_VERSION;
  id: string;
  kind: 'requirement-change';
  title: string;
  fixture: string;
  instructions: string;
  environment: JsonObject & { requirements: JsonValue[] };
  initialRequirement: string;
  changedRequirement: string;
  changePoint: RequirementChangePoint;
  changeTargets: string[];
  unknownImpactDependencies: UnknownImpactDependency[];
  preserveArtifacts: string[];
  memoryRecords: MemoryRecordSeed[];
  mandatoryConstraints: string[];
  acceptance: RequirementChangeAcceptance;
}

export function validateRequirementChangeSpec(value: unknown): RequirementChangeScenario {
  if (!isRecord(value))
    throw new TypeError('Requirement-change evaluation specification must be an object.');
  if (value.schemaVersion !== SKILL_EVALUATION_V2_VERSION)
    throw new TypeError(
      `Unsupported requirement-change evaluation specification version: ${String(value.schemaVersion)}.`,
    );
  if (value.kind !== 'requirement-change')
    throw new TypeError(`Unsupported requirement-change kind: ${String(value.kind)}.`);
  text(value.id, '$.id');
  text(value.title, '$.title');
  text(value.fixture, '$.fixture');
  text(value.instructions, '$.instructions');
  if (!isRecord(value.environment) || !Array.isArray(value.environment.requirements))
    throw new TypeError('$.environment must be an object with requirements.');
  text(value.initialRequirement, '$.initialRequirement');
  text(value.changedRequirement, '$.changedRequirement');
  if (!isRecord(value.changePoint)) throw new TypeError('$.changePoint must be an object.');
  text(value.changePoint.after, '$.changePoint.after');
  text(value.changePoint.description, '$.changePoint.description');
  paths(value.changeTargets, '$.changeTargets');
  if (
    !Array.isArray(value.unknownImpactDependencies) ||
    value.unknownImpactDependencies.some(
      (item) =>
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        !item.id ||
        typeof item.path !== 'string' ||
        typeof item.note !== 'string',
    )
  )
    throw new TypeError('$.unknownImpactDependencies must contain id/path/note objects.');
  paths(
    value.unknownImpactDependencies.map((item) => (item as JsonObject).path),
    '$.unknownImpactDependencies',
  );
  paths(value.preserveArtifacts, '$.preserveArtifacts');
  if (
    !Array.isArray(value.memoryRecords) ||
    value.memoryRecords.some(
      (item) =>
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        !item.id ||
        typeof item.text !== 'string' ||
        typeof item.misleadingAfterChange !== 'boolean',
    )
  )
    throw new TypeError('$.memoryRecords must contain id/text/misleadingAfterChange objects.');
  if (
    !Array.isArray(value.mandatoryConstraints) ||
    value.mandatoryConstraints.some((item) => typeof item !== 'string' || !item)
  )
    throw new TypeError('$.mandatoryConstraints must be an array of non-empty strings.');
  if (!isRecord(value.acceptance)) throw new TypeError('$.acceptance must be an object.');
  text(value.acceptance.module, '$.acceptance.module');
  if (
    !Array.isArray(value.acceptance.assertions) ||
    !value.acceptance.assertions.length ||
    value.acceptance.assertions.some((item) => {
      if (!isRecord(item)) return true;
      if (typeof item.id !== 'string' || !item.id) return true;
      if (typeof item.description !== 'string' || !item.description) return true;
      if (typeof item.mandatory !== 'boolean') return true;
      return item.tag !== 'new-requirement' && item.tag !== 'preexisting';
    })
  )
    throw new TypeError(
      '$.acceptance.assertions must contain id/description/mandatory/tag objects.',
    );
  return {
    schemaVersion: SKILL_EVALUATION_V2_VERSION,
    id: value.id,
    kind: 'requirement-change',
    title: value.title,
    fixture: value.fixture,
    instructions: value.instructions,
    environment: structuredClone(value.environment) as RequirementChangeScenario['environment'],
    initialRequirement: value.initialRequirement,
    changedRequirement: value.changedRequirement,
    changePoint: { after: value.changePoint.after, description: value.changePoint.description },
    changeTargets: [...value.changeTargets],
    unknownImpactDependencies: value.unknownImpactDependencies.map((item) => ({
      id: (item as JsonObject).id as string,
      path: (item as JsonObject).path as string,
      note: (item as JsonObject).note as string,
    })),
    preserveArtifacts: [...value.preserveArtifacts],
    memoryRecords: value.memoryRecords.map((item) => ({
      id: (item as JsonObject).id as string,
      text: (item as JsonObject).text as string,
      misleadingAfterChange: (item as JsonObject).misleadingAfterChange as boolean,
    })),
    mandatoryConstraints: [...value.mandatoryConstraints],
    acceptance: {
      module: value.acceptance.module,
      assertions: value.acceptance.assertions.map((item) => ({
        id: (item as JsonObject).id as string,
        description: (item as JsonObject).description as string,
        mandatory: (item as JsonObject).mandatory as boolean,
        tag: (item as JsonObject).tag as 'new-requirement' | 'preexisting',
      })),
    },
  };
}

export interface RequirementChangeMetricResult {
  id: string;
  availability: MetricAvailability;
  value: number | boolean | null;
  detail: string;
}

/**
 * The deterministic correctness gate (issue #116 acceptance criterion 3).
 * Zero tolerance for stale completion, unauthorized intent promotion,
 * dropped mandatory constraints, or silently lost work in the
 * scripted-controller arm. `uncertain` lists seeded unknown-impact
 * dependencies and is never folded into pass/fail: unknown semantic impact
 * stays unknown. `regressions` lists pre-existing (unrelated to the new
 * requirement) assertions that broke as a side effect of the change.
 */
export interface CorrectnessGateFailure {
  rule:
    | 'stale-completion'
    | 'unauthorized-intent-promotion'
    | 'dropped-mandatory-constraint'
    | 'silently-lost-work';
  detail: string;
}
export interface CorrectnessGateResult {
  denominator: number;
  failures: CorrectnessGateFailure[];
  uncertain: string[];
  regressions: string[];
  passed: boolean;
}

export interface AcceptanceSummary {
  total: number;
  passed: number;
  failedIds: string[];
}

export interface RequirementChangeArmResult {
  arm: 'baseline' | 'reconciliation';
  status: 'completed' | 'unavailable';
  reason?: string;
  controller?: 'scripted' | 'model';
  provider?: string;
  metrics: RequirementChangeMetricResult[];
  correctnessGate?: CorrectnessGateResult;
  acceptance?: AcceptanceSummary;
  flaggedDependencies?: string[];
  /** Evidence from the real task-state reconciliation API.  This is deliberately
   * separate from controller claims and acceptance output. */
  reconciliationEvidence?: {
    intentSuperseded: boolean;
    stalePreviewRejected: boolean;
    unknownImpactExplicit: boolean;
    preservedArtifacts: boolean;
    resumeContext: { status: 'unavailable'; reason: string };
  };
}

export interface RequirementChangeScenarioResult {
  id: string;
  kind: 'requirement-change';
  title: string;
  arms: {
    baseline: RequirementChangeArmResult;
    reconciliation: RequirementChangeArmResult;
  };
  completedAt: string;
}

export interface RequirementChangeSuiteResult {
  schemaVersion: typeof SKILL_EVALUATION_V2_VERSION;
  generatedAt: string;
  metadata: unknown;
  metricDefinitions: MetricDefinition[];
  denominator: number;
  counts: { completed: number; unavailable: number };
  scenarios: RequirementChangeScenarioResult[];
}

export function validateRequirementChangeResult(value: unknown): RequirementChangeSuiteResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SKILL_EVALUATION_V2_VERSION ||
    !Array.isArray(value.scenarios) ||
    !Array.isArray(value.metricDefinitions) ||
    typeof value.denominator !== 'number' ||
    !isRecord(value.counts)
  )
    throw new TypeError('Requirement-change evaluation result has an unsupported schema version.');
  return structuredClone(value) as unknown as RequirementChangeSuiteResult;
}

/** A change log a scripted or model-driven controller records while applying a scenario's change. */
export interface RequirementChangeLog {
  requirementApplied?: string;
  authorized?: boolean;
  claimsComplete?: boolean;
  touchedFiles?: string[];
  flaggedDependencies?: string[];
  supersededMemoryRecordIds?: string[];
}
