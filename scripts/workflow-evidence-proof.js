import { safePlanDiagnostics } from './workflow-plan-proof.js';

const phases = new Set([
  'requirements',
  'plan',
  'implementation',
  'verification',
  'review',
  'handoff',
]);
const states = new Set([
  'running',
  'awaiting-approval',
  'blocked',
  'cancelled',
  'verified',
  'passed',
  'failed',
]);
const stages = new Set([
  'archive-validation',
  'private-runtime',
  'fixture-setup',
  'requirements-plan',
  'plan-scope',
  'implementation-verification',
  'final-git-scope',
  'final-acceptance',
  'write-evidence',
]);
const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/.test(value) ? value : null;
const hash = (value, length) =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null;
const date = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? value
    : null;

export function fixtureGitScopeProof({ beforeHead, afterHead, changedPaths, untrackedPaths }) {
  const relevant = [...changedPaths, ...untrackedPaths].filter(
    (name) => !name.startsWith('.latchkit/'),
  );
  if (beforeHead !== afterHead || relevant.some((name) => name !== 'src/calculator.js')) {
    const error = new Error('Fixture Git scope changed outside the approved implementation.');
    error.code = 'WORKFLOW_FIXTURE_SCOPE_CHANGED';
    throw error;
  }
  return {
    headUnchanged: true,
    changedPaths: [...new Set(relevant)].sort(),
    unexpectedPathCount: 0,
  };
}

export function workflowFailureEvidence({
  attemptId,
  startedAt,
  finishedAt,
  stage,
  failureCategory,
  planDiagnostics,
  candidate = {},
  provider = {},
  workflow,
  providerProcessStarts = 0,
}) {
  return {
    schemaVersion: 1,
    kind: 'live-workflow-qualification-failure',
    status: 'failed',
    attemptId: identifier(attemptId),
    startedAt: date(startedAt),
    finishedAt: date(finishedAt),
    failure: {
      stage: stages.has(stage) ? stage : 'unknown',
      category: ['plan-checks-mismatch', 'plan-artifact-scope-mismatch'].includes(failureCategory)
        ? failureCategory
        : 'required-evidence-failed',
      reason: 'Qualification did not satisfy its required evidence checks.',
      ...(planDiagnostics ? { plan: safePlanDiagnostics(planDiagnostics) } : {}),
    },
    candidate: {
      archiveSha256: hash(candidate.archiveSha256, 64),
      commit: hash(candidate.commit, 40),
      version: identifier(candidate.version),
      target: ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'].includes(candidate.target)
        ? candidate.target
        : null,
    },
    provider: {
      id: 'codex',
      modelOverride: identifier(provider.model),
      reasoningEffortOverride: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
        provider['reasoning-effort'],
      )
        ? provider['reasoning-effort']
        : null,
    },
    bounds: {
      providerTimeoutMs: 120000,
      totalTimeoutMs: 900000,
      outputLimitBytes: 1048576,
      providerProcessStarts:
        Number.isSafeInteger(providerProcessStarts) && providerProcessStarts >= 0
          ? providerProcessStarts
          : null,
    },
    workflow: workflow
      ? {
          phase: phases.has(workflow.phase) ? workflow.phase : 'unknown',
          status: states.has(workflow.status) ? workflow.status : 'unknown',
          repairAttempts:
            Number.isInteger(workflow.repairAttempts) &&
            workflow.repairAttempts >= 0 &&
            workflow.repairAttempts <= 3
              ? workflow.repairAttempts
              : null,
          actions: (Array.isArray(workflow.completedActions) ? workflow.completedActions : [])
            .slice(0, 24)
            .map((action) => ({
              phase: phases.has(action?.phase) ? action.phase : 'unknown',
              status: states.has(action?.status) ? action.status : 'unknown',
            })),
        }
      : null,
  };
}
