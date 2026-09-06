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
