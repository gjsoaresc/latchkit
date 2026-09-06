import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_ENVELOPE_VERSION,
  ProviderContractError,
  createProviderAdapter,
  validateCommandPlan,
  validateLifecycleEnvelope,
} from './contracts.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  inspectTransaction,
  recoverTransaction,
} from '../installer/transactions.js';
import { inspectProjectLock, removeProvenStaleLock, withProjectLock } from '../installer/lock.js';
import { readOptional, resolveProjectRoot } from '../storage.js';
import { quoteWindowsCommandArgument } from '../runtime/process-runner.js';

const CLI_DOCS_URL = 'https://antigravity.google/docs/cli/overview';
const HEADLESS_DOCS_URL = 'https://antigravity.google/docs/cli/headless/';
const HOOK_DOCS_URL = 'https://antigravity.google/docs/hooks';
export const ANTIGRAVITY_RESUME_VERSION = '1.1.27';
export const ANTIGRAVITY_HOOKS_PATH = '.agents/hooks.json';
export const ANTIGRAVITY_HANDLER_PATH = '.latchkit/providers/antigravity/hook-handler.cjs';
export const ANTIGRAVITY_STATE_PATH = '.latchkit/providers/antigravity/ownership.json';
export const ANTIGRAVITY_HOOK_EVENTS = Object.freeze(['PostToolUse']);
export const ANTIGRAVITY_UNREGISTERED_HOOK_EVENTS = Object.freeze([
  'PreToolUse',
  'PreInvocation',
  'PostInvocation',
  'Stop',
]);
const ANTIGRAVITY_DOCUMENTED_HOOK_EVENTS = Object.freeze([
  ...ANTIGRAVITY_HOOK_EVENTS,
  ...ANTIGRAVITY_UNREGISTERED_HOOK_EVENTS,
]);
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
    hooks: {
      ...Object.fromEntries(
        ANTIGRAVITY_HOOK_EVENTS.map((event) => [
          event,
          evidence('supported', `Antigravity CLI documents the ${event} hook.`, HOOK_DOCS_URL),
        ]),
      ),
      ...Object.fromEntries(
        ANTIGRAVITY_UNREGISTERED_HOOK_EVENTS.map((event) => [
          event,
          evidence(
            'unsupported',
            `${event} requires an output decision or has no permission-preserving advisory response evidence.`,
            HOOK_DOCS_URL,
          ),
        ]),
      ),
    },
    decisions: {
      blocking: evidence(
        'unknown',
        'The documented hook output contract does not establish a blocking response for this adapter.',
      ),
      advisory: evidence(
        'supported',
        'Documented command hooks can observe CLI lifecycle events without an enforcement claim.',
        HOOK_DOCS_URL,
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

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024)
    throw new ProviderContractError(`Expected bounded ${field}.`, `$.${field}`);
  return value;
};

type HookDocument = Record<string, unknown>;
type Ownership = {
  schemaVersion: 1;
  command: string;
  handlerSha256: string;
  entries: Record<string, string>;
};
const hookEntry = (command: string) => ({ type: 'command', command, timeout: 10 });
const invocationEntry = (command: string) => ({ type: 'command', command, timeout: 10 });

function quoteToken(value: string, platform: NodeJS.Platform = process.platform) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Unsafe Antigravity hook command token.');
  return platform === 'win32'
    ? quoteWindowsCommandArgument(value)
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function antigravityHookCommand(
  nodeExecutable = process.execPath,
  platform: NodeJS.Platform = process.platform,
) {
  return `${quoteToken(nodeExecutable, platform)} ${quoteToken(ANTIGRAVITY_HANDLER_PATH, platform)}`;
}

function parseHooks(raw: string | null): HookDocument {
  if (raw === null) return {};
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${ANTIGRAVITY_HOOKS_PATH}.`);
  }
  if (!isRecord(document)) throw new Error(`${ANTIGRAVITY_HOOKS_PATH} must contain an object.`);
  return structuredClone(document);
}

function entriesFor(event: string, command: string) {
  const eventCommand = `${command} --event ${event}`;
  return event === 'PostToolUse'
    ? [{ matcher: '*', hooks: [hookEntry(eventCommand)] }]
    : [invocationEntry(eventCommand)];
}

export function mergeAntigravityHooks(raw: string | null, command: string): string {
  const document = parseHooks(raw);
  if (document.latchkit !== undefined && !isRecord(document.latchkit))
    throw new Error('The Latchkit Antigravity hook namespace has an unsupported shape.');
  const namespace = isRecord(document.latchkit) ? structuredClone(document.latchkit) : {};
  for (const event of ANTIGRAVITY_HOOK_EVENTS) namespace[event] = entriesFor(event, command);
  document.latchkit = namespace;
  return `${JSON.stringify(document, null, 2)}\n`;
}

function removeAntigravityHooks(raw: string | null, ownership: Ownership): string | null {
  if (raw === null) throw new Error('Owned Antigravity hooks are missing.');
  const document = parseHooks(raw);
  if (!isRecord(document.latchkit)) throw new Error('Owned Antigravity hooks are missing.');
  const namespace = structuredClone(document.latchkit);
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const actual = namespace[event];
    if (digest(JSON.stringify(actual)) !== ownership.entries[event])
      throw new Error(`Owned Antigravity hook ${event} has local edits or is missing.`);
    delete namespace[event];
  }
  if (Object.keys(namespace).length) document.latchkit = namespace;
  else delete document.latchkit;
  return Object.keys(document).length ? `${JSON.stringify(document, null, 2)}\n` : null;
}

async function hookSource() {
  return readFile(fileURLToPath(new URL('./antigravity-hook.cjs', import.meta.url)), 'utf8');
}

export async function planAntigravityHookExport(
  root: string,
  options: { enabled?: boolean; nodeExecutable?: string; platform?: NodeJS.Platform } = {},
) {
  root = await resolveProjectRoot(root);
  const currentHooks = await readOptional(root, ANTIGRAVITY_HOOKS_PATH);
  const currentHandler = await readOptional(root, ANTIGRAVITY_HANDLER_PATH);
  const rawState = await readOptional(root, ANTIGRAVITY_STATE_PATH);
  let ownership: Ownership | null = null;
  if (rawState !== null) {
    try {
      ownership = JSON.parse(rawState) as Ownership;
    } catch {
      throw new Error('Invalid Antigravity ownership record.');
    }
  }
  if (options.enabled !== true && !ownership) return { configured: false, changes: [] };
  const source = await hookSource();
  if (ownership && (currentHandler === null || digest(currentHandler) !== ownership.handlerSha256))
    throw new Error('Owned Antigravity handler has local edits or is missing.');
  const command = antigravityHookCommand(options.nodeExecutable, options.platform);
  const nextHooks =
    options.enabled === true
      ? mergeAntigravityHooks(
          ownership ? removeAntigravityHooks(currentHooks, ownership) : currentHooks,
          command,
        )
      : removeAntigravityHooks(currentHooks, ownership!);
  const nextHandler = options.enabled === true ? source : null;
  const nextState =
    options.enabled === true
      ? `${JSON.stringify(
          {
            schemaVersion: 1,
            command,
            handlerSha256: digest(source),
            entries: Object.fromEntries(
              ANTIGRAVITY_HOOK_EVENTS.map((event) => [
                event,
                digest(JSON.stringify(entriesFor(event, command))),
              ]),
            ),
          },
          null,
          2,
        )}\n`
      : null;
  return {
    configured: options.enabled === true,
    backup:
      currentHooks !== null && currentHooks !== nextHooks
        ? { bytes: currentHooks, protected: true, sha256: digest(currentHooks) }
        : null,
    changes: [
      [ANTIGRAVITY_HOOKS_PATH, currentHooks, nextHooks],
      [ANTIGRAVITY_HANDLER_PATH, currentHandler, nextHandler],
      [ANTIGRAVITY_STATE_PATH, rawState, nextState],
    ]
      .filter(([, before, after]) => before !== after)
      .map(([resourcePath, before, bytes]) => ({
        resourceId: `provider:antigravity:${resourcePath}`,
        path: resourcePath,
        action: bytes === null ? 'remove' : before === null ? 'create' : 'update',
        bytes,
      })),
  };
}

export function antigravityResourceRegistry() {
  return createResourceRegistry(
    [ANTIGRAVITY_HOOKS_PATH, ANTIGRAVITY_HANDLER_PATH, ANTIGRAVITY_STATE_PATH].map((path) => ({
      id: `provider:antigravity:${path}`,
      path,
    })),
  );
}

export async function applyAntigravityHookExport(
  root: string,
  options: {
    enabled?: boolean;
    nodeExecutable?: string;
    platform?: NodeJS.Platform;
    faultBoundary?: (boundary: string) => Promise<void>;
  } = {},
) {
  root = await resolveProjectRoot(root);
  return withProjectLock(root, async () => {
    const plan = await planAntigravityHookExport(root, options);
    if (!plan.changes.length) return plan;
    const manifest =
      (await readOptional(root, '.latchkit/manifest.json')) ??
      `${JSON.stringify({ schemaVersion: 3, files: {}, packs: [], sections: {} }, null, 2)}\n`;
    await applyRegisteredTransaction(root, {
      operation: options.enabled === true ? 'antigravity-hook-enable' : 'antigravity-hook-disable',
      registry: antigravityResourceRegistry(),
      changes: plan.changes.map(({ resourceId, bytes }) => ({ resourceId, bytes: bytes ?? null })),
      manifest,
      faultBoundary: options.faultBoundary,
    });
    return plan;
  });
}

export async function inspectAntigravityRecovery(root: string) {
  return inspectTransaction(await resolveProjectRoot(root), antigravityResourceRegistry());
}
export async function recoverAntigravityIntegration(root: string) {
  root = await resolveProjectRoot(root);
  const lock = await inspectProjectLock(root);
  if (lock.state === 'live' || lock.state === 'invalid')
    throw new Error('Antigravity recovery is blocked by the project lock.');
  if (lock.state === 'stale') await removeProvenStaleLock(root, lock);
  return recoverTransaction(root, antigravityResourceRegistry());
}

export function translateAntigravityLifecycleInput(
  input: unknown,
  context: {
    eventName?: unknown;
    projectId?: unknown;
    taskId?: unknown;
    sessionId?: unknown;
    version?: unknown;
    timestamp?: number;
  } = {},
) {
  if (!isRecord(input)) throw new ProviderContractError('Expected Antigravity hook payload.');
  const event = text(context.eventName, 'eventName');
  if (
    !ANTIGRAVITY_DOCUMENTED_HOOK_EVENTS.includes(
      event as (typeof ANTIGRAVITY_DOCUMENTED_HOOK_EVENTS)[number],
    )
  )
    throw new ProviderContractError('Unsupported Antigravity hook event.', '$.eventName');
  if (event === 'PostToolUse') {
    if (!isRecord(input.toolCall))
      throw new ProviderContractError('PostToolUse requires a toolCall object.', '$.toolCall');
    if (!Number.isInteger(input.stepIdx) || (input.stepIdx as number) < 0)
      throw new ProviderContractError('PostToolUse requires a non-negative stepIdx.', '$.stepIdx');
  }
  const kind = event === 'Stop' ? 'turn-completed' : null;
  if (!kind) return { accepted: true, event, envelope: null };
  const sessionId = text(context.sessionId ?? input.conversationId, 'sessionId');
  return {
    accepted: true,
    event,
    envelope: validateLifecycleEnvelope({
      schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
      provider: {
        id: 'antigravity',
        version: text(context.version ?? 'unknown', 'version'),
        runtime: 'cli',
      },
      correlation: {
        projectId: text(context.projectId, 'projectId'),
        taskId: text(context.taskId, 'taskId'),
        sessionId,
      },
      eventId: `${sessionId}:${event}:${context.timestamp ?? Date.now()}`,
      timestamp: context.timestamp ?? Date.now(),
      kind,
      payload: { antigravityEvent: event },
      decisionModes: ['advisory'],
    }),
  };
}

export function translateAntigravityLifecycleOutput(
  event: unknown,
  result: { decision?: unknown } = {},
) {
  if (event !== 'PostToolUse')
    throw new ProviderContractError('Unsupported Antigravity hook event.', '$.event');
  if (result.decision === undefined || result.decision === 'advisory') return {};
  throw new ProviderContractError(
    'Antigravity hook decisions are not supported by the documented adapter contract.',
    '$.result',
  );
}

export function createAntigravityAdapter() {
  return createProviderAdapter(contract, {
    inspect: inspectAntigravity,
    planInstall: (options = {}) =>
      planAntigravityHookExport(
        String((options as { root?: string }).root ?? process.cwd()),
        options,
      ),
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
    translateLifecycleInput: translateAntigravityLifecycleInput,
    translateLifecycleOutput: translateAntigravityLifecycleOutput,
    planUsage: () => ({
      state: 'unknown',
      reason: 'Antigravity usage fields are not normalized by this adapter.',
    }),
  });
}

export const ANTIGRAVITY_ADAPTER = createAntigravityAdapter();
