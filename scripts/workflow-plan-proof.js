import { isDeepStrictEqual } from 'node:util';

const checkFields = [
  'id',
  'criterionId',
  'label',
  'type',
  'timeoutMs',
  'outputLimitBytes',
  'fixture',
];
const planFields = ['executable', 'args', 'cwd', 'environment'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const other = (value, fields) =>
  object(value)
    ? Object.fromEntries(Object.entries(value).filter(([name]) => !fields.includes(name)))
    : value;
const count = (value) => (Array.isArray(value) ? value.length : null);

export function compareWorkflowChecks(expected, actual) {
  // Compare the exact persisted JSON contract. Optional undefined object fields
  // have no JSON representation, just as in the workflow's canonical digest.
  const left = JSON.parse(JSON.stringify(expected));
  const right = JSON.parse(JSON.stringify(actual));
  const equal = isDeepStrictEqual(left, right);
  const checks = [];
  const expectedChecks = Array.isArray(left?.checks) ? left.checks : [];
  const actualChecks = Array.isArray(right?.checks) ? right.checks : [];
  for (
    let index = 0;
    index < Math.min(Math.max(expectedChecks.length, actualChecks.length), 8);
    index += 1
  ) {
    const before = expectedChecks[index];
    const after = actualChecks[index];
    if (isDeepStrictEqual(before, after)) continue;
    const differingFields = checkFields.filter(
      (field) => !isDeepStrictEqual(before?.[field], after?.[field]),
    );
    differingFields.push(
      ...planFields
        .filter((field) => !isDeepStrictEqual(before?.plan?.[field], after?.plan?.[field]))
        .map((field) => `plan.${field}`),
    );
    if (
      !isDeepStrictEqual(
        other(before, [...checkFields, 'plan']),
        other(after, [...checkFields, 'plan']),
      ) ||
      !isDeepStrictEqual(other(before?.plan, planFields), other(after?.plan, planFields))
    )
      differingFields.push('other');
    checks.push({
      index,
      differingFields,
      expectedArgumentCount: count(before?.plan?.args),
      actualArgumentCount: count(after?.plan?.args),
    });
  }
  return {
    equal,
    representationOnlyDifference: equal && !isDeepStrictEqual(expected, actual),
    expectedCheckCount: count(left?.checks),
    actualCheckCount: count(right?.checks),
    schemaVersionMatches: left?.schemaVersion === right?.schemaVersion,
    otherDocumentFieldsMatch: isDeepStrictEqual(
      other(left, ['schemaVersion', 'checks']),
      other(right, ['schemaVersion', 'checks']),
    ),
    checks,
  };
}

export function fixturePlanScopeProof(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  const mentionsMultiply = text.includes('multiply');
  const mentionsImplementationPath = text.includes('src/calculator.js');
  const protectedMutation =
    /\b(?:modify|edit|change|rewrite|replace|delete|remove|create|add|install|update|commit)\b/;
  const protectedTarget =
    /requirements\.md|test\/calculator\.test\.js|package\.json|dependenc|\bgit\b|\bnpm\b|network/;
  const negated =
    /\b(?:do not|don't|never|without|avoid|unchanged|immutable|read-only|not modify|not edit|not change|no changes?)\b/;
  const protectedMutationSentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(
      (sentence) =>
        protectedMutation.test(sentence) &&
        protectedTarget.test(sentence) &&
        !negated.test(sentence),
    ).length;
  return {
    fits: mentionsMultiply && mentionsImplementationPath && protectedMutationSentences === 0,
    mentionsMultiply,
    mentionsImplementationPath,
    protectedMutationSentences,
  };
}

export function safePlanDiagnostics(value) {
  if (!object(value)) return null;
  const safeCount = (number) =>
    Number.isInteger(number) && number >= 0 && number <= 1000000 ? number : null;
  const boolean = (item) => (typeof item === 'boolean' ? item : null);
  const allowedFields = new Set([
    ...checkFields,
    ...planFields.map((field) => `plan.${field}`),
    'other',
  ]);
  return {
    checks: {
      equal: boolean(value.checks?.equal),
      representationOnlyDifference: boolean(value.checks?.representationOnlyDifference),
      expectedCheckCount: safeCount(value.checks?.expectedCheckCount),
      actualCheckCount: safeCount(value.checks?.actualCheckCount),
      schemaVersionMatches: boolean(value.checks?.schemaVersionMatches),
      otherDocumentFieldsMatch: boolean(value.checks?.otherDocumentFieldsMatch),
      checks: (Array.isArray(value.checks?.checks) ? value.checks.checks : [])
        .slice(0, 8)
        .map((item) => ({
          index: safeCount(item?.index),
          differingFields: (Array.isArray(item?.differingFields) ? item.differingFields : [])
            .filter((field) => allowedFields.has(field))
            .slice(0, allowedFields.size),
          expectedArgumentCount: safeCount(item?.expectedArgumentCount),
          actualArgumentCount: safeCount(item?.actualArgumentCount),
        })),
    },
    scope: {
      fits: boolean(value.scope?.fits),
      mentionsMultiply: boolean(value.scope?.mentionsMultiply),
      mentionsImplementationPath: boolean(value.scope?.mentionsImplementationPath),
      protectedMutationSentences: safeCount(value.scope?.protectedMutationSentences),
    },
  };
}
