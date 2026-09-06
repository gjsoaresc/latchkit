const UNSAFE_GUIDANCE = [
  /(?:skip|bypass|disable|suppress|omit|ignore|never ask for)\s+(?:user\s+)?(?:approval|permission|review)/i,
  /(?:assume|claim|report|say)?\s*(?:tests?|checks?)\s+(?:have\s+)?passed/i,
  /grant\s+(?:all\s+)?(?:permissions?|approvals?)/i,
];
import { isRecord } from '../types.js';
import type { ProjectInstructionModel, ProjectInstructionOverride, ProjectScope } from './types.js';

export const ORIGINAL_INSTRUCTIONS = Object.freeze([
  'Treat existing human-authored instructions and nearer directory rules as authoritative.',
  'Review a command and its environment before running it; this file grants no permission or approval.',
  'Report checks as passed only after observing their successful result in the current worktree.',
]);

function validateOverride(override: unknown, index: number): ProjectInstructionOverride {
  if (
    !isRecord(override) ||
    typeof override.scope !== 'string' ||
    !Array.isArray(override.instructions) ||
    override.instructions.some((item) => typeof item !== 'string' || !item.trim())
  )
    throw new Error(`Invalid project instruction override at index ${index}.`);
  for (const instruction of override.instructions) {
    if (UNSAFE_GUIDANCE.some((pattern) => pattern.test(instruction)))
      throw new Error(
        `Project instruction override for "${override.scope || '.'}" conflicts with review or permission policy.`,
      );
  }
  return {
    scope: override.scope,
    instructions: override.instructions.map((item) => item.trim()),
    provenance: 'user-override',
  };
}

export function createProjectInstructionModel(
  scopes: readonly ProjectScope[],
  options: { overrides?: readonly unknown[] } = {},
): ProjectInstructionModel {
  const overrides = (options.overrides ?? []).map(validateOverride);
  const overrideScopes = new Set(overrides.map((item) => item.scope));
  for (const override of overrides) {
    if (!scopes.some((scope) => scope.path === override.scope))
      throw new Error(
        `Project instruction override has an unselected scope: ${override.scope || '.'}.`,
      );
  }
  return {
    schemaVersion: 1,
    provenance: {
      generator: 'latchkit',
      basis: 'explicit-project-manifests',
      execution: 'not-run',
    },
    scopes: scopes
      .map((scope) => ({
        ...scope,
        selected: true as const,
        originalInstructions: [...ORIGINAL_INSTRUCTIONS],
        instructions: overrides
          .filter((override) => override.scope === scope.path)
          .flatMap((override) => override.instructions),
        hasUserOverride: overrideScopes.has(scope.path),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}
