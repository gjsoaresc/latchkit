import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  acquireTaskStateLock,
  inspectTaskStateLock,
  withTaskStateLock,
} from '../task-state/lock.js';
import { providerById } from '../providers/registry.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';
import type { ProcessRunResult } from '../runtime/process-runner.js';
import { createTaskController } from '../runtime/task-controller.js';
import { createTask } from '../task-state/service.js';
import { resolveProjectRoot, safePath } from '../storage.js';
import {
  SchedulerError,
  scheduleDefinitionDigest,
  scheduleFailureCode,
  validateSchedulerState,
} from './contracts.js';
import type { Schedule, ScheduleRun, SchedulerState } from './contracts.js';
import { readSchedulerState, writeSchedulerState } from './store.js';
import { appendEvent } from '../diagnostics/logger.js';

type Input = {
  timezone?: string;
  everyMinutes: number;
  providerId: string;
  instructions: string;
  authorization: { scope: string; reference: string; executionAuthorized: boolean };
  limits?: Partial<Schedule['limits']>;
};
const now = (clock: () => Date) => clock().toISOString();
const due = (schedule: Schedule, time: Date) => Date.parse(schedule.nextRunAt) <= time.getTime();
const next = (schedule: Schedule, time: Date) =>
  new Date(time.getTime() + schedule.everyMinutes * 60_000).toISOString();
const clone = <T>(value: T) => structuredClone(value);

async function notifyRunState(root: string, schedule: Schedule, run: ScheduleRun): Promise<void> {
  // Keep this event intentionally small: schedules contain user instructions and
  // authorization metadata, neither of which belongs in an operational log.
  const event = {
    type: 'scheduler-run-state',
    scheduleId: schedule.id,
    runId: run.id,
    state: run.state,
    ...(run.result?.code ? { code: run.result.code } : {}),
    ...(run.taskId ? { taskId: run.taskId } : {}),
    actionable:
      run.state === 'blocked' || run.state === 'failed' || run.state === 'timed-out'
        ? 'Inspect the retained run evidence before resuming the schedule.'
        : undefined,
  };
  try {
    await appendEvent(root, event);
    if (run.state !== 'completed')
      console.error(
        `Latchkit scheduler: run ${run.id} is ${run.state}; inspect the schedule for details.`,
      );
  } catch {
    // Diagnostics are best effort. The durable run transition has already been
    // committed, and a logger failure must never reopen or launch a run.
  }
}

async function mutate<T>(
  root: string,
  clock: () => Date,
  operation: (state: SchedulerState) => T | Promise<T>,
) {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    const state = await readSchedulerState(root, { clock });
    const result = await operation(state);
    state.revision += 1;
    state.updatedAt = now(clock);
    await writeSchedulerState(root, state);
    return result;
  });
}
function schedule(state: SchedulerState, id: string) {
  const value = state.schedules.find((item) => item.id === id);
  if (!value)
    throw new SchedulerError(`Schedule ${id} does not exist.`, 'SCHEDULE_NOT_FOUND', '$.id');
  return value;
}
function cleanRun(schedule: Schedule, clock: () => Date) {
  for (const run of schedule.runs.filter((item) => item.state === 'running')) {
    run.state = 'interrupted';
    run.endedAt = now(clock);
    run.reason = 'Foreground scheduler stopped before the owned run completed.';
    schedule.enabled = false;
  }
}
function validateInput(root: string, input: Input, clock: () => Date): Schedule {
  if (
    !Number.isSafeInteger(input.everyMinutes) ||
    input.everyMinutes < 1 ||
    input.everyMinutes > 10080
  )
    throw new SchedulerError(
      'Recurrence must be between 1 and 10080 minutes.',
      'SCHEDULER_INVALID',
      '$.everyMinutes',
    );
  const at = now(clock);
  const candidate: Schedule = {
    id: `schedule_${randomUUID()}`,
    revision: 1,
    enabled: true,
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    everyMinutes: input.everyMinutes,
    nextRunAt: new Date(clock().getTime() + input.everyMinutes * 60_000).toISOString(),
    targetProject: path.resolve(root),
    providerId: input.providerId,
    instructions: input.instructions,
    authorization: input.authorization,
    authorizedDefinitionSha256: '',
    limits: {
      timeoutMs: input.limits?.timeoutMs ?? 300_000,
      outputLimitBytes: input.limits?.outputLimitBytes ?? 1_048_576,
      maxRuns: input.limits?.maxRuns ?? 100,
    },
    overlap: 'skip',
    missedRun: 'skip',
    runs: [],
    createdAt: at,
    updatedAt: at,
  };
  candidate.authorizedDefinitionSha256 = scheduleDefinitionDigest(candidate);
  const state: SchedulerState = {
    schemaVersion: 1,
    project: { id: 'validation' },
    revision: 0,
    schedules: [candidate],
    createdAt: at,
    updatedAt: at,
  };
  validateSchedulerState(state);
  if (!providerById(candidate.providerId))
    throw new SchedulerError(
      'Provider is not registered.',
      'SCHEDULE_PROVIDER_UNAVAILABLE',
      '$.providerId',
    );
  return candidate;
}

export async function createSchedule(
  root: string,
  input: Input,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  root = await resolveProjectRoot(root);
  const candidate = validateInput(root, input, clock);
  return mutate(root, clock, (state) => {
    state.schedules.push(candidate);
    return clone(candidate);
  });
}
export async function listSchedules(
  root: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  const state = await readSchedulerState(root, { clock });
  return { project: state.project, revision: state.revision, schedules: clone(state.schedules) };
}
export async function exportSchedules(
  root: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  return { schemaVersion: 1, exportedAt: now(clock), ...(await listSchedules(root, { clock })) };
}
export async function inspectSchedule(
  root: string,
  id: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  const state = await readSchedulerState(root, { clock });
  return clone(schedule(state, id));
}
export async function editSchedule(
  root: string,
  id: string,
  patch: Partial<Input> & { expectedRevision?: number },
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  return mutate(root, clock, (state) => {
    const current = schedule(state, id);
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision)
      throw new SchedulerError(
        'Schedule revision conflicts with current state.',
        'SCHEDULE_REVISION_CONFLICT',
        '$.expectedRevision',
      );
    if (current.runs.some((run) => run.state === 'running'))
      throw new SchedulerError('Cannot edit a running schedule.', 'SCHEDULE_RUN_ACTIVE', '$.id');
    const replacement = validateInput(
      // The target is not editable. Reuse the canonical identity already checked
      // by readSchedulerState, even when the caller used a Windows path alias.
      current.targetProject,
      {
        timezone: patch.timezone ?? current.timezone,
        everyMinutes: patch.everyMinutes ?? current.everyMinutes,
        providerId: patch.providerId ?? current.providerId,
        instructions: patch.instructions ?? current.instructions,
        authorization: patch.authorization ?? {
          ...current.authorization,
          executionAuthorized: false,
        },
        limits: { ...current.limits, ...patch.limits },
      },
      clock,
    );
    Object.assign(current, replacement, {
      id: current.id,
      revision: current.revision + 1,
      enabled: current.enabled,
      runs: current.runs,
      createdAt: current.createdAt,
      updatedAt: now(clock),
    });
    return clone(current);
  });
}
export async function pauseSchedule(
  root: string,
  id: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  return mutate(root, clock, (state) => {
    const current = schedule(state, id);
    current.enabled = false;
    current.revision += 1;
    current.updatedAt = now(clock);
    return clone(current);
  });
}
export async function resumeSchedule(
  root: string,
  id: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  return mutate(root, clock, (state) => {
    const current = schedule(state, id);
    if (current.runs.some((run) => run.state === 'running'))
      throw new SchedulerError('Cannot resume an owned run.', 'SCHEDULE_RUN_ACTIVE');
    if (current.runs.some((run) => run.state === 'interrupted'))
      throw new SchedulerError(
        'Interrupted process ownership requires manual review; create a new schedule after reviewing the retained task evidence.',
        'SCHEDULE_ORPHAN_REVIEW_REQUIRED',
      );
    current.enabled = true;
    current.nextRunAt = next(current, clock());
    current.revision += 1;
    current.updatedAt = now(clock);
    return clone(current);
  });
}
export async function removeSchedule(
  root: string,
  id: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  return mutate(root, clock, (state) => {
    const index = state.schedules.findIndex((item) => item.id === id);
    if (index === -1)
      throw new SchedulerError(`Schedule ${id} does not exist.`, 'SCHEDULE_NOT_FOUND', '$.id');
    if (state.schedules[index]!.runs.some((run) => run.state === 'running'))
      throw new SchedulerError(
        'Cancel and wait for the owned run before removing its schedule.',
        'SCHEDULE_RUN_ACTIVE',
      );
    const [removed] = state.schedules.splice(index, 1);
    return { removed: clone(removed!) };
  });
}
export async function cancelScheduleRun(
  root: string,
  id: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  return mutate(root, clock, (state) => {
    const current = schedule(state, id);
    const run = current.runs.findLast((item) => item.state === 'running');
    if (!run) return { cancelled: false, schedule: clone(current) };
    run.cancelRequestedAt ??= now(clock);
    run.reason =
      'Cancellation requested; waiting for the owning foreground process to stop its child.';
    current.updatedAt = now(clock);
    return { cancelled: true, schedule: clone(current) };
  });
}

export function createForegroundScheduler({
  root,
  clock = () => new Date(),
  runner = runProviderProcess,
}: {
  root: string;
  clock?: () => Date;
  runner?: typeof runProviderProcess;
}) {
  let owner: Awaited<ReturnType<typeof acquireTaskStateLock>> | null = null;
  let acquiring: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling: Promise<unknown> | null = null;
  let failure: unknown = null;
  let stopping: Promise<{ stopped: true }> | null = null;
  let resolveClosed!: (result: { error: unknown | null }) => void;
  const closed = new Promise<{ error: unknown | null }>((resolve) => {
    resolveClosed = resolve;
  });
  const active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  async function own() {
    if (stopped) throw new SchedulerError('Scheduler is stopped.', 'SCHEDULER_STOPPED');
    if (owner) return;
    if (acquiring) return acquiring;
    acquiring = (async () => {
      root = await resolveProjectRoot(root);
      // A copied or shared project cannot acquire another platform's ownership
      // record before validating its canonical target binding.
      await readSchedulerState(root, { clock });
      const lockRoot = await safePath(root, '.latchkit/schedules/owner', 'directory');
      await mkdir(lockRoot, { recursive: true });
      await safePath(root, '.latchkit/schedules/owner', 'directory');
      const inspected = await inspectTaskStateLock(lockRoot);
      if ('metadata' in inspected && inspected.metadata.hostname !== os.hostname())
        throw new SchedulerError(
          'Scheduler ownership belongs to another host and cannot be reclaimed locally.',
          'SCHEDULER_OWNER_AMBIGUOUS',
        );
      if (inspected.state === 'live')
        throw new SchedulerError(
          'Another foreground scheduler owns this project.',
          'SCHEDULER_ALREADY_RUNNING',
        );
      try {
        owner = await acquireTaskStateLock(lockRoot);
      } catch (error) {
        if ((error as { code?: string }).code === 'TASK_STATE_BUSY')
          throw new SchedulerError(
            'Another foreground scheduler owns this project.',
            'SCHEDULER_ALREADY_RUNNING',
          );
        throw error;
      }
    })();
    try {
      await acquiring;
    } finally {
      acquiring = null;
    }
  }
  async function recover() {
    await own();
    if (active.size)
      throw new SchedulerError(
        'Cannot recover while this foreground scheduler owns an active run.',
        'SCHEDULE_RUN_ACTIVE',
      );
    const recoveredRuns = await mutate(root, clock, (state) => {
      const changed: Array<{ schedule: Schedule; run: ScheduleRun }> = [];
      let recovered = 0;
      for (const item of state.schedules) {
        const running = item.runs.filter((run) => run.state === 'running');
        const before = running.length;
        cleanRun(item, clock);
        recovered += before;
        for (const run of running) changed.push({ schedule: clone(item), run: clone(run) });
        if (Date.parse(item.nextRunAt) < clock().getTime()) item.nextRunAt = next(item, clock());
      }
      return { recovered, changed };
    });
    for (const entry of recoveredRuns.changed)
      await notifyRunState(root, entry.schedule, entry.run);
    return { recovered: recoveredRuns.recovered };
  }
  async function claim(id: string): Promise<{ schedule: Schedule; run: ScheduleRun } | null> {
    return mutate(root, clock, (state) => {
      if (stopped) return null;
      const item = state.schedules.find((item) => item.id === id);
      if (!item) return null;
      if (!item.enabled || !due(item, clock())) return null;
      if (clock().getTime() - Date.parse(item.nextRunAt) >= item.everyMinutes * 60_000) {
        item.nextRunAt = next(item, clock());
        return null;
      }
      if (item.runs.some((run) => run.state === 'running')) {
        item.nextRunAt = next(item, clock());
        return null;
      }
      item.nextRunAt = next(item, clock());
      const run: ScheduleRun = {
        id: `schedule_run_${randomUUID()}`,
        taskId: null,
        cancelRequestedAt: null,
        state: item.authorization.executionAuthorized ? 'running' : 'blocked',
        startedAt: now(clock),
        endedAt: item.authorization.executionAuthorized ? null : now(clock),
        reason: item.authorization.executionAuthorized
          ? null
          : 'Explicit host-local execution authorization is absent; no provider command was started.',
        result: null,
      };
      item.runs.push(run);
      item.runs = item.runs.slice(-item.limits.maxRuns);
      if (run.state === 'blocked') item.enabled = false;
      item.updatedAt = now(clock);
      return { schedule: clone(item), run: clone(run) };
    });
  }
  async function finish(id: string, runId: string, result: ProcessRunResult, taskState?: string) {
    const finished = await mutate(root, clock, (state) => {
      const item = schedule(state, id);
      const run = item.runs.find((candidate) => candidate.id === runId);
      if (!run || run.state !== 'running') return clone(item);
      run.state =
        run.cancelRequestedAt !== null || result.status === 'cancelled'
          ? 'cancelled'
          : result.status === 'timed-out'
            ? 'timed-out'
            : result.status === 'exited' && result.exitCode === 0
              ? taskState === 'verified'
                ? 'completed'
                : 'blocked'
              : result.status === 'refused'
                ? 'blocked'
                : 'failed';
      run.endedAt = now(clock);
      run.reason = result.code
        ? `Scheduled execution ended with ${scheduleFailureCode(result)}; inspect the linked task before resuming.`
        : run.state === 'blocked'
          ? 'Provider session did not produce verified task evidence; inspect the linked task before resuming.'
          : `Owned process ended with ${result.status}.`;
      run.result = {
        status: result.status,
        exitCode: result.exitCode ?? null,
        outputBytes: result.outputBytes ?? 0,
        ...(result.code ? { code: scheduleFailureCode(result) } : {}),
      };
      item.updatedAt = now(clock);
      if (run.state === 'blocked' || run.state === 'failed') item.enabled = false;
      return clone(item);
    });
    const finalRun = finished.runs.find((candidate) => candidate.id === runId);
    if (finalRun) await notifyRunState(root, finished, finalRun);
    return finished;
  }
  async function tick() {
    if (polling) return polling as Promise<{ started: string[] }>;
    polling = tickOnce();
    try {
      return (await polling) as { started: string[] };
    } finally {
      polling = null;
    }
  }
  async function tickOnce() {
    try {
      await own();
    } catch (error) {
      if ((error as { code?: string }).code === 'SCHEDULER_ALREADY_RUNNING') return { started: [] };
      throw error;
    }
    const state = await readSchedulerState(root, { clock });
    const started: string[] = [];
    for (const item of state.schedules) {
      if (
        stopped ||
        active.size >= 1 ||
        !item.enabled ||
        !due(item, clock()) ||
        active.has(item.id)
      )
        continue;
      const claimed = await claim(item.id);
      if (!claimed) continue;
      if (claimed.run.state !== 'running') {
        await notifyRunState(root, claimed.schedule, claimed.run);
        continue;
      }
      const abort = new AbortController();
      started.push(item.id);
      const done = execute(claimed, abort)
        .catch((error) => {
          failure = error;
          void stop().catch(() => {});
        })
        .finally(() => active.delete(item.id));
      active.set(item.id, { abort, done });
    }
    return { started };
  }
  async function execute(
    claimed: { schedule: Schedule; run: ScheduleRun },
    abort: AbortController,
  ) {
    const { schedule: item, run } = claimed;
    let cancellationPoll: ReturnType<typeof setInterval> | null = null;
    let checking = false;
    let taskId: string | null = null;
    const controller = createTaskController({
      root,
      executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
      launch: (options = {}) =>
        runner({
          ...options,
          timeoutMs: Math.min(options.timeoutMs ?? item.limits.timeoutMs, item.limits.timeoutMs),
          outputLimitBytes: Math.min(
            options.outputLimitBytes ?? item.limits.outputLimitBytes,
            item.limits.outputLimitBytes,
          ),
          signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
        }),
    });
    try {
      const task = await createTask(root, {
        title: `Scheduled task ${item.id}`,
        authorization: {
          source: 'user',
          scope: item.authorization.scope,
          reference: item.authorization.reference,
          provenanceKind: 'explicit-cli',
        },
        criteria: [{ description: item.instructions, required: true }],
      });
      taskId = task.id;
      await mutate(root, clock, (state) => {
        const current = schedule(state, item.id).runs.find((candidate) => candidate.id === run.id)!;
        current.taskId = task.id;
        if (current.cancelRequestedAt !== null || stopped) abort.abort();
      });
      if (abort.signal.aborted) {
        await controller.cancel({
          taskId: task.id,
          reason: 'Scheduled run cancelled before launch.',
        });
        await finish(item.id, run.id, { status: 'cancelled' });
        return;
      }
      cancellationPoll = setInterval(() => {
        if (checking) return;
        checking = true;
        void inspectSchedule(root, item.id, { clock })
          .then((current) => {
            if (
              current.runs.find((candidate) => candidate.id === run.id)?.cancelRequestedAt !== null
            )
              abort.abort();
          })
          .catch((error) => {
            failure = error;
            abort.abort();
            void stop().catch(() => {});
          })
          .finally(() => {
            checking = false;
          });
      }, 100);
      const result = await controller.start({
        taskId: task.id,
        providerId: item.providerId,
        executionAuthorized: true,
        prompt: `Authorized scope: ${item.authorization.scope}\nAuthorization reference: ${item.authorization.reference}\n\n${item.instructions}`,
      });
      const cancellationObserved = abort.signal.aborted;
      if (cancellationObserved)
        await controller.cancel({
          taskId: task.id,
          reason: 'Scheduled run cancelled by its owner.',
        });
      const finished = await finish(
        item.id,
        run.id,
        abort.signal.aborted ? { ...result.process, status: 'cancelled' } : result.process,
        result.task.state,
      );
      // A separate CLI may commit its request between the last poll and finish.
      // Drain the linked task cancellation as well as preserving the run's state.
      if (
        !cancellationObserved &&
        finished.runs.find((candidate) => candidate.id === run.id)?.state === 'cancelled'
      )
        await controller.cancel({
          taskId: task.id,
          reason: 'Scheduled cancellation won the completion race.',
        });
    } catch (error) {
      if (taskId && abort.signal.aborted)
        await controller
          .cancel({ taskId, reason: 'Scheduled run cancelled before launch.' })
          .catch(() => {});
      await finish(item.id, run.id, {
        status: abort.signal.aborted ? 'cancelled' : 'refused',
        code: scheduleFailureCode(error),
      });
    } finally {
      if (cancellationPoll) clearInterval(cancellationPoll);
    }
  }
  async function stop(): Promise<{ stopped: true }> {
    if (stopping) return stopping;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    stopping = (async () => {
      try {
        await acquiring;
        await polling;
        for (const current of active.values()) current.abort.abort();
        await Promise.all([...active.values()].map((current) => current.done));
        if (failure) throw failure;
        return { stopped: true as const };
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        try {
          await owner?.release();
        } catch (error) {
          failure ??= error;
        }
        owner = null;
        resolveClosed({ error: failure });
      }
    })();
    return stopping;
  }
  return Object.freeze({
    recover,
    tick,
    closed,
    stop,
    async start(intervalMs = 30_000) {
      if (!Number.isInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000)
        throw new SchedulerError(
          'Foreground interval must be between 1000 and 60000 ms.',
          'SCHEDULER_INVALID',
          '$.intervalMs',
        );
      if (timer)
        throw new SchedulerError(
          'Foreground scheduler is already running.',
          'SCHEDULER_ALREADY_RUNNING',
        );
      try {
        await recover();
      } catch (error) {
        await stop().catch(() => {});
        throw error;
      }
      if (stopped)
        throw new SchedulerError('Scheduler stopped during startup.', 'SCHEDULER_STOPPED');
      timer = setInterval(() => {
        void tick().catch((error) => {
          failure = error;
          void stop().catch(() => {});
        });
      }, intervalMs);
      return { intervalMs };
    },
  });
}
