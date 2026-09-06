import { standaloneHookCommand } from '../installation/hooks.js';
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
import { readOptional, resolveProjectRoot, safePath } from '../storage.js';
import { quoteWindowsCommandArgument } from '../runtime/process-runner.js';
import { inspectProjectLock, removeProvenStaleLock, withProjectLock } from '../installer/lock.js';
import { errorCode, errorMessage, isRecord as isUnknownRecord } from '../types.js';

interface CursorIdeIo {
  access(path: string): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

interface CursorIdeOptions {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  io?: CursorIdeIo;
  editorCandidates?: readonly string[];
  launcherCandidates?: readonly string[];
  root?: string;
  integrationConfigured?: boolean;
  observedSessionId?: string;
  trustedWorkspace?: boolean;
  hooksEnabled?: boolean;
  managedPolicyAllowed?: boolean;
  evidence?: unknown;
  outputPath?: string;
  nodeExecutable?: string;
  faultBoundary?: () => Promise<void>;
}

interface CursorEvidenceRecord {
  schemaVersion: number;
  sequence: number;
  event: (typeof CURSOR_IDE_AGENT_EVENTS)[number];
  classification: 'success' | 'failure' | 'refusal';
}

interface CursorEvidenceDocument {
  schemaVersion: number;
  records: CursorEvidenceRecord[];
}

interface CursorHookDocument {
  version?: number;
  hooks?: Record<string, unknown[]>;
}

interface CursorOwnership {
  handlerSha256: string;
  evidence?: unknown;
  entries: Record<string, string>;
}

const DOCS = 'https://cursor.com/docs/hooks';
const SKILLS_DOCS = 'https://cursor.com/docs/skills';
export const CURSOR_IDE_HOOKS_PATH = '.cursor/hooks.json';
export const CURSOR_IDE_HANDLER_PATH = '.latchkit/providers/cursor-ide/hook-handler.cjs';
export const CURSOR_IDE_STATE_PATH = '.latchkit/providers/cursor-ide/ownership.json';
export const CURSOR_IDE_EVIDENCE_DIRECTORY = '.latchkit/providers/cursor-ide/evidence';
export const CURSOR_IDE_EVIDENCE_SCHEMA_VERSION = 1;
export const CURSOR_IDE_EVIDENCE_MAX_RECORDS = 256;
export const CURSOR_IDE_EVIDENCE_MAX_BYTES = 64 * 1024;
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

const evidence = (
  state: string,
  reason: string,
  evidenceUrl = DOCS,
  versionRange = 'documented-current',
) => ({
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

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isRecord = isUnknownRecord;
const opaque = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value || value.length > 1024)
    throw new ProviderContractError(`Expected bounded opaque ${field}.`, `$.${field}`);
  return value;
};

function cursorIdeEvidencePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    !new RegExp(
      `^${CURSOR_IDE_EVIDENCE_DIRECTORY.replaceAll('.', '\\.')}/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\\.json$`,
    ).test(value)
  )
    throw new Error(
      `Cursor IDE evidence output must be a bounded JSON file directly under ${CURSOR_IDE_EVIDENCE_DIRECTORY}.`,
    );
  return value;
}

function cursorIdeEvidenceConfiguration(value: unknown) {
  if (value === undefined || value === false) return { enabled: false };
  if (!isRecord(value)) throw new Error('Cursor IDE evidence configuration must be an object.');
  const unknown = Object.keys(value).filter((key) => !['enabled', 'outputPath'].includes(key));
  if (unknown.length)
    throw new Error(`Unknown Cursor IDE evidence option: ${unknown.sort().join(', ')}.`);
  if (value.enabled !== true) {
    if (value.enabled === false && value.outputPath === undefined) return { enabled: false };
    throw new Error('Cursor IDE evidence mode must be explicitly enabled.');
  }
  return {
    schemaVersion: CURSOR_IDE_EVIDENCE_SCHEMA_VERSION,
    enabled: true,
    outputPath: cursorIdeEvidencePath(value.outputPath),
    format: 'json',
    maxRecords: CURSOR_IDE_EVIDENCE_MAX_RECORDS,
    maxBytes: CURSOR_IDE_EVIDENCE_MAX_BYTES,
  };
}

function validateCursorIdeEvidenceDocument(document: unknown): CursorEvidenceDocument {
  if (!isRecord(document)) throw new Error('Cursor IDE evidence must contain an object.');
  const topLevel = Object.keys(document).sort();
  if (topLevel.join(',') !== 'records,schemaVersion')
    throw new Error('Cursor IDE evidence contains unsupported fields.');
  if (document.schemaVersion !== CURSOR_IDE_EVIDENCE_SCHEMA_VERSION)
    throw new Error('Unsupported Cursor IDE evidence schema version.');
  if (!Array.isArray(document.records))
    throw new Error('Cursor IDE evidence records must be an array.');
  if (document.records.length > CURSOR_IDE_EVIDENCE_MAX_RECORDS)
    throw new Error('Cursor IDE evidence exceeds the record limit.');
  let sequence = 0;
  for (const record of document.records) {
    if (!isRecord(record)) throw new Error('Cursor IDE evidence record must be an object.');
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'classification,event,schemaVersion,sequence')
      throw new Error('Cursor IDE evidence record contains unsupported fields.');
    if (record.schemaVersion !== CURSOR_IDE_EVIDENCE_SCHEMA_VERSION)
      throw new Error('Unsupported Cursor IDE evidence record schema version.');
    if (record.sequence !== sequence + 1)
      throw new Error('Cursor IDE evidence sequence is not contiguous.');
    if (
      typeof record.event !== 'string' ||
      !CURSOR_IDE_AGENT_EVENTS.includes(record.event as (typeof CURSOR_IDE_AGENT_EVENTS)[number])
    )
      throw new Error('Cursor IDE evidence contains an unsupported event.');
    if (
      typeof record.classification !== 'string' ||
      !['success', 'failure', 'refusal'].includes(record.classification)
    )
      throw new Error('Cursor IDE evidence contains an unsupported classification.');
    sequence = record.sequence;
  }
  return document as unknown as CursorEvidenceDocument;
}

function defaultEditorCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [
      ...(env.LOCALAPPDATA
        ? [path.win32.join(env.LOCALAPPDATA, 'Programs', 'Cursor', 'Cursor.exe')]
        : []),
      ...(env.PROGRAMFILES ? [path.win32.join(env.PROGRAMFILES, 'Cursor', 'Cursor.exe')] : []),
    ];
  }
  if (platform === 'darwin') return ['/Applications/Cursor.app/Contents/MacOS/Cursor'];
  return ['/usr/bin/cursor', '/usr/local/bin/cursor', '/opt/Cursor/cursor'];
}

function launcherCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const suffixes = platform === 'win32' ? ['', '.cmd', '.exe'] : [''];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return (env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
    .flatMap((directory) => suffixes.map((suffix) => pathApi.join(directory, `cursor${suffix}`)));
}

async function firstAccessible(
  candidates: readonly string[],
  io: CursorIdeIo,
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await io.access(candidate);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error;
    }
  }
  return null;
}

async function metadataVersion(
  editorPath: string,
  platform: NodeJS.Platform,
  io: CursorIdeIo,
): Promise<{ version: string | null; source: string | null }> {
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
      const parsed: unknown = JSON.parse(await io.readFile(filename, 'utf8'));
      if (!isRecord(parsed)) continue;
      const version = parsed.cursorVersion ?? parsed.version;
      if (typeof version === 'string' && version) return { version, source: filename };
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR', 'EACCES'].includes(errorCode(error) ?? '') &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
  }
  return { version: null, source: null };
}

/** Inspect files only. It never launches the editor or a provider session. */
export async function inspectCursorIde(options: CursorIdeOptions = {}) {
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
        Object.entries(state.entries ?? {}).every(
          ([event, ownedHash]) =>
            isRecord(hooks.hooks) &&
            Array.isArray(hooks.hooks[event]) &&
            hooks.hooks[event].some(
              (entry: unknown) => digest(JSON.stringify(entry)) === ownedHash,
            ),
        );
      configuration = intact
        ? { state: 'verified', reason: 'Owned project hook entries and handler match.' }
        : { state: 'unverified', reason: 'Owned project hook evidence is absent or incomplete.' };
    } catch (error) {
      configuration = {
        state: 'unverified',
        reason: `Project integration is invalid: ${errorMessage(error)}`,
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

function quoteCommandToken(value: string, platform: NodeJS.Platform = process.platform) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Unsafe Cursor hook command token.');
  if (platform === 'win32') return quoteWindowsCommandArgument(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cursorIdeHookCommand(
  nodeExecutable: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  evidence: unknown = { enabled: false },
) {
  const configuration = cursorIdeEvidenceConfiguration(
    isRecord(evidence) && evidence.enabled === true
      ? { enabled: true, outputPath: evidence.outputPath }
      : { enabled: false },
  );
  const standalone = standaloneHookCommand(
    'cursor',
    configuration.enabled && configuration.outputPath
      ? ['--evidence', configuration.outputPath]
      : [],
    { nodeExecutable, platform },
  );
  if (standalone) return standalone;
  const command = `${quoteCommandToken(nodeExecutable, platform)} ${quoteCommandToken(CURSOR_IDE_HANDLER_PATH, platform)}`;
  return configuration.enabled
    ? `${command} --evidence ${quoteCommandToken(configuration.outputPath!, platform)}`
    : command;
}

const managedEntry = (command: string) => ({ command, timeout: 10 });

export function mergeCursorIdeHooks(raw: string | null, command: string): string {
  let document: CursorHookDocument = {};
  if (raw !== null) {
    try {
      document = JSON.parse(raw) as CursorHookDocument;
    } catch (error) {
      throw new Error(`Invalid ${CURSOR_IDE_HOOKS_PATH}: ${errorMessage(error)}`);
    }
  }
  if (!isRecord(document)) throw new Error(`${CURSOR_IDE_HOOKS_PATH} must contain an object.`);
  if (document.hooks !== undefined && !isRecord(document.hooks))
    throw new Error(`${CURSOR_IDE_HOOKS_PATH}.hooks must contain an object.`);
  const next = clone(document) as CursorHookDocument;
  if (next.version === undefined) next.version = 1;
  if (next.version !== 1) throw new Error('Unsupported Cursor hooks configuration version.');
  next.hooks ??= {};
  for (const event of CURSOR_IDE_AGENT_EVENTS) {
    const entries = next.hooks![event] ?? [];
    if (!Array.isArray(entries)) throw new Error(`Cursor hook ${event} must be an array.`);
    const expected = digest(JSON.stringify(managedEntry(command)));
    if (
      !entries.some(
        (entry: unknown) => isRecord(entry) && digest(JSON.stringify(entry)) === expected,
      )
    )
      entries.push(managedEntry(command));
    next.hooks![event] = entries;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

function removeCursorIdeHooks(raw: string | null, state: CursorOwnership): string | null {
  if (raw === null) return null;
  const document = JSON.parse(raw);
  const next = clone(document) as CursorHookDocument;
  const hooks = next.hooks;
  if (!hooks) throw new Error('Owned Cursor hooks are missing.');
  for (const [event, ownedHash] of Object.entries(state.entries)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) throw new Error(`Owned Cursor hook ${event} is missing.`);
    const index = entries.findIndex(
      (entry: unknown) => digest(JSON.stringify(entry)) === ownedHash,
    );
    if (index < 0) throw new Error(`Owned Cursor hook ${event} has local edits or is missing.`);
    entries.splice(index, 1);
    if (!entries.length) delete hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks!).length) delete next.hooks;
  if (Object.keys(next).length === 1 && next.version === 1) return null;
  return `${JSON.stringify(next, null, 2)}\n`;
}

function ownershipFor(
  command: string,
  handlerBytes: string,
  evidence: unknown,
): CursorOwnership & { schemaVersion: number; command: string } {
  return {
    schemaVersion: 2,
    command,
    handlerSha256: digest(handlerBytes),
    evidence,
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
export async function planCursorIdeHookExport(root: string, options: CursorIdeOptions = {}) {
  root = await resolveProjectRoot(root);
  const enabled = options.enabled === true;
  const evidence = cursorIdeEvidenceConfiguration(options.evidence) as {
    enabled: boolean;
    outputPath?: string;
  };
  if (evidence.enabled && evidence.outputPath) await safePath(root, evidence.outputPath);
  const currentHooks = await readOptional(root, CURSOR_IDE_HOOKS_PATH);
  const currentHandler = await readOptional(root, CURSOR_IDE_HANDLER_PATH);
  const currentStateRaw = await readOptional(root, CURSOR_IDE_STATE_PATH);
  let currentState: (CursorOwnership & { command: string }) | null = null;
  if (currentStateRaw !== null) {
    try {
      currentState = JSON.parse(currentStateRaw) as CursorOwnership & { command: string };
    } catch (error) {
      throw new Error(`Invalid Cursor IDE ownership record: ${errorMessage(error)}`);
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
    const command = cursorIdeHookCommand(options.nodeExecutable, options.platform, evidence);
    nextHooks = currentState
      ? currentState.command === command
        ? currentHooks
        : mergeCursorIdeHooks(removeCursorIdeHooks(currentHooks, currentState), command)
      : mergeCursorIdeHooks(currentHooks, command);
    nextHandler = source;
    nextState = `${JSON.stringify(ownershipFor(command, source, evidence), null, 2)}\n`;
  } else {
    nextHooks = removeCursorIdeHooks(currentHooks, currentState!);
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
    evidence,
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

/** Read and validate only the bounded allowlisted qualification evidence. */
export async function inspectCursorIdeHookEvidence(root: string) {
  root = await resolveProjectRoot(root);
  const stateRaw = await readOptional(root, CURSOR_IDE_STATE_PATH);
  if (stateRaw === null) return { configured: false, records: [], events: {} };
  const state = JSON.parse(stateRaw) as CursorOwnership;
  const stateEvidence = isRecord(state.evidence) ? state.evidence : {};
  const evidence = cursorIdeEvidenceConfiguration(
    stateEvidence.enabled === true
      ? { enabled: true, outputPath: stateEvidence.outputPath }
      : { enabled: false },
  );
  if (JSON.stringify(state.evidence ?? { enabled: false }) !== JSON.stringify(evidence))
    throw new Error('Invalid Cursor IDE evidence ownership configuration.');
  if (!evidence.enabled || !('outputPath' in evidence) || typeof evidence.outputPath !== 'string')
    return { configured: false, records: [], events: {} };
  const raw = await readOptional(root, evidence.outputPath);
  if (raw === null)
    return {
      configured: true,
      path: evidence.outputPath,
      records: [],
      events: Object.fromEntries(
        CURSOR_IDE_AGENT_EVENTS.map((event) => [event, { observed: false, count: 0 }]),
      ),
    };
  if (Buffer.byteLength(raw) > CURSOR_IDE_EVIDENCE_MAX_BYTES)
    throw new Error('Cursor IDE evidence exceeds the byte limit.');
  const document = validateCursorIdeEvidenceDocument(JSON.parse(raw));
  return {
    configured: true,
    path: evidence.outputPath,
    records: clone(document.records),
    events: Object.fromEntries(
      CURSOR_IDE_AGENT_EVENTS.map((event) => {
        const matching = document.records.filter((record) => record.event === event);
        return [
          event,
          {
            observed: matching.length > 0,
            count: matching.length,
            classifications: [...new Set(matching.map((record) => record.classification))],
          },
        ];
      }),
    ),
  };
}

/** Apply an explicitly enabled/disabled plan through the crash-recoverable transaction engine. */
export async function applyCursorIdeHookExport(root: string, options: CursorIdeOptions = {}) {
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
      changes: plan.changes.map(({ resourceId, bytes }) => ({ resourceId, bytes: bytes ?? null })),
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

export async function inspectCursorIdeRecovery(root: string) {
  root = await resolveProjectRoot(root);
  return {
    ...(await inspectTransaction(root, cursorIdeResourceRegistry())),
    lock: await inspectProjectLock(root),
  };
}

export async function recoverCursorIdeIntegration(root: string) {
  root = await resolveProjectRoot(root);
  const lock = await inspectProjectLock(root);
  if (lock.state === 'live' || lock.state === 'invalid')
    throw new Error(
      lock.state === 'live'
        ? 'A live Latchkit operation owns the project lock.'
        : `Cursor IDE recovery is blocked: ${'reason' in lock ? lock.reason : 'invalid lock state'}`,
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

function normalizeInput(
  input: unknown,
  context: { eventId?: unknown; projectId?: unknown; taskId?: unknown; timestamp?: number } = {},
) {
  if (!isRecord(input)) throw new ProviderContractError('Expected Cursor hook payload.');
  const event = input.hook_event_name;
  if (typeof event !== 'string') throw new ProviderContractError('Cursor hook event is missing.');
  if (CURSOR_IDE_NON_AGENT_EVENTS.includes(event as (typeof CURSOR_IDE_NON_AGENT_EVENTS)[number]))
    return {
      accepted: false,
      source: event === 'workspaceOpen' ? 'workspace' : 'tab',
      reason: `${event} is not an Agent task-progress event.`,
    };
  if (!CURSOR_IDE_AGENT_EVENTS.includes(event as (typeof CURSOR_IDE_AGENT_EVENTS)[number]))
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
  const kinds: Record<string, 'session-terminated' | 'turn-completed'> = {
    sessionEnd: 'session-terminated',
    stop: 'turn-completed',
  };
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

export function translateCursorIdeLifecycleOutput(
  event: string,
  result: { decision?: unknown; reason?: unknown } = {},
) {
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

const unsupportedPlan = (capability: string, reason: string) => ({
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
  planRuleExport: (
    model: Parameters<typeof planProviderExports>[0],
    providerIds: readonly string[] = ['cursor'],
  ) => planProviderExports(model, providerIds),
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
