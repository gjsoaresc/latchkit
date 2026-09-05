import path from 'node:path';
import {
  negotiateCapabilities,
  validateCommandPlan,
  validateProviderContract,
} from '../providers/contracts.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';
import { recordEvidence } from '../task-state/service.js';
import { validateAcceptanceDocument } from '../acceptance/contracts.js';
import { createAcceptanceVerifier } from '../acceptance/service.js';

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

function redacted(value) {
  return String(value ?? '').replace(SENSITIVE, '[redacted]');
}

function capability(provider, event, mode) {
  if (mode !== 'blocking') return { decision: 'advisory', limitation: null };
  const [result] = negotiateCapabilities(provider, [
    { capability: 'decision:blocking', decisionMode: mode },
  ]);
  if (!event.decisionModes.includes('blocking') || result.outcome !== 'available') {
    return {
      decision: 'advisory',
      limitation:
        result.reason ?? 'This normalized provider event cannot enforce a blocking decision.',
    };
  }
  return { decision: 'blocking', limitation: null };
}

function affected(check, changedPaths) {
  if (!changedPaths?.length || !check.watchPaths?.length) return true;
  return changedPaths.some((changed) =>
    check.watchPaths.some((watched) => changed === watched || changed.startsWith(`${watched}/`)),
  );
}

function validateCheck(check, index) {
  if (!check || typeof check !== 'object' || Array.isArray(check))
    throw new TypeError(`Expected declared check ${index} to be an object.`);
  for (const field of ['id', 'criterionId', 'label']) {
    if (typeof check[field] !== 'string' || !check[field].trim())
      throw new TypeError(`Declared check ${index}.${field} must be a non-empty string.`);
  }
  let normalized = check;
  if (check.type) {
    normalized = validateAcceptanceDocument({ schemaVersion: 1, checks: [check] }).checks[0];
  } else validateCommandPlan(check.plan);
  if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0))
    throw new TypeError(`Declared check ${index}.timeoutMs must be a positive integer.`);
  if (
    check.watchPaths !== undefined &&
    (!Array.isArray(check.watchPaths) || check.watchPaths.some((p) => typeof p !== 'string' || !p))
  )
    throw new TypeError(`Declared check ${index}.watchPaths must be string paths.`);
  return { ...normalized, ...(check.watchPaths ? { watchPaths: check.watchPaths } : {}) };
}

/** Pure selection: discussion and maintenance events do nothing unless an adapter
 * explicitly marks the normalized event as a quality-gate trigger. */
export function selectQualityGates({ provider, event, checks, changedPaths = [] }) {
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

function evidenceOutcome(result) {
  if (result.status === 'exited') return result.exitCode === 0 ? 'passed' : 'failed';
  if (result.status === 'timed-out') return 'timed-out';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'refused') return 'unsupported';
  return 'failed';
}

function artifact(check, result) {
  return JSON.stringify({
    checkId: check.id,
    launch: {
      executable: path.basename(check.plan.executable),
      argumentCount: check.plan.args.length,
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
}) {
  if (typeof isExecutionAuthorized !== 'function')
    throw new TypeError('Expected an explicit execution authorization function.');
  const selection = selectQualityGates({ provider, event, checks, changedPaths });
  if (selection.status !== 'selected') return { ...selection, results: [] };
  const results = [];
  let current = task;
  for (const check of selection.checks) {
    if (selection.limitation && event.payload.decisionMode === 'blocking') {
      current = await recordEvidence(root, {
        taskId: current.id,
        runId: current.owner.runId,
        expectedRevision: current.revision,
        criterionId: check.criterionId,
        criterionRevision: current.criteria.find((criterion) => criterion.id === check.criterionId)
          ?.revision,
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
      const acceptance = await createAcceptanceVerifier({ root, launch: run }).verify({
        taskId: current.id,
        document: { schemaVersion: 1, checks: [check] },
        executionAuthorized: true,
        signal,
      });
      const [accepted] = acceptance.results;
      current = acceptance.task;
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
    const outcome = evidenceOutcome(processResult);
    current = await recordEvidence(root, {
      taskId: current.id,
      runId: current.owner.runId,
      expectedRevision: current.revision,
      criterionId: check.criterionId,
      criterionRevision: current.criteria.find((criterion) => criterion.id === check.criterionId)
        ?.revision,
      outcome,
      command: check.label,
      environmentDetails: `quality-gate; boundary=${HOST_LOCAL_EXECUTION_PROFILE}`,
      artifact: artifact(check, processResult),
    });
    results.push({ checkId: check.id, outcome, process: processResult.status });
  }
  const failed = results.some((result) => result.outcome !== 'passed');
  return {
    status: failed ? 'failed' : 'passed',
    decision: failed ? selection.decision : 'advisory',
    limitation: selection.limitation,
    results,
    task: current,
  };
}

/** Adapter-facing normalized handler. It deliberately returns no block when
 * support is absent, and ignores ordinary lifecycle discussion events. */
export function createQualityGateHandler(options) {
  return async (task, event) => executeQualityGates({ ...options, task, event });
}

export { CHECK_OUTCOMES, redacted as redactQualityGateText };
