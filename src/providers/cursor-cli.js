import { randomUUID } from 'node:crypto';
import {
  validateCommandPlan,
  validateLifecycleEnvelope,
  createProviderAdapter,
} from './contracts.js';
import { buildProjectRuleExports } from '../rules/index.js';

const PARAMETERS_URL = 'https://docs.cursor.com/en/cli/reference/parameters';
const USING_URL = 'https://docs.cursor.com/en/cli/using';
const CONFIG_URL = 'https://prod.cursor.com/docs/cli/reference/configuration';
const HOOKS_URL = 'https://prod.cursor.com/docs/hooks';

const supported = (reason, versionRange, evidenceUrl) => ({
  state: 'supported',
  reason,
  versionRange,
  evidenceUrl,
});
const partial = (reason, versionRange, evidenceUrl) => ({
  state: 'partial',
  reason,
  versionRange,
  evidenceUrl,
});
const unknown = (reason, evidenceUrl) => ({
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

const executableFor = (options = {}) => options.executable ?? 'cursor-agent';
const versionProbe = (executable) => ({ executable, args: ['--version'] });
const helpProbe = (executable) => ({ executable, args: ['--help'] });

function inspect(options = {}) {
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

function planInstall(options = {}) {
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

function planSkillExport(options = {}) {
  return {
    provider: 'cursor-cli',
    destination: '.agents/skills',
    shared: true,
    reason:
      'Cursor CLI and compatible tools discover the shared skill directory; the installer owns reversible transactions and file ownership.',
    ...(options.skillIds ? { skillIds: [...options.skillIds] } : {}),
  };
}

async function planRuleExport(options = {}) {
  if (!options.root) throw new TypeError('A project root is required to plan Cursor CLI rules.');
  const result = await buildProjectRuleExports(options.root, ['cursor-cli'], options);
  return {
    provider: 'cursor-cli',
    ...result,
    reason:
      'Rule rendering is delegated to the canonical rule-generation serializer; ownership and transaction handling remain with the installer.',
  };
}

function planInvocation(options = {}) {
  const args = [];
  if (options.print === true) args.push('--print');
  if (options.outputFormat !== undefined) {
    if (options.print !== true) throw new TypeError('outputFormat requires print mode.');
    if (!['text', 'json', 'stream-json'].includes(options.outputFormat))
      throw new TypeError('outputFormat must be text, json, or stream-json.');
    args.push('--output-format', options.outputFormat);
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

function planResume(options = {}) {
  if (options.chatId !== undefined) return planInvocation({ ...options, resume: options.chatId });
  return validateCommandPlan({
    executable: executableFor(options),
    args: ['resume'],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
}

const contextFor = (context = {}) => ({
  providerVersion: context.providerVersion ?? 'unknown',
  runtime: context.runtime ?? process.platform,
  projectId: context.projectId ?? 'unknown-project',
  taskId: context.taskId ?? 'unknown-task',
  sessionId: context.sessionId ?? 'unknown-session',
});

function envelope(kind, payload, context, eventId = randomUUID(), timestamp = Date.now()) {
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

function translateLifecycleInput(input, context = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const events = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      events.push(envelope('turn-completed', { format: 'text', text: line }, context));
      continue;
    }
    const kind =
      record.type === 'result' || record.type === 'assistant' ? 'turn-completed' : 'turn-completed';
    events.push(envelope(kind, record, context, record.eventId, record.timestamp));
  }
  return events;
}

function translateLifecycleOutput(result = {}, context = {}) {
  const events = [];
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

function planProjectPermissions(options = {}) {
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
