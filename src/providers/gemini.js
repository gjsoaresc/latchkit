import {
  createProviderAdapter,
  LIFECYCLE_ENVELOPE_VERSION,
  validateCommandPlan,
} from './contracts.js';
import { createResourceRegistry } from '../installer/transactions.js';

const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'PreCompress',
]);
const HOOK_URL = 'https://geminicli.com/docs/hooks/reference/';
const CLI_URL = 'https://geminicli.com/docs/cli/headless/';
const SESSION_URL = 'https://geminicli.com/docs/cli/session-management/';
const evidence = (state, reason, evidenceUrl = HOOK_URL, versionRange = '*') => ({
  state,
  reason,
  versionRange,
  evidenceUrl,
});

const hookEvidence = {
  SessionStart: evidence(
    'supported',
    'Gemini invokes SessionStart at startup, resume, and clear; it is advisory.',
  ),
  SessionEnd: evidence(
    'supported',
    'Gemini invokes SessionEnd on exit or clear; it is best-effort and advisory.',
  ),
  BeforeAgent: evidence(
    'supported',
    'Gemini can block a turn or add context before agent planning.',
  ),
  AfterAgent: evidence('supported', 'Gemini can request a retry or halt after an agent turn.'),
  BeforeTool: evidence('supported', 'Gemini can block a tool call or rewrite its arguments.'),
  AfterTool: evidence('supported', 'Gemini can process a tool result and block the result.'),
  PreCompress: evidence(
    'supported',
    'Gemini invokes PreCompress before compression, but it cannot block or modify it.',
  ),
};

const baseContract = (version = '*') => ({
  schemaVersion: 1,
  id: 'gemini',
  label: 'Gemini CLI',
  command: 'gemini',
  skillDirectory: '.agents/skills',
  capabilities: {
    skills: evidence(
      'supported',
      'Gemini discovers project skills from .agents/skills.',
      'https://geminicli.com/docs/cli/using-agent-skills/',
      version,
    ),
    invocation: evidence(
      'partial',
      'Headless JSON invocation is documented; provider authentication and end-to-end execution remain unverified.',
      CLI_URL,
      version,
    ),
    hooks: hookEvidence,
    decisions: {
      blocking: evidence(
        'partial',
        'BeforeAgent and BeforeTool can block; advisory-only events and failure handling cannot provide a universal blocking gate.',
        HOOK_URL,
        version,
      ),
      advisory: evidence(
        'supported',
        'Gemini hook output supports advisory messages and explicit non-blocking outcomes.',
        HOOK_URL,
        version,
      ),
    },
    compaction: evidence(
      'partial',
      'PreCompress is observable before compression but cannot block or modify compression.',
      HOOK_URL,
      version,
    ),
    resume: evidence(
      'supported',
      'Gemini supports --resume with latest, an index, or a session UUID.',
      SESSION_URL,
      version,
    ),
    cancellation: evidence(
      'partial',
      'The adapter exposes cancellation through the bounded host runner; Gemini-specific cancellation semantics are not claimed.',
      CLI_URL,
      version,
    ),
    usage: evidence(
      'unknown',
      'Usage fields are not normalized by this adapter.',
      CLI_URL,
      version,
    ),
  },
  verification: {
    installed: 'unknown',
    authenticated: 'unknown',
    configured: 'unverified',
    endToEnd: 'unverified',
  },
});

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function hookOutput(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Hook output must be an object.');
  return value;
}

export function parseGeminiVersion(output) {
  const match = typeof output === 'string' && output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/);
  return match ? match[1] : null;
}

export function inspectGemini({ versionOutput = '', helpOutput = '' } = {}) {
  const version = parseGeminiVersion(versionOutput);
  const help = String(helpOutput);
  const contract = baseContract(version ?? '*');
  const missing = [];
  for (const flag of ['--prompt', '--output-format', '--resume'])
    if (!help.includes(flag)) missing.push(flag);
  if (missing.length) {
    contract.capabilities.invocation = evidence(
      'unknown',
      `Installed Gemini help did not document: ${missing.join(', ')}.`,
      CLI_URL,
      version ?? '*',
    );
    if (missing.includes('--resume'))
      contract.capabilities.resume = evidence(
        'unknown',
        'Installed Gemini help did not document --resume.',
        SESSION_URL,
        version ?? '*',
      );
  }
  return { version, contract, missingFlags: missing };
}

export function planGeminiInvocation({ prompt, cwd, outputFormat = 'json' } = {}) {
  requiredText(prompt, 'prompt');
  if (outputFormat !== 'json') throw new TypeError('Gemini adapter requires JSON output.');
  return validateCommandPlan({
    executable: 'gemini',
    args: ['--prompt', prompt, '--output-format', 'json'],
    cwd,
  });
}

export function planGeminiResume({ sessionId = 'latest', prompt, cwd } = {}) {
  requiredText(sessionId, 'sessionId');
  requiredText(prompt, 'prompt');
  return validateCommandPlan({
    executable: 'gemini',
    args: ['--resume', sessionId, '--prompt', prompt, '--output-format', 'json'],
    cwd,
  });
}

export function translateGeminiHookInput(
  input,
  {
    projectId,
    taskId,
    sessionId,
    providerVersion = 'unknown',
    runtime = process.platform,
    timestamp = Date.now(),
  } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Gemini hook input must be an object.');
  const eventName = requiredText(input.hook_event_name, 'hook_event_name');
  if (!HOOK_EVENTS.includes(eventName))
    throw new Error(`Unsupported Gemini hook event: ${eventName}.`);
  const correlation = {
    projectId: requiredText(projectId ?? input.cwd, 'projectId'),
    taskId: requiredText(taskId ?? input.session_id, 'taskId'),
    sessionId: requiredText(sessionId ?? input.session_id, 'sessionId'),
  };
  const parsedTimestamp =
    typeof input.timestamp === 'string' ? Date.parse(input.timestamp) : timestamp;
  if (!Number.isInteger(parsedTimestamp) || parsedTimestamp < 0)
    throw new TypeError(
      'Gemini hook timestamp must be a valid ISO timestamp or Unix milliseconds.',
    );
  const decisionModes = ['advisory'];
  if (['BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool'].includes(eventName))
    decisionModes.unshift('blocking');
  return {
    schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
    provider: { id: 'gemini', version: providerVersion, runtime },
    correlation,
    eventId: input.event_id ?? `${correlation.sessionId}:${eventName}:${parsedTimestamp}`,
    timestamp: parsedTimestamp,
    kind: eventName === 'SessionEnd' ? 'session-terminated' : 'turn-completed',
    payload: { eventName, input },
    decisionModes,
  };
}

export function translateGeminiHookOutput(eventName, result = {}) {
  if (!HOOK_EVENTS.includes(eventName))
    throw new Error(`Unsupported Gemini hook event: ${eventName}.`);
  const output = hookOutput(result);
  if (eventName === 'SessionStart' || eventName === 'SessionEnd' || eventName === 'PreCompress') {
    const advisory = { ...output };
    delete advisory.decision;
    delete advisory.continue;
    return advisory;
  }
  if (eventName === 'AfterAgent' && output.retry === true) {
    const maxRetries =
      Number.isInteger(output.maxRetries) && output.maxRetries > 0 ? output.maxRetries : 1;
    return {
      decision: 'deny',
      reason: requiredText(output.reason ?? 'Retry requested by workflow handler.', 'reason'),
      retry: true,
      maxRetries,
    };
  }
  if (output.decision === 'deny' || output.decision === 'block')
    return { decision: 'deny', reason: requiredText(output.reason, 'reason') };
  return output;
}

export async function runGeminiHook({ stdin, eventName, handler = async () => ({}) } = {}) {
  if (typeof stdin !== 'string') throw new TypeError('stdin must be a JSON string.');
  let input;
  try {
    input = JSON.parse(stdin);
  } catch (error) {
    throw new Error(`Invalid Gemini hook JSON: ${error.message}`);
  }
  const result = await handler(input);
  return JSON.stringify(translateGeminiHookOutput(eventName ?? input.hook_event_name, result));
}

export const GEMINI_SETTINGS_PATH = '.gemini/settings.json';
export const GEMINI_SETTINGS_RESOURCE_ID = 'provider:gemini:settings';
export function createGeminiResourceRegistry() {
  return createResourceRegistry([{ id: GEMINI_SETTINGS_RESOURCE_ID, path: GEMINI_SETTINGS_PATH }]);
}

function ownedHook(eventName, command, timeout = 60000) {
  return {
    matcher: '.*',
    sequential: true,
    hooks: [
      {
        type: 'command',
        name: `latchkit-${eventName}`,
        command,
        timeout,
        description: 'Latchkit workflow bridge; preserves Gemini consent and approvals.',
      },
    ],
  };
}

function validateHookOptions(command, timeout) {
  requiredText(command, 'command');
  if (!Number.isInteger(timeout) || timeout <= 0)
    throw new TypeError('timeout must be a positive integer.');
}

export function mergeGeminiSettings(
  settings,
  { command = 'node .latchkit/gemini-hook.js', timeout = 60000 } = {},
) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new TypeError('Gemini settings must be an object.');
  validateHookOptions(command, timeout);
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? structuredClone(settings.hooks)
      : {};
  for (const eventName of HOOK_EVENTS) {
    const entries = Array.isArray(hooks[eventName]) ? hooks[eventName].slice() : [];
    if (
      !entries.some((entry) => entry?.hooks?.some((hook) => hook?.name === `latchkit-${eventName}`))
    )
      entries.push(ownedHook(eventName, command, timeout));
    hooks[eventName] = entries;
  }
  return { ...structuredClone(settings), hooks };
}

export function removeGeminiSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new TypeError('Gemini settings must be an object.');
  const next = structuredClone(settings);
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const eventName of HOOK_EVENTS) {
    if (!Array.isArray(next.hooks[eventName])) continue;
    next.hooks[eventName] = next.hooks[eventName]
      .map((group) => ({
        ...group,
        hooks: Array.isArray(group.hooks)
          ? group.hooks.filter((hook) => hook?.name !== `latchkit-${eventName}`)
          : group.hooks,
      }))
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length);
    if (!next.hooks[eventName].length) delete next.hooks[eventName];
  }
  return next;
}

export function createGeminiAdapter(options = {}) {
  const { contract } = inspectGemini(options);
  return createProviderAdapter(contract, {
    inspect: () => inspectGemini(options),
    planInstall: ({ settings = {}, command, timeout } = {}) => ({
      resourceId: GEMINI_SETTINGS_RESOURCE_ID,
      path: GEMINI_SETTINGS_PATH,
      bytes: Buffer.from(
        `${JSON.stringify(mergeGeminiSettings(settings, { command, timeout }), null, 2)}\n`,
      ),
    }),
    planSkillExport: ({ skills = [] } = {}) => ({
      provider: 'gemini',
      directory: '.agents/skills',
      skills: [...skills],
    }),
    planRuleExport: ({ rules = [] } = {}) => ({
      provider: 'gemini',
      contextFile: 'GEMINI.md',
      rules: [...rules],
    }),
    planInvocation: planGeminiInvocation,
    planResume: planGeminiResume,
    translateLifecycleInput: translateGeminiHookInput,
    translateLifecycleOutput: translateGeminiHookOutput,
    planUsage: () => ({
      state: 'unknown',
      reason: 'Gemini usage fields are not normalized by this adapter.',
    }),
  });
}

export { HOOK_EVENTS };
