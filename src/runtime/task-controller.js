import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { validateCommandPlan, validateLifecycleEnvelope } from '../providers/contracts.js';
import { CLAUDE_ADAPTER } from '../providers/claude.js';
import { codexAdapter } from '../providers/codex.js';
import { ANTIGRAVITY_ADAPTER } from '../providers/antigravity.js';
import { cursorIdeAdapter } from '../providers/cursor-ide.js';
import { cursorCliAdapter } from '../providers/cursor-cli.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from './process-runner.js';
import {
  cancelTask,
  checkpointTask,
  inspectTask,
  pauseTask,
  resumeTask,
} from '../task-state/service.js';
import { withTaskStateLock } from '../task-state/lock.js';

export const TASK_SESSION_PATH = '.latchkit/tasks/sessions-v1.json';
const SESSION_SCHEMA_VERSION = 1;
const ACTIVE = new Map();
const ADAPTERS = new Map([
  ['claude', CLAUDE_ADAPTER],
  ['codex', codexAdapter],
  ['antigravity', ANTIGRAVITY_ADAPTER],
  ['cursor', cursorIdeAdapter],
  ['cursor-cli', cursorCliAdapter],
]);
const CAPABLE = new Set(['supported', 'partial']);

export class TaskControllerError extends Error {
  constructor(message, code = 'TASK_CONTROLLER_INVALID') {
    super(message);
    this.name = 'TaskControllerError';
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const key = (root, taskId) => `${path.resolve(root)}\0${taskId}`;

function redacted(value) {
  return String(value ?? '').replace(
    /\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+|\b(?:bearer|token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
    '[redacted]',
  );
}

function assertId(value, name) {
  if (typeof value !== 'string' || !value.trim())
    throw new TaskControllerError(`${name} is required.`, 'TASK_CONTROLLER_INVALID');
  return value;
}

function adapterFor(id, adapters) {
  const adapter = adapters.get(id);
  if (!adapter)
    throw new TaskControllerError(`Provider ${id} has no task adapter.`, 'PROVIDER_UNAVAILABLE');
  return adapter;
}

function capability(adapter, name) {
  const evidence = adapter.contract.capabilities[name];
  if (!CAPABLE.has(evidence?.state))
    throw new TaskControllerError(
      evidence?.reason ?? `${name} is unavailable.`,
      'CAPABILITY_UNAVAILABLE',
    );
}

async function readSessions(root) {
  try {
    const document = JSON.parse(await readFile(path.join(root, TASK_SESSION_PATH), 'utf8'));
    if (document.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(document.sessions))
      throw new TaskControllerError('Task session state is invalid.', 'TASK_SESSION_INVALID');
    return document;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: SESSION_SCHEMA_VERSION, sessions: [] };
    throw error;
  }
}

async function writeSessions(root, document) {
  const destination = path.join(root, TASK_SESSION_PATH);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function resultSummary(result) {
  return {
    status: result.status,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    outputBytes: result.outputBytes ?? 0,
    stderr: redacted(result.stderr ?? result.message ?? ''),
  };
}

function jsonRecords(value) {
  const records = [];
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

function providerSessionIdentity(providerId, result) {
  if (typeof result?.sessionId === 'string' && result.sessionId.trim()) return result.sessionId;
  const records = jsonRecords(result?.stdout);
  if (providerId === 'codex') {
    const started = records.find(
      (record) => record.type === 'thread.started' && typeof record.thread_id === 'string',
    );
    return started?.thread_id ?? null;
  }
  if (providerId === 'claude') {
    const completed = records.find(
      (record) => record.type === 'result' && typeof record.session_id === 'string',
    );
    return completed?.session_id ?? null;
  }
  if (providerId === 'antigravity' || providerId === 'cursor-cli') {
    const correlated = records.find((record) => typeof record.session_id === 'string');
    return correlated?.session_id ?? null;
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
} = {}) {
  if (!root) throw new TaskControllerError('Project root is required.');
  if (!(adapters instanceof Map)) throw new TypeError('Expected adapters map.');
  if (typeof launch !== 'function' || typeof gateHandler !== 'function')
    throw new TypeError('Expected launch and gateHandler functions.');
  root = path.resolve(root);
  let pendingSessionWrite = Promise.resolve();

  async function save(session) {
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

  async function inspect(taskId) {
    const state = await inspectTask(root, taskId);
    const sessions = (await readSessions(root)).sessions.filter((item) => item.taskId === taskId);
    return { ...state, sessions };
  }

  async function run({ taskId, providerId, prompt, expectedRevision, mutationId, resumeSession }) {
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
    const planResult = resumeSession
      ? adapter.operations.planResume({
          sessionId: resumeSession.providerSessionId,
          prompt: prompt ?? before.task.title,
          cwd: root,
        })
      : adapter.operations.planInvocation({ prompt: prompt ?? before.task.title, cwd: root });
    if (planResult?.supported === false || planResult?.command === null)
      throw new TaskControllerError(planResult.reason, 'CAPABILITY_UNAVAILABLE');
    const plan = validateCommandPlan(planResult);
    const task = await resumeTask(root, {
      taskId,
      expectedRevision: expectedRevision ?? before.task.revision,
      ...(mutationId ? { mutationId } : {}),
    });
    const runId = task.owner.runId;
    const session = {
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
      createdAt: now(),
      updatedAt: now(),
    };
    await save(session);
    const abort = new AbortController();
    ACTIVE.set(key(root, taskId), { abort, sessionId: session.id, runId });
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
          void save(session);
        },
      });
      session.providerSessionId =
        providerSessionIdentity(providerId, processResult) ?? session.providerSessionId;
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
      ACTIVE.delete(key(root, taskId));
    }
  }

  async function start(input) {
    if (input?.executionAuthorized !== true)
      throw new TaskControllerError(
        'Starting a provider session requires explicit host-local execution authorization.',
        'EXECUTION_AUTHORIZATION_REQUIRED',
      );
    return run(input);
  }

  async function resume(input) {
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
    return run({ ...input, providerId: session.providerId, resumeSession: session });
  }

  async function cancel({ taskId, expectedRevision, mutationId, reason } = {}) {
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

  async function observe(event) {
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

export async function readTaskSessions(root) {
  return (await readSessions(path.resolve(root))).sessions;
}
