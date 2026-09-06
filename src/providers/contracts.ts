/** Versioned, provider-neutral contracts.  These describe evidence and plans;
 * they deliberately do not start a provider process or modify provider state. */
export const PROVIDER_CONTRACT_VERSION = 1;
export const LIFECYCLE_ENVELOPE_VERSION = 1;
export const CAPABILITY_STATES = Object.freeze(['supported', 'partial', 'unsupported', 'unknown']);
export const DECISION_MODES = Object.freeze(['blocking', 'advisory']);
export const VERIFICATION_STATES = Object.freeze(['verified', 'unverified', 'unknown']);
export const ADAPTER_OPERATIONS = Object.freeze([
  'inspect',
  'planInstall',
  'planSkillExport',
  'planRuleExport',
  'planInvocation',
  'planResume',
  'translateLifecycleInput',
  'translateLifecycleOutput',
  'planUsage',
]);
export const LIFECYCLE_EVENT_KINDS = Object.freeze([
  'turn-completed',
  'session-terminated',
  'interrupted',
  'verified-task-completed',
]);
export const MAX_LIFECYCLE_PAYLOAD_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
type CapabilityState = (typeof CAPABILITY_STATES)[number];
type DecisionMode = (typeof DECISION_MODES)[number];
type VerificationState = (typeof VERIFICATION_STATES)[number];

export interface CapabilityEvidence {
  state: CapabilityState;
  reason: string;
  versionRange: string;
  evidenceUrl: string;
}

export interface ProviderContract {
  schemaVersion: number;
  id: string;
  label: string;
  command: string;
  skillDirectory: string;
  capabilities: {
    skills: CapabilityEvidence;
    invocation: CapabilityEvidence;
    compaction: CapabilityEvidence;
    resume: CapabilityEvidence;
    cancellation: CapabilityEvidence;
    usage: CapabilityEvidence;
    hooks: Record<string, CapabilityEvidence>;
    decisions: Record<string, CapabilityEvidence>;
  };
  verification: Record<string, VerificationState>;
}

export interface CommandPlan {
  executable: string;
  args: string[];
  cwd?: string;
  environment?: Record<string, unknown>;
}

export interface LifecycleEnvelope {
  schemaVersion: number;
  provider: { id: string; version: string; runtime: string };
  correlation: { projectId: string; taskId: string; sessionId: string };
  eventId: string;
  timestamp: number;
  kind: (typeof LIFECYCLE_EVENT_KINDS)[number];
  payload: JsonObject;
  decisionModes: DecisionMode[];
}

export class ProviderContractError extends Error {
  path: string;
  code: string;
  constructor(message: string, path = '$', code = 'PROVIDER_CONTRACT_INVALID') {
    super(message);
    this.name = 'ProviderContractError';
    this.path = path;
    this.code = code;
  }
}

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new ProviderContractError('Expected a non-empty string.', path);
  return value;
};
const exactKeys = (value: JsonObject, allowed: readonly string[], path: string): void => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new ProviderContractError(`Unknown field "${key}".`, `${path}.${key}`);
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function validateEvidence(evidence: unknown, path: string): asserts evidence is CapabilityEvidence {
  if (!record(evidence)) throw new ProviderContractError('Expected an evidence object.', path);
  exactKeys(evidence, ['state', 'reason', 'versionRange', 'evidenceUrl'], path);
  if (!CAPABILITY_STATES.includes(evidence.state as CapabilityState))
    throw new ProviderContractError('Unknown capability state.', `${path}.state`);
  text(evidence.reason, `${path}.reason`);
  text(evidence.versionRange, `${path}.versionRange`);
  if (typeof evidence.evidenceUrl !== 'string')
    throw new ProviderContractError('Expected an evidence URL string.', `${path}.evidenceUrl`);
}

function validateCapabilities(
  capabilities: unknown,
  path: string,
): asserts capabilities is ProviderContract['capabilities'] {
  if (!record(capabilities))
    throw new ProviderContractError('Expected a capabilities object.', path);
  const names = ['skills', 'invocation', 'compaction', 'resume', 'cancellation', 'usage'];
  exactKeys(capabilities, [...names, 'hooks', 'decisions'], path);
  for (const name of names) validateEvidence(capabilities[name], `${path}.${name}`);
  for (const group of ['hooks', 'decisions']) {
    if (!record(capabilities[group]))
      throw new ProviderContractError('Expected a capability map.', `${path}.${group}`);
    for (const [name, evidence] of Object.entries(capabilities[group]))
      validateEvidence(evidence, `${path}.${group}.${name}`);
  }
}

/** Validate serializable provider metadata. Provider versions use a deliberately
 * opaque range string: an adapter owns range parsing, not every consumer. */
export function validateProviderContract(contract: unknown): Readonly<ProviderContract> {
  if (!record(contract)) throw new ProviderContractError('Expected a provider contract object.');
  exactKeys(
    contract,
    ['schemaVersion', 'id', 'label', 'command', 'skillDirectory', 'capabilities', 'verification'],
    '$',
  );
  const candidate = contract as unknown as ProviderContract;
  if (candidate.schemaVersion !== PROVIDER_CONTRACT_VERSION)
    throw new ProviderContractError(
      `Unsupported provider contract version ${candidate.schemaVersion}.`,
      '$.schemaVersion',
      'PROVIDER_CONTRACT_VERSION_UNSUPPORTED',
    );
  for (const field of ['id', 'label', 'command', 'skillDirectory'] as const)
    text(candidate[field], `$.${field}`);
  validateCapabilities(candidate.capabilities, '$.capabilities');
  if (!record(candidate.verification))
    throw new ProviderContractError('Expected verification evidence.', '$.verification');
  exactKeys(
    candidate.verification,
    ['installed', 'authenticated', 'configured', 'endToEnd'],
    '$.verification',
  );
  for (const [name, state] of Object.entries(candidate.verification)) {
    if (!VERIFICATION_STATES.includes(state as VerificationState))
      throw new ProviderContractError('Unknown verification state.', `$.verification.${name}`);
  }
  return Object.freeze(clone(candidate));
}

export function createProviderAdapter(contract: unknown, operations: unknown) {
  const metadata = validateProviderContract(contract);
  if (!record(operations))
    throw new ProviderContractError('Expected an adapter operations object.', '$.operations');
  for (const name of ADAPTER_OPERATIONS) {
    if (typeof operations[name] !== 'function')
      throw new ProviderContractError(
        `Missing adapter operation "${name}".`,
        `$.operations.${name}`,
      );
  }
  return Object.freeze({ contract: metadata, operations: Object.freeze({ ...operations }) });
}

function capabilityFor(
  contract: Readonly<ProviderContract>,
  name: string,
): CapabilityEvidence | undefined {
  if (name.startsWith('hook:')) return contract.capabilities.hooks[name.slice(5)];
  if (name.startsWith('decision:')) return contract.capabilities.decisions[name.slice(9)];
  return contract.capabilities[
    name as keyof Omit<ProviderContract['capabilities'], 'hooks' | 'decisions'>
  ];
}

/** Negotiate evidence, never inferred support. A requested blocking decision can
 * only fall back to advisory when advisory evidence explicitly says supported. */
export function negotiateCapabilities(contract: unknown, requests: unknown): unknown[] {
  const provider = validateProviderContract(contract);
  if (!Array.isArray(requests))
    throw new ProviderContractError('Expected capability requests array.', '$.requests');
  return requests.map((request: unknown, index: number) => {
    if (!record(request) || typeof request.capability !== 'string')
      throw new ProviderContractError('Expected a capability request.', `$.requests[${index}]`);
    const evidence = capabilityFor(provider, request.capability);
    if (!evidence)
      return {
        ...request,
        state: 'unknown',
        outcome: 'refused',
        reason: 'The provider contract has no evidence for this capability.',
      };
    if (evidence.state === 'supported')
      return { ...request, ...clone(evidence), outcome: 'available' };
    if (request.decisionMode === 'blocking') {
      const advisory = provider.capabilities.decisions.advisory;
      if (advisory?.state === 'supported')
        return {
          ...request,
          ...clone(evidence),
          outcome: 'advisory-fallback',
          fallback: 'advisory',
          reason: `${evidence.reason} Blocking enforcement was not requested as passed.`,
        };
    }
    return { ...request, ...clone(evidence), outcome: 'refused' };
  });
}

export function validateCommandPlan(plan: unknown): Readonly<CommandPlan> {
  if (!record(plan)) throw new ProviderContractError('Expected a command plan object.', '$.plan');
  exactKeys(plan, ['executable', 'args', 'cwd', 'environment'], '$.plan');
  const candidate = plan as unknown as CommandPlan;
  text(candidate.executable, '$.plan.executable');
  if (
    !Array.isArray(candidate.args) ||
    candidate.args.some((arg: unknown) => typeof arg !== 'string')
  )
    throw new ProviderContractError('Expected string argument array.', '$.plan.args');
  if (candidate.cwd !== undefined) text(candidate.cwd, '$.plan.cwd');
  if (candidate.environment !== undefined && !record(candidate.environment))
    throw new ProviderContractError('Expected environment object.', '$.plan.environment');
  return Object.freeze(clone(candidate));
}

export function validateLifecycleEnvelope(envelope: unknown): Readonly<LifecycleEnvelope> {
  if (!record(envelope)) throw new ProviderContractError('Expected lifecycle envelope.');
  exactKeys(
    envelope,
    [
      'schemaVersion',
      'provider',
      'correlation',
      'eventId',
      'timestamp',
      'kind',
      'payload',
      'decisionModes',
    ],
    '$',
  );
  const candidate = envelope as unknown as LifecycleEnvelope;
  if (candidate.schemaVersion !== LIFECYCLE_ENVELOPE_VERSION)
    throw new ProviderContractError(
      'Unsupported lifecycle envelope version.',
      '$.schemaVersion',
      'LIFECYCLE_VERSION_UNSUPPORTED',
    );
  if (!record(candidate.provider))
    throw new ProviderContractError('Expected provider identity.', '$.provider');
  exactKeys(candidate.provider, ['id', 'version', 'runtime'], '$.provider');
  for (const field of ['id', 'version', 'runtime'] as const)
    text(candidate.provider[field], `$.provider.${field}`);
  if (!record(candidate.correlation))
    throw new ProviderContractError('Expected correlation object.', '$.correlation');
  exactKeys(candidate.correlation, ['projectId', 'taskId', 'sessionId'], '$.correlation');
  for (const field of ['projectId', 'taskId', 'sessionId'] as const)
    text(candidate.correlation[field], `$.correlation.${field}`);
  text(candidate.eventId, '$.eventId');
  if (!Number.isInteger(candidate.timestamp) || candidate.timestamp < 0)
    throw new ProviderContractError('Expected Unix timestamp milliseconds.', '$.timestamp');
  if (!LIFECYCLE_EVENT_KINDS.includes(candidate.kind))
    throw new ProviderContractError('Unknown lifecycle event kind.', '$.kind');
  if (!record(candidate.payload))
    throw new ProviderContractError('Expected object payload.', '$.payload');
  if (Buffer.byteLength(JSON.stringify(envelope.payload), 'utf8') > MAX_LIFECYCLE_PAYLOAD_BYTES)
    throw new ProviderContractError(
      'Lifecycle payload exceeds 64 KB.',
      '$.payload',
      'LIFECYCLE_PAYLOAD_TOO_LARGE',
    );
  if (
    !Array.isArray(candidate.decisionModes) ||
    candidate.decisionModes.some((mode: unknown) => !DECISION_MODES.includes(mode as DecisionMode))
  )
    throw new ProviderContractError('Expected supported decision modes.', '$.decisionModes');
  return Object.freeze(clone(candidate));
}

/** In-process bridge for future adapters. It is intentionally injectable: this
 * repository has no task store, authorization policy, hook service, or daemon.
 * Callers provide lookup/authorize/handle and may enforce their own deadline. */
export function createLifecycleDispatcher({
  lookupTask,
  authorize,
  handle,
  timeoutMs = 5_000,
  now = () => Date.now(),
}: {
  lookupTask: (taskId: string, event: Readonly<LifecycleEnvelope>) => unknown | Promise<unknown>;
  authorize: (task: unknown, event: Readonly<LifecycleEnvelope>) => boolean | Promise<boolean>;
  handle: (
    task: unknown,
    event: Readonly<LifecycleEnvelope>,
    context: { deadline: number },
  ) => unknown | Promise<unknown>;
  timeoutMs?: number;
  now?: () => number;
}) {
  for (const [name, value] of Object.entries({ lookupTask, authorize, handle, now }))
    if (typeof value !== 'function')
      throw new ProviderContractError(`Expected ${name} function.`, `$.dispatcher.${name}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new ProviderContractError('Expected positive timeout.', '$.dispatcher.timeoutMs');
  const seen = new Set();
  const latestTimestamp = new Map();
  return async function dispatch(envelope: unknown) {
    const event = validateLifecycleEnvelope(envelope);
    if (seen.has(event.eventId))
      return {
        status: 'duplicate',
        decision: 'advisory',
        reason: 'Event ID was already processed.',
      };
    seen.add(event.eventId);
    const stream = `${event.provider.id}:${event.correlation.projectId}:${event.correlation.taskId}:${event.correlation.sessionId}`;
    const latest = latestTimestamp.get(stream);
    if (latest !== undefined && event.timestamp < latest)
      return {
        status: 'out-of-order',
        decision: 'advisory',
        reason: 'Event timestamp precedes an already processed event.',
      };
    latestTimestamp.set(stream, event.timestamp);
    const task = await lookupTask(event.correlation.taskId, event);
    if (!task)
      return {
        status: 'missing-task',
        decision: 'advisory',
        reason: 'No task matched the correlation ID.',
      };
    if (!(await authorize(task, event)))
      return {
        status: 'unauthorized',
        decision: 'advisory',
        reason: 'Task authorization rejected this event.',
      };
    const deadline = now() + timeoutMs;
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Lifecycle handler timed out.')), timeoutMs);
      });
      const result = await Promise.race([
        Promise.resolve(handle(task, event, { deadline })),
        timeout,
      ]);
      return { status: 'handled', result: result ?? { decision: 'advisory' } };
    } catch (error) {
      return {
        status: 'handler-failed',
        decision: 'advisory',
        reason: error instanceof Error ? error.message : 'Lifecycle handler failed.',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
