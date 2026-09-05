import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createProviderAdapter } from './contracts.js';

export const CODEX_EVIDENCE = Object.freeze({
  cli: 'https://learn.chatgpt.com/docs/codex/cli',
  agents: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md',
  hooks: 'https://learn.chatgpt.com/docs/hooks',
});

const supported = (reason, url = CODEX_EVIDENCE.hooks, versionRange = '>=0.1.0') => ({
  state: 'supported',
  reason,
  versionRange,
  evidenceUrl: url,
});
const unknown = (reason, url = CODEX_EVIDENCE.hooks) => ({
  state: 'unknown',
  reason,
  versionRange: '*',
  evidenceUrl: url,
});

export const CODEX_EVENTS = Object.freeze({
  SessionStart: 'session-start',
  SessionEnd: 'session-terminated',
  UserPromptSubmit: 'turn-completed',
  PreToolUse: 'turn-completed',
  PostToolUse: 'turn-completed',
  PreCompact: 'interrupted',
  Interrupt: 'interrupted',
  Stop: 'session-terminated',
  SubagentStart: 'turn-completed',
  SubagentStop: 'turn-completed',
});

const hookEvidence = Object.fromEntries(
  Object.keys(CODEX_EVENTS).map((name) => [
    name,
    supported(`Codex documents the ${name} hook event and its JSON input/output contract.`),
  ]),
);

export const CODEX_CONTRACT = Object.freeze({
  schemaVersion: 1,
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  skillDirectory: '.agents/skills',
  capabilities: {
    skills: supported(
      'Codex discovers repository skills from .agents/skills.',
      'https://learn.chatgpt.com/docs/build-skills',
    ),
    invocation: supported(
      'The Codex CLI documents non-interactive execution and JSONL output.',
      CODEX_EVIDENCE.cli,
    ),
    hooks: hookEvidence,
    decisions: {
      blocking: supported('Codex command hooks can return decision:block for supported events.'),
      advisory: supported(
        'Hook output and SessionEnd are advisory where Codex documents them as such.',
      ),
    },
    compaction: supported(
      'PreCompact and SessionStart(source=compact) are documented lifecycle points.',
    ),
    resume: supported('codex resume is a documented CLI operation.', CODEX_EVIDENCE.cli),
    cancellation: supported(
      'Interrupt is a documented hook event; process cancellation remains runner-owned.',
    ),
    usage: unknown('Codex hook payloads do not establish a stable token counter contract.'),
  },
  verification: {
    installed: 'unknown',
    authenticated: 'unknown',
    configured: 'unverified',
    endToEnd: 'unverified',
  },
});

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, limit = 64 * 1024) => {
  const text = JSON.stringify(value ?? {});
  return Buffer.byteLength(text, 'utf8') <= limit ? JSON.parse(text) : { truncated: true };
};
const textVersion = (output) => {
  const match = String(output ?? '').match(/(?:codex\s+)?v?(\d+\.\d+(?:\.\d+)?)/i);
  return match?.[1] ?? null;
};

export function inspectCodexVersion(output) {
  const version = textVersion(output);
  return {
    version,
    state: version ? 'verified' : 'unknown',
    reason: version
      ? 'Version was returned by the bounded version probe.'
      : 'Codex version output was missing or unrecognized.',
  };
}

export function parseCodexHookConfig(raw, source = 'hooks.json') {
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    return { source, valid: false, error: `Invalid JSON: ${error.message}` };
  }
  if (!record(config) || !record(config.hooks))
    return { source, valid: false, error: 'Expected a hooks object.' };
  const handlers = [];
  const unsupported = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) {
      unsupported.push({ event, reason: 'Hook groups must be arrays.' });
      continue;
    }
    for (const group of groups) {
      if (!record(group) || !Array.isArray(group.hooks)) {
        unsupported.push({ event, reason: 'Hook group is malformed.' });
        continue;
      }
      for (const handler of group.hooks) {
        if (!record(handler) || typeof handler.type !== 'string') {
          unsupported.push({ event, reason: 'Handler is malformed.' });
          continue;
        }
        if (handler.type === 'command' || handler.type === 'mcp_tool')
          handlers.push({
            event,
            matcher: group.matcher ?? null,
            type: handler.type,
            async: handler.async === true,
          });
        else
          unsupported.push({
            event,
            type: handler.type,
            reason: 'Codex parses but skips prompt and agent handlers.',
          });
      }
    }
  }
  return { source, valid: true, handlers, unsupported, reviewRequired: handlers.length > 0 };
}

export function buildCodexHookConfig({
  handlerPath,
  events = ['SessionStart', 'SessionEnd'],
  windows = process.platform === 'win32',
} = {}) {
  if (typeof handlerPath !== 'string' || !handlerPath)
    throw new TypeError('handlerPath is required.');
  const hooks = {};
  for (const event of events) {
    if (!CODEX_EVENTS[event]) throw new Error(`Unsupported Codex event: ${event}`);
    const command = `node "${handlerPath}"`;
    hooks[event] = [
      { hooks: [{ type: 'command', command, ...(windows ? { commandWindows: command } : {}) }] },
    ];
  }
  return { description: 'Latchkit-owned handlers; review and trust before enabling.', hooks };
}

export function translateCodexEvent(
  input,
  {
    providerVersion = 'unknown',
    runtime = process.platform,
    correlation,
    eventId,
    timestamp = Date.now(),
  } = {},
) {
  if (!record(input) || typeof input.hook_event_name !== 'string')
    throw new TypeError('Expected a Codex hook event.');
  const kind = CODEX_EVENTS[input.hook_event_name];
  if (!kind || kind === 'session-start') return null;
  return {
    schemaVersion: 1,
    provider: { id: 'codex', version: providerVersion, runtime },
    correlation: correlation ?? {
      projectId: input.cwd ?? 'unknown',
      taskId: input.turn_id ?? input.session_id ?? 'unknown',
      sessionId: input.session_id ?? 'unknown',
    },
    eventId: eventId ?? `${input.session_id ?? 'session'}:${input.hook_event_name}:${timestamp}`,
    timestamp,
    kind,
    payload: bounded({
      hookEventName: input.hook_event_name,
      permissionMode: input.permission_mode,
      reason: input.reason,
      toolName: input.tool_name,
      output: input.output,
    }),
    decisionModes: [
      'advisory',
      ...(input.hook_event_name === 'UserPromptSubmit' || input.hook_event_name === 'Stop'
        ? ['blocking']
        : []),
    ],
  };
}

const noPlan = (reason) => ({ status: 'refused', reason });
const plan = (args, cwd) => ({ executable: 'codex', args, ...(cwd ? { cwd } : {}) });

export const codexAdapter = createProviderAdapter(CODEX_CONTRACT, {
  async inspect({ root, versionOutput } = {}) {
    const files = ['.codex/hooks.json', '.codex/config.toml'];
    const present = [];
    if (root)
      for (const relative of files) {
        try {
          await access(path.join(root, relative));
          present.push(relative);
        } catch {
          /* absent */
        }
      }
    return {
      provider: 'codex',
      version: inspectCodexVersion(versionOutput),
      hookSources: present,
      trust: 'review-required-for-project-hooks',
      authentication: 'unknown',
    };
  },
  planInstall() {
    return noPlan('Codex installation is provider-owned and is never performed by Latchkit.');
  },
  planSkillExport({ root } = {}) {
    return {
      destination: path.join(root ?? '.', '.agents', 'skills'),
      shared: true,
      action: 'export',
    };
  },
  planRuleExport({ root } = {}) {
    return {
      destination: path.join(root ?? '.', 'AGENTS.md'),
      shared: true,
      action: 'owned-section',
    };
  },
  planInvocation({ prompt, cwd } = {}) {
    return plan(['exec', '--json', '--', String(prompt ?? '')], cwd);
  },
  planResume({ sessionId, cwd } = {}) {
    return sessionId
      ? plan(['resume', '--json', '--', String(sessionId)], cwd)
      : noPlan('A session ID is required for resume.');
  },
  translateLifecycleInput(input, options) {
    return translateCodexEvent(input, options);
  },
  translateLifecycleOutput(output) {
    return record(output)
      ? bounded(output)
      : { decision: 'advisory', reason: 'Non-JSON hook output is advisory text.' };
  },
  planUsage() {
    return noPlan('Codex token counters are not a stable adapter capability.');
  },
});

export async function readCodexHookFixture(file) {
  return parseCodexHookConfig(await readFile(file, 'utf8'), file);
}
