import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentOutcome,
  WorkflowOutcome,
  WorkflowSnapshot,
  next_step_async,
  parse_agent_outcome_async,
  policy_version_async,
  type WorkflowAction,
  type WorkflowPhase,
} from '../baml_sdk/index.js';
import { BYTECODE } from '../baml_sdk/_inlinedbaml.js';
import {
  validateAcceptanceDocument,
  type AcceptanceDocument,
  type AcceptanceCheck,
} from '../acceptance/contracts.js';
import { createAcceptanceVerifier } from '../acceptance/service.js';
import { CLAUDE_ADAPTER } from '../providers/claude.js';
import { codexAdapter } from '../providers/codex.js';
import { ANTIGRAVITY_ADAPTER } from '../providers/antigravity.js';
import { cursorCliAdapter } from '../providers/cursor-cli.js';
import { validateCommandPlan } from '../providers/contracts.js';
import { createReviewOrchestrator } from '../reviews/orchestrator.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';
import type { ProcessRunResult } from '../runtime/process-runner.js';
import {
  cancelTask,
  captureSource,
  completeTask,
  createTask,
  inspectTask,
  resumeTask,
  verifyTask,
} from '../task-state/service.js';
import type { SourceSnapshot, Task } from '../task-state/contracts.js';

const LIVE_ACTION_OWNERS = new Set<string>();

function actionOwnerIsLive(action: WorkflowActionJournal): boolean {
  if (action.ownerPid === process.pid) return LIVE_ACTION_OWNERS.has(action.ownerId);
  try {
    process.kill(action.ownerPid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
import {
  WorkflowError,
  boundedContext,
  canonicalJson,
  digestJson,
  sha256,
  sourceEqual,
  type CompletedWorkflowAction,
  type WorkflowActionJournal,
  type WorkflowArtifact,
  type WorkflowRecord,
} from './contracts.js';
import {
  createWorkflow,
  journalWorkflowAction,
  listWorkflows,
  mutateWorkflow,
  readWorkflow,
} from './store.js';

type ProviderAdapter = {
  contract: {
    id: string;
    capabilities: { invocation: { state: string; reason?: string } };
  };
  operations: { planInvocation(options: Record<string, unknown>): unknown };
};

type TaskServices = {
  create: typeof createTask;
  inspect: typeof inspectTask;
  resume: typeof resumeTask;
  cancel: typeof cancelTask;
  complete: typeof completeTask;
  verify: typeof verifyTask;
  source: typeof captureSource;
};

type TaskInspection = Awaited<ReturnType<TaskServices['inspect']>>;

type AcceptanceService = ReturnType<typeof createAcceptanceVerifier>;

type ReviewService = {
  run(input: Record<string, unknown>): Promise<{
    state?: unknown;
    findings?: unknown;
    sourceSnapshot?: SourceSnapshot;
    reviewers?: Array<{
      state?: string;
      sourceSnapshot?: SourceSnapshot;
      process?: { status?: string; exitCode?: number | null };
      result?: { state?: string };
    }>;
  }>;
  cancel?(input: { reviewId: string }): Promise<unknown>;
  inspect?(root: string): Promise<{
    reviews: Array<{ id: string; taskId: string; state: string }>;
  }>;
};

type PolicyService = {
  version(): Promise<string>;
  next(snapshot: WorkflowSnapshot, outcome: WorkflowOutcome): Promise<WorkflowAction>;
  parse(raw: string): Promise<AgentOutcome>;
};

export type WorkflowRunInput = {
  taskId?: string;
  prompt?: string;
  providerId: string;
  reviewProviderId?: string;
  executionAuthorized: boolean;
  expectedRevision?: number;
  mutationId?: string;
  checksDocument?: unknown;
};

export type WorkflowResumeResolution = {
  actionId: string;
  decision: 'observed' | 'abandon' | 'retry';
  evidenceId?: string;
};

export type WorkflowControllerOptions = {
  root: string;
  adapters?: Map<string, ProviderAdapter>;
  launch?: typeof runProviderProcess;
  acceptance?: AcceptanceService;
  review?: ReviewService;
  tasks?: Partial<TaskServices>;
  policy?: Partial<PolicyService>;
  clock?: () => Date;
};

const defaultAdapters = new Map<string, ProviderAdapter>([
  ['claude', CLAUDE_ADAPTER as unknown as ProviderAdapter],
  ['codex', codexAdapter as unknown as ProviderAdapter],
  ['antigravity', ANTIGRAVITY_ADAPTER as unknown as ProviderAdapter],
  ['cursor-cli', cursorCliAdapter as unknown as ProviderAdapter],
]);

const taskDefaults: TaskServices = {
  create: createTask,
  inspect: inspectTask,
  resume: resumeTask,
  cancel: cancelTask,
  complete: completeTask,
  verify: verifyTask,
  source: captureSource,
};

const policyDefaults: PolicyService = {
  version: policy_version_async,
  next: next_step_async,
  parse: parse_agent_outcome_async,
};

const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const eventId = () => id('event');

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new WorkflowError(`${name} is required.`, 'WORKFLOW_INPUT_INVALID');
  return value;
}

function normalizeMutationId(value?: string): string {
  const selected = value ?? eventId();
  if (!/^event_[0-9a-f-]{36}$/i.test(selected))
    throw new WorkflowError('mutationId must be a stable event ID.', 'WORKFLOW_INPUT_INVALID');
  return selected;
}

function requiredRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new WorkflowError(
      'expectedRevision must be a positive integer.',
      'WORKFLOW_REVISION_REQUIRED',
    );
  return value;
}

function commitMutation(
  record: WorkflowRecord,
  request: unknown,
  selectedMutationId: string,
): boolean {
  const digest = digestJson(request);
  const prior = record.mutations.find((item) => item.id === selectedMutationId);
  if (prior) {
    if (prior.digest !== digest)
      throw new WorkflowError(
        'Mutation ID was already used with different input.',
        'WORKFLOW_IDEMPOTENCY_CONFLICT',
      );
    return false;
  }
  record.mutations.push({ id: selectedMutationId, digest, revision: record.revision + 1 });
  return true;
}

function criteriaDigest(task: Task): string {
  return digestJson(
    task.criteria.map(({ id, revision, description, required, approvalRequired }) => ({
      id,
      revision,
      description,
      required,
      approvalRequired,
    })),
  );
}

function approvalValid(record: WorkflowRecord, task: Task): boolean {
  return Boolean(
    record.approval &&
    record.requirements &&
    record.plan &&
    record.approval.requirementsDigest === record.requirements.digest &&
    record.approval.planDigest === record.plan.digest &&
    record.approval.checksDigest === record.plan.checksDigest &&
    record.approval.criteriaDigest === criteriaDigest(task),
  );
}

function correlatedCheckLabel(actionId: string, check: AcceptanceCheck): string {
  return `[latchkit-workflow:${actionId}:${check.id}] ${check.label}`;
}

function correlatedChecks(document: AcceptanceDocument, actionId: string): AcceptanceDocument {
  return {
    schemaVersion: 1,
    checks: document.checks.map((check) => ({
      ...check,
      label: correlatedCheckLabel(actionId, check),
    })),
  };
}

function providerText(result: ProcessRunResult, providerId: string): string {
  const stdout = result.stdout ?? '';
  if (providerId === 'claude') {
    try {
      const envelope = JSON.parse(stdout) as { result?: unknown };
      if (typeof envelope.result === 'string') return envelope.result;
    } catch {
      return stdout;
    }
  }
  if (providerId === 'codex') {
    const records = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown } }];
        } catch {
          return [];
        }
      });
    const message = records.findLast(
      (item) => item.type === 'item.completed' && item.item?.type === 'agent_message',
    );
    if (typeof message?.item?.text === 'string') return message.item.text;
  }
  return stdout;
}

function validateAgentOutcome(outcome: AgentOutcome, phase: WorkflowPhase): void {
  if (outcome.status === 'ready') {
    if (!outcome.artifact.trim() || outcome.questions.length)
      throw new WorkflowError(
        `Ready ${phase} output requires a non-empty artifact and no questions.`,
        'WORKFLOW_OUTCOME_INVALID',
      );
  } else if (outcome.status === 'needs-input' && outcome.questions.length === 0) {
    throw new WorkflowError(
      'needs-input output requires at least one question.',
      'WORKFLOW_OUTCOME_INVALID',
    );
  }
}

function parseChecks(raw: string, task: Task): { document: unknown; digest: string } {
  if (!raw.trim())
    throw new WorkflowError('Plan output omitted acceptance checks.', 'WORKFLOW_CHECKS_INVALID');
  let proposed: unknown;
  try {
    proposed = JSON.parse(raw);
  } catch {
    throw new WorkflowError('Plan acceptance checks are invalid JSON.', 'WORKFLOW_CHECKS_INVALID');
  }
  let document: unknown;
  try {
    document = validateAcceptanceDocument(proposed);
  } catch (error) {
    throw new WorkflowError('Plan acceptance checks are invalid.', 'WORKFLOW_CHECKS_INVALID', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const checks = (document as { checks: Array<{ criterionId: string }> }).checks;
  const covered = new Set(checks.map((check) => check.criterionId));
  const missing = task.criteria.filter(
    (criterion) => criterion.required && !covered.has(criterion.id),
  );
  if (missing.length)
    throw new WorkflowError(
      'Acceptance checks do not cover every required criterion.',
      'WORKFLOW_CHECK_COVERAGE_INCOMPLETE',
      { criterionIds: missing.map((item) => item.id) },
    );
  return { document, digest: digestJson(document) };
}

function makeArtifact(phase: WorkflowPhase, outcome: AgentOutcome, at: string): WorkflowArtifact {
  return {
    phase,
    artifact: outcome.artifact,
    digest: sha256(outcome.artifact),
    summary: outcome.summary,
    createdAt: at,
  };
}

function workflowContext(record: WorkflowRecord, task: Task): string {
  return boundedContext({
    taskId: record.taskId,
    request: record.initialPrompt,
    inputs: record.inputs,
    criteria: task.criteria,
    requirements: record.requirements?.artifact ?? null,
    plan: record.plan?.artifact ?? null,
    checks: record.plan?.checks ?? record.proposedChecks,
    lastOutcome: record.lastOutcome,
    failures: record.completedActions
      .filter((item) => item.status === 'failed')
      .slice(-3)
      .map(({ phase, summary }) => ({ phase, summary })),
  });
}

function assertActionSemantics(record: WorkflowRecord, action: WorkflowAction): void {
  if (
    action.kind === 'invoke' &&
    !['requirements', 'plan', 'implementation', 'handoff'].includes(action.phase)
  )
    throw new WorkflowError('Invocation action has the wrong phase.', 'WORKFLOW_POLICY_INVALID');
  if (action.kind === 'verify' && action.phase !== 'verification')
    throw new WorkflowError('Verification action has the wrong phase.', 'WORKFLOW_POLICY_INVALID');
  if (action.kind === 'review' && action.phase !== 'review')
    throw new WorkflowError('Review action has the wrong phase.', 'WORKFLOW_POLICY_INVALID');
  if (action.repair && action.phase !== 'implementation')
    throw new WorkflowError('Repair action must target implementation.', 'WORKFLOW_POLICY_INVALID');
  if (action.repair && record.repairAttempts >= 3)
    throw new WorkflowError('Repair budget is exhausted.', 'WORKFLOW_REPAIR_LIMIT');
  if (action.kind === 'await-approval' && action.phase !== 'plan')
    throw new WorkflowError('Approval action has the wrong phase.', 'WORKFLOW_POLICY_INVALID');
  if (action.kind === 'complete' && action.phase !== 'handoff')
    throw new WorkflowError('Completion action has the wrong phase.', 'WORKFLOW_POLICY_INVALID');
}

function enforceReadOnlyPlan(
  providerId: string,
  value: unknown,
): { executable: string; args: string[]; cwd?: string; environment?: Record<string, string> } {
  let candidate = value;
  if (
    providerId === 'claude' &&
    candidate &&
    typeof candidate === 'object' &&
    Array.isArray((candidate as { args?: unknown }).args)
  ) {
    const args = [...((candidate as { args: unknown[] }).args as string[])];
    if (!args.some((arg, index) => arg === '--permission-mode' && args[index + 1] === 'plan'))
      args.push('--permission-mode', 'plan');
    candidate = { ...candidate, args };
  }
  const planned = validateCommandPlan(candidate) as {
    executable: string;
    args: string[];
    cwd?: string;
    environment?: Record<string, string>;
  };
  const codexReadOnly =
    providerId === 'codex' &&
    planned.args.some(
      (arg, index) => arg === '--sandbox' && planned.args[index + 1] === 'read-only',
    );
  const claudeReadOnly =
    providerId === 'claude' &&
    planned.args.some(
      (arg, index) => arg === '--permission-mode' && planned.args[index + 1] === 'plan',
    );
  if (!codexReadOnly && !claudeReadOnly)
    throw new WorkflowError(
      `${providerId} cannot enforce a read-only provider session.`,
      'WORKFLOW_READONLY_UNAVAILABLE',
    );
  return planned;
}

function invocationPlan(
  adapter: ProviderAdapter,
  phase: WorkflowPhase,
  prompt: string,
  root: string,
): { executable: string; args: string[]; cwd?: string; environment?: Record<string, string> } {
  const readonly = phase === 'requirements' || phase === 'plan' || phase === 'handoff';
  const proposed = adapter.operations.planInvocation({
    prompt,
    cwd: root,
    sandbox: readonly ? 'read-only' : 'workspace-write',
    approvalPolicy: 'on-request',
    permissionMode: readonly ? 'plan' : undefined,
  });
  if (readonly && (adapter.contract.id === 'codex' || adapter.contract.id === 'claude'))
    return enforceReadOnlyPlan(adapter.contract.id, proposed);
  const planned = validateCommandPlan(proposed) as {
    executable: string;
    args: string[];
    cwd?: string;
    environment?: Record<string, string>;
  };
  if (readonly) {
    const declaredReadOnly =
      (adapter.contract as { capabilities?: { readonly?: { state?: string } } }).capabilities
        ?.readonly?.state === 'supported';
    if (!declaredReadOnly)
      throw new WorkflowError(
        `${adapter.contract.id} cannot enforce a read-only ${phase} phase.`,
        'WORKFLOW_READONLY_UNAVAILABLE',
      );
  }
  return planned;
}

function matchesPending(record: WorkflowRecord, expected: WorkflowActionJournal): boolean {
  const pending = record.pendingAction;
  return Boolean(
    pending &&
    pending.actionId === expected.actionId &&
    pending.phase === expected.phase &&
    pending.inputDigest === expected.inputDigest &&
    pending.ownerId === expected.ownerId &&
    sourceEqual(pending.source, expected.source),
  );
}

export function createWorkflowController(options: WorkflowControllerOptions) {
  const root = path.resolve(requiredText(options.root, 'root'));
  const adapters = options.adapters ?? defaultAdapters;
  const launch = options.launch ?? runProviderProcess;
  const tasks: TaskServices = { ...taskDefaults, ...options.tasks };
  const policy: PolicyService = { ...policyDefaults, ...options.policy };
  const acceptance =
    options.acceptance ??
    (
      createAcceptanceVerifier as unknown as (input: {
        root: string;
        launch: typeof runProviderProcess;
      }) => AcceptanceService
    )({ root, launch });
  const reviewLaunch: typeof runProviderProcess = async (input = {}) => {
    const providerId = (input.provider as { id?: unknown } | undefined)?.id;
    if (typeof providerId !== 'string')
      return {
        status: 'refused',
        code: 'WORKFLOW_READONLY_UNAVAILABLE',
        reason: 'Reviewer provider identity is missing.',
      };
    try {
      return launch({ ...input, plan: enforceReadOnlyPlan(providerId, input.plan) });
    } catch (error) {
      return {
        status: 'refused',
        code: error instanceof WorkflowError ? error.code : 'WORKFLOW_READONLY_UNAVAILABLE',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const review =
    options.review ??
    (
      createReviewOrchestrator as unknown as (input: {
        root: string;
        launch: typeof runProviderProcess;
      }) => ReviewService
    )({ root, launch: reviewLaunch });
  const clock = options.clock ?? (() => new Date());
  const active = new Map<
    string,
    { ownerId: string; abort: AbortController; promise: Promise<WorkflowRecord> }
  >();

  const now = () => clock().toISOString();
  const currentPolicyDigest = sha256(BYTECODE);

  function assertCurrentPolicy(record: WorkflowRecord): void {
    if (record.policyDigest !== currentPolicyDigest)
      throw new WorkflowError(
        'The recorded workflow policy changed; an explicit migration is required.',
        'WORKFLOW_POLICY_CHANGED',
      );
  }

  async function workflow(taskId: string): Promise<WorkflowRecord> {
    const record = await readWorkflow(root, requiredText(taskId, 'taskId'));
    if (!record) throw new WorkflowError('Workflow was not found.', 'WORKFLOW_NOT_FOUND');
    return record;
  }

  async function markStatus(
    taskId: string,
    status: WorkflowRecord['status'],
    summary: string,
    expectedRevision?: number,
  ): Promise<WorkflowRecord> {
    return mutateWorkflow(root, taskId, expectedRevision, (record) => {
      record.status = status;
      record.lastOutcome = {
        status:
          status === 'awaiting-input'
            ? 'needs-input'
            : status === 'blocked' || status === 'interrupted'
              ? 'error'
              : record.lastOutcome.status,
        summary,
      };
    });
  }

  async function journal(
    record: WorkflowRecord,
    action: WorkflowAction,
    ownerId: string,
    actionContext: string,
  ): Promise<WorkflowActionJournal> {
    const source = await tasks.source(root);
    const pending: WorkflowActionJournal = {
      actionId: id('action'),
      kind: action.kind as 'invoke' | 'verify' | 'review' | 'complete',
      phase: action.phase,
      inputDigest: sha256(actionContext),
      ownerId,
      ownerPid: process.pid,
      source,
      repair: action.repair,
      startedAt: now(),
    };
    LIVE_ACTION_OWNERS.add(ownerId);
    try {
      await journalWorkflowAction(root, record.taskId, record.revision, (current) => {
        if (current.pendingAction)
          throw new WorkflowError('Workflow has an uncertain action.', 'WORKFLOW_ACTION_UNCERTAIN');
        current.phase = action.phase;
        current.pendingAction = pending;
        current.status = 'running';
        current.lastOutcome = { status: 'none', summary: '' };
        if (action.repair) current.repairAttempts += 1;
      });
    } catch (error) {
      LIVE_ACTION_OWNERS.delete(ownerId);
      throw error;
    }
    return pending;
  }

  async function recordForAction(actionId: string): Promise<WorkflowRecord> {
    const record = (await listWorkflows(root)).find(
      (item) => item.pendingAction?.actionId === actionId,
    );
    if (!record)
      throw new WorkflowError('Pending workflow action was not found.', 'WORKFLOW_STALE_RESULT');
    return record;
  }

  async function commitAction(
    pending: WorkflowActionJournal,
    outcome: WorkflowRecord['lastOutcome'],
    apply?: (record: WorkflowRecord, at: string) => void,
  ): Promise<WorkflowRecord> {
    const sourceAfter = await tasks.source(root);
    const found = await recordForAction(pending.actionId);
    return mutateWorkflow(root, found.taskId, undefined, (record) => {
      if (record.status === 'cancelled' || !matchesPending(record, pending)) return false;
      const at = now();
      const completed: CompletedWorkflowAction = {
        ...pending,
        status: outcome.status === 'none' ? 'error' : outcome.status,
        summary: outcome.summary,
        resultDigest: digestJson(outcome),
        sourceAfter,
        finishedAt: at,
      };
      record.pendingAction = null;
      record.completedActions.push(completed);
      record.lastOutcome = outcome;
      apply?.(record, at);
    });
  }

  async function settleCancelledAction(taskId: string, ownerId: string): Promise<void> {
    const record = await workflow(taskId);
    const pending = record.pendingAction;
    if (record.status !== 'cancelled' || !pending || pending.ownerId !== ownerId) return;
    await mutateWorkflow(root, taskId, record.revision, (current) => {
      if (
        current.status !== 'cancelled' ||
        !current.pendingAction ||
        current.pendingAction.actionId !== pending.actionId
      )
        return false;
      current.completedActions.push({
        ...current.pendingAction,
        status: 'abandoned',
        summary: 'Cancelled before a correlated result committed.',
        resultDigest: digestJson({ cancelled: true }),
        sourceAfter: current.pendingAction.source,
        finishedAt: now(),
      });
      current.pendingAction = null;
    }).catch(() => {});
  }

  async function ensureRunningTask(record: WorkflowRecord): Promise<TaskInspection> {
    let inspected = await tasks.inspect(root, record.taskId);
    if (inspected.task.state === 'running') {
      if (inspected.task.owner?.ownerId !== record.taskOwnerId)
        throw new WorkflowError(
          'The running task is owned by another execution path.',
          'WORKFLOW_OWNERSHIP_CONFLICT',
        );
      return inspected;
    }
    const task = await tasks.resume(root, {
      taskId: record.taskId,
      expectedRevision: inspected.task.revision,
      mutationId: eventId(),
      ownerId: record.taskOwnerId,
    });
    inspected = await tasks.inspect(root, task.id);
    return inspected;
  }

  async function invoke(
    record: WorkflowRecord,
    action: WorkflowAction,
    ownerId: string,
    abort: AbortController,
    task: Task,
  ): Promise<void> {
    if (!record.executionAuthorized)
      throw new WorkflowError(
        'Workflow execution requires explicit authorization.',
        'WORKFLOW_EXECUTION_AUTHORIZATION_REQUIRED',
      );
    const adapter = adapters.get(record.providerId);
    if (
      !adapter ||
      !['supported', 'partial'].includes(adapter.contract.capabilities.invocation.state)
    )
      throw new WorkflowError(
        'Provider invocation is unavailable.',
        'WORKFLOW_PROVIDER_UNAVAILABLE',
      );
    if (action.phase === 'implementation') {
      const prior = record.completedActions.at(-1);
      const explicitRetry =
        prior?.status === 'abandoned' && record.retryOfActionId === prior.actionId;
      if (!action.repair && !explicitRetry && record.approval) {
        const currentSource = await tasks.source(root);
        if (!sourceEqual(currentSource, record.approval.source))
          throw new WorkflowError(
            'Project source changed after plan approval.',
            'WORKFLOW_APPROVAL_STALE',
          );
      }
      await ensureRunningTask(record);
    }
    const actionContext = workflowContext(record, task);
    const pending = await journal(record, action, ownerId, actionContext);
    try {
      const plan = invocationPlan(adapter, action.phase, action.prompt, root);
      const result = await launch({
        provider: adapter.contract,
        plan,
        executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
        signal: abort.signal,
      });
      if (result.status !== 'exited' || result.exitCode !== 0)
        throw new WorkflowError(
          `Provider ended with ${result.status}.`,
          result.status === 'cancelled' ? 'WORKFLOW_CANCELLED' : 'WORKFLOW_PROVIDER_FAILED',
        );
      let parsed: AgentOutcome;
      try {
        parsed = await policy.parse(providerText(result, record.providerId));
        validateAgentOutcome(parsed, action.phase);
      } catch (error) {
        throw new WorkflowError(
          'Provider output did not match the workflow result contract.',
          'WORKFLOW_PROVIDER_OUTPUT_MALFORMED',
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      const checks =
        parsed.status === 'ready' && action.phase === 'plan'
          ? parseChecks(parsed.checks_json, task)
          : null;
      const status = parsed.status === 'ready' ? 'passed' : parsed.status;
      await commitAction(pending, { status, summary: parsed.summary }, (current, at) => {
        if (parsed.status === 'needs-input') {
          current.status = 'awaiting-input';
          current.inputs.push(...parsed.questions.map((question) => `Question: ${question}`));
          return;
        }
        if (parsed.status === 'failed') {
          current.status = 'blocked';
          return;
        }
        const stored = makeArtifact(action.phase, parsed, at);
        if (action.phase === 'implementation') current.retryOfActionId = null;
        current.artifacts.push(stored);
        if (action.phase === 'requirements') current.requirements = stored;
        if (action.phase === 'plan' && checks) {
          current.plan = { ...stored, checks: checks.document, checksDigest: checks.digest };
          current.approval = null;
        }
      });
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : 'WORKFLOW_PROVIDER_FAILED';
      if (code !== 'WORKFLOW_CANCELLED') {
        await commitAction(
          pending,
          {
            status: 'error',
            summary: error instanceof Error ? error.message : String(error),
          },
          (current) => {
            current.status = 'blocked';
          },
        ).catch(() => {});
      }
      throw error;
    }
  }

  async function executeVerification(
    record: WorkflowRecord,
    action: WorkflowAction,
    ownerId: string,
    abort: AbortController,
  ): Promise<void> {
    if (!record.plan)
      throw new WorkflowError('Approved checks are missing.', 'WORKFLOW_CHECKS_INVALID');
    await ensureRunningTask(record);
    const pending = await journal(record, action, ownerId, canonicalJson(record.plan.checks));
    try {
      const document = validateAcceptanceDocument(record.plan.checks);
      const result = await acceptance.verify({
        taskId: record.taskId,
        document: correlatedChecks(document, pending.actionId),
        executionAuthorized: record.executionAuthorized,
        signal: abort.signal,
      });
      if (abort.signal.aborted)
        throw new WorkflowError(
          'Verification was interrupted before its result committed.',
          'WORKFLOW_CANCELLED',
        );
      const passed = result.status === 'passed';
      await commitAction(pending, {
        status: passed ? 'passed' : 'failed',
        summary: passed ? 'Acceptance checks passed.' : 'Acceptance checks failed.',
      });
    } catch (error) {
      if (abort.signal.aborted)
        throw new WorkflowError(
          'Verification was interrupted before its result committed.',
          'WORKFLOW_CANCELLED',
        );
      await commitAction(pending, {
        status: 'failed',
        summary: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
  }

  async function executeReview(
    record: WorkflowRecord,
    action: WorkflowAction,
    ownerId: string,
    task: Task,
    abort: AbortController,
  ): Promise<void> {
    if (!record.reviewProviderId)
      throw new WorkflowError('An independent reviewer is required.', 'WORKFLOW_REVIEWER_REQUIRED');
    const pending = await journal(record, action, ownerId, workflowContext(record, task));
    try {
      const result = await review.run({
        taskId: record.taskId,
        reviewers: [
          {
            providerId: record.reviewProviderId,
            prompt: `Review the exact verified task snapshot for correctness against the approved requirements, plan, criteria and checks. Return the required structured review result.\n${workflowContext(record, task)}`,
          },
        ],
        executionAuthorized: record.executionAuthorized,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
        signal: abort.signal,
      });
      if (abort.signal.aborted)
        throw new WorkflowError(
          'Review was interrupted before its result committed.',
          'WORKFLOW_CANCELLED',
        );
      const findings = Array.isArray(result.findings)
        ? (result.findings as Array<{ severity?: string }>)
        : [];
      const sourceAfterReview = await tasks.source(root);
      const passed =
        result.state === 'completed' &&
        Boolean(result.sourceSnapshot && sourceEqual(result.sourceSnapshot, pending.source)) &&
        sourceEqual(sourceAfterReview, pending.source) &&
        Array.isArray(result.reviewers) &&
        result.reviewers.length > 0 &&
        result.reviewers.every(
          (item) =>
            item.state === 'completed' &&
            item.result?.state === 'completed' &&
            item.process?.status === 'exited' &&
            item.process.exitCode === 0 &&
            Boolean(item.sourceSnapshot && sourceEqual(item.sourceSnapshot, pending.source)),
        ) &&
        !findings.some((item) => item.severity === 'blocker' || item.severity === 'high');
      await commitAction(pending, {
        status: passed ? 'passed' : 'failed',
        summary: passed
          ? 'Independent review passed.'
          : 'Independent review found blocking issues.',
      });
    } catch (error) {
      if (abort.signal.aborted)
        throw new WorkflowError(
          'Review was interrupted before its result committed.',
          'WORKFLOW_CANCELLED',
        );
      await commitAction(pending, {
        status: 'failed',
        summary: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
  }

  async function complete(
    record: WorkflowRecord,
    action: WorkflowAction,
    ownerId: string,
    abort: AbortController,
  ): Promise<WorkflowRecord> {
    const verification = record.completedActions.findLast(
      (item) => item.phase === 'verification' && item.status === 'passed',
    );
    if (!verification)
      throw new WorkflowError(
        'Current verification evidence is missing.',
        'WORKFLOW_NOT_VERIFIABLE',
      );
    const currentSource = await tasks.source(root);
    if (!sourceEqual(currentSource, verification.sourceAfter)) {
      await mutateWorkflow(root, record.taskId, record.revision, (current) => {
        current.phase = 'verification';
        current.status = 'running';
        current.lastOutcome = {
          status: 'failed',
          summary: 'Project source changed after verification.',
        };
      });
      return workflow(record.taskId);
    }
    const inspected = await tasks.inspect(root, record.taskId);
    if (inspected.task.state === 'verified')
      return mutateWorkflow(root, record.taskId, record.revision, (current) => {
        current.status = 'verified';
        current.lastOutcome = {
          status: 'passed',
          summary: 'Workflow reconciled with the verified task state.',
        };
      });
    if (inspected.task.state === 'completed') {
      const pending = await journal(
        record,
        action,
        ownerId,
        canonicalJson({ taskRevision: inspected.task.revision, operation: 'verify-completed' }),
      );
      if (abort.signal.aborted)
        throw new WorkflowError('Completion was interrupted.', 'WORKFLOW_CANCELLED');
      await tasks.verify(root, {
        taskId: record.taskId,
        expectedRevision: inspected.task.revision,
        mutationId: eventId(),
      });
      if (abort.signal.aborted)
        throw new WorkflowError('Completion was interrupted.', 'WORKFLOW_CANCELLED');
      return commitAction(
        pending,
        { status: 'passed', summary: 'Workflow completed and verified.' },
        (current) => {
          current.status = 'verified';
        },
      );
    }
    if (
      inspected.task.state !== 'running' ||
      !inspected.task.owner ||
      inspected.task.owner.ownerId !== record.taskOwnerId
    )
      throw new WorkflowError('Task run ownership is missing.', 'WORKFLOW_OWNERSHIP_LOST');
    const owner = inspected.task.owner;
    const pending = await journal(
      record,
      action,
      ownerId,
      canonicalJson({ taskRevision: inspected.task.revision, runId: owner.runId }),
    );
    const completed = await tasks.complete(root, {
      taskId: record.taskId,
      runId: owner.runId,
      expectedRevision: inspected.task.revision,
      mutationId: eventId(),
    });
    if (abort.signal.aborted)
      throw new WorkflowError('Completion was interrupted.', 'WORKFLOW_CANCELLED');
    await tasks.verify(root, {
      taskId: record.taskId,
      expectedRevision: completed.revision,
      mutationId: eventId(),
    });
    if (abort.signal.aborted)
      throw new WorkflowError('Completion was interrupted.', 'WORKFLOW_CANCELLED');
    return commitAction(
      pending,
      { status: 'passed', summary: 'Workflow completed and verified.' },
      (current) => {
        current.status = 'verified';
      },
    );
  }

  async function drive(
    taskId: string,
    ownerId: string,
    abort: AbortController,
  ): Promise<WorkflowRecord> {
    while (true) {
      const record = await workflow(taskId);
      assertCurrentPolicy(record);
      if (
        ['awaiting-input', 'awaiting-approval', 'blocked', 'cancelled', 'verified'].includes(
          record.status,
        )
      )
        return record;
      if (record.pendingAction)
        return markStatus(
          taskId,
          'interrupted',
          'A prior action may have produced effects; resolve it before resuming.',
          record.revision,
        );
      const inspected = await tasks.inspect(root, taskId);
      const adapter = adapters.get(record.providerId);
      const capabilityReady = Boolean(
        adapter &&
        ['supported', 'partial'].includes(adapter.contract.capabilities.invocation.state),
      );
      const action = await policy.next(
        new WorkflowSnapshot({
          phase: record.phase,
          cancelled: record.status === 'cancelled',
          approval_valid: approvalValid(record, inspected.task),
          repair_attempts: record.repairAttempts,
          policy_version: record.policyVersion,
          capability_ready: capabilityReady,
          context: workflowContext(record, inspected.task),
        }),
        new WorkflowOutcome({ ...record.lastOutcome }),
      );
      assertActionSemantics(record, action);
      if (action.kind === 'await-input')
        return markStatus(taskId, 'awaiting-input', action.reason, record.revision);
      if (action.kind === 'await-approval')
        return markStatus(taskId, 'awaiting-approval', action.reason, record.revision);
      if (action.kind === 'blocked')
        return markStatus(taskId, 'blocked', action.reason, record.revision);
      if (action.kind === 'cancelled')
        return markStatus(taskId, 'cancelled', action.reason, record.revision);
      if (action.kind === 'complete') {
        const completed = await complete(record, action, ownerId, abort);
        if (completed.status === 'running') continue;
        return completed;
      }
      if (abort.signal.aborted) return workflow(taskId);
      if (action.kind === 'invoke') await invoke(record, action, ownerId, abort, inspected.task);
      else if (action.kind === 'verify') await executeVerification(record, action, ownerId, abort);
      else if (action.kind === 'review')
        await executeReview(record, action, ownerId, inspected.task, abort);
    }
  }

  function schedule(taskId: string): void {
    if (active.has(taskId)) return;
    const ownerId = id('owner');
    const abort = new AbortController();
    const promise = drive(taskId, ownerId, abort)
      .catch(async (error) => {
        const current = await workflow(taskId);
        if (current.status === 'cancelled') return current;
        return markStatus(
          taskId,
          current.pendingAction ? 'interrupted' : 'blocked',
          error instanceof Error ? error.message : String(error),
          current.revision,
        ).catch(() => workflow(taskId));
      })
      .finally(async () => {
        LIVE_ACTION_OWNERS.delete(ownerId);
        await settleCancelledAction(taskId, ownerId);
        active.delete(taskId);
      });
    active.set(taskId, { ownerId, abort, promise });
  }

  async function run(input: WorkflowRunInput): Promise<WorkflowRecord> {
    requiredText(input.providerId, 'providerId');
    if (input.executionAuthorized !== true)
      throw new WorkflowError(
        'Workflow execution requires explicit authorization.',
        'WORKFLOW_EXECUTION_AUTHORIZATION_REQUIRED',
      );
    if (!adapters.has(input.providerId))
      throw new WorkflowError('Provider is unavailable.', 'WORKFLOW_PROVIDER_UNAVAILABLE');
    const selectedMutationId = normalizeMutationId(input.mutationId);
    let task: Task;
    let prompt: string;
    if (input.taskId) {
      task = (await tasks.inspect(root, input.taskId)).task;
      if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision)
        throw new WorkflowError('Task revision changed.', 'WORKFLOW_TASK_REVISION_CONFLICT');
      prompt = input.prompt?.trim() || task.title;
    } else {
      prompt = requiredText(input.prompt, 'prompt');
      task = await tasks.create(root, {
        title: prompt,
        criteria: [{ description: prompt, required: true, approvalRequired: false }],
        authorizationRequired: true,
        authorization: {
          source: 'user',
          scope: 'execute approved workflow',
          reference: selectedMutationId,
        },
        mutationId: selectedMutationId,
      });
    }
    if (!task.criteria.some((criterion) => criterion.required))
      throw new WorkflowError(
        'Workflow requires at least one required criterion.',
        'WORKFLOW_CRITERIA_REQUIRED',
      );
    const existing = await readWorkflow(root, task.id);
    if (existing) {
      assertCurrentPolicy(existing);
      if (existing.status === 'running' && !existing.pendingAction) schedule(task.id);
      return existing;
    }
    if (task.state === 'running')
      throw new WorkflowError(
        'The task is already owned by another execution path.',
        'WORKFLOW_OWNERSHIP_CONFLICT',
      );
    const policyVersion = await policy.version();
    const source = await tasks.source(root);
    const at = now();
    const reviewProviderId =
      input.reviewProviderId ??
      (input.providerId === 'codex' || input.providerId === 'claude' ? input.providerId : '');
    if (!reviewProviderId)
      throw new WorkflowError(
        'A Codex or Claude review provider must be selected.',
        'WORKFLOW_REVIEWER_REQUIRED',
      );
    const record: WorkflowRecord = {
      schemaVersion: 1,
      workflowId: id('workflow'),
      taskId: task.id,
      taskOwnerId: id('owner'),
      revision: 1,
      status: 'running',
      phase: 'requirements',
      providerId: input.providerId,
      reviewProviderId,
      executionAuthorized: true,
      policyVersion,
      policyDigest: currentPolicyDigest,
      promptDigest: sha256(prompt),
      initialPrompt: prompt,
      inputs: [],
      proposedChecks: input.checksDocument ?? null,
      requirements: null,
      plan: null,
      approval: null,
      repairAttempts: 0,
      retryOfActionId: null,
      artifacts: [],
      pendingAction: null,
      completedActions: [],
      mutations: [{ id: selectedMutationId, digest: digestJson(input), revision: 1 }],
      lastOutcome: { status: 'none', summary: '' },
      source,
      createdAt: at,
      updatedAt: at,
    };
    const created = await createWorkflow(root, record);
    schedule(task.id);
    return created;
  }

  async function approve(input: {
    taskId: string;
    planDigest: string;
    requirementsDigest: string;
    checksDigest: string;
    scope: string;
    reference: string;
    expectedRevision: number;
    mutationId?: string;
  }): Promise<WorkflowRecord> {
    const expectedRevision = requiredRevision(input.expectedRevision);
    const selectedMutationId = normalizeMutationId(input.mutationId);
    assertCurrentPolicy(await workflow(input.taskId));
    const task = (await tasks.inspect(root, input.taskId)).task;
    const source = await tasks.source(root);
    const updated = await mutateWorkflow(root, input.taskId, expectedRevision, (record) => {
      if (!commitMutation(record, input, selectedMutationId)) return false;
      if (record.status !== 'awaiting-approval' || !record.requirements || !record.plan)
        throw new WorkflowError(
          'Workflow is not awaiting plan approval.',
          'WORKFLOW_APPROVAL_INVALID',
        );
      if (
        input.planDigest !== record.plan.digest ||
        input.requirementsDigest !== record.requirements.digest ||
        input.checksDigest !== record.plan.checksDigest
      )
        throw new WorkflowError(
          'Approval does not match the exact plan.',
          'WORKFLOW_APPROVAL_STALE',
        );
      record.approval = {
        planDigest: input.planDigest,
        requirementsDigest: input.requirementsDigest,
        checksDigest: input.checksDigest,
        criteriaDigest: criteriaDigest(task),
        scope: requiredText(input.scope, 'scope'),
        reference: requiredText(input.reference, 'reference'),
        source,
        approvedAt: now(),
      };
      record.status = 'running';
      record.lastOutcome = { status: 'passed', summary: 'Exact plan approved.' };
    });
    schedule(input.taskId);
    return updated;
  }

  async function resume(input: {
    taskId: string;
    executionAuthorized: boolean;
    prompt?: string;
    resolution?: WorkflowResumeResolution;
    expectedRevision: number;
    mutationId?: string;
  }): Promise<WorkflowRecord> {
    if (input.executionAuthorized !== true)
      throw new WorkflowError(
        'Workflow execution requires explicit authorization.',
        'WORKFLOW_EXECUTION_AUTHORIZATION_REQUIRED',
      );
    const expectedRevision = requiredRevision(input.expectedRevision);
    const before = await workflow(input.taskId);
    assertCurrentPolicy(before);
    if (before.pendingAction && actionOwnerIsLive(before.pendingAction))
      throw new WorkflowError(
        'The pending workflow action is still owned by a live controller.',
        'WORKFLOW_ACTION_ACTIVE',
      );
    const selectedMutationId = normalizeMutationId(input.mutationId);
    let observed: { evidence: Task['evidence']; source: SourceSnapshot } | undefined;
    if (before.pendingAction && input.resolution?.decision === 'observed') {
      const pending = before.pendingAction;
      if (pending.kind !== 'verify' || pending.phase !== 'verification' || !before.plan)
        throw new WorkflowError(
          'This action has no phase-specific host evidence recovery.',
          'WORKFLOW_RESOLUTION_UNSUPPORTED',
        );
      const document = validateAcceptanceDocument(before.plan.checks);
      if (pending.inputDigest !== sha256(canonicalJson(before.plan.checks)))
        throw new WorkflowError(
          'Approved check correlation changed.',
          'WORKFLOW_RESOLUTION_EVIDENCE_INVALID',
        );
      const inspected = await tasks.inspect(root, input.taskId);
      const source = await tasks.source(root);
      const used = new Set<string>();
      const evidence = document.checks.map((check) => {
        const criterion = inspected.task.criteria.find((item) => item.id === check.criterionId);
        const matches = inspected.task.evidence.filter(
          (item) =>
            Boolean(criterion) &&
            item.criterionId === check.criterionId &&
            item.criterionRevision === criterion!.revision &&
            item.outcome === 'passed' &&
            item.command === correlatedCheckLabel(pending.actionId, check) &&
            Date.parse(item.createdAt) >= Date.parse(pending.startedAt) &&
            sourceEqual(item.source, source),
        );
        const selected = matches.find((item) => !used.has(item.id));
        if (selected) used.add(selected.id);
        return selected;
      });
      const runIds = new Set(evidence.filter(Boolean).map((item) => item!.runId));
      if (
        evidence.some((item) => !item) ||
        runIds.size !== 1 ||
        !evidence.some((item) => item?.id === input.resolution?.evidenceId)
      )
        throw new WorkflowError(
          'Observed verification requires correlated current evidence for every approved check.',
          'WORKFLOW_RESOLUTION_EVIDENCE_INVALID',
        );
      observed = { evidence: evidence as Task['evidence'], source };
    }
    const updated = await mutateWorkflow(root, input.taskId, expectedRevision, (record) => {
      if (!commitMutation(record, input, selectedMutationId)) return false;
      if (record.pendingAction) {
        const resolution = input.resolution;
        if (!resolution || resolution.actionId !== record.pendingAction.actionId)
          throw new WorkflowError(
            'The uncertain action requires an explicit matching resolution.',
            'WORKFLOW_ACTION_UNCERTAIN',
          );
        const pending = record.pendingAction;
        const sourceAfter = observed?.source ?? pending.source;
        if (resolution.decision === 'observed') {
          if (!observed)
            throw new WorkflowError(
              'Observed resolution requires correlated verifier evidence.',
              'WORKFLOW_RESOLUTION_EVIDENCE_INVALID',
            );
          record.completedActions.push({
            ...pending,
            status: 'passed',
            summary: 'Verification was recovered from every correlated approved check.',
            resultDigest: digestJson(observed.evidence),
            sourceAfter,
            finishedAt: now(),
          });
          record.lastOutcome = { status: 'passed', summary: 'Acceptance checks passed.' };
        } else {
          record.completedActions.push({
            ...pending,
            status: 'abandoned',
            summary:
              resolution.decision === 'retry'
                ? 'User explicitly requested retry.'
                : 'User abandoned the uncertain action.',
            resultDigest: digestJson(resolution),
            sourceAfter,
            finishedAt: now(),
          });
          record.lastOutcome =
            resolution.decision === 'retry'
              ? pending.kind === 'complete'
                ? { status: 'passed', summary: 'Retry host completion.' }
                : { status: 'none', summary: '' }
              : { status: 'error', summary: 'Uncertain action was abandoned.' };
          record.retryOfActionId =
            resolution.decision === 'retry' &&
            pending.kind === 'invoke' &&
            pending.phase === 'implementation'
              ? pending.actionId
              : null;
        }
        record.pendingAction = null;
      } else if (record.status === 'awaiting-input') {
        record.inputs.push(requiredText(input.prompt, 'prompt'));
        record.lastOutcome = { status: 'none', summary: '' };
      } else if (record.status === 'running' && !record.pendingAction) {
        // A journal-free running record is a safe persisted checkpoint. Explicit
        // resume re-enters the generated policy without repeating an effect.
      } else {
        throw new WorkflowError(
          'Workflow cannot be resumed from this state.',
          'WORKFLOW_RESUME_INVALID',
        );
      }
      record.executionAuthorized = true;
      if (record.status !== 'verified')
        record.status = record.lastOutcome.status === 'error' ? 'blocked' : 'running';
    });
    if (updated.status === 'running') schedule(input.taskId);
    return updated;
  }

  async function cancel(input: {
    taskId: string;
    expectedRevision: number;
    mutationId?: string;
  }): Promise<WorkflowRecord> {
    const expectedRevision = requiredRevision(input.expectedRevision);
    const selectedMutationId = normalizeMutationId(input.mutationId);
    const before = await workflow(input.taskId);
    const pendingCanSettle = Boolean(
      before.pendingAction && !actionOwnerIsLive(before.pendingAction),
    );
    const updated = await mutateWorkflow(root, input.taskId, expectedRevision, (record) => {
      if (!commitMutation(record, input, selectedMutationId)) return false;
      record.status = 'cancelled';
      record.lastOutcome = { status: 'error', summary: 'Workflow was cancelled.' };
      if (record.pendingAction && pendingCanSettle) {
        record.completedActions.push({
          ...record.pendingAction,
          status: 'abandoned',
          summary: 'Cancelled before a correlated result committed.',
          resultDigest: digestJson({ cancelled: true }),
          sourceAfter: record.pendingAction.source,
          finishedAt: now(),
        });
        record.pendingAction = null;
      }
    });
    active.get(input.taskId)?.abort.abort();
    acceptance.cancel?.(input.taskId);
    if (review.cancel && review.inspect) {
      const state = await review.inspect(root).catch(() => null);
      const running = state?.reviews.find(
        (item) => item.taskId === input.taskId && item.state === 'running',
      );
      if (running) await review.cancel({ reviewId: running.id }).catch(() => {});
    }
    const inspected = await tasks.inspect(root, input.taskId);
    if (inspected.task.state !== 'cancelled' && inspected.task.state !== 'verified')
      await tasks.cancel(root, {
        taskId: input.taskId,
        expectedRevision: inspected.task.revision,
        mutationId: eventId(),
        reason: 'workflow-cancelled',
      });
    return updated;
  }

  async function wait(taskId: string): Promise<WorkflowRecord> {
    return active.get(taskId)?.promise ?? workflow(taskId);
  }

  async function shutdown(): Promise<void> {
    for (const [taskId, item] of active) {
      item.abort.abort();
      acceptance.cancel(taskId);
    }
    if (review.cancel && review.inspect) {
      const state = await review.inspect(root).catch(() => null);
      await Promise.allSettled(
        (state?.reviews ?? [])
          .filter((item) => item.state === 'running' && active.has(item.taskId))
          .map((item) => review.cancel!({ reviewId: item.id })),
      );
    }
    await Promise.allSettled([...active.values()].map((item) => item.promise));
  }

  return Object.freeze({ run, inspect: workflow, approve, resume, cancel, wait, shutdown });
}
