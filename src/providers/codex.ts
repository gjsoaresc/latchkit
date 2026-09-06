import { standaloneHookCommand } from '../installation/hooks.js';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createProviderAdapter } from './contracts.js';
import { errorMessage, isRecord } from '../types.js';

interface CodexHookOptions {
  providerVersion?: string;
  runtime?: string;
  correlation?: { projectId: string; taskId: string; sessionId: string };
  eventId?: string;
  timestamp?: number;
}

interface CodexPlanOptions {
  root?: string;
  versionOutput?: unknown;
  prompt?: unknown;
  cwd?: string;
  sandbox?: string;
  approvalPolicy?: string;
  sessionId?: string;
}

export const CODEX_EVIDENCE = Object.freeze({
  cli: 'https://learn.chatgpt.com/docs/codex/cli',
  agents: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md',
  hooks: 'https://learn.chatgpt.com/docs/hooks',
});

const supported = (
  reason: string,
  url: string = CODEX_EVIDENCE.hooks,
  versionRange = '>=0.1.0',
) => ({
  state: 'supported',
  reason,
  versionRange,
  evidenceUrl: url,
});
const unknown = (reason: string, url: string = CODEX_EVIDENCE.hooks) => ({
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

const record = isRecord;
const bounded = (value: unknown, limit = 64 * 1024): unknown => {
  const text = JSON.stringify(value ?? {});
  return Buffer.byteLength(text, 'utf8') <= limit ? JSON.parse(text) : { truncated: true };
};
const textVersion = (output: unknown): string | null => {
  const match = String(output ?? '').match(/(?:codex\s+)?v?(\d+\.\d+(?:\.\d+)?)/i);
  return match?.[1] ?? null;
};

export function inspectCodexVersion(output: unknown) {
  const version = textVersion(output);
  return {
    version,
    state: version ? 'verified' : 'unknown',
    reason: version
      ? 'Version was returned by the bounded version probe.'
      : 'Codex version output was missing or unrecognized.',
  };
}

export function parseCodexHookConfig(raw: string, source = 'hooks.json') {
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    return { source, valid: false, error: `Invalid JSON: ${errorMessage(error)}` };
  }
  if (!record(config) || !record(config.hooks))
    return { source, valid: false, error: 'Expected a hooks object.' };
  const handlers: Array<{ event: string; matcher: unknown; type: string; async: boolean }> = [];
  const unsupported: Array<{ event: string; type?: string; reason: string }> = [];
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
}: { handlerPath?: string; events?: readonly string[]; windows?: boolean } = {}) {
  if (typeof handlerPath !== 'string' || !handlerPath)
    throw new TypeError('handlerPath is required.');
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    if (!CODEX_EVENTS[event as keyof typeof CODEX_EVENTS])
      throw new Error(`Unsupported Codex event: ${event}`);
    const command =
      standaloneHookCommand('codex', [], {
        scriptPath: handlerPath,
        platform: windows ? 'win32' : process.platform,
      }) ?? `node "${handlerPath}"`;
    hooks[event] = [
      { hooks: [{ type: 'command', command, ...(windows ? { commandWindows: command } : {}) }] },
    ];
  }
  return { description: 'Latchkit-owned handlers; review and trust before enabling.', hooks };
}

export function translateCodexEvent(
  input: unknown,
  {
    providerVersion = 'unknown',
    runtime = process.platform,
    correlation,
    eventId,
    timestamp = Date.now(),
  }: CodexHookOptions = {},
) {
  if (!record(input) || typeof input.hook_event_name !== 'string')
    throw new TypeError('Expected a Codex hook event.');
  const kind = CODEX_EVENTS[input.hook_event_name as keyof typeof CODEX_EVENTS];
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

const noPlan = (reason: string) => ({ status: 'refused', reason });
const plan = (args: string[], cwd?: string) => ({
  executable: 'codex',
  args,
  ...(cwd ? { cwd } : {}),
});
const codexSandbox = (value = 'read-only'): string => {
  if (!['read-only', 'workspace-write'].includes(value))
    throw new Error('Codex sandbox must be read-only or workspace-write.');
  return value;
};
const codexApprovalPolicy = (value = 'on-request'): string => {
  if (!['on-request', 'never'].includes(value))
    throw new Error('Codex approval policy must be on-request or never.');
  return value;
};

export const codexAdapter = createProviderAdapter(CODEX_CONTRACT, {
  async inspect({ root, versionOutput }: CodexPlanOptions = {}) {
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
  planSkillExport({ root }: CodexPlanOptions = {}) {
    return {
      destination: path.join(root ?? '.', '.agents', 'skills'),
      shared: true,
      action: 'export',
    };
  },
  planRuleExport({ root }: CodexPlanOptions = {}) {
    return {
      destination: path.join(root ?? '.', 'AGENTS.md'),
      shared: true,
      action: 'owned-section',
    };
  },
  planInvocation({ prompt, cwd, sandbox, approvalPolicy }: CodexPlanOptions = {}) {
    return plan(
      [
        '--ask-for-approval',
        codexApprovalPolicy(approvalPolicy),
        'exec',
        '--sandbox',
        codexSandbox(sandbox),
        '--json',
        '--',
        String(prompt ?? ''),
      ],
      cwd,
    );
  },
  planResume({ sessionId, prompt, cwd, sandbox, approvalPolicy }: CodexPlanOptions = {}) {
    return sessionId
      ? plan(
          [
            '--ask-for-approval',
            codexApprovalPolicy(approvalPolicy),
            'exec',
            '--sandbox',
            codexSandbox(sandbox),
            'resume',
            '--json',
            '--',
            String(sessionId),
            String(prompt ?? ''),
          ],
          cwd,
        )
      : noPlan('A session ID is required for resume.');
  },
  translateLifecycleInput(input: unknown, options: CodexHookOptions = {}) {
    return translateCodexEvent(input, options);
  },
  translateLifecycleOutput(output: unknown) {
    return record(output)
      ? bounded(output)
      : { decision: 'advisory', reason: 'Non-JSON hook output is advisory text.' };
  },
  planUsage() {
    return noPlan('Codex token counters are not a stable adapter capability.');
  },
});

export async function readCodexHookFixture(file: string) {
  return parseCodexHookConfig(await readFile(file, 'utf8'), file);
}
