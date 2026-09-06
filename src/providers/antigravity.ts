import { createProviderAdapter, validateCommandPlan } from './contracts.js';

const CLI_DOCS_URL = 'https://antigravity.google/docs/cli/overview';
const HEADLESS_DOCS_URL = 'https://antigravity.google/docs/cli/headless/';
export const ANTIGRAVITY_RESUME_VERSION = '1.1.27';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

const evidence = (state: string, reason: string, evidenceUrl = CLI_DOCS_URL) => ({
  state,
  reason,
  versionRange: '*',
  evidenceUrl,
});

const contract = {
  schemaVersion: 1,
  id: 'antigravity',
  label: 'Antigravity CLI',
  command: 'agy',
  skillDirectory: '.agents/skills',
  capabilities: {
    skills: evidence(
      'supported',
      'Antigravity CLI operates in the project workspace and can discover workspace skills.',
    ),
    invocation: evidence(
      'supported',
      'Official documentation describes print mode (-p/--print) and machine-readable JSON output.',
      HEADLESS_DOCS_URL,
    ),
    hooks: {},
    decisions: {
      blocking: evidence(
        'unknown',
        'Documented Antigravity hooks are not implemented by this adapter.',
      ),
      advisory: evidence(
        'unknown',
        'Documented Antigravity hooks are not implemented by this adapter.',
      ),
    },
    compaction: evidence(
      'unknown',
      'Compaction events are not exposed by the documented CLI contract.',
    ),
    resume: {
      ...evidence(
        'partial',
        'Explicit conversation resume is documented and fixture-tested for 1.1.27 only; execution requires a matching version probe. Live resume remains unverified.',
        HEADLESS_DOCS_URL,
      ),
      versionRange: ANTIGRAVITY_RESUME_VERSION,
    },
    cancellation: evidence(
      'partial',
      'The bounded host runner can cancel the process; Antigravity-native cancellation is not claimed.',
    ),
    usage: evidence('unknown', 'Usage fields are not normalized by this adapter.'),
  },
  verification: {
    installed: 'unknown',
    authenticated: 'unknown',
    configured: 'unverified',
    endToEnd: 'unverified',
  },
};

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

export function parseAntigravityVersion(output: unknown): string | null {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 4096) return null;
  const matches = [...output.matchAll(/(?:^|\s)v?(\d+\.\d+\.\d+)(?=\s|$)/g)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

export function inspectAntigravity({ versionOutput = '' }: { versionOutput?: string } = {}) {
  const version = parseAntigravityVersion(versionOutput);
  return {
    version,
    contract: {
      ...contract,
      capabilities: {
        ...contract.capabilities,
        resume: {
          ...contract.capabilities.resume,
          ...(version === ANTIGRAVITY_RESUME_VERSION
            ? {}
            : {
                state: 'unknown',
                reason:
                  'This version has no Latchkit resume contract evidence; only 1.1.27 is accepted.',
              }),
        },
      },
    },
  };
}

type InvocationOptions = {
  prompt: unknown;
  cwd?: string;
  outputFormat?: string;
  sandbox?: unknown;
  approvalPolicy?: unknown;
};

export function planAntigravityInvocation({
  prompt,
  cwd,
  outputFormat = 'json',
  sandbox,
  approvalPolicy,
}: InvocationOptions) {
  if (sandbox !== undefined || approvalPolicy !== undefined)
    throw new TypeError(
      'Antigravity sandbox and approval policy overrides are not supported by this adapter; existing provider permissions apply.',
    );
  const promptText = requiredText(prompt, 'prompt');
  if (!['json', 'stream-json'].includes(outputFormat))
    throw new TypeError('Antigravity adapter requires JSON or stream-json output.');
  return validateCommandPlan({
    executable: 'agy',
    args: ['-p', promptText, '--output-format', outputFormat],
    cwd,
  });
}

export function planAntigravityResume({
  providerVersion,
  sessionId,
  ...options
}: Partial<InvocationOptions> & { providerVersion?: unknown; sessionId?: unknown } = {}) {
  if (providerVersion !== ANTIGRAVITY_RESUME_VERSION)
    return {
      supported: false,
      reason:
        'Antigravity resume requires an observed version of exactly 1.1.27; other versions have no adapter evidence.',
    };
  if (typeof sessionId !== 'string' || !UUID.test(sessionId))
    throw new TypeError('A canonical Antigravity conversation UUID is required for resume.');
  const plan = planAntigravityInvocation({ ...options, prompt: options.prompt });
  return validateCommandPlan({ ...plan, args: [...plan.args, '--conversation', sessionId] });
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Extract only the bounded single-turn contract. Streaming stdin/multiple turns
 * and hook payloads are different protocols and are deliberately not accepted. */
export function parseAntigravitySessionIdentity(
  output: unknown,
  {
    providerVersion,
    expectedSessionId,
  }: { providerVersion?: unknown; expectedSessionId?: string | null } = {},
): string | null {
  if (
    providerVersion !== ANTIGRAVITY_RESUME_VERSION ||
    typeof output !== 'string' ||
    Buffer.byteLength(output) > 1024 * 1024
  )
    return null;
  let envelope: unknown;
  let streamId: string | undefined;
  try {
    envelope = JSON.parse(output);
  } catch {
    let entries: unknown[];
    try {
      entries = output
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      return null;
    }
    const first = entries[0];
    const last = entries.at(-1);
    if (
      entries.length < 2 ||
      !record(first) ||
      first.event !== 'init' ||
      !record(first.init) ||
      typeof first.conversation_id !== 'string' ||
      !UUID.test(first.conversation_id) ||
      !record(last) ||
      last.event !== 'result'
    )
      return null;
    streamId = first.conversation_id;
    for (const entry of entries.slice(1, -1)) {
      if (!record(entry) || entry.event !== 'step_update' || !record(entry.step_update))
        return null;
      const step = entry.step_update;
      if (
        step.conversation_id !== streamId ||
        !Number.isInteger(step.step_index) ||
        (step.step_index as number) < 0 ||
        !['ACTIVE', 'DONE'].includes(String(step.state)) ||
        typeof step.step_type !== 'string' ||
        !step.step_type
      )
        return null;
    }
    envelope = last.result;
  }
  if (
    !record(envelope) ||
    typeof envelope.conversation_id !== 'string' ||
    !UUID.test(envelope.conversation_id) ||
    envelope.status !== 'SUCCESS' ||
    typeof envelope.response !== 'string'
  )
    return null;
  if (
    (envelope.error !== undefined && envelope.error !== '') ||
    (envelope.denied_actions !== undefined &&
      (!Array.isArray(envelope.denied_actions) || envelope.denied_actions.length > 0))
  )
    return null;
  if (
    (streamId !== undefined && envelope.conversation_id !== streamId) ||
    (expectedSessionId !== undefined &&
      expectedSessionId !== null &&
      envelope.conversation_id !== expectedSessionId)
  )
    return null;
  return envelope.conversation_id;
}

function unsupported(name: string) {
  return () => ({
    supported: false,
    reason: `This adapter does not implement Antigravity ${name} integration.`,
  });
}

export function createAntigravityAdapter() {
  return createProviderAdapter(contract, {
    inspect: inspectAntigravity,
    planInstall: unsupported('project hook/settings'),
    planSkillExport: ({ skills = [] } = {}) => ({
      provider: 'antigravity',
      directory: '.agents/skills',
      skills: [...skills],
    }),
    planRuleExport: ({ rules = [] } = {}) => ({
      provider: 'antigravity',
      directory: '.agents/skills',
      rules: [...rules],
    }),
    planInvocation: planAntigravityInvocation,
    planResume: planAntigravityResume,
    translateLifecycleInput: unsupported('lifecycle events'),
    translateLifecycleOutput: unsupported('lifecycle events'),
    planUsage: () => ({
      state: 'unknown',
      reason: 'Antigravity usage fields are not normalized by this adapter.',
    }),
  });
}

export const ANTIGRAVITY_ADAPTER = createAntigravityAdapter();
