import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateCommandPlan, validateLifecycleEnvelope } from '../providers/contracts.js';
import type { LifecycleEnvelope, ProviderContract } from '../providers/contracts.js';
import { CLAUDE_ADAPTER } from '../providers/claude.js';
import { codexAdapter } from '../providers/codex.js';
import {
  ANTIGRAVITY_ADAPTER,
  parseAntigravitySessionIdentity,
  parseAntigravityVersion,
} from '../providers/antigravity.js';
import { cursorIdeAdapter } from '../providers/cursor-ide.js';
import { cursorCliAdapter } from '../providers/cursor-cli.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from './process-runner.js';
import type { ProcessRunResult } from './process-runner.js';
import {
  claimExecutionFence,
  clearExecutionFence,
  inspectExecutionFence,
  releaseExecutionFence,
} from './execution-fence.js';
import {
  cancelTask,
  checkpointTask,
  inspectTask,
  pauseTask,
  resumeTask,
} from '../task-state/service.js';
import { buildContextBrief } from '../context-brief/service.js';
import { contractFreshness } from '../task-state/contract-coordination.js';
import { withTaskStateLock } from '../task-state/lock.js';
import type { Task } from '../task-state/contracts.js';
import { recordProviderUsage } from '../usage/service.js';
import { readUsageState } from '../usage/store.js';
import { writeAtomic } from '../storage.js';
import { createTaskWorkspace } from '../workspaces/git.js';
import { resolveExecutionChoice, type WorkspaceExecutionChoice } from '../workspaces/preference.js';
import {
  DEFAULT_WORKSPACE_EXECUTION_PREFERENCE,
  type WorkspaceExecutionPreference,
} from '../config/contracts.js';

export const TASK_SESSION_PATH = '.latchkit/tasks/sessions-v1.json';
const SESSION_SCHEMA_VERSION = 1;
/** The implementation workspace a session actually ran in. Recorded once at
 * first start and reused verbatim on resume, so resuming a task never
 * re-decides or moves its workspace even if the project preference changes
 * later. Absent on sessions persisted before this field existed; those are
 * treated as direct (their only possible prior behavior). */
type SessionWorkspace = { mode: 'isolated' | 'direct'; path: string };
type TaskSession = {
  id: string;
  providerSessionId: string | null;
  taskId: string;
  runId: string;
  providerId: string;
  state: 'launching' | 'running' | 'finished' | 'cancelled';
  executionBoundary: string;
  process: { pid: number | null; hostname: string; platform: NodeJS.Platform } | null;
  eventIds: string[];
  result: ReturnType<typeof resultSummary> | null;
  workspace?: SessionWorkspace | null;
  /** The context-brief digest bound to this dispatch (issue #112), best-effort: a failure
   * building the brief never blocks a direct task start/resume, and is recorded as `null` rather
   * than guessed. Absent on sessions persisted before this field existed. */
  contextBriefDigest?: string | null;
  /** Cross-task contract freshness is checked at dispatch; a stale association blocks a new
   * provider launch and leaves the existing checkpoint/resume route intact. */
  contractFreshness?: Array<{
    associationId: string;
    expected: string;
    actual: string;
    reconciliation: string;
    acknowledged: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
};
type SessionDocument = { schemaVersion: number; sessions: TaskSession[] };
type ActiveSession = { abort: AbortController; sessionId: string; runId: string };
type Adapter = {
  contract: ProviderContract;
  operations: {
    planInvocation(options: Record<string, unknown>): unknown;
    planResume(options: Record<string, unknown>): unknown;
  };
};
type RunInput = {
  taskId: string;
  providerId: string;
  prompt?: string;
  expectedRevision?: number;
  mutationId?: string;
  resumeSession?: TaskSession;
  sandbox?: string;
  approvalPolicy?: string;
  executionAuthorized?: boolean;
  sessionId?: string;
  /** An explicit per-task choice for a fresh start only; ignored on resume,
   * which always reuses the session's recorded workspace. */
  workspaceChoice?: WorkspaceExecutionChoice;
  /** An explicit per-call worktree-root override for a fresh, isolated start. */
  worktreeRoot?: string;
};
type TaskControllerOptions = {
  root: string;
  adapters?: Map<string, Adapter>;
  launch?: typeof runProviderProcess;
  executionProfile?: string;
  gateHandler?: (task: Task, event: LifecycleEnvelope) => Promise<unknown> | unknown;
};

const ACTIVE = new Map<string, ActiveSession>();
const ADAPTERS = new Map<string, Adapter>([
  ['claude', CLAUDE_ADAPTER as unknown as Adapter],
  ['codex', codexAdapter as unknown as Adapter],
  ['antigravity', ANTIGRAVITY_ADAPTER as unknown as Adapter],
  ['cursor', cursorIdeAdapter as unknown as Adapter],
  ['cursor-cli', cursorCliAdapter as unknown as Adapter],
]);
const CAPABLE = new Set(['supported', 'partial']);

export class TaskControllerError extends Error {
  code: string;

  constructor(message: string, code = 'TASK_CONTROLLER_INVALID') {
    super(message);
    this.name = 'TaskControllerError';
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const key = (root: string, taskId: string) => `${path.resolve(root)}\0${taskId}`;

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function redacted(value: unknown) {
  return String(value ?? '').replace(
    /\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+|\b(?:bearer|token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
    '[redacted]',
  );
}

function assertId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new TaskControllerError(`${name} is required.`, 'TASK_CONTROLLER_INVALID');
}

function adapterFor(id: string, adapters: Map<string, Adapter>): Adapter {
  const adapter = adapters.get(id);
  if (!adapter)
    throw new TaskControllerError(`Provider ${id} has no task adapter.`, 'PROVIDER_UNAVAILABLE');
  return adapter;
}

function capability(adapter: Adapter, name: 'invocation' | 'resume'): void {
  const evidence = adapter.contract.capabilities[name];
  if (!CAPABLE.has(evidence?.state))
    throw new TaskControllerError(
      evidence?.reason ?? `${name} is unavailable.`,
      'CAPABILITY_UNAVAILABLE',
    );
}

async function readSessions(root: string): Promise<SessionDocument> {
  try {
    const document = JSON.parse(await readFile(path.join(root, TASK_SESSION_PATH), 'utf8'));
    if (document.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(document.sessions))
      throw new TaskControllerError('Task session state is invalid.', 'TASK_SESSION_INVALID');
    return document;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: SESSION_SCHEMA_VERSION, sessions: [] };
    throw error;
  }
}

async function writeSessions(root: string, document: SessionDocument): Promise<void> {
  await writeAtomic(root, TASK_SESSION_PATH, `${JSON.stringify(document, null, 2)}\n`, 0o600);
}

/** Reads the project's persisted `workspace.executionPreference` without
 * requiring an initialized or validated Latchkit project. A missing,
 * unreadable, or malformed configuration falls back to the documented
 * default ("direct"), which is also today's only actual behavior — so a
 * project that never sets this preference sees no behavioral change. */
async function projectExecutionPreference(root: string): Promise<WorkspaceExecutionPreference> {
  try {
    const raw = await readFile(path.join(root, '.latchkit', 'config.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const preference =
      parsed && typeof parsed === 'object' && 'workspace' in parsed
        ? (parsed as { workspace?: unknown }).workspace
        : undefined;
    const executionPreference =
      preference && typeof preference === 'object' && 'executionPreference' in preference
        ? (preference as { executionPreference?: unknown }).executionPreference
        : undefined;
    if (
      executionPreference === 'ask' ||
      executionPreference === 'always-worktree' ||
      executionPreference === 'direct'
    )
      return executionPreference;
  } catch {
    // A missing or malformed project configuration keeps the safe default.
  }
  return DEFAULT_WORKSPACE_EXECUTION_PREFERENCE;
}

function resultSummary(result: ProcessRunResult) {
  return {
    status: result.status,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    outputBytes: result.outputBytes ?? 0,
    stderr: redacted(result.stderr ?? result.message ?? ''),
  };
}

function jsonRecords(value: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of String(value ?? '')
    .split(/\r?\n/)
    .filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record);
    } catch {
      // Provider text is untrusted output, not a session identity.
    }
  }
  return records;
}

function providerSessionIdentity(
  providerId: string,
  result: ProcessRunResult,
  providerVersion?: string | null,
  expectedSessionId?: string | null,
): string | null {
  if (providerId === 'antigravity') {
    if (result.status !== 'exited' || result.exitCode !== 0) return null;
    return parseAntigravitySessionIdentity(result.stdout, { providerVersion, expectedSessionId });
  }
  if (typeof result?.sessionId === 'string' && result.sessionId.trim()) return result.sessionId;
  const records = jsonRecords(result?.stdout);
  if (providerId === 'codex') {
    const started = records.find(
      (record) => record.type === 'thread.started' && typeof record.thread_id === 'string',
    );
    return (started?.thread_id as string | undefined) ?? null;
  }
  if (providerId === 'claude') {
    const completed = records.find(
      (record) => record.type === 'result' && typeof record.session_id === 'string',
    );
    return (completed?.session_id as string | undefined) ?? null;
  }
  if (providerId === 'cursor-cli') {
    const correlated = records.find((record) => typeof record.session_id === 'string');
    return (correlated?.session_id as string | undefined) ?? null;
  }
  return null;
}

/** A bounded coordinator for task-state ownership and adapter-backed sessions.
 * It deliberately never adopts a PID after restart: only the controller that
 * launched a child owns its AbortController and may terminate that child. */
export function createTaskController({
  root,
  adapters = ADAPTERS,
  launch = runProviderProcess,
  executionProfile = HOST_LOCAL_EXECUTION_PROFILE,
  gateHandler = async () => ({ decision: 'advisory' }),
}: TaskControllerOptions) {
  if (!root) throw new TaskControllerError('Project root is required.');
  if (!(adapters instanceof Map)) throw new TypeError('Expected adapters map.');
  if (typeof launch !== 'function' || typeof gateHandler !== 'function')
    throw new TypeError('Expected launch and gateHandler functions.');
  root = path.resolve(root);
  let pendingSessionWrite: Promise<unknown> = Promise.resolve();

  async function save(session: TaskSession): Promise<TaskSession> {
    const operation = async () => {
      return withTaskStateLock(root, async () => {
        const document = await readSessions(root);
        const index = document.sessions.findIndex((item) => item.id === session.id);
        if (index === -1) document.sessions.push(session);
        else document.sessions[index] = session;
        await writeSessions(root, document);
        return session;
      });
    };
    const result = pendingSessionWrite.then(operation, operation);
    pendingSessionWrite = result.catch(() => {});
    return result;
  }

  async function inspect(taskId: string) {
    const state = await inspectTask(root, taskId);
    const sessions = (await readSessions(root)).sessions.filter((item) => item.taskId === taskId);
    return { ...state, sessions };
  }

  async function run({
    taskId,
    providerId,
    prompt,
    expectedRevision,
    mutationId,
    resumeSession,
    sandbox,
    approvalPolicy,
    workspaceChoice,
    worktreeRoot,
  }: RunInput) {
    assertId(taskId, 'taskId');
    assertId(providerId, 'providerId');
    if (executionProfile !== HOST_LOCAL_EXECUTION_PROFILE)
      throw new TaskControllerError(
        'Host-local execution requires explicit authorization and is not provider-sandboxed.',
        'EXECUTION_PROFILE_UNAVAILABLE',
      );
    const adapter = adapterFor(providerId, adapters);
    capability(adapter, resumeSession ? 'resume' : 'invocation');
    const provider = adapter.contract;
    const before = await inspectTask(root, taskId);
    if (before.task.state === 'cancelled')
      throw new TaskControllerError('Cancelled tasks cannot be resumed.', 'TASK_CANCELLED');
    const contracts = await contractFreshness(root, taskId);
    if (
      contracts.some(
        (item) =>
          item.expected !== item.actual || item.reconciliation !== 'current' || !item.acknowledged,
      )
    )
      throw new TaskControllerError(
        'A declared producer contract changed or is awaiting reconciliation. No provider was launched; use the existing checkpoint/stop/resume path after acknowledging the changed context.',
        'CONTRACT_RECONCILIATION_PENDING',
      );
    // Resuming reuses whatever workspace (or lack of one) the session already
    // recorded; it never re-decides, so an unrelated default change cannot
    // move an active task's workspace. A session persisted before this field
    // existed had no workspace concept, which was always direct execution.
    // A fresh start resolves the project preference (or an explicit per-task
    // override); "ask every time" with no override starts nothing.
    const workspace: SessionWorkspace = resumeSession
      ? (resumeSession.workspace ?? { mode: 'direct', path: root })
      : await (async () => {
          const choice = resolveExecutionChoice({
            projectPreference: await projectExecutionPreference(root),
            override: workspaceChoice,
          });
          if (choice.decision === 'undecided')
            throw new TaskControllerError(
              'This project asks for a worktree-or-direct choice before every new task. Pass an explicit workspaceChoice to start it.',
              'WORKSPACE_CHOICE_REQUIRED',
            );
          if (choice.decision === 'direct') return { mode: 'direct', path: root };
          const created = await createTaskWorkspace(root, {
            taskId,
            ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
          });
          if ('capability' in created && created.capability === 'unavailable')
            throw new TaskControllerError(
              `Worktree isolation is unavailable (${created.code}). Choose direct execution or resolve the Git environment.`,
              'WORKSPACE_UNAVAILABLE',
            );
          if (!('path' in created))
            throw new TaskControllerError(
              'Worktree isolation did not return a workspace path.',
              'WORKSPACE_UNAVAILABLE',
            );
          return { mode: 'isolated', path: created.path };
        })();
    const cwd = workspace.path;
    // Version inspection is a bounded, model-free command only inside an
    // explicitly authorized start/resume. Re-probe on resume after upgrades.
    let providerVersion: string | null = null;
    const usageEnabled =
      ['claude', 'codex'].includes(providerId) &&
      (await readUsageState(root)
        .then((state) => state.settings.enabled)
        .catch(() => false));
    if (providerId === 'antigravity' || usageEnabled) {
      const version = await launch({
        provider,
        plan: { executable: provider.command, args: ['--version'], cwd: root },
        executionProfile,
        timeoutMs: 5000,
        outputLimitBytes: 4096,
      });
      if (version.status === 'exited' && version.exitCode === 0)
        providerVersion =
          providerId === 'antigravity'
            ? parseAntigravityVersion(version.stdout)
            : (version.stdout
                ?.trim()
                .match(
                  /^(?:(?:codex(?:-cli)?|claude)\s+)?v?(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/i,
                )?.[1] ?? null);
    }
    const planResult = resumeSession
      ? adapter.operations.planResume({
          sessionId: resumeSession.providerSessionId,
          prompt: prompt ?? before.task.title,
          cwd,
          sandbox,
          approvalPolicy,
          ...(providerId === 'antigravity' ? { providerVersion } : {}),
        })
      : adapter.operations.planInvocation({
          prompt: prompt ?? before.task.title,
          cwd,
          sandbox,
          approvalPolicy,
        });
    const planned = planResult as { supported?: boolean; command?: unknown; reason?: string };
    if (planned?.supported === false || planned?.command === null)
      throw new TaskControllerError(
        planned.reason ?? 'Provider operation is unavailable.',
        'CAPABILITY_UNAVAILABLE',
      );
    const plan = validateCommandPlan(planResult);
    const fenceOwnerId = `owner_${randomUUID()}`;
    const fenceActionId = `action_${randomUUID()}`;
    await claimExecutionFence(root, {
      taskId,
      ownerId: fenceOwnerId,
      actionId: fenceActionId,
      kind: 'direct',
    });
    try {
      const task = await resumeTask(root, {
        taskId,
        expectedRevision: expectedRevision ?? before.task.revision,
        ...(mutationId ? { mutationId } : {}),
      });
      const runId = task.owner?.runId;
      if (!runId)
        throw new TaskControllerError(
          'Task run ownership was not acquired.',
          'TASK_OWNERSHIP_CONFLICT',
        );
      // Best-effort context-brief binding (issue #112) for the direct task-controller dispatch
      // path, mirroring the delivery workflow's own binding in src/workflows/service.ts#invoke.
      // A failure here (an unexpected brief-building error, not a deliberate budget refusal) never
      // blocks starting/resuming a direct session; the digest is recorded as `null` instead of
      // guessed at.
      const contextBriefDigest = await buildContextBrief(root, { taskId })
        .then((brief) => brief.digest)
        .catch(() => null);
      const session: TaskSession = {
        id: `session_${randomUUID()}`,
        providerSessionId: resumeSession?.providerSessionId ?? null,
        taskId,
        runId,
        providerId,
        state: 'launching',
        executionBoundary: executionProfile,
        process: null,
        eventIds: [],
        result: null,
        workspace,
        contextBriefDigest,
        contractFreshness: contracts,
        createdAt: now(),
        updatedAt: now(),
      };
      await save(session);
      const abort = new AbortController();
      ACTIVE.set(key(root, taskId), { abort, sessionId: session.id, runId });
      let pendingEventWrite: Promise<void> = Promise.resolve();
      let eventWriteFailure: { error: unknown } | undefined;
      try {
        const processResult = await launch({
          provider,
          plan,
          executionProfile,
          signal: abort.signal,
          onEvent: (event) => {
            if (event.type !== 'process-start') return;
            session.state = 'running';
            session.process = {
              pid: event.pid ?? null,
              hostname: os.hostname(),
              platform: process.platform,
            };
            session.updatedAt = now();
            // Observe rejection immediately and retain the drain promise. A
            // failed ownership write must stop this child, not escape globally.
            pendingEventWrite = save(structuredClone(session)).then(
              () => {},
              (error: unknown) => {
                eventWriteFailure ??= { error };
                abort.abort();
              },
            );
          },
        });
        await pendingEventWrite;
        session.providerSessionId =
          providerSessionIdentity(
            providerId,
            processResult,
            providerVersion,
            session.providerSessionId,
          ) ?? session.providerSessionId;
        // This is deliberately local and opt-in. The recorder parses only bounded
        // documented result lines and never launches a provider or reads transcripts.
        await recordProviderUsage(root, {
          provider: providerId,
          providerVersion,
          sourceEventId: session.runId,
          taskId,
          sessionId: session.providerSessionId,
          output: processResult.stdout ?? '',
        }).catch(() => {});
        if (eventWriteFailure) throw eventWriteFailure.error;
        session.state = processResult.status === 'cancelled' ? 'cancelled' : 'finished';
        session.result = resultSummary(processResult);
        session.updatedAt = now();
        await save(session);
        const current = await inspectTask(root, taskId);
        if (current.task.state === 'running' && current.task.owner?.runId === runId) {
          await pauseTask(root, {
            taskId,
            expectedRevision: current.task.revision,
            state: processResult.status === 'cancelled' ? 'awaiting-decision' : 'blocked',
            reason: `Provider session ended with ${processResult.status}.`,
          });
        }
        return { task: (await inspectTask(root, taskId)).task, session, process: processResult };
      } finally {
        await pendingEventWrite;
        ACTIVE.delete(key(root, taskId));
      }
    } finally {
      await releaseExecutionFence(root, {
        taskId,
        ownerId: fenceOwnerId,
        actionId: fenceActionId,
      }).catch(() => {});
    }
  }

  async function start(input: RunInput) {
    if (input?.executionAuthorized !== true)
      throw new TaskControllerError(
        'Starting a provider session requires explicit host-local execution authorization.',
        'EXECUTION_AUTHORIZATION_REQUIRED',
      );
    return run(input);
  }

  async function resume(input: Omit<RunInput, 'providerId'> & { providerId?: string }) {
    if (input?.executionAuthorized !== true)
      throw new TaskControllerError(
        'Resuming a provider session requires explicit host-local execution authorization.',
        'EXECUTION_AUTHORIZATION_REQUIRED',
      );
    const sessions = (await readSessions(root)).sessions;
    const session = sessions.find(
      (item) => item.id === input.sessionId && item.taskId === input.taskId,
    );
    if (!session)
      throw new TaskControllerError('Session does not belong to this task.', 'SESSION_NOT_FOUND');
    if (session.state === 'cancelled')
      throw new TaskControllerError('Cancelled sessions cannot be resumed.', 'SESSION_CANCELLED');
    if (!session.providerSessionId)
      throw new TaskControllerError(
        'Provider did not expose a resumable session identity.',
        'RESUME_UNAVAILABLE',
      );
    const fence = await inspectExecutionFence(root, input.taskId);
    if (fence?.kind === 'direct') {
      const ownerLive = fence.hostname !== os.hostname() || processIsLive(fence.pid);
      const childLive =
        session.process !== null &&
        (session.process.hostname !== os.hostname() ||
          (session.process.pid ? processIsLive(session.process.pid) : false));
      if (ownerLive || childLive)
        throw new TaskControllerError(
          'The prior direct execution may still be active.',
          'TASK_EXECUTION_BUSY',
        );
      await clearExecutionFence(root, { taskId: input.taskId, actionId: fence.actionId });
    }
    return run({ ...input, providerId: session.providerId, resumeSession: session });
  }

  async function cancel({
    taskId,
    expectedRevision,
    mutationId,
    reason,
  }: {
    taskId: string;
    expectedRevision?: number;
    mutationId?: string;
    reason?: string;
  }) {
    assertId(taskId, 'taskId');
    const active = ACTIVE.get(key(root, taskId));
    const task = await inspectTask(root, taskId);
    const cancelled = await cancelTask(root, {
      taskId,
      expectedRevision: expectedRevision ?? task.task.revision,
      ...(mutationId ? { mutationId } : {}),
      ...(reason ? { reason } : {}),
    });
    // Commit cancellation before signalling the child. A late child exit then
    // observes the terminal state and cannot race the cancellation revision.
    if (active) active.abort.abort();
    const fence = await inspectExecutionFence(root, taskId);
    if (fence?.kind === 'direct')
      await clearExecutionFence(root, { taskId, actionId: fence.actionId }).catch(() => {});
    await withTaskStateLock(root, async () => {
      const document = await readSessions(root);
      for (const session of document.sessions.filter(
        (item) => item.taskId === taskId && item.state !== 'finished',
      )) {
        session.state = 'cancelled';
        session.updatedAt = now();
      }
      await writeSessions(root, document);
    });
    return { task: cancelled, cancelledProcess: Boolean(active) };
  }

  async function observe(event: LifecycleEnvelope) {
    event = validateLifecycleEnvelope(event);
    const observed = await withTaskStateLock(root, async () => {
      const document = await readSessions(root);
      const session = document.sessions.find(
        (item) =>
          item.id === event.correlation.sessionId && item.taskId === event.correlation.taskId,
      );
      if (!session || session.providerId !== event.provider.id)
        return {
          response: {
            status: 'unauthorized',
            decision: 'advisory',
            reason: 'Unknown task/session correlation.',
          },
        };
      if (session.eventIds.includes(event.eventId))
        return { response: { status: 'duplicate', decision: 'advisory' } };
      session.eventIds.push(event.eventId);
      session.eventIds = session.eventIds.slice(-128);
      session.updatedAt = now();
      await writeSessions(root, document);
      return { session };
    });
    if (observed.response) return observed.response;
    const { session } = observed;
    const task = await inspectTask(root, event.correlation.taskId);
    if (task.task.state === 'cancelled')
      return {
        status: 'cancelled',
        decision: 'advisory',
        reason: 'Cancelled runs ignore late events.',
      };
    const result = await gateHandler(task.task, event);
    if (event.kind === 'session-terminated') {
      await checkpointTask(root, {
        taskId: task.task.id,
        runId: session.runId,
        expectedRevision: task.task.revision,
        summary: 'Provider reported session termination; acceptance remains unverified.',
      }).catch(() => {});
    }
    return { status: 'handled', result: result ?? { decision: 'advisory' } };
  }

  return Object.freeze({ start, resume, cancel, inspect, observe });
}

export async function readTaskSessions(root: string): Promise<TaskSession[]> {
  return (await readSessions(path.resolve(root))).sessions;
}
