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

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, path) => {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${path} must be non-empty text.`);
};
const paths = (value, path) => {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item || item.includes('..'))
  )
    throw new TypeError(`${path} must be an array of safe relative paths.`);
};

/** Validate a portable, versioned scenario without exposing its grading rules to a runner. */
export function validateEvaluationSpec(value) {
  if (!record(value)) throw new TypeError('Evaluation specification must be an object.');
  if (value.schemaVersion !== SKILL_EVALUATION_VERSION)
    throw new TypeError(`Unsupported evaluation specification version: ${value.schemaVersion}.`);
  text(value.id, '$.id');
  if (!KINDS.has(value.kind)) throw new TypeError(`Unsupported evaluation kind: ${value.kind}.`);
  text(value.title, '$.title');
  text(value.fixture, '$.fixture');
  text(value.instructions, '$.instructions');
  if (!record(value.environment)) throw new TypeError('$.environment must be an object.');
  if (!Array.isArray(value.environment.requirements))
    throw new TypeError('$.environment.requirements must be an array.');
  if (!record(value.expectations)) throw new TypeError('$.expectations must be an object.');
  const expectations = value.expectations;
  if (expectations.requiredFiles !== undefined)
    paths(expectations.requiredFiles, '$.expectations.requiredFiles');
  if (expectations.requiredContent !== undefined) {
    if (
      !Array.isArray(expectations.requiredContent) ||
      expectations.requiredContent.some(
        (item) =>
          !record(item) || typeof item.path !== 'string' || typeof item.includes !== 'string',
      )
    )
      throw new TypeError('$.expectations.requiredContent must contain path/includes objects.');
    paths(
      expectations.requiredContent.map((item) => item.path),
      '$.expectations.requiredContent',
    );
  }
  if (expectations.forbiddenFiles !== undefined)
    paths(expectations.forbiddenFiles, '$.expectations.forbiddenFiles');
  if (expectations.execution !== undefined && !record(expectations.execution))
    throw new TypeError('$.expectations.execution must be an object.');
  if (expectations.evidence !== undefined && !record(expectations.evidence))
    throw new TypeError('$.expectations.evidence must be an object.');
  if (expectations.response !== undefined && !record(expectations.response))
    throw new TypeError('$.expectations.response must be an object.');
  return structuredClone(value);
}

export function validateEvaluationResult(value) {
  if (!record(value) || value.schemaVersion !== SKILL_EVALUATION_VERSION)
    throw new TypeError('Evaluation result has an unsupported schema version.');
  if (!Array.isArray(value.scenarios))
    throw new TypeError('Evaluation result must contain scenarios.');
  return structuredClone(value);
}
