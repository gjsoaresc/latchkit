import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, realpath } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { runProviderProcess } from '../dist/src/runtime/process-runner.js';
import { inspectTask } from '../dist/src/task-state/service.js';
import { scheduleDefinitionDigest } from '../dist/src/scheduler/contracts.js';
const executeFile = promisify(execFile);
import {
  cancelScheduleRun,
  createForegroundScheduler as buildScheduler,
  createSchedule,
  editSchedule,
  exportSchedules,
  inspectSchedule,
  listSchedules,
  pauseSchedule,
  removeSchedule,
  resumeSchedule,
} from '../dist/src/scheduler/service.js';
const schedulers = new Map();
function createForegroundScheduler(options) {
  const scheduler = buildScheduler(options);
  schedulers.get(options.root)?.push(scheduler);
  return scheduler;
}

async function fixture(t, at = '2026-03-08T06:30:00.000Z') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit schedule é-'));
  schedulers.set(root, []);
  t.after(async () => {
    for (const scheduler of schedulers.get(root)) await scheduler.stop();
    schedulers.delete(root);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
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
async function until(check) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await wait();
  }
  assert.fail('Condition did not settle within 5 seconds.');
}

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
  await schedulers.get(root)[0].stop();
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
  await until(() => calls === 1);
  assert.equal(calls, 1);
  assert.equal((await cancelScheduleRun(root, schedule.id, { clock })).cancelled, true);
  resolve();
  await until(
    async () => (await inspectSchedule(root, schedule.id, { clock })).runs[0].state !== 'running',
  );
  assert.equal((await inspectSchedule(root, schedule.id, { clock })).runs[0].state, 'cancelled');
  await first.stop();
  const cancelled = (await inspectSchedule(root, schedule.id, { clock })).runs[0];
  assert.equal((await inspectTask(root, cancelled.taskId)).task.state, 'cancelled');
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
  await until(
    async () => (await inspectSchedule(root, schedule.id, { clock })).runs[0].state !== 'running',
  );
  const timedOut = (await inspectSchedule(root, schedule.id, { clock })).runs[0];
  assert.equal(timedOut.state, 'timed-out', JSON.stringify(timedOut.result));
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

test('editing executable scope invalidates the prior execution authorization', async (t) => {
  const { root, clock } = await fixture(t);
  const schedule = await add(root, clock);
  const edited = await editSchedule(
    root,
    schedule.id,
    { instructions: 'Write new source files.' },
    { clock },
  );
  assert.equal(edited.authorization.executionAuthorized, false);
});

test(
  'editing through a Windows path spelling alias preserves the canonical authorized target',
  {
    skip: process.platform !== 'win32' ? 'Windows drive-letter spelling regression.' : false,
  },
  async (t) => {
    const { root, clock } = await fixture(t);
    const canonical = await realpath(root);
    const alias = `${canonical[0] === canonical[0].toLowerCase() ? canonical[0].toUpperCase() : canonical[0].toLowerCase()}${canonical.slice(1)}`;
    assert.notEqual(alias, canonical);
    assert.equal(await realpath(alias), canonical);
    const original = await add(alias, clock);
    assert.equal(original.targetProject, canonical);
    const edited = await editSchedule(alias, original.id, { everyMinutes: 30 }, { clock });
    assert.equal(edited.targetProject, canonical);
    assert.equal(edited.authorization.executionAuthorized, false);
    await resumeSchedule(alias, original.id, { clock });
    assert.equal((await listSchedules(alias)).schedules[0].targetProject, canonical);
    assert.equal((await exportSchedules(alias)).schedules[0].targetProject, canonical);
    assert.equal((await removeSchedule(alias, original.id)).removed.id, original.id);
  },
);

test('blocked scheduled execution retains an allowlisted error code without raw error data', async (t) => {
  for (const code of ['EPERM', 'test-only-secret-value']) {
    const { root, clock, setTime } = await fixture(t);
    const scheduled = await add(root, clock);
    setTime('2026-03-08T07:30:00.000Z');
    const scheduler = createForegroundScheduler({
      root,
      clock,
      runner: async () => {
        throw Object.assign(new Error('test-only-secret-value'), { code });
      },
    });
    await scheduler.tick();
    await until(
      async () => (await inspectSchedule(root, scheduled.id)).runs[0].state === 'blocked',
    );
    await scheduler.stop();
    const run = (await inspectSchedule(root, scheduled.id)).runs[0];
    assert.equal(run.result.code, code === 'EPERM' ? 'EPERM' : 'SCHEDULE_EXECUTION_FAILED');
    assert.equal(JSON.stringify(run).includes('test-only-secret-value'), false);
  }
});

test('resume and recovery cannot erase another live foreground run', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock);
  setTime('2026-03-08T07:30:00.000Z');
  let release;
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await scheduler.tick();
  await until(() => typeof release === 'function');
  try {
    await assert.rejects(resumeSchedule(root, schedule.id, { clock }), {
      code: 'SCHEDULE_RUN_ACTIVE',
    });
    await assert.rejects(createForegroundScheduler({ root, clock }).recover(), {
      code: 'SCHEDULER_ALREADY_RUNNING',
    });
  } finally {
    release({ status: 'cancelled' });
    await wait();
    await scheduler.stop();
  }
});

test('successful process exit retains a durable task and cannot claim verified delivery', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock);
  setTime('2026-03-08T07:30:00.000Z');
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: async () => ({ status: 'exited', exitCode: 0, outputBytes: 0 }),
  });
  await scheduler.tick();
  await until(
    async () => (await inspectSchedule(root, schedule.id, { clock })).runs[0].state !== 'running',
  );
  const run = (await inspectSchedule(root, schedule.id, { clock })).runs[0];
  assert.match(run.taskId ?? '', /^task_/);
  assert.equal(run.state, 'blocked');
  await scheduler.stop();
});

test('resource limits reject timer overflow and history overflow before persisting', async (t) => {
  const { root, clock } = await fixture(t);
  await assert.rejects(
    add(root, clock, { limits: { timeoutMs: 2 ** 32, outputLimitBytes: 1024, maxRuns: 1000 } }),
    { code: 'SCHEDULER_INVALID' },
  );
  assert.equal((await listSchedules(root)).schedules.length, 0);
});

test('another CLI process requests cancellation and only the owner terminates its real child', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock, {
    limits: { timeoutMs: 5000, outputLimitBytes: 1024, maxRuns: 5 },
  });
  setTime('2026-03-08T07:30:00.000Z');
  let launched = false;
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: (options) =>
      runProviderProcess({
        ...options,
        plan: {
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: root,
        },
        gracePeriodMs: 25,
        onEvent: (event) => {
          launched = true;
          options.onEvent?.(event);
        },
      }),
  });
  await scheduler.tick();
  await until(() => launched);
  const duplicate = await executeFile(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { createForegroundScheduler } from ${JSON.stringify(new URL('../dist/src/scheduler/service.js', import.meta.url).href)};
    try { await createForegroundScheduler({root: process.argv[1]}).recover(); process.exitCode = 1; }
    catch (error) { console.log(error.code); }
  `,
    root,
  ]);
  assert.match(duplicate.stdout, /SCHEDULER_ALREADY_RUNNING/);
  await executeFile(process.execPath, [
    path.resolve('dist/src/cli.js'),
    'schedule',
    'cancel',
    '--project',
    root,
    '--id',
    schedule.id,
  ]);
  await until(async () => (await inspectSchedule(root, schedule.id)).runs[0].state === 'cancelled');
  const run = (await inspectSchedule(root, schedule.id)).runs[0];
  const task = (await inspectTask(root, run.taskId)).task;
  assert.equal(task.state, 'cancelled');
  assert.ok(run.cancelRequestedAt);
  await scheduler.stop();
});

test('timeout reaches the owned process runner and stop drains it before releasing ownership', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock, {
    limits: { timeoutMs: 100, outputLimitBytes: 1024, maxRuns: 5 },
  });
  setTime('2026-03-08T07:30:00.000Z');
  let launches = 0;
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: (options) =>
      runProviderProcess({
        ...options,
        plan: {
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: root,
        },
        gracePeriodMs: 25,
        onEvent: (event) => {
          launches += 1;
          options.onEvent?.(event);
        },
      }),
  });
  await scheduler.tick();
  await until(async () => (await inspectSchedule(root, schedule.id)).runs[0].state !== 'running');
  const timedOut = (await inspectSchedule(root, schedule.id)).runs[0];
  assert.equal(timedOut.state, 'timed-out', JSON.stringify(timedOut.result));
  setTime('2026-03-08T08:30:00.000Z');
  // Terminal state can become visible before the owned promise releases its
  // overlap guard. Exercise the foreground polling contract until that drain ends.
  await until(async () => {
    await scheduler.tick();
    return launches === 2;
  });
  await scheduler.stop();
  const state = await inspectSchedule(root, schedule.id);
  assert.equal(state.runs.at(-1).state, 'cancelled');
  const replacement = createForegroundScheduler({ root, clock });
  assert.equal((await replacement.recover()).recovered, 0);
});

test('crash recovery retains interrupted task evidence and disables unproven orphan ownership', async (t) => {
  const { root, clock } = await fixture(t);
  const schedule = await add(root, clock);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createForegroundScheduler } from ${JSON.stringify(new URL('../dist/src/scheduler/service.js', import.meta.url).href)};
    const scheduler = createForegroundScheduler({root: process.argv[1], clock: () => new Date('2026-03-08T07:30:00.000Z'), runner: async () => {console.log('RUNNING'); return new Promise(() => {});}});
    await scheduler.tick();
  `,
      root,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  await until(() => output.includes('RUNNING'));
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.kill();
  await exited;
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: async () => {
      assert.fail('Orphan recovery must not launch');
    },
  });
  assert.equal((await scheduler.recover()).recovered, 1);
  const recovered = await inspectSchedule(root, schedule.id);
  assert.equal(recovered.enabled, false);
  assert.equal(recovered.runs[0].state, 'interrupted');
  assert.match(recovered.runs[0].taskId, /^task_/);
  await assert.rejects(resumeSchedule(root, schedule.id), {
    code: 'SCHEDULE_ORPHAN_REVIEW_REQUIRED',
  });
});

test('persisted target changes, oversized input and managed directory junctions are refused', async (t) => {
  const { root, clock } = await fixture(t);
  await add(root, clock);
  const statePath = path.join(root, '.latchkit/schedules/state-v1.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.schedules[0].targetProject = path.dirname(root);
  state.schedules[0].authorizedDefinitionSha256 = scheduleDefinitionDigest(state.schedules[0]);
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(listSchedules(root), { code: 'SCHEDULE_TARGET_CHANGED' });
  await writeFile(statePath, ' '.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(listSchedules(root), { code: 'SCHEDULER_INVALID' });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'latchkit schedule outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linked = await fixture(t);
  await mkdir(path.join(linked.root, '.latchkit'));
  await symlink(
    outside,
    path.join(linked.root, '.latchkit/schedules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(add(linked.root, clock), /symlink or junction/);
});

test('edited persisted definitions cannot reuse authorization and malformed JSON does not expose its bytes', async (t) => {
  const { root, clock } = await fixture(t);
  await add(root, clock);
  const statePath = path.join(root, '.latchkit/schedules/state-v1.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.schedules[0].instructions = 'Mutate production configuration.';
  await writeFile(statePath, JSON.stringify(state));
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: async () => assert.fail('Changed scope must not launch'),
  });
  await assert.rejects(scheduler.tick(), { code: 'SCHEDULE_SCOPE_CHANGED' });
  await writeFile(statePath, '{"private":"test-secret-value" invalid}');
  await assert.rejects(
    listSchedules(root),
    (error) =>
      error.code === 'SCHEDULER_INVALID_JSON' && !error.message.includes('test-secret-value'),
  );
});

test('large forward clock changes skip missed intervals and repeated unauthorized wakes stay quiet', async (t) => {
  const { root, clock, setTime } = await fixture(t);
  const schedule = await add(root, clock, {
    authorization: { scope: 'inspect only', reference: 'test', executionAuthorized: false },
  });
  setTime('2026-03-09T12:00:00.000Z');
  const scheduler = createForegroundScheduler({
    root,
    clock,
    runner: async () => assert.fail('Must not launch'),
  });
  await scheduler.tick();
  assert.equal((await inspectSchedule(root, schedule.id)).runs.length, 0);
  setTime('2026-03-09T13:00:00.000Z');
  await scheduler.tick();
  setTime('2026-03-09T14:00:00.000Z');
  await scheduler.tick();
  const current = await inspectSchedule(root, schedule.id);
  assert.equal(current.runs.length, 1);
  assert.equal(current.enabled, false);
});
