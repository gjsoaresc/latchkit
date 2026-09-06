export type QualificationClassification =
  | 'provider-permission-or-auth-refusal'
  | 'provider-process-failure'
  | 'workflow-json-contract-malformed'
  | 'workflow-needs-input'
  | 'workflow-plan-check-mismatch'
  | 'pre-approval-not-ready';

export type QualificationObservation = {
  process?: { exitCode: number | null; status: string; permissionLike: boolean };
  outcome?: 'ready' | 'needs-input' | 'failed' | 'malformed';
  planChecksMatch?: boolean;
};

export function observeProviderProcess(
  current: QualificationObservation,
  result: { exitCode?: unknown; status?: unknown; stderr?: unknown },
): QualificationObservation {
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const process = {
    status: typeof result.status === 'string' ? result.status : 'unknown',
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    permissionLike: /\b(?:permission|denied|unauthori[sz]ed|authenti\w*|login)\b/i.test(stderr),
  };
  return current.process?.permissionLike ? current : { ...current, process };
}

/** Parses provider output only in memory and returns no text to evidence. */
export function observeClaudeOutcome(
  current: QualificationObservation,
  stdout: unknown,
  expectedPlanChecksJson: string,
): QualificationObservation {
  if (typeof stdout !== 'string') return { ...current, outcome: 'malformed' };
  try {
    const envelope: unknown = JSON.parse(stdout);
    const result =
      envelope &&
      typeof envelope === 'object' &&
      typeof (envelope as { result?: unknown }).result === 'string'
        ? (envelope as { result: string }).result
        : null;
    if (!result) return { ...current, outcome: 'malformed' };
    const outcome: unknown = JSON.parse(result);
    const status =
      outcome && typeof outcome === 'object' ? (outcome as { status?: unknown }).status : null;
    if (status === 'needs-input') return { ...current, outcome: 'needs-input' };
    if (status !== 'ready')
      return { ...current, outcome: status === 'failed' ? 'failed' : 'malformed' };
    const checks = (outcome as { checks_json?: unknown }).checks_json;
    const planChecksMatch =
      typeof checks !== 'string' || !checks.trim()
        ? true
        : JSON.stringify(JSON.parse(checks)) === expectedPlanChecksJson;
    return { ...current, outcome: 'ready', planChecksMatch };
  } catch {
    return { ...current, outcome: 'malformed' };
  }
}

export function classifyQualificationFailure(
  input: QualificationObservation,
): QualificationClassification {
  if (input.process?.permissionLike) return 'provider-permission-or-auth-refusal';
  if (input.process && (input.process.status !== 'exited' || input.process.exitCode !== 0))
    return 'provider-process-failure';
  if (input.outcome === 'malformed') return 'workflow-json-contract-malformed';
  if (input.outcome === 'needs-input') return 'workflow-needs-input';
  if (input.outcome === 'ready' && input.planChecksMatch === false)
    return 'workflow-plan-check-mismatch';
  return 'pre-approval-not-ready';
}
