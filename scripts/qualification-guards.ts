export function validateArtifactBinding(input: {
  dirty: unknown;
  commit: unknown;
  version: unknown;
  nodeVersion: unknown;
  packageVersion: unknown;
  privateNodeVersion: unknown;
  packageMatchesManifest: boolean;
  runtimeMatchesManifest: boolean;
}): void {
  if (
    input.dirty !== false ||
    typeof input.commit !== 'string' ||
    typeof input.version !== 'string' ||
    typeof input.nodeVersion !== 'string' ||
    input.packageVersion !== input.version ||
    input.privateNodeVersion !== `v${input.nodeVersion}` ||
    !input.packageMatchesManifest ||
    !input.runtimeMatchesManifest
  )
    throw new Error('INSTALLED_ARTIFACT_BINDING_MISMATCH');
}

export function assertFccBoundLaunch(plan: {
  args: string[];
  environment?: Record<string, string>;
}): void {
  if (
    !plan.args.includes('--model') ||
    !plan.args.includes('haiku') ||
    !plan.args.includes('--max-turns') ||
    !plan.args.includes('8') ||
    plan.environment?.ANTHROPIC_BASE_URL === undefined ||
    plan.environment.CLAUDE_CODE_MAX_RETRIES !== '0'
  )
    throw new Error('FCC_BOUND_LAUNCH_REQUIRED');
}

export function assertFixtureScope(changed: string[], untracked: string[]): void {
  if (changed.length !== 1 || changed[0] !== 'src/calculator.js' || untracked.length !== 0)
    throw new Error('FIXTURE_SCOPE_VIOLATION');
}

export function createQualificationDeadline(timeoutMs: number, shutdown: () => void) {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    shutdown();
  }, timeoutMs);
  return { expired: () => expired, clear: () => clearTimeout(timer) };
}
