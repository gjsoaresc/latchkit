import { createHash } from 'node:crypto';
import os from 'node:os';
import {
  ADAPTER_OPERATIONS,
  PROVIDER_CONTRACT_VERSION,
  createProviderAdapter,
  validateCommandPlan,
} from './contracts.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';

export const CLAUDE_EVIDENCE_URLS = Object.freeze({
  setup: 'https://code.claude.com/docs/en/setup',
  cli: 'https://code.claude.com/docs/en/cli-usage',
  hooks: 'https://code.claude.com/docs/en/hooks',
  skills: 'https://code.claude.com/docs/en/skills',
});

export const CLAUDE_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'Stop',
]);

const BLOCKING_EVENTS = new Set(['PreToolUse', 'PreCompact', 'Stop', 'UserPromptSubmit']);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${name} must be non-empty text.`);
  return value;
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function versionParts(version) {
  const match = String(version)
    .trim()
    .match(/(?:v)?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function atLeast(version, major, minor = 0) {
  const parts = versionParts(version);
  return Boolean(parts && (parts[0] > major || (parts[0] === major && parts[1] >= minor)));
}

const unknown = (reason, evidenceUrl = CLAUDE_EVIDENCE_URLS.cli) => ({
  state: 'unknown',
  reason,
  versionRange: '*',
  evidenceUrl,
});
const supported = (reason, versionRange, evidenceUrl) => ({
  state: 'supported',
  reason,
  versionRange,
  evidenceUrl,
});

function contractFor(version, installed = 'verified') {
  const directHooks = atLeast(version, 1, 0);
  return {
    schemaVersion: PROVIDER_CONTRACT_VERSION,
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    skillDirectory: '.claude/skills',
    capabilities: {
      skills: supported(
        'Project skills are documented and exportable.',
        '*',
        CLAUDE_EVIDENCE_URLS.skills,
      ),
      invocation: directHooks
        ? supported(
            'Print mode, JSON input/output, and bounded session execution are documented for this installed version.',
            '>=1.0.0',
            CLAUDE_EVIDENCE_URLS.cli,
          )
        : unknown(
            'The installed Claude Code version could not be matched to documented invocation flags.',
          ),
      hooks: Object.fromEntries(
        CLAUDE_HOOK_EVENTS.map((event) => [
          event,
          directHooks
            ? supported(
                `${event} command hooks are documented for project settings.`,
                '>=1.0.0',
                CLAUDE_EVIDENCE_URLS.hooks,
              )
            : unknown(
                `No documented ${event} hook contract was verified for this version.`,
                CLAUDE_EVIDENCE_URLS.hooks,
              ),
        ]),
      ),
      decisions: {
        blocking: directHooks
          ? supported(
              'Blocking is available only for documented blocking hook events and remains subject to Claude permission policy.',
              '>=1.0.0',
              CLAUDE_EVIDENCE_URLS.hooks,
            )
          : unknown(
              'Blocking hook semantics were not verified for this version.',
              CLAUDE_EVIDENCE_URLS.hooks,
            ),
        advisory: directHooks
          ? supported(
              'Observational and advisory hook responses are documented.',
              '>=1.0.0',
              CLAUDE_EVIDENCE_URLS.hooks,
            )
          : unknown(
              'Advisory hook semantics were not verified for this version.',
              CLAUDE_EVIDENCE_URLS.hooks,
            ),
      },
      compaction: directHooks
        ? supported('PreCompact is a documented hook event.', '>=1.0.0', CLAUDE_EVIDENCE_URLS.hooks)
        : unknown('Compaction hook support is unknown.', CLAUDE_EVIDENCE_URLS.hooks),
      resume: directHooks
        ? supported(
            'The CLI documents --resume by session ID or name.',
            '>=1.0.0',
            CLAUDE_EVIDENCE_URLS.cli,
          )
        : unknown('Resume flags were not verified for this version.'),
      cancellation: supported(
        'Cancellation is owned by the bounded process runner; this does not change Claude permissions.',
        '>=1.0.0',
        CLAUDE_EVIDENCE_URLS.cli,
      ),
      usage: unknown('Claude usage reporting is not exposed by this adapter.'),
    },
    verification: {
      installed,
      authenticated: 'unknown',
      configured: 'unverified',
      endToEnd: 'unverified',
    },
  };
}

export const CLAUDE_CONTRACT = Object.freeze(contractFor('1.0.0'));

/** Run only `claude --version`; the caller supplies an authorized runner. */
export async function inspectClaude({
  runner = runProviderProcess,
  executable = 'claude',
  cwd,
  environment,
  signal,
} = {}) {
  if (typeof runner !== 'function')
    throw new TypeError('inspectClaude requires a runner function.');
  const probe = contractFor('1.0.0', 'unverified');
  const result = await runner({
    provider: probe,
    plan: {
      executable,
      args: ['--version'],
      ...(cwd ? { cwd } : {}),
      ...(environment ? { environment } : {}),
    },
    executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
    ...(signal ? { signal } : {}),
  });
  const versionMatch =
    result?.status === 'exited' && result.exitCode === 0
      ? String(result.stdout ?? '').match(/\d+(?:\.\d+){0,2}/)
      : null;
  if (!versionMatch)
    return {
      contract: contractFor('0.0.0', 'unverified'),
      detected: false,
      result: redactProbe(result),
    };
  return {
    contract: contractFor(versionMatch[0]),
    detected: true,
    version: versionMatch[0],
    result: redactProbe(result),
  };
}

const redactProbe = (result) =>
  result && {
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    outputBytes: result.outputBytes,
  };

export function planClaudeInvocation({
  executable = 'claude',
  prompt,
  cwd,
  sessionId,
  version,
} = {}) {
  text(prompt, 'prompt');
  const args = ['-p', prompt, '--output-format', 'json'];
  if (sessionId !== undefined) args.push('--resume', text(sessionId, 'sessionId'));
  if (version !== undefined && !atLeast(version, 1))
    throw new Error('Claude version does not have verified invocation flags.');
  return validateCommandPlan({ executable, args, ...(cwd ? { cwd } : {}) });
}

export function planClaudeResume({ executable = 'claude', sessionId, cwd } = {}) {
  return validateCommandPlan({
    executable,
    args: ['--resume', text(sessionId, 'sessionId')],
    ...(cwd ? { cwd } : {}),
  });
}

const shellQuote = (value, platform) => {
  text(value, 'hook argument');
  if (platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
};

export function serializeNodeHookCommand({
  nodeExecutable = process.execPath,
  scriptPath,
  event,
  platform = process.platform,
  directExecutionSupported = true,
} = {}) {
  text(scriptPath, 'scriptPath');
  text(event, 'event');
  const args = [nodeExecutable, scriptPath, '--event', event];
  if (directExecutionSupported) return args.map((arg) => shellQuote(arg, platform)).join(' ');
  if (platform === 'win32') {
    const command = args.map((arg) => shellQuote(arg, 'win32')).join(' ');
    return `powershell.exe -NoProfile -NonInteractive -Command & ${command}`;
  }
  return `sh -c ${shellQuote(args.map((arg) => shellQuote(arg, 'posix')).join(' '), 'posix')}`;
}

function hookEntry(command, timeout = 30) {
  return { type: 'command', command, timeout };
}

/** Pure settings serializer. `owned` contains hashes from the last applied plan. */
export function planClaudeSettings({
  current = null,
  handlers = {},
  owned = {},
  remove = false,
} = {}) {
  let settings = {};
  if (current !== null) {
    if (typeof current !== 'string') throw new TypeError('settings must be text.');
    try {
      settings = JSON.parse(current);
    } catch (error) {
      throw new Error(`Claude settings are invalid JSON: ${error.message}`);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('Claude settings must be a JSON object.');
  }
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? structuredClone(settings.hooks)
      : {};
  const newline = current?.includes('\r\n') ? '\r\n' : '\n';
  const conflicts = [];
  const nextOwned = {};
  for (const event of Object.keys(handlers)) {
    if (!CLAUDE_HOOK_EVENTS.includes(event))
      throw new Error(`Unsupported Claude hook event: ${event}`);
    const desired = handlers[event];
    if (typeof desired !== 'string')
      throw new TypeError(`Handler for ${event} must be a command string.`);
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const previous = owned[event] ?? [];
    for (const [index, group] of groups.entries()) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        conflicts.push({ event, reason: `Hook group ${index} has an unsupported shape.` });
        continue;
      }
      for (const handler of group.hooks) {
        if (
          handler?.type === 'command' &&
          handler.command === desired &&
          !previous.some((item) => item.command === desired)
        )
          conflicts.push({
            event,
            reason: 'A user-owned hook collides with the generated command.',
          });
      }
    }
    const generated = hookEntry(desired);
    const match = previous.find((item) => item.command === desired);
    if (
      match &&
      groups.some((group) =>
        group.hooks.some(
          (handler) =>
            handler?.type === 'command' &&
            handler.command === desired &&
            sha256(JSON.stringify(handler)) !== match.sha256,
        ),
      )
    ) {
      conflicts.push({ event, reason: 'A generated Claude hook was edited outside Latchkit.' });
      continue;
    }
    if (remove) {
      hooks[event] = groups
        .map((group) => ({
          ...group,
          hooks: group.hooks.filter(
            (handler) =>
              !(
                handler?.type === 'command' &&
                handler.command === desired &&
                (!match || sha256(JSON.stringify(handler)) === match.sha256)
              ),
          ),
        }))
        .filter((group) => group.hooks.length);
    } else {
      const retained = groups.filter(
        (group) =>
          !group.hooks.some(
            (handler) => handler?.type === 'command' && handler.command === desired,
          ),
      );
      hooks[event] = [...retained, { matcher: '', hooks: [generated] }];
      nextOwned[event] = [{ command: desired, sha256: sha256(JSON.stringify(generated)) }];
    }
    if (!hooks[event]?.length) delete hooks[event];
  }
  if (conflicts.length)
    return { status: 'conflict', conflicts, bytes: null, backup: null, owned: nextOwned };
  const next = { ...settings, ...(Object.keys(hooks).length ? { hooks } : {}) };
  if (!Object.keys(hooks).length) delete next.hooks;
  const bytes = `${JSON.stringify(next, null, 2).replaceAll('\n', newline)}${newline}`;
  return {
    status: bytes === (current ?? '') ? 'unchanged' : 'planned',
    conflicts: [],
    bytes,
    backup:
      current === null || bytes === current
        ? null
        : { bytes: current, protected: true, sha256: sha256(current) },
    owned: nextOwned,
  };
}

function lifecycleEnvelope({
  eventName,
  input,
  version = 'unknown',
  projectId,
  taskId,
  sessionId,
  now = Date.now,
}) {
  const kind =
    eventName === 'SessionEnd'
      ? 'session-terminated'
      : eventName === 'Stop'
        ? 'turn-completed'
        : eventName === 'PreCompact'
          ? 'interrupted'
          : null;
  if (!kind) return { status: 'observed', eventName, payload: input };
  const correlation = {
    projectId: text(projectId ?? input.cwd ?? 'unknown-project', 'projectId'),
    taskId: text(taskId ?? input.task_id ?? input.session_id ?? 'unknown-task', 'taskId'),
    sessionId: text(sessionId ?? input.session_id ?? 'unknown-session', 'sessionId'),
  };
  return {
    schemaVersion: 1,
    provider: {
      id: 'claude',
      version: text(version, 'version'),
      runtime: `${process.platform}-${os.arch()}`,
    },
    correlation,
    eventId: `${correlation.sessionId}:${eventName}:${input.timestamp ?? now()}`,
    timestamp: Number.isInteger(input.timestamp) ? input.timestamp : now(),
    kind,
    payload: input,
    decisionModes: BLOCKING_EVENTS.has(eventName) ? ['blocking', 'advisory'] : ['advisory'],
  };
}

export function translateClaudeLifecycleInput(input, { eventName, ...options } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Claude hook input must be an object.');
  const name = eventName ?? input.hook_event_name;
  if (!CLAUDE_HOOK_EVENTS.includes(name))
    throw new Error(`Unsupported or missing Claude hook event: ${name ?? 'unknown'}.`);
  return lifecycleEnvelope({ eventName: name, input: structuredClone(input), ...options });
}

export function translateClaudeLifecycleOutput({ eventName, response } = {}) {
  if (!CLAUDE_HOOK_EVENTS.includes(eventName))
    throw new Error(`Unsupported Claude hook event: ${eventName}.`);
  if (response === undefined || response === null) return {};
  if (typeof response !== 'object' || Array.isArray(response))
    throw new TypeError('Normalized hook response must be an object.');
  const reason =
    response.reason === undefined
      ? 'Latchkit handler blocked this action.'
      : text(response.reason, 'reason');
  if (response.decision === 'block') {
    if (!BLOCKING_EVENTS.has(eventName)) return {};
    if (eventName === 'PreToolUse')
      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    return { decision: 'block', reason };
  }
  if (response.decision === 'allow' && eventName === 'PreToolUse')
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: 'allow',
        permissionDecisionReason: reason,
      },
    };
  if (response.additionalContext !== undefined)
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: text(response.additionalContext, 'additionalContext'),
      },
    };
  if (response.decision !== undefined)
    throw new Error(`Unsupported ${eventName} decision: ${response.decision}.`);
  return {};
}

const operations = {
  inspect: inspectClaude,
  planInstall: (options = {}) => planClaudeSettings(options),
  planSkillExport: (options = {}) => options,
  planRuleExport: (options = {}) => options,
  planInvocation: planClaudeInvocation,
  planResume: planClaudeResume,
  translateLifecycleInput: translateClaudeLifecycleInput,
  translateLifecycleOutput: translateClaudeLifecycleOutput,
  planUsage: () => ({
    status: 'unknown',
    reason: 'Claude usage reporting is not exposed by this adapter.',
  }),
};

export const CLAUDE_ADAPTER = createProviderAdapter(CLAUDE_CONTRACT, operations);
export { ADAPTER_OPERATIONS };
