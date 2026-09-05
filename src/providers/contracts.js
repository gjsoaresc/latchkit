/** Versioned, provider-neutral contracts.  These describe evidence and plans;
 * they deliberately do not start a provider process or modify provider state. */
export const PROVIDER_CONTRACT_VERSION = 1;
export const LIFECYCLE_ENVELOPE_VERSION = 1;
export const CAPABILITY_STATES = Object.freeze(['supported', 'partial', 'unsupported', 'unknown']);
export const DECISION_MODES = Object.freeze(['blocking', 'advisory']);
export const VERIFICATION_STATES = Object.freeze(['verified', 'unverified', 'unknown']);
export const ADAPTER_OPERATIONS = Object.freeze([
  'inspect', 'planInstall', 'planSkillExport', 'planRuleExport', 'planInvocation', 'planResume',
  'translateLifecycleInput', 'translateLifecycleOutput', 'planUsage',
]);
export const LIFECYCLE_EVENT_KINDS = Object.freeze([
  'turn-completed', 'session-terminated', 'interrupted', 'verified-task-completed',
]);
export const MAX_LIFECYCLE_PAYLOAD_BYTES = 64 * 1024;

export class ProviderContractError extends Error {
  constructor(message, path = '$', code = 'PROVIDER_CONTRACT_INVALID') {
    super(message);
    this.name = 'ProviderContractError'; this.path = path; this.code = code;
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, path) => {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderContractError('Expected a non-empty string.', path);
  return value;
};
const exactKeys = (value, allowed, path) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ProviderContractError(`Unknown field "${key}".`, `${path}.${key}`);
};
const clone = value => JSON.parse(JSON.stringify(value));

function validateEvidence(evidence, path) {
  if (!record(evidence)) throw new ProviderContractError('Expected an evidence object.', path);
  exactKeys(evidence, ['state', 'reason', 'versionRange', 'evidenceUrl'], path);
  if (!CAPABILITY_STATES.includes(evidence.state)) throw new ProviderContractError('Unknown capability state.', `${path}.state`);
  text(evidence.reason, `${path}.reason`); text(evidence.versionRange, `${path}.versionRange`);
  if (typeof evidence.evidenceUrl !== 'string') throw new ProviderContractError('Expected an evidence URL string.', `${path}.evidenceUrl`);
}

function validateCapabilities(capabilities, path) {
  if (!record(capabilities)) throw new ProviderContractError('Expected a capabilities object.', path);
  const names = ['skills', 'invocation', 'compaction', 'resume', 'cancellation', 'usage'];
  exactKeys(capabilities, [...names, 'hooks', 'decisions'], path);
  for (const name of names) validateEvidence(capabilities[name], `${path}.${name}`);
  for (const group of ['hooks', 'decisions']) {
    if (!record(capabilities[group])) throw new ProviderContractError('Expected a capability map.', `${path}.${group}`);
    for (const [name, evidence] of Object.entries(capabilities[group])) validateEvidence(evidence, `${path}.${group}.${name}`);
  }
}

/** Validate serializable provider metadata. Provider versions use a deliberately
 * opaque range string: an adapter owns range parsing, not every consumer. */
export function validateProviderContract(contract) {
  if (!record(contract)) throw new ProviderContractError('Expected a provider contract object.');
  exactKeys(contract, ['schemaVersion', 'id', 'label', 'command', 'skillDirectory', 'capabilities', 'verification'], '$');
  if (contract.schemaVersion !== PROVIDER_CONTRACT_VERSION) throw new ProviderContractError(`Unsupported provider contract version ${contract.schemaVersion}.`, '$.schemaVersion', 'PROVIDER_CONTRACT_VERSION_UNSUPPORTED');
  for (const field of ['id', 'label', 'command', 'skillDirectory']) text(contract[field], `$.${field}`);
  validateCapabilities(contract.capabilities, '$.capabilities');
  if (!record(contract.verification)) throw new ProviderContractError('Expected verification evidence.', '$.verification');
  exactKeys(contract.verification, ['installed', 'authenticated', 'configured', 'endToEnd'], '$.verification');
  for (const [name, state] of Object.entries(contract.verification)) {
    if (!VERIFICATION_STATES.includes(state)) throw new ProviderContractError('Unknown verification state.', `$.verification.${name}`);
  }
  return Object.freeze(clone(contract));
}

export function createProviderAdapter(contract, operations) {
  const metadata = validateProviderContract(contract);
  if (!record(operations)) throw new ProviderContractError('Expected an adapter operations object.', '$.operations');
  for (const name of ADAPTER_OPERATIONS) {
    if (typeof operations[name] !== 'function') throw new ProviderContractError(`Missing adapter operation "${name}".`, `$.operations.${name}`);
  }
  return Object.freeze({ contract: metadata, operations: Object.freeze({ ...operations }) });
}

function capabilityFor(contract, name) {
  if (name.startsWith('hook:')) return contract.capabilities.hooks[name.slice(5)];
  if (name.startsWith('decision:')) return contract.capabilities.decisions[name.slice(9)];
  return contract.capabilities[name];
}

/** Negotiate evidence, never inferred support. A requested blocking decision can
 * only fall back to advisory when advisory evidence explicitly says supported. */
export function negotiateCapabilities(contract, requests) {
  const provider = validateProviderContract(contract);
  if (!Array.isArray(requests)) throw new ProviderContractError('Expected capability requests array.', '$.requests');
  return requests.map((request, index) => {
    if (!record(request) || typeof request.capability !== 'string') throw new ProviderContractError('Expected a capability request.', `$.requests[${index}]`);
    const evidence = capabilityFor(provider, request.capability);
    if (!evidence) return { ...request, state: 'unknown', outcome: 'refused', reason: 'The provider contract has no evidence for this capability.' };
    if (evidence.state === 'supported') return { ...request, ...clone(evidence), outcome: 'available' };
    if (request.decisionMode === 'blocking') {
      const advisory = provider.capabilities.decisions.advisory;
      if (advisory?.state === 'supported') return { ...request, ...clone(evidence), outcome: 'advisory-fallback', fallback: 'advisory', reason: `${evidence.reason} Blocking enforcement was not requested as passed.` };
    }
    return { ...request, ...clone(evidence), outcome: 'refused' };
  });
}

export function validateCommandPlan(plan) {
  if (!record(plan)) throw new ProviderContractError('Expected a command plan object.', '$.plan');
  exactKeys(plan, ['executable', 'args', 'cwd', 'environment'], '$.plan');
  text(plan.executable, '$.plan.executable');
  if (!Array.isArray(plan.args) || plan.args.some(arg => typeof arg !== 'string')) throw new ProviderContractError('Expected string argument array.', '$.plan.args');
  if (plan.cwd !== undefined) text(plan.cwd, '$.plan.cwd');
  if (plan.environment !== undefined && !record(plan.environment)) throw new ProviderContractError('Expected environment object.', '$.plan.environment');
  return Object.freeze(clone(plan));
}

export function validateLifecycleEnvelope(envelope) {
  if (!record(envelope)) throw new ProviderContractError('Expected lifecycle envelope.');
  exactKeys(envelope, ['schemaVersion', 'provider', 'correlation', 'eventId', 'timestamp', 'kind', 'payload', 'decisionModes'], '$');
  if (envelope.schemaVersion !== LIFECYCLE_ENVELOPE_VERSION) throw new ProviderContractError('Unsupported lifecycle envelope version.', '$.schemaVersion', 'LIFECYCLE_VERSION_UNSUPPORTED');
  if (!record(envelope.provider)) throw new ProviderContractError('Expected provider identity.', '$.provider');
  exactKeys(envelope.provider, ['id', 'version', 'runtime'], '$.provider');
  for (const field of ['id', 'version', 'runtime']) text(envelope.provider[field], `$.provider.${field}`);
  if (!record(envelope.correlation)) throw new ProviderContractError('Expected correlation object.', '$.correlation');
  exactKeys(envelope.correlation, ['projectId', 'taskId', 'sessionId'], '$.correlation');
  for (const field of ['projectId', 'taskId', 'sessionId']) text(envelope.correlation[field], `$.correlation.${field}`);
  text(envelope.eventId, '$.eventId');
  if (!Number.isInteger(envelope.timestamp) || envelope.timestamp < 0) throw new ProviderContractError('Expected Unix timestamp milliseconds.', '$.timestamp');
  if (!LIFECYCLE_EVENT_KINDS.includes(envelope.kind)) throw new ProviderContractError('Unknown lifecycle event kind.', '$.kind');
  if (!record(envelope.payload)) throw new ProviderContractError('Expected object payload.', '$.payload');
  if (Buffer.byteLength(JSON.stringify(envelope.payload), 'utf8') > MAX_LIFECYCLE_PAYLOAD_BYTES) throw new ProviderContractError('Lifecycle payload exceeds 64 KB.', '$.payload', 'LIFECYCLE_PAYLOAD_TOO_LARGE');
  if (!Array.isArray(envelope.decisionModes) || envelope.decisionModes.some(mode => !DECISION_MODES.includes(mode))) throw new ProviderContractError('Expected supported decision modes.', '$.decisionModes');
  return Object.freeze(clone(envelope));
}

/** In-process bridge for future adapters. It is intentionally injectable: this
 * repository has no task store, authorization policy, hook service, or daemon.
 * Callers provide lookup/authorize/handle and may enforce their own deadline. */
export function createLifecycleDispatcher({ lookupTask, authorize, handle, timeoutMs = 5_000, now = () => Date.now() }) {
  for (const [name, value] of Object.entries({ lookupTask, authorize, handle, now })) if (typeof value !== 'function') throw new ProviderContractError(`Expected ${name} function.`, `$.dispatcher.${name}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new ProviderContractError('Expected positive timeout.', '$.dispatcher.timeoutMs');
  const seen = new Set();
  const latestTimestamp = new Map();
  return async function dispatch(envelope) {
    const event = validateLifecycleEnvelope(envelope);
    if (seen.has(event.eventId)) return { status: 'duplicate', decision: 'advisory', reason: 'Event ID was already processed.' };
    seen.add(event.eventId);
    const stream = `${event.provider.id}:${event.correlation.projectId}:${event.correlation.taskId}:${event.correlation.sessionId}`;
    const latest = latestTimestamp.get(stream);
    if (latest !== undefined && event.timestamp < latest) return { status: 'out-of-order', decision: 'advisory', reason: 'Event timestamp precedes an already processed event.' };
    latestTimestamp.set(stream, event.timestamp);
    const task = await lookupTask(event.correlation.taskId, event);
    if (!task) return { status: 'missing-task', decision: 'advisory', reason: 'No task matched the correlation ID.' };
    if (!(await authorize(task, event))) return { status: 'unauthorized', decision: 'advisory', reason: 'Task authorization rejected this event.' };
    const deadline = now() + timeoutMs;
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Lifecycle handler timed out.')), timeoutMs); });
      const result = await Promise.race([Promise.resolve(handle(task, event, { deadline })), timeout]);
      return { status: 'handled', result: result ?? { decision: 'advisory' } };
    } catch (error) {
      return { status: 'handler-failed', decision: 'advisory', reason: error.message };
    } finally {
      clearTimeout(timer);
    }
  };
}
