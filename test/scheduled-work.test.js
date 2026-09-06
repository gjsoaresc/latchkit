import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cancelScheduleRun,
  createForegroundScheduler,
  createSchedule,
  editSchedule,
  exportSchedules,
  inspectSchedule,
  listSchedules,
  pauseSchedule,
  removeSchedule,
  resumeSchedule,
} from '../dist/src/scheduler/service.js';

async function fixture(t, at = '2026-03-08T06:30:00.000Z') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit schedule é-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let time = new Date(at);
  const clock = () => new Date(time);
  return {
    root,
    clock,
    setTime(value) {
      time = new Date(value);
    },
  };
}
async function add(root, clock, overrides = {}) {
  return createSchedule(
    root,
    {
      timezone: 'America/New_York',
      everyMinutes: 60,
      providerId: 'codex',
      instructions: 'Inspect only the scoped task.',
      authorization: {
        scope: 'inspect only',
        reference: 'explicit test authorization',
        executionAuthorized: true,
      },
      limits: { timeoutMs: 1000, outputLimitBytes: 1024, maxRuns: 5 },
      ...overrides,
    },
    { clock },
  );
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 25));

test('uses an injected UTC clock across DST and skips missed or rolled-back time', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock);
  assert.equal(schedule.nextRunAt, '2026-03-08T07:30:00.000Z');
  setTime('2026-03-08T05:30:00.000Z');
  const runner = async () => {
    throw new Error('clock rollback must not launch');
  };
  assert.deepEqual(await createForegroundScheduler({ root, clock, runner }).tick(), {
    started: [],
  });
  setTime('2026-03-09T12:00:00.000Z');
  const recovered = await createForegroundScheduler({ root, clock, runner }).recover();
  assert.equal(recovered.recovered, 0);
  assert.equal(
    (await inspectSchedule(root, schedule.id, { clock })).nextRunAt,
    '2026-03-09T13:00:00.000Z',
  );
});

test('does not launch without explicit host-local authorization and persists blocked evidence', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock, {
    authorization: { scope: 'inspect only', reference: 'test', executionAuthorized: false },
  });
  setTime('2026-03-08T07:30:00.000Z');
  let calls = 0;
  await createForegroundScheduler({
    root,
    clock,
    runner: async () => {
      calls += 1;
      return { status: 'exited', exitCode: 0 };
    },
  }).tick();
  assert.equal(calls, 0);
  assert.equal((await inspectSchedule(root, schedule.id, { clock })).runs[0].state, 'blocked');
});

test('duplicate foreground schedulers prevent overlap, cancellation owns only its run, and late result cannot complete it', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock);
  setTime('2026-03-08T07:30:00.000Z');
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  let calls = 0;
  const runner = async ({ signal }) => {
    calls += 1;
    await pending;
    return { status: signal.aborted ? 'cancelled' : 'exited', exitCode: 0, outputBytes: 3 };
  };
  const first = createForegroundScheduler({ root, clock, runner });
  const second = createForegroundScheduler({ root, clock, runner });
  assert.deepEqual(await first.tick(), { started: [schedule.id] });
  assert.deepEqual(await second.tick(), { started: [] });
  assert.equal(calls, 1);
  assert.equal((await cancelScheduleRun(root, schedule.id, { clock })).cancelled, true);
  resolve();
  await wait();
  await wait();
  assert.equal((await inspectSchedule(root, schedule.id, { clock })).runs[0].state, 'cancelled');
});

test('timeout, pause/edit/resume/remove, and bounded history remain inspectable', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock);
  setTime('2026-03-08T07:30:00.000Z');
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: async () => ({ status: 'timed-out', exitCode: null, outputBytes: 8 }),
  });
  await scheduler.tick();
  await wait();
  assert.equal((await inspectSchedule(root, schedule.id, { clock })).runs[0].state, 'timed-out');
  await pauseSchedule(root, schedule.id, { clock });
  const edited = await editSchedule(
    root,
    schedule.id,
    { instructions: 'Read only changed files.', expectedRevision: 2 },
    { clock },
  );
  assert.equal(edited.instructions, 'Read only changed files.');
  await resumeSchedule(root, schedule.id, { clock });
  assert.equal((await listSchedules(root, { clock })).schedules.length, 1);
  assert.equal((await exportSchedules(root, { clock })).schedules[0].runs[0].state, 'timed-out');
  assert.equal((await removeSchedule(root, schedule.id, { clock })).removed.id, schedule.id);
  assert.equal((await listSchedules(root, { clock })).schedules.length, 0);
});
