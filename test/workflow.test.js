import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  AgentOutcome,
  WorkflowOutcome,
  WorkflowSnapshot,
  next_step_async,
  parse_agent_outcome_async,
  policy_version_async,
} from '../dist/src/workflows/policy.js';
import { createWorkflowController } from '../dist/src/workflows/service.js';
import { assertWorkflowRecord } from '../dist/src/workflows/contracts.js';
import { mutateWorkflow, readWorkflow } from '../dist/src/workflows/store.js';
import { claimExecutionFence, releaseExecutionFence } from '../dist/src/runtime/execution-fence.js';
import { createTaskController } from '../dist/src/runtime/task-controller.js';
import { createTask } from '../dist/src/task-state/service.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const source = (name) => ({ revision: null, dirtyFingerprint: name ? hash(name) : null });

function harness() {
  const criterionId = `criterion_${randomUUID()}`;
  let currentSource = source('initial');
  let verificationCalls = 0;
  let implementationGate = null;
  let implementationStarted = null;
  let ignoreImplementationAbort = false;
  let malformedImplementation = false;
  let verificationStarted = null;
  let holdVerification = false;
  let completionGate = null;
  let completionStarted = null;
  const calls = [];
  const task = {
    id: `task_${randomUUID()}`,
    title: 'Build the fixture',
    state: 'planned',
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    authorizationRequired: false,
    authorizations: [],
    owner: null,
    criteria: [
      {
        id: criterionId,
        revision: 1,
        description: 'Fixture works',
        required: true,
        approvalRequired: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    runs: [],
    checkpoints: [],
    evidence: [],
    events: [],
    import: null,
  };
  const tasks = {
    create: async () => task,
    inspect: async () => ({
      task: structuredClone(task),
      reconciliation: {
        currentSource,
        verifiable: task.evidence.length > 0,
        verificationFailures: [],
      },
    }),
    resume: async (_root, input) => {
      task.state = 'running';
      task.revision += 1;
      task.owner = { runId: `run_${randomUUID()}`, ownerId: input.ownerId };
      return structuredClone(task);
    },
    cancel: async () => {
      task.state = 'cancelled';
      task.owner = null;
      task.revision += 1;
      return structuredClone(task);
    },
    complete: async () => {
      completionStarted?.();
      if (completionGate) await completionGate;
      task.state = 'completed';
      task.owner = null;
      task.revision += 1;
      return structuredClone(task);
    },
    verify: async () => {
      task.state = 'verified';
      task.revision += 1;
      return structuredClone(task);
    },
    source: async () => structuredClone(currentSource),
  };
  const checks = {
    schemaVersion: 1,
    checks: [
      {
        id: 'fixture-check',
        criterionId,
        label: 'Inspect fixture result',
        type: 'manual',
        instructions: 'Inspect the deterministic fixture.',
      },
    ],
  };
  const adapter = {
    contract: {
      id: 'fixture',
      capabilities: {
        invocation: { state: 'supported' },
        readonly: { state: 'supported' },
      },
    },
    operations: {
      planInvocation: (options) => {
        calls.push({ type: 'plan', options });
        return { executable: process.execPath, args: ['--version'], cwd: options.cwd };
      },
    },
  };
  const launch = async ({ plan, signal }) => {
    const prompt = calls.findLast((item) => item.type === 'plan' && item.options)?.options.prompt;
    const phase = /requirements phase/.test(prompt)
      ? 'requirements'
      : /plan phase/.test(prompt)
        ? 'plan'
        : /implementation phase/.test(prompt)
          ? 'implementation'
          : 'handoff';
    calls.push({ type: 'launch', phase, plan });
    if (phase === 'implementation') {
      currentSource = source(`implementation-${calls.length}`);
      implementationStarted?.();
      if (implementationGate) {
        if (ignoreImplementationAbort) await implementationGate;
        else
          await Promise.race([
            implementationGate,
            new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true })),
          ]);
        if (signal?.aborted && !ignoreImplementationAbort)
          return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
      }
    }
    if (phase === 'implementation' && malformedImplementation)
      return { status: 'exited', exitCode: 0, stdout: '{', stderr: '' };
    return {
      status: 'exited',
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'ready',
        summary: `${phase} ready`,
        artifact: `${phase} artifact`,
        questions: [],
        checks_json: phase === 'plan' ? JSON.stringify(checks) : '',
      }),
      stderr: '',
    };
  };
  const acceptance = {
    verify: async ({ signal, document } = {}) => {
      verificationCalls += 1;
      task.evidence.push({
        id: `evidence_${randomUUID()}`,
        criterionId,
        criterionRevision: 1,
        runId: task.owner?.runId,
        command: document?.checks?.[0]?.label,
        outcome: 'passed',
        source: structuredClone(currentSource),
        createdAt: new Date().toISOString(),
      });
      verificationStarted?.(task.evidence.at(-1).id);
      if (holdVerification) {
        holdVerification = false;
        await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
        throw new Error('verification interrupted');
      }
      return { status: 'passed' };
    },
    cancel: () => {},
  };
  const review = {
    run: async () => ({
      state: 'completed',
      sourceSnapshot: structuredClone(currentSource),
      findings: [],
      reviewers: [
        {
          state: 'completed',
          sourceSnapshot: structuredClone(currentSource),
          process: { status: 'exited', exitCode: 0 },
          result: { state: 'completed' },
        },
      ],
    }),
  };
  return {
    task,
    tasks,
    adapter,
    launch,
    acceptance,
    review,
    calls,
    get verificationCalls() {
      return verificationCalls;
    },
    failVerification() {
      acceptance.verify = async () => {
        verificationCalls += 1;
        return { status: 'failed' };
      };
    },
    failReviewWithoutFindings() {
      review.run = async () => ({
        state: 'completed',
        sourceSnapshot: structuredClone(currentSource),
        findings: [],
        reviewers: [
          {
            state: 'failed',
            sourceSnapshot: structuredClone(currentSource),
            process: { status: 'exited', exitCode: 1 },
            result: { state: 'failed' },
          },
        ],
      });
    },
    addSecondCheck() {
      checks.checks.push({
        id: 'fixture-check-second',
        criterionId,
        label: 'Inspect the second fixture result',
        type: 'manual',
        instructions: 'Inspect the second deterministic fixture.',
      });
    },
    holdImplementation() {
      let release;
      const started = new Promise((resolve) => {
        implementationStarted = resolve;
      });
      implementationGate = new Promise((resolve) => {
        release = resolve;
      });
      return { started, release };
    },
    returnMalformedImplementationAfterCancellation() {
      ignoreImplementationAbort = true;
      malformedImplementation = true;
    },
    ignoreImplementationCancellation() {
      ignoreImplementationAbort = true;
    },
    holdVerification() {
      holdVerification = true;
      return new Promise((resolve) => {
        verificationStarted = resolve;
      });
    },
    holdCompletion() {
      let release;
      const started = new Promise((resolve) => {
        completionStarted = resolve;
      });
      completionGate = new Promise((resolve) => {
        release = resolve;
      });
      return { started, release };
    },
    currentSource() {
      return structuredClone(currentSource);
    },
  };
}

async function rootFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test('TypeScript policy gates plans and parses strict outcomes', async () => {
  const version = await policy_version_async();
  const action = await next_step_async(
    new WorkflowSnapshot({
      phase: 'plan',
      cancelled: false,
      approval_valid: false,
      repair_attempts: 0,
      policy_version: version,
      capability_ready: true,
      context: 'fixture',
    }),
    new WorkflowOutcome({ status: 'passed', summary: 'planned' }),
  );
  assert.equal(action.kind, 'await-approval');
  assert.deepEqual(
    await parse_agent_outcome_async(
      JSON.stringify({
        status: 'ready',
        summary: 'done',
        artifact: 'artifact',
        questions: [],
        checks_json: '',
      }),
    ),
    new AgentOutcome({
      status: 'ready',
      summary: 'done',
      artifact: 'artifact',
      questions: [],
      checks_json: '',
    }),
  );
});

test('workflow state rejects null documents, invalid enums and asynchronous lock callbacks', async (t) => {
  const invalidRoot = await rootFixture(t);
  const statePath = path.join(invalidRoot, '.latchkit', 'workflows', 'state-v1.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, 'null\n');
  await assert.rejects(readWorkflow(invalidRoot, `task_${randomUUID()}`), {
    code: 'WORKFLOW_STATE_INVALID',
  });

  const root = await rootFixture(t);
  const fixture = harness();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const created = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(created.taskId);
  assert.throws(() => assertWorkflowRecord({ ...planned, status: 'invented' }), {
    code: 'WORKFLOW_STATE_INVALID',
  });
  await assert.rejects(
    mutateWorkflow(root, planned.taskId, planned.revision, async () => {}),
    { code: 'WORKFLOW_MUTATION_INVALID' },
  );
  assert.equal((await controller.inspect(planned.taskId)).revision, planned.revision);
});

test('persisted workflows refuse a changed emitted policy before approval or execution', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  const changed = await mutateWorkflow(root, planned.taskId, planned.revision, (record) => {
    record.policyDigest = '0'.repeat(64);
  });
  await assert.rejects(
    controller.approve({
      taskId: planned.taskId,
      expectedRevision: changed.revision,
      planDigest: planned.plan.digest,
      requirementsDigest: planned.requirements.digest,
      checksDigest: planned.plan.checksDigest,
      scope: 'implement exact plan',
      reference: 'test approval',
    }),
    { code: 'WORKFLOW_POLICY_CHANGED' },
  );
  assert.equal((await controller.inspect(planned.taskId)).policyDigest, '0'.repeat(64));
  const cancelled = await controller.cancel({
    taskId: planned.taskId,
    expectedRevision: changed.revision,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('an explicit run resumes a journal-free running checkpoint after restart', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const options = {
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  };
  const controller = createWorkflowController(options);
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  const checkpoint = await mutateWorkflow(root, planned.taskId, planned.revision, (record) => {
    record.status = 'running';
  });
  const recovered = createWorkflowController(options);
  await recovered.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const resumed = await recovered.wait(checkpoint.taskId);
  assert.equal(resumed.status, 'awaiting-approval');
  assert.equal(resumed.pendingAction, null);
});

test('workflow persists exact approval and completes only after verification, review and handoff', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  assert.equal(planned.status, 'awaiting-approval');
  await assert.rejects(
    claimExecutionFence(root, {
      taskId: planned.taskId,
      ownerId: `owner_${randomUUID()}`,
      actionId: `action_${randomUUID()}`,
      kind: 'direct',
    }),
    { code: 'TASK_EXECUTION_BUSY' },
  );
  await assert.rejects(
    controller.approve({
      taskId: planned.taskId,
      expectedRevision: planned.revision,
      planDigest: '0'.repeat(64),
      requirementsDigest: planned.requirements.digest,
      checksDigest: planned.plan.checksDigest,
      scope: 'implement exact plan',
      reference: 'test approval',
    }),
    { code: 'WORKFLOW_APPROVAL_STALE' },
  );
  const approved = await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  assert.equal(approved.approval.planDigest, planned.plan.digest);
  const completed = await controller.wait(planned.taskId);
  assert.equal(completed.status, 'verified');
  assert.equal(fixture.task.state, 'verified');
  assert.equal(fixture.verificationCalls, 1);
  assert.deepEqual(
    fixture.calls.filter((item) => item.type === 'launch').map((item) => item.phase),
    ['requirements', 'plan', 'implementation', 'handoff'],
  );
});

test('verification failures reserve and enforce the durable three-repair budget', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  fixture.failVerification();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  const blocked = await controller.wait(planned.taskId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.repairAttempts, 3);
  assert.equal(fixture.verificationCalls, 4);
});

test('an aggregate review with failed children and no findings cannot pass', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  fixture.failReviewWithoutFindings();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  const blocked = await controller.wait(planned.taskId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.repairAttempts, 3);
  assert.equal(fixture.task.state, 'running');
});

test('cancellation commits before abort and fences a late implementation result', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const held = fixture.holdImplementation();
  fixture.ignoreImplementationCancellation();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  await held.started;
  const executing = await controller.inspect(planned.taskId);
  const peer = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  await assert.rejects(
    peer.resume({
      taskId: planned.taskId,
      expectedRevision: executing.revision,
      executionAuthorized: true,
      resolution: { actionId: executing.pendingAction.actionId, decision: 'retry' },
    }),
    { code: 'WORKFLOW_ACTION_ACTIVE' },
  );
  const cancelled = await controller.cancel({
    taskId: planned.taskId,
    expectedRevision: executing.revision,
  });
  await assert.rejects(
    claimExecutionFence(root, {
      taskId: planned.taskId,
      ownerId: `owner_${randomUUID()}`,
      actionId: `action_${randomUUID()}`,
      kind: 'direct',
    }),
    { code: 'TASK_EXECUTION_BUSY' },
  );
  held.release();
  await controller.wait(planned.taskId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await controller.inspect(planned.taskId)).status, 'cancelled');
  assert.equal(fixture.task.state, 'cancelled');
  const directOwnerId = `owner_${randomUUID()}`;
  const directActionId = `action_${randomUUID()}`;
  await claimExecutionFence(root, {
    taskId: planned.taskId,
    ownerId: directOwnerId,
    actionId: directActionId,
    kind: 'direct',
  });
  await releaseExecutionFence(root, {
    taskId: planned.taskId,
    ownerId: directOwnerId,
    actionId: directActionId,
  });
});

test('a malformed provider result arriving after cancellation cannot resurrect the workflow', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const held = fixture.holdImplementation();
  fixture.returnMalformedImplementationAfterCancellation();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  await held.started;
  const executing = await controller.inspect(planned.taskId);
  await controller.cancel({ taskId: planned.taskId, expectedRevision: executing.revision });
  held.release();
  await controller.wait(planned.taskId);
  assert.equal((await controller.inspect(planned.taskId)).status, 'cancelled');
});

test('cancellation during host completion cannot resurrect a verified workflow', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const held = fixture.holdCompletion();
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  await held.started;
  const executing = await controller.inspect(planned.taskId);
  await controller.cancel({ taskId: planned.taskId, expectedRevision: executing.revision });
  held.release();
  await controller.wait(planned.taskId);
  const cancelled = await controller.inspect(planned.taskId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.pendingAction, null);
});

test('an interrupted agent effect cannot bypass its phase and requires explicit retry', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const held = fixture.holdImplementation();
  const options = {
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  };
  const controller = createWorkflowController(options);
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  await held.started;
  await controller.shutdown();
  held.release();
  const recovered = createWorkflowController(options);
  const interrupted = await recovered.inspect(planned.taskId);
  assert.equal(interrupted.status, 'interrupted');
  assert.ok(interrupted.pendingAction);
  await assert.rejects(
    recovered.resume({
      taskId: planned.taskId,
      expectedRevision: interrupted.revision,
      executionAuthorized: true,
    }),
    { code: 'WORKFLOW_ACTION_UNCERTAIN' },
  );
  await assert.rejects(
    recovered.resume({
      taskId: planned.taskId,
      expectedRevision: interrupted.revision,
      executionAuthorized: true,
      resolution: {
        actionId: interrupted.pendingAction.actionId,
        decision: 'observed',
        evidenceId: `evidence_${randomUUID()}`,
      },
    }),
    { code: 'WORKFLOW_RESOLUTION_UNSUPPORTED' },
  );
  await recovered.resume({
    taskId: planned.taskId,
    expectedRevision: interrupted.revision,
    executionAuthorized: true,
    resolution: { actionId: interrupted.pendingAction.actionId, decision: 'retry' },
  });
  assert.equal((await recovered.wait(planned.taskId)).status, 'verified');
});

test('interrupted verification accepts only complete action-correlated check evidence', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const evidenceStarted = fixture.holdVerification();
  const options = {
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  };
  const controller = createWorkflowController(options);
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  const evidenceId = await evidenceStarted;
  await controller.shutdown();
  const recovered = createWorkflowController(options);
  const interrupted = await recovered.inspect(planned.taskId);
  assert.equal(interrupted.pendingAction.phase, 'verification');
  await recovered.resume({
    taskId: planned.taskId,
    expectedRevision: interrupted.revision,
    executionAuthorized: true,
    resolution: {
      actionId: interrupted.pendingAction.actionId,
      decision: 'observed',
      evidenceId,
    },
  });
  assert.equal((await recovered.wait(planned.taskId)).status, 'verified');
});

test('observed verification rejects partial evidence for a multi-check criterion', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  fixture.addSecondCheck();
  const evidenceStarted = fixture.holdVerification();
  const options = {
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  };
  const controller = createWorkflowController(options);
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const planned = await controller.wait(started.taskId);
  await controller.approve({
    taskId: planned.taskId,
    expectedRevision: planned.revision,
    planDigest: planned.plan.digest,
    requirementsDigest: planned.requirements.digest,
    checksDigest: planned.plan.checksDigest,
    scope: 'implement exact plan',
    reference: 'test approval',
  });
  const evidenceId = await evidenceStarted;
  await controller.shutdown();
  const recovered = createWorkflowController(options);
  const interrupted = await recovered.inspect(planned.taskId);
  await assert.rejects(
    recovered.resume({
      taskId: planned.taskId,
      expectedRevision: interrupted.revision,
      executionAuthorized: true,
      resolution: {
        actionId: interrupted.pendingAction.actionId,
        decision: 'observed',
        evidenceId,
      },
    }),
    { code: 'WORKFLOW_RESOLUTION_EVIDENCE_INVALID' },
  );
});

test('direct task execution and workflows share the durable cross-controller fence', async (t) => {
  const root = await rootFixture(t);
  const task = await createTask(root, {
    title: 'Fence fixture',
    criteria: [{ description: 'Fence holds', required: true }],
  });
  const ownerId = `owner_${randomUUID()}`;
  const actionId = `action_${randomUUID()}`;
  await claimExecutionFence(root, { taskId: task.id, ownerId, actionId, kind: 'workflow' });
  const adapter = {
    contract: {
      id: 'fixture',
      capabilities: {
        invocation: { state: 'supported' },
        resume: { state: 'supported' },
      },
    },
    operations: {
      planInvocation: () => ({ executable: process.execPath, args: ['--version'] }),
      planResume: () => ({ executable: process.execPath, args: ['--version'] }),
    },
  };
  const direct = createTaskController({
    root,
    adapters: new Map([['fixture', adapter]]),
    launch: async () => ({ status: 'exited', exitCode: 0, stdout: '', stderr: '' }),
  });
  await assert.rejects(
    direct.start({ taskId: task.id, providerId: 'fixture', executionAuthorized: true }),
    { code: 'TASK_EXECUTION_BUSY' },
  );
  await releaseExecutionFence(root, { taskId: task.id, ownerId, actionId });
});

test('a direct execution fence blocks workflow journaling before provider launch', async (t) => {
  const root = await rootFixture(t);
  const fixture = harness();
  const ownerId = `owner_${randomUUID()}`;
  const actionId = `action_${randomUUID()}`;
  await claimExecutionFence(root, {
    taskId: fixture.task.id,
    ownerId,
    actionId,
    kind: 'direct',
  });
  const controller = createWorkflowController({
    root,
    adapters: new Map([['fixture', fixture.adapter]]),
    launch: fixture.launch,
    acceptance: fixture.acceptance,
    review: fixture.review,
    tasks: fixture.tasks,
  });
  const started = await controller.run({
    taskId: fixture.task.id,
    providerId: 'fixture',
    reviewProviderId: 'fixture-review',
    executionAuthorized: true,
  });
  const blocked = await controller.wait(started.taskId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(fixture.calls.filter((item) => item.type === 'launch').length, 0);
  await releaseExecutionFence(root, { taskId: fixture.task.id, ownerId, actionId });
});
