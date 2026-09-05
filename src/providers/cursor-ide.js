import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_ENVELOPE_VERSION,
  PROVIDER_CONTRACT_VERSION,
  ProviderContractError,
  createProviderAdapter,
  validateLifecycleEnvelope,
  validateProviderContract,
} from './contracts.js';
import { planProviderExports } from '../rules/exporters.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  inspectTransaction,
  recoverTransaction,
} from '../installer/transactions.js';
import { readOptional, resolveProjectRoot } from '../storage.js';
import { quoteWindowsCommandArgument } from '../runtime/process-runner.js';
import { inspectProjectLock, removeProvenStaleLock, withProjectLock } from '../installer/lock.js';

const DOCS = 'https://cursor.com/docs/hooks';
const SKILLS_DOCS = 'https://cursor.com/docs/skills';
export const CURSOR_IDE_HOOKS_PATH = '.cursor/hooks.json';
export const CURSOR_IDE_HANDLER_PATH = '.latchkit/providers/cursor-ide/hook-handler.cjs';
export const CURSOR_IDE_STATE_PATH = '.latchkit/providers/cursor-ide/ownership.json';
export const CURSOR_IDE_AGENT_EVENTS = Object.freeze([
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'preCompact',
  'stop',
]);
export const CURSOR_IDE_NON_AGENT_EVENTS = Object.freeze([
  'beforeTabFileRead',
  'afterTabFileEdit',
  'workspaceOpen',
]);

const evidence = (state, reason, evidenceUrl = DOCS, versionRange = 'documented-current') => ({
  state,
  reason,
  versionRange,
  evidenceUrl,
});

export const CURSOR_IDE_CONTRACT = validateProviderContract({
  schemaVersion: PROVIDER_CONTRACT_VERSION,
  id: 'cursor',
  label: 'Cursor IDE',
  command: 'cursor',
  skillDirectory: '.agents/skills',
  capabilities: {
    skills: evidence('supported', 'Cursor documents project skill discovery.', SKILLS_DOCS),
    invocation: evidence(
      'unsupported',
      'The IDE has no documented non-interactive Agent session invocation contract.',
    ),
    hooks: Object.fromEntries(
      CURSOR_IDE_AGENT_EVENTS.map((name) => [
        name,
        evidence('supported', `Cursor documents the ${name} Agent hook.`),
      ]),
    ),
    decisions: {
      blocking: evidence(
        'partial',
        'Only documented pre-action and stop responses can affect an Agent; hook failures are fail-open unless the user independently chooses failClosed.',
      ),
      advisory: evidence(
        'supported',
        'Command hooks can observe Agent events without blocking them.',
      ),
    },
    compaction: evidence('supported', 'Cursor documents the preCompact Agent hook.'),
    resume: evidence('unsupported', 'No official editor resume command contract is documented.'),
    cancellation: evidence(
      'unsupported',
      'Cancellation remains a manual editor action; opening Cursor is not a controllable Agent session.',
    ),
    usage: evidence('unsupported', 'No official project hook exposes authoritative usage totals.'),
  },
  verification: {
    installed: 'unknown',
    authenticated: 'unknown',
    configured: 'unverified',
    endToEnd: 'unverified',
  },
});

const digest = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaque = (value, field) => {
  if (typeof value !== 'string' || !value || value.length > 1024)
    throw new ProviderContractError(`Expected bounded opaque ${field}.`, `$.${field}`);
  return value;
};

function defaultEditorCandidates(platform, env) {
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Cursor', 'Cursor.exe'),
      env.PROGRAMFILES && path.win32.join(env.PROGRAMFILES, 'Cursor', 'Cursor.exe'),
    ].filter(Boolean);
  }
  if (platform === 'darwin') return ['/Applications/Cursor.app/Contents/MacOS/Cursor'];
  return ['/usr/bin/cursor', '/usr/local/bin/cursor', '/opt/Cursor/cursor'];
}

function launcherCandidates(platform, env) {
  const suffixes = platform === 'win32' ? ['', '.cmd', '.exe'] : [''];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return (env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .flatMap((directory) => suffixes.map((suffix) => pathApi.join(directory, `cursor${suffix}`)));
}

async function firstAccessible(candidates, io) {
  for (const candidate of candidates) {
    try {
      await io.access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  return null;
}

async function metadataVersion(editorPath, platform, io) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const candidates =
    platform === 'darwin'
      ? [pathApi.join(pathApi.dirname(editorPath), '..', 'Resources', 'app', 'product.json')]
      : [
          pathApi.join(pathApi.dirname(editorPath), 'resources', 'app', 'product.json'),
          pathApi.join(pathApi.dirname(editorPath), 'resources', 'app', 'package.json'),
        ];
  for (const filename of candidates) {
    try {
      const parsed = JSON.parse(await io.readFile(filename, 'utf8'));
      const version = parsed.cursorVersion ?? parsed.version;
      if (typeof version === 'string' && version) return { version, source: filename };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code) && !(error instanceof SyntaxError))
        throw error;
    }
  }
  return { version: null, source: null };
}

/** Inspect files only. It never launches the editor or a provider session. */
export async function inspectCursorIde(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const io = options.io ?? { access, readFile };
  const editorPath = await firstAccessible(
    options.editorCandidates ?? defaultEditorCandidates(platform, env),
    io,
  );
  const launcherPath = await firstAccessible(
    options.launcherCandidates ?? launcherCandidates(platform, env),
    io,
  );
  const metadata = editorPath
    ? await metadataVersion(editorPath, platform, io)
    : { version: null, source: null };
  let configuration = { state: 'unverified', reason: 'No project integration evidence supplied.' };
  if (options.root) {
    const root = await resolveProjectRoot(options.root);
    try {
      const state = JSON.parse((await readOptional(root, CURSOR_IDE_STATE_PATH)) ?? 'null');
      const hooks = JSON.parse((await readOptional(root, CURSOR_IDE_HOOKS_PATH)) ?? 'null');
      const handler = await readOptional(root, CURSOR_IDE_HANDLER_PATH);
      const intact =
        isRecord(state) &&
        isRecord(hooks) &&
        typeof handler === 'string' &&
        digest(handler) === state.handlerSha256 &&
        Object.entries(state.entries ?? {}).every(([event, ownedHash]) =>
          hooks.hooks?.[event]?.some((entry) => digest(JSON.stringify(entry)) === ownedHash),
        );
      configuration = intact
        ? { state: 'verified', reason: 'Owned project hook entries and handler match.' }
        : { state: 'unverified', reason: 'Owned project hook evidence is absent or incomplete.' };
    } catch (error) {
      configuration = {
        state: 'unverified',
        reason: `Project integration is invalid: ${error.message}`,
      };
    }
  } else if (options.integrationConfigured === true) {
    configuration = { state: 'verified', reason: 'Configuration evidence was user-supplied.' };
  }
  const sessionObserved = typeof options.observedSessionId === 'string';
  return {
    installed: { state: editorPath ? 'verified' : 'unknown', path: editorPath },
    launcherAvailable: { state: launcherPath ? 'verified' : 'unverified', path: launcherPath },
    version: metadata.version,
    versionSource: metadata.source,
    integrationConfigured: configuration,
    hookExecution: {
      state:
        options.trustedWorkspace === false ||
        options.hooksEnabled === false ||
        options.managedPolicyAllowed === false
          ? 'unverified'
          : 'unknown',
      reason:
        options.trustedWorkspace === false
          ? 'The workspace is not trusted.'
          : options.hooksEnabled === false
            ? 'Cursor hooks are disabled.'
            : options.managedPolicyAllowed === false
              ? 'Managed policy does not allow project hooks.'
              : 'Runtime hook enablement requires editor observation.',
    },
    sessionObserved: {
      state: sessionObserved ? 'verified' : 'unverified',
      correlation: sessionObserved ? opaque(options.observedSessionId, 'observedSessionId') : null,
      evidence: sessionObserved ? 'user-supplied' : 'none',
    },
    authenticated: { state: 'unknown', reason: 'Latchkit does not inspect Cursor credentials.' },
    endToEnd: {
      state: 'unverified',
      reason: 'Filesystem detection and hook configuration do not prove an Agent session.',
    },
  };
}

function quoteCommandToken(value, platform = process.platform) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Unsafe Cursor hook command token.');
  if (platform === 'win32') return quoteWindowsCommandArgument(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cursorIdeHookCommand(
  nodeExecutable = process.execPath,
  platform = process.platform,
) {
  return `${quoteCommandToken(nodeExecutable, platform)} ${quoteCommandToken(CURSOR_IDE_HANDLER_PATH, platform)}`;
}

const managedEntry = (command) => ({ command, timeout: 10 });

export function mergeCursorIdeHooks(raw, command) {
  let document = {};
  if (raw !== null) {
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid ${CURSOR_IDE_HOOKS_PATH}: ${error.message}`);
    }
  }
  if (!isRecord(document)) throw new Error(`${CURSOR_IDE_HOOKS_PATH} must contain an object.`);
  if (document.hooks !== undefined && !isRecord(document.hooks))
    throw new Error(`${CURSOR_IDE_HOOKS_PATH}.hooks must contain an object.`);
  const next = clone(document);
  if (next.version === undefined) next.version = 1;
  if (next.version !== 1) throw new Error('Unsupported Cursor hooks configuration version.');
  next.hooks ??= {};
  for (const event of CURSOR_IDE_AGENT_EVENTS) {
    const entries = next.hooks[event] ?? [];
    if (!Array.isArray(entries)) throw new Error(`Cursor hook ${event} must be an array.`);
    const expected = digest(JSON.stringify(managedEntry(command)));
    if (!entries.some((entry) => isRecord(entry) && digest(JSON.stringify(entry)) === expected))
      entries.push(managedEntry(command));
    next.hooks[event] = entries;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

function removeCursorIdeHooks(raw, state) {
  if (raw === null) return null;
  const document = JSON.parse(raw);
  const next = clone(document);
  for (const [event, ownedHash] of Object.entries(state.entries)) {
    const entries = next.hooks?.[event];
    if (!Array.isArray(entries)) throw new Error(`Owned Cursor hook ${event} is missing.`);
    const index = entries.findIndex((entry) => digest(JSON.stringify(entry)) === ownedHash);
    if (index < 0) throw new Error(`Owned Cursor hook ${event} has local edits or is missing.`);
    entries.splice(index, 1);
    if (!entries.length) delete next.hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  if (Object.keys(next).length === 1 && next.version === 1) return null;
  return `${JSON.stringify(next, null, 2)}\n`;
}

function ownershipFor(command, handlerBytes) {
  return {
    schemaVersion: 1,
    command,
    handlerSha256: digest(handlerBytes),
    entries: Object.fromEntries(
      CURSOR_IDE_AGENT_EVENTS.map((event) => [
        event,
        digest(JSON.stringify(managedEntry(command))),
      ]),
    ),
  };
}

async function handlerSource() {
  return readFile(fileURLToPath(new URL('./cursor-ide-hook.cjs', import.meta.url)), 'utf8');
}

/** Build exact bytes and registered resources without writing them. */
export async function planCursorIdeHookExport(root, options = {}) {
  root = await resolveProjectRoot(root);
  const enabled = options.enabled === true;
  const currentHooks = await readOptional(root, CURSOR_IDE_HOOKS_PATH);
  const currentHandler = await readOptional(root, CURSOR_IDE_HANDLER_PATH);
  const currentStateRaw = await readOptional(root, CURSOR_IDE_STATE_PATH);
  let currentState = null;
  if (currentStateRaw !== null) {
    try {
      currentState = JSON.parse(currentStateRaw);
    } catch (error) {
      throw new Error(`Invalid Cursor IDE ownership record: ${error.message}`);
    }
  }
  if (!enabled && !currentState)
    return { changes: [], configured: false, instructions: cursorActivationInstructions() };

  const source = await handlerSource();
  if (currentState) {
    if (currentHandler === null || digest(currentHandler) !== currentState.handlerSha256)
      throw new Error('Owned Cursor IDE handler has local edits or is missing.');
    for (const [event, ownedHash] of Object.entries(currentState.entries ?? {})) {
      const document = currentHooks === null ? null : JSON.parse(currentHooks);
      const entries = document?.hooks?.[event];
      if (
        !Array.isArray(entries) ||
        !entries.some((entry) => digest(JSON.stringify(entry)) === ownedHash)
      )
        throw new Error(`Owned Cursor hook ${event} has local edits or is missing.`);
    }
  }

  let nextHooks;
  let nextHandler;
  let nextState;
  if (enabled) {
    const command = cursorIdeHookCommand(options.nodeExecutable, options.platform);
    nextHooks = currentState
      ? currentState.command === command
        ? currentHooks
        : mergeCursorIdeHooks(removeCursorIdeHooks(currentHooks, currentState), command)
      : mergeCursorIdeHooks(currentHooks, command);
    nextHandler = source;
    nextState = `${JSON.stringify(ownershipFor(command, source), null, 2)}\n`;
  } else {
    nextHooks = removeCursorIdeHooks(currentHooks, currentState);
    nextHandler = null;
    nextState = null;
  }
  const values = [
    [CURSOR_IDE_HOOKS_PATH, currentHooks, nextHooks],
    [CURSOR_IDE_HANDLER_PATH, currentHandler, nextHandler],
    [CURSOR_IDE_STATE_PATH, currentStateRaw, nextState],
  ];
  return {
    configured: enabled,
    instructions: cursorActivationInstructions(),
    backup:
      currentHooks !== null && nextHooks !== currentHooks
        ? { bytes: currentHooks, protected: true, sha256: digest(currentHooks) }
        : null,
    warnings: [
      ...(options.trustedWorkspace === false
        ? ['Cursor will not execute project hooks until the workspace is trusted.']
        : []),
      ...(options.hooksEnabled === false ? ['Cursor hooks are currently disabled.'] : []),
      ...(options.managedPolicyAllowed === false
        ? ['Managed policy may prevent the project hooks from running.']
        : []),
    ],
    changes: values
      .filter(([, before, after]) => before !== after)
      .map(([resourcePath, before, after]) => ({
        resourceId: `provider:cursor-ide:${resourcePath}`,
        path: resourcePath,
        action: after === null ? 'remove' : before === null ? 'create' : 'update',
        bytes: after,
      })),
  };
}

/** Apply an explicitly enabled/disabled plan through the crash-recoverable transaction engine. */
export async function applyCursorIdeHookExport(root, options = {}) {
  root = await resolveProjectRoot(root);
  return withProjectLock(root, async () => {
    const plan = await planCursorIdeHookExport(root, options);
    if (!plan.changes.length) return plan;
    const registry = cursorIdeResourceRegistry();
    const manifest =
      (await readOptional(root, '.latchkit/manifest.json')) ??
      `${JSON.stringify({ schemaVersion: 3, files: {}, packs: [], sections: {} }, null, 2)}\n`;
    await applyRegisteredTransaction(root, {
      operation: options.enabled === true ? 'cursor-ide-enable' : 'cursor-ide-disable',
      registry,
      changes: plan.changes.map(({ resourceId, bytes }) => ({ resourceId, bytes })),
      manifest,
      faultBoundary: options.faultBoundary,
    });
    return plan;
  });
}

export function cursorIdeResourceRegistry() {
  return createResourceRegistry(
    [CURSOR_IDE_HOOKS_PATH, CURSOR_IDE_HANDLER_PATH, CURSOR_IDE_STATE_PATH].map((resourcePath) => ({
      id: `provider:cursor-ide:${resourcePath}`,
      path: resourcePath,
    })),
  );
}

export async function inspectCursorIdeRecovery(root) {
  root = await resolveProjectRoot(root);
  return {
    ...(await inspectTransaction(root, cursorIdeResourceRegistry())),
    lock: await inspectProjectLock(root),
  };
}

export async function recoverCursorIdeIntegration(root) {
  root = await resolveProjectRoot(root);
  const lock = await inspectProjectLock(root);
  if (lock.state === 'live' || lock.state === 'invalid')
    throw new Error(
      lock.state === 'live'
        ? 'A live Latchkit operation owns the project lock.'
        : `Cursor IDE recovery is blocked: ${lock.reason}`,
    );
  if (lock.state === 'stale') await removeProvenStaleLock(root, lock);
  return recoverTransaction(root, cursorIdeResourceRegistry());
}

export function cursorActivationInstructions() {
  return {
    skills:
      'Cursor shares .agents/skills. Open Settings > Rules, inspect the available skills, and reload the window if a newly synchronized skill is not shown.',
    rules: 'Review project rules in Settings > Rules; .cursor/rules/*.mdc remains scope-aware.',
    hooks:
      'Trust the workspace, review .cursor/hooks.json, and ensure hooks are enabled by local or managed policy. Cursor watches the file; reload the window if status remains unverified.',
    session:
      'Start Agent Chat manually. Opening a folder or running the cursor launcher does not start a controllable Agent session.',
  };
}

function normalizeInput(input, context = {}) {
  if (!isRecord(input)) throw new ProviderContractError('Expected Cursor hook payload.');
  const event = input.hook_event_name;
  if (CURSOR_IDE_NON_AGENT_EVENTS.includes(event))
    return {
      accepted: false,
      source: event === 'workspaceOpen' ? 'workspace' : 'tab',
      reason: `${event} is not an Agent task-progress event.`,
    };
  if (!CURSOR_IDE_AGENT_EVENTS.includes(event))
    throw new ProviderContractError('Unsupported Cursor IDE hook event.', '$.hook_event_name');
  const sessionId = opaque(input.conversation_id, 'conversation_id');
  const eventId = opaque(
    context.eventId ??
      `${event}:${input.generation_id ?? sessionId}:${digest(JSON.stringify(input))}`,
    'eventId',
  );
  const correlation = {
    projectId: opaque(context.projectId, 'projectId'),
    taskId: opaque(context.taskId, 'taskId'),
    sessionId,
  };
  const payload = {
    source: 'agent',
    cursorEvent: event,
    generationId: typeof input.generation_id === 'string' ? input.generation_id : null,
    toolName: typeof input.tool_name === 'string' ? input.tool_name : null,
    status: typeof input.status === 'string' ? input.status : null,
  };
  const kinds = { sessionEnd: 'session-terminated', stop: 'turn-completed' };
  const envelope = kinds[event]
    ? validateLifecycleEnvelope({
        schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
        provider: {
          id: 'cursor',
          version: opaque(input.cursor_version ?? 'unknown', 'cursor_version'),
          runtime: 'ide',
        },
        correlation,
        eventId,
        timestamp: context.timestamp ?? Date.now(),
        kind: kinds[event],
        payload,
        decisionModes: ['advisory'],
      })
    : null;
  return {
    accepted: true,
    source: 'agent',
    event,
    correlation,
    observation: payload,
    envelope,
  };
}

export function translateCursorIdeLifecycleOutput(event, result = {}) {
  if (!CURSOR_IDE_AGENT_EVENTS.includes(event))
    throw new ProviderContractError('Unsupported Cursor IDE hook event.', '$.event');
  if (result.decision === undefined || result.decision === 'advisory') return {};
  if (result.decision === 'deny' && ['preToolUse'].includes(event)) {
    return {
      permission: 'deny',
      user_message: String(result.reason ?? 'Blocked by the configured project policy.'),
      agent_message: String(result.reason ?? 'The configured project policy denied this tool.'),
    };
  }
  if (result.decision === 'continue' && event === 'stop')
    return { followup_message: String(result.reason ?? 'Continue the task.') };
  throw new ProviderContractError(
    'Decision is not supported for this Cursor IDE event.',
    '$.result',
  );
}

const unsupportedPlan = (capability, reason) => ({
  capability,
  supported: false,
  manual: true,
  reason,
  command: null,
});

export const cursorIdeAdapter = createProviderAdapter(CURSOR_IDE_CONTRACT, {
  inspect: inspectCursorIde,
  planInstall: () => ({
    supported: false,
    manual: true,
    reason:
      'Install Cursor IDE through an official platform installer; Latchkit does not install it.',
  }),
  planSkillExport: () => ({
    destination: '.agents/skills',
    deduplicated: true,
    warning:
      'Cursor can discover shared and provider-specific skill roots; Latchkit writes only the selected shared destination.',
  }),
  planRuleExport: (model, providerIds = ['cursor']) => planProviderExports(model, providerIds),
  planInvocation: () =>
    unsupportedPlan(
      'invocation',
      'Start Cursor Agent manually inside the trusted editor workspace.',
    ),
  planResume: () =>
    unsupportedPlan('resume', 'Resume the opaque conversation manually in Cursor Agent Chat.'),
  translateLifecycleInput: normalizeInput,
  translateLifecycleOutput: translateCursorIdeLifecycleOutput,
  planUsage: () =>
    unsupportedPlan('usage', 'Cursor project hooks do not expose authoritative usage totals.'),
});
