import { errorMessage } from '../types.js';

/**
 * Fast-mode bounded, change-focused verification.
 *
 * This module is deliberately standalone: it has no dependency on task-state,
 * quality-gates, or the acceptance verifier, so it can be unit tested as a pure
 * planning function and reused by every check-execution engine in the
 * repository (quality gates and the acceptance verifier) without coupling
 * them to each other.
 */

export const VERIFICATION_SETTINGS_SCHEMA_VERSION = 1;
export const VERIFICATION_SETTINGS_PATH = '.latchkit/verification/settings-v1.json';

export const VERIFICATION_MODES = Object.freeze(['fast', 'standard'] as const);
export type VerificationMode = (typeof VERIFICATION_MODES)[number];
/** Existing tasks and projects default to the full, unbounded verification path. */
export const DEFAULT_VERIFICATION_MODE: VerificationMode = 'standard';

/** Bounded ceiling applied only in fast mode; standard mode remains unbounded. */
export const DEFAULT_FAST_TIME_BUDGET_MS = 5 * 60_000;
export const DEFAULT_FAST_MAX_EXECUTIONS = 50;

export function isVerificationMode(value: unknown): value is VerificationMode {
  return (
    typeof value === 'string' && (VERIFICATION_MODES as readonly string[]).includes(value as never)
  );
}

export type VerificationSettings = { defaultMode: VerificationMode };
export type VerificationSettingsState = {
  schemaVersion: 1;
  project: { id: string };
  revision: number;
  settings: VerificationSettings;
  createdAt: string;
  updatedAt: string;
};

export class VerificationError extends Error {
  code: string;
  path: string;
  constructor(message: string, code = 'VERIFICATION_INVALID', path = '$') {
    super(`${path}: ${message}`);
    this.name = 'VerificationError';
    this.code = code;
    this.path = path;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, names: string[], path: string): void {
  if (!record(value))
    throw new VerificationError('Expected an object.', 'VERIFICATION_INVALID', path);
  for (const key of Object.keys(value))
    if (!names.includes(key))
      throw new VerificationError(
        `Unknown field "${key}".`,
        'VERIFICATION_INVALID',
        `${path}.${key}`,
      );
  for (const key of names)
    if (!Object.hasOwn(value, key))
      throw new VerificationError(
        'Required field is missing.',
        'VERIFICATION_INVALID',
        `${path}.${key}`,
      );
}
function nonempty(value: unknown, path: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new VerificationError('Expected a non-empty string.', 'VERIFICATION_INVALID', path);
}
function iso(value: unknown, path: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new VerificationError('Expected an ISO date-time.', 'VERIFICATION_INVALID', path);
}

export function validateVerificationSettingsState(input: unknown): VerificationSettingsState {
  const state = input as VerificationSettingsState;
  fields(
    state,
    ['schemaVersion', 'project', 'revision', 'settings', 'createdAt', 'updatedAt'],
    '$',
  );
  if (state.schemaVersion !== VERIFICATION_SETTINGS_SCHEMA_VERSION)
    throw new VerificationError(
      'Unsupported verification settings schema version.',
      'VERIFICATION_UNSUPPORTED_VERSION',
      '$.schemaVersion',
    );
  fields(state.project, ['id'], '$.project');
  nonempty(state.project.id, '$.project.id');
  if (!Number.isInteger(state.revision) || state.revision < 0)
    throw new VerificationError(
      'Expected a non-negative revision.',
      'VERIFICATION_INVALID',
      '$.revision',
    );
  fields(state.settings, ['defaultMode'], '$.settings');
  if (!isVerificationMode(state.settings.defaultMode))
    throw new VerificationError(
      'defaultMode must be fast or standard.',
      'VERIFICATION_INVALID',
      '$.settings.defaultMode',
    );
  iso(state.createdAt, '$.createdAt');
  iso(state.updatedAt, '$.updatedAt');
  return state;
}

export function parseVerificationSettingsState(raw: string): VerificationSettingsState {
  try {
    return validateVerificationSettingsState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError(
      `Invalid JSON (${errorMessage(error)}).`,
      'VERIFICATION_INVALID_JSON',
    );
  }
}

/* ------------------------------------------------------------------------ *
 * Bounded verification planning: shared by quality gates and the           *
 * acceptance verifier so both engines apply the same fast-mode policy.     *
 * ------------------------------------------------------------------------ */

export type SourceLike = { revision: string | null; dirtyFingerprint: string | null };
export type EvidenceLike = {
  id: string;
  criterionId: string;
  criterionRevision: number;
  kind: string;
  outcome: string;
  source: SourceLike;
};
export type CriterionLike = { id: string; revision: number };
export type CheckLike = { id: string; criterionId: string; watchPaths?: readonly string[] };

export function sourceEqual(a: SourceLike | undefined, b: SourceLike | undefined): boolean {
  return a?.revision === b?.revision && a?.dirtyFingerprint === b?.dirtyFingerprint;
}

/** A check with no watchPaths conservatively counts as affected by any change,
 * matching the existing quality-gates selection behavior it must stay compatible with. */
export function isCheckAffected(check: CheckLike, changedPaths?: readonly string[]): boolean {
  if (!changedPaths?.length || !check.watchPaths?.length) return true;
  const watchPaths = check.watchPaths;
  return changedPaths.some((changed) =>
    watchPaths.some((watched) => changed === watched || changed.startsWith(`${watched}/`)),
  );
}

export type ReuseDecision = { reusable: boolean; reason: string; evidence: EvidenceLike | null };

/**
 * Decide whether a check's prior evidence may stand in for rerunning it.
 *
 * Reuse requires a passing prior result for the exact current criterion
 * revision. When `changedPaths` is unknown, reuse additionally requires the
 * whole-project source snapshot to be byte-identical to the one that produced
 * the evidence (a true "nothing changed" rerun). When `changedPaths` is
 * supplied, a path-scoped check is reusable whenever none of the changed
 * paths fall under its declared `watchPaths`; a check without watchPaths has
 * no declared dependency scope, so it is reused only when nothing changed at
 * all. New failures, a missing prior result, or any declared change to a
 * check's own dependencies always force a rerun.
 */
export function evaluateEvidenceReuse({
  check,
  criterion,
  evidence,
  currentSource,
  changedPaths,
  evidenceKind = 'check',
}: {
  check: CheckLike;
  criterion: CriterionLike | undefined;
  evidence: readonly EvidenceLike[];
  currentSource: SourceLike;
  changedPaths?: readonly string[];
  evidenceKind?: string;
}): ReuseDecision {
  if (!criterion) return { reusable: false, reason: 'unknown-criterion', evidence: null };
  const candidates = evidence.filter(
    (item) =>
      item.criterionId === criterion.id &&
      item.criterionRevision === criterion.revision &&
      item.kind === evidenceKind,
  );
  const latest = candidates.length ? candidates[candidates.length - 1] : null;
  if (!latest) return { reusable: false, reason: 'no-prior-evidence', evidence: null };
  if (latest.outcome !== 'passed')
    return { reusable: false, reason: `prior-outcome-${latest.outcome}`, evidence: latest };
  if (changedPaths === undefined) {
    return sourceEqual(latest.source, currentSource)
      ? { reusable: true, reason: 'source-unchanged', evidence: latest }
      : { reusable: false, reason: 'source-changed', evidence: latest };
  }
  if (check.watchPaths?.length) {
    return isCheckAffected(check, changedPaths)
      ? { reusable: false, reason: 'changed-dependency', evidence: latest }
      : { reusable: true, reason: 'unaffected-by-change', evidence: latest };
  }
  return changedPaths.length === 0
    ? { reusable: true, reason: 'no-declared-changes', evidence: latest }
    : { reusable: false, reason: 'unscoped-check-conservative-rerun', evidence: latest };
}

export type VerificationPlanEntry = {
  checkId: string;
  criterionId: string;
  /** True when the check must run (or rerun). */
  selected: boolean;
  /** True when a still-valid prior pass stands in for running it. */
  reused: boolean;
  reason: string;
  evidenceId: string | null;
};
export type VerificationPlan = {
  mode: VerificationMode;
  generatedAt: string;
  entries: VerificationPlanEntry[];
};

/**
 * Build the bounded verification plan for a set of checks. In standard mode
 * every check is selected and nothing is reused, preserving the existing
 * unconditional-execution behavior exactly. In fast mode a check is reused
 * whenever `evaluateEvidenceReuse` finds it safe, and every other check
 * (including every check for a criterion with no prior evidence) is
 * selected to run.
 */
export function buildVerificationPlan({
  mode,
  checks,
  criteria,
  evidence,
  currentSource,
  changedPaths,
  evidenceKind,
  now = () => new Date(),
}: {
  mode: VerificationMode;
  checks: readonly CheckLike[];
  criteria: readonly CriterionLike[];
  evidence: readonly EvidenceLike[];
  currentSource: SourceLike;
  changedPaths?: readonly string[];
  evidenceKind?: (check: CheckLike) => string;
  now?: () => Date;
}): VerificationPlan {
  const criterionById = new Map(criteria.map((item) => [item.id, item]));
  const entries = checks.map((check): VerificationPlanEntry => {
    const criterion = criterionById.get(check.criterionId);
    if (mode === 'standard')
      return {
        checkId: check.id,
        criterionId: check.criterionId,
        selected: true,
        reused: false,
        reason: 'standard-mode',
        evidenceId: null,
      };
    const decision = evaluateEvidenceReuse({
      check,
      criterion,
      evidence,
      currentSource,
      changedPaths,
      evidenceKind: evidenceKind?.(check) ?? 'check',
    });
    return {
      checkId: check.id,
      criterionId: check.criterionId,
      selected: !decision.reusable,
      reused: decision.reusable,
      reason: decision.reason,
      evidenceId: decision.evidence?.id ?? null,
    };
  });
  return { mode, generatedAt: now().toISOString(), entries };
}

export type VerificationBudget = { timeBudgetMs: number; maxExecutions: number };
export function defaultFastBudget(): VerificationBudget {
  return { timeBudgetMs: DEFAULT_FAST_TIME_BUDGET_MS, maxExecutions: DEFAULT_FAST_MAX_EXECUTIONS };
}
/** Only fast mode is ever bounded; standard mode has no budget to exceed. */
export function isBudgetExceeded(
  mode: VerificationMode,
  startedAtMs: number,
  executedCount: number,
  budget: VerificationBudget,
  nowMs: () => number = Date.now,
): boolean {
  if (mode !== 'fast') return false;
  return nowMs() - startedAtMs > budget.timeBudgetMs || executedCount >= budget.maxExecutions;
}

export type VerificationStats = {
  mode: VerificationMode;
  selected: number;
  reused: number;
  executed: number;
  skippedForBudget: number;
  elapsedMs: number;
  fallback: 'standard' | null;
  fallbackReason: string | null;
  nextChecks: string[];
  usage: unknown | null;
};
