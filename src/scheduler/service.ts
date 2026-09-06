import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withTaskStateLock } from '../task-state/lock.js';
import { providerById } from '../providers/registry.js';
import { CLAUDE_ADAPTER } from '../providers/claude.js';
import { codexAdapter } from '../providers/codex.js';
import { ANTIGRAVITY_ADAPTER } from '../providers/antigravity.js';
import { cursorIdeAdapter } from '../providers/cursor-ide.js';
import { cursorCliAdapter } from '../providers/cursor-cli.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';
import type { ProcessRunResult } from '../runtime/process-runner.js';
import { SchedulerError, validateSchedulerState } from './contracts.js';
import type { Schedule, ScheduleRun, SchedulerState } from './contracts.js';
import { readSchedulerState, writeSchedulerState } from './store.js';

type Input = {
  timezone?: string;
  everyMinutes: number;
  providerId: string;
  instructions: string;
  authorization: { scope: string; reference: string; executionAuthorized: boolean };
  limits?: Partial<Schedule['limits']>;
};
type Adapter = {
  contract: unknown;
  operations: { planInvocation(options: Record<string, unknown>): unknown };
};
const adapters = new Map<string, Adapter>([
  ['claude', CLAUDE_ADAPTER as unknown as Adapter],
  ['codex', codexAdapter as unknown as Adapter],
  ['antigravity', ANTIGRAVITY_ADAPTER as unknown as Adapter],
  ['cursor', cursorIdeAdapter as unknown as Adapter],
  ['cursor-cli', cursorCliAdapter as unknown as Adapter],
]);
const active = new Map<string, AbortController>();
const now = (clock: () => Date) => clock().toISOString();
const key = (root: string, id: string) => `${path.resolve(root)}\0${id}`;
const due = (schedule: Schedule, time: Date) => Date.parse(schedule.nextRunAt) <= time.getTime();
const next = (schedule: Schedule, time: Date) =>
  new Date(time.getTime() + schedule.everyMinutes * 60_000).toISOString();
const clone = <T>(value: T) => structuredClone(value);

async function mutate<T>(
  root: string,
  clock: () => Date,
  operation: (state: SchedulerState) => T | Promise<T>,
) {
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
  }
}
function validateInput(root: string, input: Input, clock: () => Date): Schedule {
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
      root,
      {
        timezone: patch.timezone ?? current.timezone,
        everyMinutes: patch.everyMinutes ?? current.everyMinutes,
        providerId: patch.providerId ?? current.providerId,
        instructions: patch.instructions ?? current.instructions,
        authorization: patch.authorization ?? current.authorization,
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
    cleanRun(current, clock);
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
  if (active.has(key(root, id)))
    throw new SchedulerError(
      'Cancel the owned run before removing its schedule.',
      'SCHEDULE_RUN_ACTIVE',
      '$.id',
    );
  return mutate(root, clock, (state) => {
    const index = state.schedules.findIndex((item) => item.id === id);
    if (index === -1)
      throw new SchedulerError(`Schedule ${id} does not exist.`, 'SCHEDULE_NOT_FOUND', '$.id');
    const [removed] = state.schedules.splice(index, 1);
    return { removed: clone(removed!) };
  });
}
export async function cancelScheduleRun(
  root: string,
  id: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
) {
  const controller = active.get(key(root, id));
  if (controller) controller.abort();
  return mutate(root, clock, (state) => {
    const current = schedule(state, id);
    const run = current.runs.findLast((item) => item.state === 'running');
    if (!run) return { cancelled: false, schedule: clone(current) };
    run.state = 'cancelled';
    run.endedAt = now(clock);
    run.reason = 'Cancelled by explicit local schedule command.';
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
  root = path.resolve(root);
  async function recover() {
    return mutate(root, clock, (state) => {
      let recovered = 0;
      for (const item of state.schedules) {
        const before = item.runs.filter((run) => run.state === 'running').length;
        cleanRun(item, clock);
        recovered += before;
        if (Date.parse(item.nextRunAt) < clock().getTime()) item.nextRunAt = next(item, clock());
      }
      return { recovered };
    });
  }
  async function claim(id: string): Promise<{ schedule: Schedule; run: ScheduleRun } | null> {
    return mutate(root, clock, (state) => {
      const item = schedule(state, id);
      if (!item.enabled || !due(item, clock())) return null;
      if (item.runs.some((run) => run.state === 'running')) {
        item.nextRunAt = next(item, clock());
        return null;
      }
      item.nextRunAt = next(item, clock());
      const run: ScheduleRun = {
        id: `schedule_run_${randomUUID()}`,
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
      item.updatedAt = now(clock);
      return run.state === 'running' ? { schedule: clone(item), run: clone(run) } : null;
    });
  }
  async function finish(id: string, runId: string, result: ProcessRunResult) {
    return mutate(root, clock, (state) => {
      const item = schedule(state, id);
      const run = item.runs.find((candidate) => candidate.id === runId);
      if (!run || run.state === 'cancelled') return clone(item);
      run.state =
        result.status === 'cancelled'
          ? 'cancelled'
          : result.status === 'timed-out'
            ? 'timed-out'
            : result.status === 'exited' && result.exitCode === 0
              ? 'completed'
              : 'failed';
      run.endedAt = now(clock);
      run.reason = result.reason ?? result.message ?? null;
      run.result = {
        status: result.status,
        exitCode: result.exitCode ?? null,
        outputBytes: result.outputBytes ?? 0,
      };
      item.updatedAt = now(clock);
      return clone(item);
    });
  }
  async function tick() {
    const state = await readSchedulerState(root, { clock });
    const started: string[] = [];
    for (const item of state.schedules) {
      if (!item.enabled || !due(item, clock()) || active.has(key(root, item.id))) continue;
      const claimed = await claim(item.id);
      if (!claimed) continue;
      const adapter = adapters.get(claimed.schedule.providerId);
      if (!adapter) {
        await finish(item.id, claimed.run.id, {
          status: 'refused',
          reason: 'Provider adapter is unavailable.',
        });
        continue;
      }
      let plan;
      try {
        plan = adapter.operations.planInvocation({
          prompt: claimed.schedule.instructions,
          cwd: claimed.schedule.targetProject,
        });
      } catch (error) {
        await finish(item.id, claimed.run.id, {
          status: 'refused',
          reason: error instanceof Error ? error.message : 'Provider plan was refused.',
        });
        continue;
      }
      const controller = new AbortController();
      active.set(key(root, item.id), controller);
      started.push(item.id);
      void runner({
        provider: adapter.contract,
        plan,
        executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
        timeoutMs: claimed.schedule.limits.timeoutMs,
        outputLimitBytes: claimed.schedule.limits.outputLimitBytes,
        signal: controller.signal,
      })
        .then((result) => finish(item.id, claimed.run.id, result))
        .catch((error) =>
          finish(item.id, claimed.run.id, {
            status: 'spawn-failed',
            message: error instanceof Error ? error.message : 'Scheduled runner failed.',
          }),
        )
        .finally(() => active.delete(key(root, item.id)));
    }
    return { started };
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  return Object.freeze({
    recover,
    tick,
    start(intervalMs = 30_000) {
      if (!Number.isInteger(intervalMs) || intervalMs < 1_000)
        throw new SchedulerError(
          'Foreground interval must be at least 1000 ms.',
          'SCHEDULER_INVALID',
          '$.intervalMs',
        );
      if (timer)
        throw new SchedulerError(
          'Foreground scheduler is already running.',
          'SCHEDULER_ALREADY_RUNNING',
        );
      timer = setInterval(() => void tick(), intervalMs);
      return { intervalMs };
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const [owned, controller] of active)
        if (owned.startsWith(`${root}\0`)) controller.abort();
      return { stopped: true };
    },
  });
}
