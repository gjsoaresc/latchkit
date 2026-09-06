#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  classifyQualificationFailure,
  observeClaudeOutcome,
  observeProviderProcess,
  type QualificationObservation,
} from './qualification-classification.js';
import {
  assertFccBoundLaunch,
  assertFixtureScope,
  createQualificationDeadline,
  validateArtifactBinding,
} from './qualification-guards.js';

type Action = { phase: string; status: string; inputDigest: string; resultDigest: string };
type Workflow = {
  taskId: string;
  revision: number;
  status: string;
  phase: string;
  requirements?: { digest: string };
  plan?: { digest: string; checksDigest: string };
  completedActions: Action[];
  artifacts: Array<{ phase: string; artifact: string }>;
};
type LaunchInput = {
  plan: { args: string[]; environment?: Record<string, string> };
  timeoutMs?: number;
  outputLimitBytes?: number;
  [key: string]: unknown;
};
type Controller = {
  run(input: Record<string, unknown>): Promise<{ taskId: string }>;
  wait(taskId: string): Promise<Workflow>;
  approve(input: Record<string, unknown>): Promise<unknown>;
  shutdown(): Promise<void>;
};
type Installed = {
  workflows: { createWorkflowController(input: Record<string, unknown>): Controller };
  tasks: {
    createTask(
      root: string,
      input: Record<string, unknown>,
    ): Promise<{ id: string; criteria: Array<{ id: string }> }>;
    inspectTask(
      root: string,
      taskId: string,
    ): Promise<{ task: { state: string; revision: number } }>;
  };
  acceptance: { validateAcceptanceDocument(input: unknown): unknown };
  runner: {
    runProviderProcess(input: Record<string, unknown>): Promise<unknown>;
    HOST_LOCAL_EXECUTION_PROFILE: string;
  };
  fcc: {
    inspectFcc(options?: Record<string, never>): Promise<{ managed?: { commit?: unknown } | null }>;
    runWithFccClaudeEnvironment<T>(
      options: Record<string, never>,
      callback: (input: {
        environment: Record<string, string>;
        environmentMode: 'inherit' | 'replace';
      }) => Promise<T>,
    ): Promise<T>;
  };
  reviews: { createReviewOrchestrator(input: Record<string, unknown>): unknown };
};
type Evidence = Record<string, unknown> & {
  status: 'passed' | 'failed';
  fcc: { version: string; pin: string; routedModel: string };
  phases: unknown[];
};

const app = process.env.LATCHKIT_QUALIFICATION_APP;
const output = process.env.LATCHKIT_QUALIFICATION_OUTPUT;
const retainedRoot = process.env.LATCHKIT_QUALIFICATION_FIXTURE_ROOT;
if (!app || !output)
  throw new Error('LATCHKIT_QUALIFICATION_APP and LATCHKIT_QUALIFICATION_OUTPUT are required.');
const run = promisify(execFile);
const moduleAt = (file: string) => pathToFileURL(path.join(app, 'dist/src', file)).href;
const installed = {
  workflows: await import(moduleAt('workflows/service.js')),
  tasks: await import(moduleAt('task-state/service.js')),
  acceptance: await import(moduleAt('acceptance/contracts.js')),
  runner: await import(moduleAt('runtime/process-runner.js')),
  fcc: await import(moduleAt('managed-tools/fcc.js')),
  reviews: await import(moduleAt('reviews/orchestrator.js')),
} as unknown as Installed;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const privateNode = path.join(
  path.dirname(app),
  'runtime',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const bundle = path.dirname(app);
const bundleManifest = JSON.parse(
  await readFile(path.join(bundle, 'bundle-manifest.json'), 'utf8'),
) as {
  commit?: unknown;
  dirty?: unknown;
  nodeVersion?: unknown;
  version?: unknown;
  files?: unknown;
};
const manifestFiles = Array.isArray(bundleManifest.files)
  ? bundleManifest.files.filter(
      (entry): entry is { path: string; sha256: string } =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        typeof (entry as { path?: unknown }).path === 'string' &&
        typeof (entry as { sha256?: unknown }).sha256 === 'string',
    )
  : [];
const matchesManifest = async (relative: string) => {
  const expected = manifestFiles.find((entry) => entry.path === relative)?.sha256;
  return Boolean(expected && sha256(await readFile(path.join(bundle, relative))) === expected);
};
validateArtifactBinding({
  dirty: bundleManifest.dirty,
  commit: bundleManifest.commit,
  version: bundleManifest.version,
  nodeVersion: bundleManifest.nodeVersion,
  packageVersion: JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8')).version,
  privateNodeVersion: (await run(privateNode, ['--version'], { windowsHide: true })).stdout.trim(),
  packageMatchesManifest: await matchesManifest('app/package.json'),
  runtimeMatchesManifest: await matchesManifest(
    `runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
  ),
});
const base = retainedRoot
  ? path.join(path.resolve(retainedRoot), `attempt-${randomUUID()}`)
  : await mkdtemp(path.join(os.tmpdir(), 'latchkit-fcc-workflow-'));
const root = path.join(base, 'fixture');
const evidence: Evidence = {
  schemaVersion: 2,
  kind: 'fcc-nim-code-edit-workflow-qualification',
  startedAt: new Date().toISOString(),
  installedLatchkit: { version: bundleManifest.version, commit: bundleManifest.commit },
  fcc: {
    version: '5.22.8',
    pin: 'c9b75088b09cbd3251d1e828b710cfdcd1ff3c5a',
    routedModel: 'nvidia_nim/nvidia/nemotron-3-super-120b-a12b',
  },
  bounds: {
    phaseTimeoutMs: 120000,
    totalTimeoutMs: 480000,
    outputLimitBytes: 1048576,
    maxTurns: 8,
    concurrency: 1,
    clientRetries: 0,
    modelFallbacks: 0,
  },
  billing: 'unknown; FCC upstream retries are not an aggregate cap',
  status: 'failed',
  phases: [],
};
let controller: Controller | undefined;
let retain = false;
let observation: QualificationObservation = {};
const deadline = createQualificationDeadline(480000, () => {
  void controller?.shutdown();
});
const sanitizeWorkflow = (workflow: Workflow) => ({
  status: workflow.status,
  phase: workflow.phase,
  completedActions: workflow.completedActions.map(
    ({ phase, status, inputDigest, resultDigest }) => ({
      phase,
      status,
      inputDigest,
      resultDigest,
    }),
  ),
});
try {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}\n');
  await writeFile(
    path.join(root, 'REQUIREMENTS.md'),
    'Immutable fixture requirement: multiply(left, right) returns the numeric product.\n',
  );
  await writeFile(
    path.join(root, 'src/calculator.js'),
    "export function multiply() { throw new Error('synthetic known regression'); }\n",
  );
  await writeFile(
    path.join(root, 'test/calculator.test.js'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { multiply } from '../src/calculator.js';\ntest('multiply', () => { assert.equal(multiply(3,4),12); assert.equal(multiply(-2,5),-10); assert.equal(multiply(0,9),0); });\n",
  );
  await writeFile(path.join(root, '.gitignore'), '.latchkit/\n');
  for (const args of [
    ['init', '--initial-branch=main'],
    ['config', 'user.name', 'Latchkit Qualification'],
    ['config', 'user.email', 'qualification@example.invalid'],
    ['add', '-A'],
    ['commit', '-m', 'fixture: synthetic known regression'],
  ])
    await run('git', args, { cwd: root, windowsHide: true });
  const immutable = {
    requirements: sha256(await readFile(path.join(root, 'REQUIREMENTS.md'))),
    tests: sha256(await readFile(path.join(root, 'test/calculator.test.js'))),
  };
  assert.equal(
    await run(privateNode, ['--test'], { cwd: root, windowsHide: true }).then(
      () => false,
      () => true,
    ),
    true,
    'independent failing check did not fail before the edit',
  );
  const task = await installed.tasks.createTask(root, {
    title: 'Repair the synthetic multiply regression',
    criteria: [{ description: 'Immutable calculator test passes.', required: true }],
    authorization: {
      source: 'user',
      scope: 'src/calculator.js only; requirements and test immutable',
      reference: 'issue-105 bounded live qualification',
    },
    mutationId: `event_${randomUUID()}`,
  });
  const checks = installed.acceptance.validateAcceptanceDocument({
    schemaVersion: 1,
    checks: [
      {
        id: 'multiply-test',
        criterionId: task.criteria[0]?.id,
        label: 'Run immutable calculator test',
        type: 'cli',
        timeoutMs: 30000,
        outputLimitBytes: 262144,
        plan: { executable: privateNode, args: ['--test'], cwd: root },
      },
    ],
  });
  await installed.fcc.runWithFccClaudeEnvironment({}, async ({ environment, environmentMode }) => {
    const inspectedFcc = await installed.fcc.inspectFcc({});
    if (inspectedFcc.managed?.commit !== evidence.fcc.pin) throw new Error('FCC_PIN_MISMATCH');
    const config: unknown = await fetch(`${environment.ANTHROPIC_BASE_URL}/admin/api/config`, {
      signal: AbortSignal.timeout(10000),
    }).then(async (response) => response.json());
    const fields =
      config && typeof config === 'object' && Array.isArray((config as { fields?: unknown }).fields)
        ? (config as { fields: Array<{ key?: unknown; value?: unknown }> }).fields
        : [];
    if (fields.find((field) => field.key === 'MODEL')?.value !== evidence.fcc.routedModel)
      throw new Error('FCC_ROUTE_MISMATCH');
    evidence.bridge = { ownedControllerEndpoint: true, environmentMode };
    const launch = async (input: LaunchInput) => {
      const result = (await installed.runner.runProviderProcess({
        ...input,
        plan: {
          ...input.plan,
          args: [
            ...input.plan.args,
            '--model',
            'haiku',
            '--max-turns',
            '8',
            '--no-session-persistence',
          ],
          environment: {
            ...environment,
            ...input.plan.environment,
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512',
            CLAUDE_CODE_MAX_RETRIES: '0',
            API_TIMEOUT_MS: '30000',
          },
        },
        environmentMode,
        executionProfile: installed.runner.HOST_LOCAL_EXECUTION_PROFILE,
        timeoutMs: Math.min(input.timeoutMs ?? 120000, 120000),
        outputLimitBytes: Math.min(input.outputLimitBytes ?? 1048576, 1048576),
      })) as { exitCode?: unknown; status?: unknown; stderr?: unknown; stdout?: unknown };
      const fccBaseUrl = environment.ANTHROPIC_BASE_URL;
      if (!fccBaseUrl) throw new Error('FCC_BOUND_LAUNCH_REQUIRED');
      assertFccBoundLaunch({
        args: [...input.plan.args, '--model', 'haiku', '--max-turns', '8'],
        environment: {
          ...environment,
          ...input.plan.environment,
          ANTHROPIC_BASE_URL: fccBaseUrl,
          CLAUDE_CODE_MAX_RETRIES: '0',
        },
      });
      observation = observeProviderProcess(observation, result);
      observation = observeClaudeOutcome(observation, result.stdout, JSON.stringify(checks));
      return result;
    };
    const review = installed.reviews.createReviewOrchestrator({ root, launch });
    controller = installed.workflows.createWorkflowController({ root, launch, review });
    const proposed = await controller.wait(
      (
        await controller.run({
          taskId: task.id,
          providerId: 'claude',
          reviewProviderId: 'claude',
          executionAuthorized: true,
          checksDocument: checks,
          prompt:
            'Repair only src/calculator.js. The failing test and REQUIREMENTS.md are immutable. Run the specified test. Do not create files or commits. Treat this as a synthetic known regression fixture.',
        })
      ).taskId,
    );
    evidence.preApproval = sanitizeWorkflow(proposed);
    if (proposed.status !== 'awaiting-approval' || !proposed.requirements || !proposed.plan)
      throw new Error(`PLAN_NOT_READY:${proposed.status}`);
    await controller.approve({
      taskId: task.id,
      expectedRevision: proposed.revision,
      requirementsDigest: proposed.requirements.digest,
      planDigest: proposed.plan.digest,
      checksDigest: proposed.plan.checksDigest,
      scope: 'src/calculator.js only; requirements and test immutable',
      reference: 'issue-105 explicit operator authorization',
      mutationId: `event_${randomUUID()}`,
    });
    const completed = await controller.wait(proposed.taskId);
    evidence.phases = sanitizeWorkflow(completed).completedActions;
    if (completed.status !== 'verified' || completed.phase !== 'handoff')
      throw new Error(`WORKFLOW_NOT_VERIFIED:${completed.status}:${completed.phase}`);
    await run(privateNode, ['--test'], { cwd: root, windowsHide: true });
    assert.equal(
      sha256(await readFile(path.join(root, 'REQUIREMENTS.md'))),
      immutable.requirements,
    );
    assert.equal(
      sha256(await readFile(path.join(root, 'test/calculator.test.js'))),
      immutable.tests,
    );
    const changed = (
      await run('git', ['diff', '--name-only'], { cwd: root, windowsHide: true })
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const untracked = (
      await run('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: root,
        windowsHide: true,
      })
    ).stdout.trim();
    assertFixtureScope(changed, untracked ? untracked.split(/\r?\n/) : []);
    const inspected = await installed.tasks.inspectTask(root, task.id);
    evidence.task = { state: inspected.task.state, revision: inspected.task.revision };
    evidence.handoff = completed.artifacts.some(
      (artifact) => artifact.phase === 'handoff' && artifact.artifact.trim(),
    )
      ? 'present'
      : 'missing';
    evidence.independentReview = evidence.phases.some(
      (phase) =>
        (phase as { phase: string; status: string }).phase === 'review' &&
        (phase as { status: string }).status === 'passed',
    )
      ? 'passed'
      : 'missing';
    assert.equal(evidence.independentReview, 'passed');
    assert.equal(evidence.handoff, 'present');
    evidence.finalCheck = 'passed';
    evidence.changedFiles = changed;
    evidence.status = 'passed';
  });
} catch {
  retain = true;
  evidence.failure = {
    classification: classifyQualificationFailure(observation),
    rawErrorWithheld: true,
  };
} finally {
  deadline.clear();
  evidence.finishedAt = new Date().toISOString();
  evidence.deadlineExceeded = deadline.expired();
  await controller?.shutdown().catch(() => {});
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  if (retain) {
    await writeFile(
      path.join(base, 'sanitized-status.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
  } else await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== 'passed') process.exitCode = 1;
