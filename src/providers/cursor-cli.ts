import { randomUUID } from 'node:crypto';
import {
  validateCommandPlan,
  validateLifecycleEnvelope,
  createProviderAdapter,
} from './contracts.js';
import { buildProjectRuleExports } from '../rules/index.js';
import type { LifecycleEnvelope } from './contracts.js';

interface CursorCliOptions {
  executable?: string;
  allowLegacy?: boolean;
  probeTimeoutMs?: number;
  probeOutputLimitBytes?: number;
  skillIds?: readonly string[];
  root?: string;
  scopes?: readonly string[];
  overrides?: readonly unknown[];
  print?: boolean;
  prompt?: unknown;
  outputFormat?: string;
  model?: unknown;
  resume?: boolean | string;
  cwd?: string;
  environment?: Record<string, unknown>;
  chatId?: string;
  sessionId?: string;
  providerVersion?: string;
  runtime?: string;
  projectId?: string;
  taskId?: string;
  allow?: readonly unknown[];
  deny?: readonly unknown[];
  requested?: boolean;
}

interface LifecycleContext {
  providerVersion?: string;
  runtime?: string;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
}

interface ProcessResult {
  stdout?: unknown;
  stderr?: unknown;
  status?: string;
  exitCode?: number | null;
}

const PARAMETERS_URL = 'https://docs.cursor.com/en/cli/reference/parameters';
const USING_URL = 'https://docs.cursor.com/en/cli/using';
const CONFIG_URL = 'https://prod.cursor.com/docs/cli/reference/configuration';
const HOOKS_URL = 'https://prod.cursor.com/docs/hooks';

const supported = (reason: string, versionRange: string, evidenceUrl: string) => ({
  state: 'supported',
  reason,
  versionRange,
  evidenceUrl,
});
const partial = (reason: string, versionRange: string, evidenceUrl: string) => ({
  state: 'partial',
  reason,
  versionRange,
  evidenceUrl,
});
const unknown = (reason: string, evidenceUrl: string) => ({
  state: 'unknown',
  reason,
  versionRange: '*',
  evidenceUrl,
});

export const CURSOR_CLI_PROVIDER = {
  schemaVersion: 1,
  id: 'cursor-cli',
  label: 'Cursor CLI',
  command: 'cursor-agent',
  skillDirectory: '.agents/skills',
  capabilities: {
    skills: supported('Cursor CLI reads the shared .agents/skills directory.', '*', USING_URL),
    invocation: supported(
      'The documented agent executable supports interactive and print modes.',
      '*',
      PARAMETERS_URL,
    ),
    hooks: {
      sessionStart: unknown(
        'Cursor hook evidence is documented for cloud agents, not this local CLI adapter.',
        HOOKS_URL,
      ),
      sessionEnd: unknown(
        'Cursor hook evidence is documented for cloud agents, not this local CLI adapter.',
        HOOKS_URL,
      ),
      preToolUse: unknown(
        'Local CLI hook payload and decision behavior are not independently verified.',
        HOOKS_URL,
      ),
      stop: unknown(
        'Local CLI stop-hook continuation behavior is not independently verified.',
        HOOKS_URL,
      ),
    },
    decisions: {
      blocking: unknown(
        'The CLI owns command approvals; no adapter hook proves a Latchkit blocking decision.',
        HOOKS_URL,
      ),
      advisory: unknown(
        'No local CLI lifecycle handler contract is independently verified.',
        HOOKS_URL,
      ),
    },
    compaction: unknown(
      'Compaction behavior is not exposed by the documented CLI command contract.',
      USING_URL,
    ),
    resume: supported('The CLI documents latest and chat-id resume commands.', '*', PARAMETERS_URL),
    cancellation: partial(
      'The host process runner can cancel the owned process; provider-session cancellation is not separately evidenced.',
      '*',
      PARAMETERS_URL,
    ),
    usage: unknown('The CLI does not document a stable usage-reporting command.', PARAMETERS_URL),
  },
  verification: {
    installed: 'unknown',
    authenticated: 'unknown',
    configured: 'unknown',
    endToEnd: 'unverified',
  },
};

const executableFor = (options: CursorCliOptions = {}): string =>
  options.executable ?? 'cursor-agent';
const versionProbe = (executable: string) => ({ executable, args: ['--version'] });
const helpProbe = (executable: string) => ({ executable, args: ['--help'] });

function inspect(options: CursorCliOptions = {}) {
  const executable = executableFor(options);
  const legacy = options.allowLegacy === true;
  const candidates = legacy ? ['cursor-agent', 'agent'] : ['cursor-agent'];
  return {
    provider: 'cursor-cli',
    executable,
    candidates,
    compatibility: legacy
      ? 'The older agent executable name is accepted only when allowLegacy is explicitly true.'
      : 'Only the documented cursor-agent executable is selected by default.',
    probes: [versionProbe(executable), helpProbe(executable)].map((plan) => ({
      ...plan,
      timeoutMs: options.probeTimeoutMs ?? 2_000,
      outputLimitBytes: options.probeOutputLimitBytes ?? 16 * 1024,
    })),
    redaction:
      'Probe output may contain account or path data and must be retained only by the caller under its own redaction policy.',
  };
}

function planInstall(options: CursorCliOptions = {}) {
  return {
    provider: 'cursor-cli',
    executable: executableFor(options),
    skillDirectory: '.agents/skills',
    install: 'external',
    reason:
      'Latchkit does not install or update Cursor CLI. Resolve and verify the executable through the caller-authorized process runner.',
    probes: inspect(options).probes,
  };
}

function planSkillExport(options: CursorCliOptions = {}) {
  return {
    provider: 'cursor-cli',
    destination: '.agents/skills',
    shared: true,
    reason:
      'Cursor CLI and compatible tools discover the shared skill directory; the installer owns reversible transactions and file ownership.',
    ...(options.skillIds ? { skillIds: [...options.skillIds] } : {}),
  };
}

async function planRuleExport(options: CursorCliOptions = {}) {
  if (!options.root) throw new TypeError('A project root is required to plan Cursor CLI rules.');
  const result = await buildProjectRuleExports(options.root, ['cursor-cli'], options);
  return {
    provider: 'cursor-cli',
    ...result,
    reason:
      'Rule rendering is delegated to the canonical rule-generation serializer; ownership and transaction handling remain with the installer.',
  };
}

function planInvocation(options: CursorCliOptions = {}) {
  const args: string[] = [];
  const print = options.print ?? options.prompt !== undefined;
  const outputFormat = options.outputFormat ?? (print ? 'json' : undefined);
  if (print) args.push('--print');
  if (outputFormat !== undefined) {
    if (!print) throw new TypeError('outputFormat requires print mode.');
    if (!['text', 'json', 'stream-json'].includes(outputFormat))
      throw new TypeError('outputFormat must be text, json, or stream-json.');
    args.push('--output-format', outputFormat);
  }
  if (options.model !== undefined) args.push('--model', String(options.model));
  if (options.resume !== undefined) {
    args.push(options.resume === true ? '--resume' : `--resume=${String(options.resume)}`);
  }
  if (options.prompt !== undefined) args.push(String(options.prompt));
  return validateCommandPlan({
    executable: executableFor(options),
    args,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.environment !== undefined ? { environment: { ...options.environment } } : {}),
  });
}

function planResume(options: CursorCliOptions = {}) {
  const chatId = options.chatId ?? options.sessionId;
  if (chatId !== undefined) return planInvocation({ ...options, resume: chatId });
  return validateCommandPlan({
    executable: executableFor(options),
    args: ['resume'],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
}

const contextFor = (context: LifecycleContext = {}) => ({
  providerVersion: context.providerVersion ?? 'unknown',
  runtime: context.runtime ?? process.platform,
  projectId: context.projectId ?? 'unknown-project',
  taskId: context.taskId ?? 'unknown-task',
  sessionId: context.sessionId ?? 'unknown-session',
});

function envelope(
  kind: LifecycleEnvelope['kind'],
  payload: unknown,
  context: LifecycleContext,
  eventId: string = randomUUID(),
  timestamp: number = Date.now(),
) {
  const base = contextFor(context);
  return validateLifecycleEnvelope({
    schemaVersion: 1,
    provider: { id: 'cursor-cli', version: base.providerVersion, runtime: base.runtime },
    correlation: { projectId: base.projectId, taskId: base.taskId, sessionId: base.sessionId },
    eventId,
    timestamp,
    kind,
    payload:
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : { value: payload },
    decisionModes: ['advisory'],
  });
}

function translateLifecycleInput(input: unknown, context: LifecycleContext = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const events: Readonly<LifecycleEnvelope>[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      events.push(envelope('turn-completed', { format: 'text', text: line }, context));
      continue;
    }
    const value: Record<string, unknown> =
      record && typeof record === 'object' && !Array.isArray(record)
        ? (record as Record<string, unknown>)
        : {};
    events.push(
      envelope(
        'turn-completed',
        value,
        context,
        typeof value.eventId === 'string' ? value.eventId : undefined,
        typeof value.timestamp === 'number' ? value.timestamp : undefined,
      ),
    );
  }
  return events;
}

function translateLifecycleOutput(result: ProcessResult = {}, context: LifecycleContext = {}) {
  const events: Readonly<LifecycleEnvelope>[] = [];
  if (result.stdout) events.push(...translateLifecycleInput(result.stdout, context));
  if (result.stderr)
    events.push(
      envelope('turn-completed', { stream: 'stderr', text: String(result.stderr) }, context),
    );
  if (result.status === 'cancelled' || result.status === 'timed-out')
    events.push(envelope('interrupted', { status: result.status }, context));
  if (result.status === 'exited' || result.status === 'spawn-failed')
    events.push(
      envelope(
        'session-terminated',
        { status: result.status, exitCode: result.exitCode ?? null },
        context,
      ),
    );
  return events;
}

function planUsage() {
  return {
    provider: 'cursor-cli',
    state: 'unknown',
    reason: 'Cursor CLI has no documented stable usage-reporting command.',
  };
}

function planProjectPermissions(options: CursorCliOptions = {}) {
  const allow = options.allow ?? [];
  const deny = options.deny ?? [];
  if (
    !Array.isArray(allow) ||
    !Array.isArray(deny) ||
    [...allow, ...deny].some((value) => typeof value !== 'string')
  )
    throw new TypeError('Permission allow and deny values must be string arrays.');
  return {
    path: '.cursor/cli.json',
    scope: 'project',
    fields: { permissions: { allow: [...allow], deny: [...deny] } },
    preserve:
      'All unrelated settings, credentials, trust state, comments, and global cli-config.json remain untouched.',
    requested: options.requested === true,
    transaction:
      'Use the registered-resource transaction and ownership layers before applying or removing this file.',
    evidenceUrl: CONFIG_URL,
  };
}

export const cursorCliAdapter = createProviderAdapter(CURSOR_CLI_PROVIDER, {
  inspect,
  planInstall,
  planSkillExport,
  planRuleExport,
  planInvocation,
  planResume,
  translateLifecycleInput,
  translateLifecycleOutput,
  planUsage,
});

export {
  inspect,
  planInstall,
  planSkillExport,
  planRuleExport,
  planInvocation,
  planResume,
  translateLifecycleInput,
  translateLifecycleOutput,
  planUsage,
  planProjectPermissions,
};
