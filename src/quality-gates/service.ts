import path from 'node:path';
import {
  negotiateCapabilities,
  validateCommandPlan,
  validateProviderContract,
} from '../providers/contracts.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';
import { captureSource, recordEvidence } from '../task-state/service.js';
import { validateAcceptanceDocument } from '../acceptance/contracts.js';
import { createAcceptanceVerifier } from '../acceptance/service.js';
import type { LifecycleEnvelope, ProviderContract, CommandPlan } from '../providers/contracts.js';
import type { ProcessRunResult, RunProviderProcessOptions } from '../runtime/process-runner.js';
import type { Task } from '../task-state/contracts.js';
import { isRecord } from '../types.js';
import {
  buildVerificationPlan,
  DEFAULT_VERIFICATION_MODE,
  defaultFastBudget,
  isBudgetExceeded,
} from '../verification/contracts.js';
import type { VerificationMode, VerificationStats } from '../verification/contracts.js';

const CHECK_OUTCOMES = new Set([
  'passed',
  'failed',
  'timed-out',
  'cancelled',
  'skipped',
  'unsupported',
]);
const SENSITIVE =
  /\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+|\b(?:bearer|token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi;

type DeclaredCheck = {
  id: string;
  criterionId: string;
  label: string;
  type?: string;
  plan?: Readonly<CommandPlan>;
  timeoutMs?: number;
  outputLimitBytes?: number;
  watchPaths?: string[];
} & Record<string, unknown>;
type Selection = {
  status: 'not-applicable' | 'selected' | 'skipped';
  decision: 'advisory' | 'blocking';
  checks: DeclaredCheck[];
  limitation: string | null;
};
type Execution = (options?: RunProviderProcessOptions) => Promise<ProcessRunResult>;
type GateInput = {
  root: string;
  task: Task;
  event: Readonly<LifecycleEnvelope>;
  provider: Readonly<ProviderContract>;
  checks: unknown[];
  changedPaths?: string[];
  isExecutionAuthorized: (
    task: Task,
    check: DeclaredCheck,
    event: Readonly<LifecycleEnvelope>,
  ) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  run?: Execution;
  /** Bounded, change-focused fast verification versus the full standard path.
   * Defaults to standard, which selects and runs every affected check exactly
   * as before this option existed. */
  mode?: VerificationMode;
  /** Fast-mode-only ceiling on wall-clock time spent executing (not reusing)
   * checks in one call. Ignored in standard mode. */
  timeBudgetMs?: number;
  /** Fast-mode-only ceiling on the number of checks executed (not reused) in
   * one call. Ignored in standard mode. */
  maxExecutions?: number;
};

function redacted(value: unknown): string {
  return String(value ?? '').replace(SENSITIVE, '[redacted]');
}

function capability(
  provider: unknown,
  event: Readonly<LifecycleEnvelope>,
  mode: string,
): { decision: 'advisory' | 'blocking'; limitation: string | null } {
  if (mode !== 'blocking') return { decision: 'advisory', limitation: null };
  const [result] = negotiateCapabilities(provider, [
    { capability: 'decision:blocking', decisionMode: mode },
  ]);
  const outcome = isRecord(result) && result.outcome;
  const reason = isRecord(result) && typeof result.reason === 'string' ? result.reason : undefined;
  if (!event.decisionModes.includes('blocking') || outcome !== 'available') {
    return {
      decision: 'advisory',
      limitation: reason ?? 'This normalized provider event cannot enforce a blocking decision.',
    };
  }
  return { decision: 'blocking', limitation: null };
}

function affected(check: DeclaredCheck, changedPaths: string[]): boolean {
  if (!changedPaths?.length || !check.watchPaths?.length) return true;
  const watchPaths = check.watchPaths;
  if (!watchPaths) return true;
  return changedPaths.some((changed) =>
    watchPaths.some((watched) => changed === watched || changed.startsWith(`${watched}/`)),
  );
}

function validateCheck(check: unknown, index: number): DeclaredCheck {
  if (!isRecord(check)) throw new TypeError(`Expected declared check ${index} to be an object.`);
  for (const field of ['id', 'criterionId', 'label']) {
    if (typeof check[field] !== 'string' || !check[field].trim())
      throw new TypeError(`Declared check ${index}.${field} must be a non-empty string.`);
  }
  const candidate: DeclaredCheck = {
    id: String(check.id),
    criterionId: String(check.criterionId),
    label: String(check.label),
    ...check,
  };
  let normalized: DeclaredCheck = candidate;
  if (typeof check.type === 'string' && check.type) {
    const normalizedCheck = validateAcceptanceDocument({ schemaVersion: 1, checks: [check] })
      .checks[0];
    if (!normalizedCheck) throw new TypeError(`Declared check ${index} is missing.`);
    normalized = normalizedCheck;
  } else validateCommandPlan(check.plan);
  if (
    check.timeoutMs !== undefined &&
    (typeof check.timeoutMs !== 'number' ||
      !Number.isInteger(check.timeoutMs) ||
      check.timeoutMs <= 0)
  )
    throw new TypeError(`Declared check ${index}.timeoutMs must be a positive integer.`);
  if (
    check.watchPaths !== undefined &&
    (!Array.isArray(check.watchPaths) ||
      check.watchPaths.some((p: unknown) => typeof p !== 'string' || !p))
  )
    throw new TypeError(`Declared check ${index}.watchPaths must be string paths.`);
  const watchPaths = Array.isArray(check.watchPaths)
    ? check.watchPaths.map((item) => {
        if (typeof item !== 'string')
          throw new TypeError(`Declared check ${index}.watchPaths must be string paths.`);
        return item;
      })
    : undefined;
  return { ...normalized, ...(watchPaths ? { watchPaths } : {}) };
}

/** Pure selection: discussion and maintenance events do nothing unless an adapter
 * explicitly marks the normalized event as a quality-gate trigger. */
export function selectQualityGates({
  provider,
  event,
  checks,
  changedPaths = [],
}: {
  provider: unknown;
  event: Readonly<LifecycleEnvelope>;
  checks: unknown[];
  changedPaths?: string[];
}): Selection {
  validateProviderContract(provider);
  if (event?.payload?.qualityGateTrigger !== true)
    return { status: 'not-applicable', decision: 'advisory', checks: [], limitation: null };
  const requestedMode = event.payload.decisionMode === 'blocking' ? 'blocking' : 'advisory';
  const policy = capability(provider, event, requestedMode);
  const selected = checks.map(validateCheck).filter((check) => affected(check, changedPaths));
  return {
    status: selected.length ? 'selected' : 'skipped',
    decision: policy.decision,
    checks: selected,
    limitation: policy.limitation,
  };
}

function evidenceOutcome(result: ProcessRunResult): string {
  if (result.status === 'exited') return result.exitCode === 0 ? 'passed' : 'failed';
  if (result.status === 'timed-out') return 'timed-out';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'refused') return 'unsupported';
  return 'failed';
}

function artifact(check: DeclaredCheck, result: ProcessRunResult): string {
  const plan = validateCommandPlan(check.plan);
  return JSON.stringify({
    checkId: check.id,
    launch: {
      executable: path.basename(plan.executable),
      argumentCount: plan.args.length,
    },
    status: result.status,
    code: result.code ?? null,
    exitCode: result.exitCode ?? null,
    outputBytes: result.outputBytes ?? 0,
    stdout: redacted(result.stdout),
    stderr: redacted(result.stderr ?? result.message),
    executionBoundary: HOST_LOCAL_EXECUTION_PROFILE,
  });
}

/** Execute explicit declared checks only. The caller supplies authorization;
 * repository configuration alone can never make this true. */
export async function executeQualityGates({
  root,
  task,
  event,
  provider,
  checks,
  changedPaths,
  isExecutionAuthorized,
  signal,
  run = runProviderProcess,
  mode = DEFAULT_VERIFICATION_MODE,
  timeBudgetMs,
  maxExecutions,
}: GateInput) {
  if (typeof isExecutionAuthorized !== 'function')
    throw new TypeError('Expected an explicit execution authorization function.');
  const selection = selectQualityGates({ provider, event, checks, changedPaths });
  if (selection.status !== 'selected') return { ...selection, results: [] };
  const results: {
    checkId: string;
    outcome: string;
    reason?: string | null;
    process?: string;
    artifact?: unknown;
    reused?: boolean;
  }[] = [];
  // Only fast mode ever reuses evidence, so only fast mode pays for computing
  // the current source snapshot (a git call plus, when dirty, a full tree hash).
  const currentSource =
    mode === 'fast' ? await captureSource(root) : { revision: null, dirtyFingerprint: null };
  const plan = buildVerificationPlan({
    mode,
    checks: selection.checks,
    criteria: task.criteria,
    evidence: task.evidence,
    currentSource,
    changedPaths,
  });
  const budget = {
    ...defaultFastBudget(),
    ...(timeBudgetMs !== undefined ? { timeBudgetMs } : {}),
    ...(maxExecutions !== undefined ? { maxExecutions } : {}),
  };
  const startedAtMs = Date.now();
  let executed = 0;
  let skippedForBudget = 0;
  let fallback: 'standard' | null = null;
  let fallbackReason: string | null = null;
  const nextChecks: string[] = [];
  let current = task;
  for (const check of selection.checks) {
    const entry = plan.entries.find((item) => item.checkId === check.id);
    if (entry?.reused) {
      results.push({
        checkId: check.id,
        outcome: 'passed',
        reason: entry.reason,
        process: 'reused',
        reused: true,
      });
      continue;
    }
    if (isBudgetExceeded(mode, startedAtMs, executed, budget)) fallback = 'standard';
    if (fallback) {
      fallbackReason ??= `Fast-mode time/execution budget exceeded after ${executed} executed check(s).`;
      const criterion = current.criteria.find((item) => item.id === check.criterionId);
      if (!current.owner || !criterion)
        throw new TypeError('Quality gate task ownership or criterion is unavailable.');
      current = await recordEvidence(root, {
        taskId: current.id,
        runId: current.owner.runId,
        expectedRevision: current.revision,
        criterionId: check.criterionId,
        criterionRevision: criterion.revision,
        outcome: 'skipped',
        command: check.label,
        environmentDetails: 'fast-mode; time/execution budget exceeded before this check ran',
        artifact: JSON.stringify({ checkId: check.id, status: 'fast-mode-budget-exceeded' }),
      });
      results.push({ checkId: check.id, outcome: 'skipped', reason: fallbackReason });
      skippedForBudget += 1;
      nextChecks.push(check.id);
      continue;
    }
    if (selection.limitation && event.payload.decisionMode === 'blocking') {
      const criterion = current.criteria.find((item) => item.id === check.criterionId);
      if (!current.owner || !criterion)
        throw new TypeError('Quality gate task ownership or criterion is unavailable.');
      current = await recordEvidence(root, {
        taskId: current.id,
        runId: current.owner.runId,
        expectedRevision: current.revision,
        criterionId: check.criterionId,
        criterionRevision: criterion.revision,
        outcome: 'unsupported',
        command: check.label,
        environmentDetails: 'quality-gate; enforcement capability unavailable',
        artifact: JSON.stringify({
          checkId: check.id,
          status: 'unsupported',
          limitation: selection.limitation,
        }),
      });
      results.push({ checkId: check.id, outcome: 'unsupported', reason: selection.limitation });
      continue;
    }
    if (!(await isExecutionAuthorized(current, check, event))) {
      const result = {
        checkId: check.id,
        outcome: 'skipped',
        reason: 'Execution was not authorized.',
      };
      results.push(result);
      continue;
    }
    if (check.type) {
      const acceptanceDocument = validateAcceptanceDocument({ schemaVersion: 1, checks: [check] });
      const acceptanceCheck = acceptanceDocument.checks[0];
      if (!acceptanceCheck) throw new TypeError('Quality gate acceptance check is missing.');
      const acceptance = await createAcceptanceVerifier({ root, launch: run }).verify({
        taskId: current.id,
        document: { schemaVersion: 1, checks: [acceptanceCheck] },
        executionAuthorized: true,
        signal,
      });
      const accepted = acceptance.results[0];
      if (!accepted)
        throw new TypeError('Acceptance verifier did not return an executed check result.');
      current = acceptance.task;
      executed += 1;
      results.push({
        checkId: check.id,
        outcome: accepted.outcome,
        process: accepted.status,
        artifact: accepted.artifact,
      });
      continue;
    }
    const processResult = await run({
      provider,
      plan: check.plan,
      executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
      timeoutMs: check.timeoutMs,
      outputLimitBytes: check.outputLimitBytes,
      signal,
    });
    executed += 1;
    const outcome = evidenceOutcome(processResult);
    const criterion = current.criteria.find((item) => item.id === check.criterionId);
    if (!current.owner || !criterion)
      throw new TypeError('Quality gate task ownership or criterion is unavailable.');
    current = await recordEvidence(root, {
      taskId: current.id,
      runId: current.owner.runId,
      expectedRevision: current.revision,
      criterionId: check.criterionId,
      criterionRevision: criterion.revision,
      outcome,
      command: check.label,
      environmentDetails: `quality-gate; boundary=${HOST_LOCAL_EXECUTION_PROFILE}`,
      artifact: artifact(check, processResult),
    });
    results.push({ checkId: check.id, outcome, process: processResult.status });
  }
  const failed = results.some((result) => result.outcome !== 'passed');
  const stats: VerificationStats = {
    mode,
    selected: plan.entries.filter((item) => item.selected).length,
    reused: plan.entries.filter((item) => item.reused).length,
    executed,
    skippedForBudget,
    elapsedMs: Date.now() - startedAtMs,
    fallback,
    fallbackReason,
    nextChecks,
    usage: null,
  };
  return {
    status: failed ? 'failed' : 'passed',
    decision: failed ? selection.decision : 'advisory',
    limitation: selection.limitation,
    results,
    task: current,
    plan,
    stats,
  };
}

/** Adapter-facing normalized handler. It deliberately returns no block when
 * support is absent, and ignores ordinary lifecycle discussion events. */
export function createQualityGateHandler(options: Omit<GateInput, 'task' | 'event'>) {
  return async (task: Task, event: Readonly<LifecycleEnvelope>) =>
    executeQualityGates({
      // Default to the task's own persisted mode; an explicit option still wins.
      mode: task.verificationMode,
      ...options,
      task,
      event,
    });
}

export { CHECK_OUTCOMES, redacted as redactQualityGateText };
