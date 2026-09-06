#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type ProcessResult = { status: string };
type Runner = (input: Record<string, unknown>) => Promise<ProcessResult>;
type Task = { id: string };
type TaskInspection = { task: { revision: number; state: string } };
type Controller = {
  start(
    input: Record<string, unknown>,
  ): Promise<{ session: { state: string }; process: ProcessResult }>;
  inspect(taskId: string): Promise<TaskInspection>;
  cancel(input: Record<string, unknown>): Promise<{ cancelledProcess: boolean }>;
};
type InstalledModules = {
  runner: { runProviderProcess: Runner; HOST_LOCAL_EXECUTION_PROFILE: string };
  claude: { CLAUDE_CONTRACT: unknown };
  tasks: { createTask(root: string, input: Record<string, unknown>): Promise<Task> };
  controller: { createTaskController(input: Record<string, unknown>): Controller };
};

const app = process.env.LATCHKIT_QUALIFICATION_APP;
if (!app) throw new Error('LATCHKIT_QUALIFICATION_APP is required.');
const moduleAt = (file: string) => pathToFileURL(path.join(app, 'dist/src', file)).href;
const installed = {
  runner: await import(moduleAt('runtime/process-runner.js')),
  claude: await import(moduleAt('providers/claude.js')),
  tasks: await import(moduleAt('task-state/service.js')),
  controller: await import(moduleAt('runtime/task-controller.js')),
} as unknown as InstalledModules;
const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-fcc-prerequisite-'));
const plan = {
  executable: process.execPath,
  args: ['-e', 'setTimeout(() => {}, 10000)'],
  cwd: root,
};
const result: Record<string, unknown> = {};
try {
  const timeout = await installed.runner.runProviderProcess({
    provider: installed.claude.CLAUDE_CONTRACT,
    plan,
    executionProfile: installed.runner.HOST_LOCAL_EXECUTION_PROFILE,
    timeoutMs: 100,
    outputLimitBytes: 4096,
    gracePeriodMs: 100,
  });
  assert.equal(timeout.status, 'timed-out');
  result.timeout = timeout.status;
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 100);
  const cancellation = await installed.runner.runProviderProcess({
    provider: installed.claude.CLAUDE_CONTRACT,
    plan,
    executionProfile: installed.runner.HOST_LOCAL_EXECUTION_PROFILE,
    timeoutMs: 10000,
    outputLimitBytes: 4096,
    gracePeriodMs: 100,
    signal: abort.signal,
  });
  assert.equal(cancellation.status, 'cancelled');
  result.cancellation = cancellation.status;
  const task = await installed.tasks.createTask(root, {
    title: 'Deterministic owned-child cancellation prerequisite',
    authorization: { source: 'user', scope: 'temporary fixture only', reference: 'issue-105' },
  });
  const adapter = {
    contract: installed.claude.CLAUDE_CONTRACT,
    operations: { planInvocation: () => plan, planResume: () => plan },
  };
  const controller = installed.controller.createTaskController({
    root,
    adapters: new Map([['fixture', adapter]]),
  });
  const started = controller.start({
    taskId: task.id,
    providerId: 'fixture',
    executionAuthorized: true,
    workspaceChoice: 'direct',
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  const beforeCancel = await controller.inspect(task.id);
  const cancelled = await controller.cancel({
    taskId: task.id,
    expectedRevision: beforeCancel.task.revision,
  });
  const settled = await started;
  const inspected = await controller.inspect(task.id);
  assert.equal(cancelled.cancelledProcess, true);
  assert.equal(inspected.task.state, 'cancelled');
  assert.equal(settled.session.state, 'cancelled');
  assert.equal(settled.process.status, 'cancelled');
  result.taskCancellation = 'passed';
  console.log(JSON.stringify({ status: 'passed', result }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
