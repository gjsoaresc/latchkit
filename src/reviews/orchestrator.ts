import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import { redact } from '../diagnostics/redact.js';
import { captureSource, createTask } from '../task-state/service.js';
import { withTaskStateLock } from '../task-state/lock.js';
import { createReviewWorkspace } from '../workspaces/git.js';
import { validateCommandPlan } from '../providers/contracts.js';
import { CLAUDE_ADAPTER } from '../providers/claude.js';
import { codexAdapter } from '../providers/codex.js';
import { runProviderProcess, HOST_LOCAL_EXECUTION_PROFILE } from '../runtime/process-runner.js';
import type { ProcessRunResult, RunProviderProcessOptions } from '../runtime/process-runner.js';
import type { ProviderContract } from '../providers/contracts.js';
import type { SourceSnapshot } from '../task-state/contracts.js';
import { errorCode, errorMessage, isRecord } from '../types.js';
import { observeProviderInvocation } from '../usage/observe.js';

export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_STATE_PATH = '.latchkit/reviews/state-v1.json';
type Finding = {
  severity: 'blocker' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  path?: string;
};
type ReviewResult = {
  schemaVersion: number;
  state: 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'unavailable';
  findings: Finding[];
  summary?: string;
};
type ReviewerAssignment = { id?: unknown; providerId?: unknown; prompt?: unknown };
type ReviewItem = {
  id: string;
  reviewerId: string;
  providerId: string;
  state: ReviewResult['state'] | 'running';
  independent: true;
  sourceSnapshot: SourceSnapshot;
  startedAt: string;
  childTaskId?: string;
  workspace?: string | null;
  snapshotDigest?: string;
  process?: unknown;
  result?: ReviewResult;
  error?: unknown;
  finishedAt?: string;
};
type Review = {
  id: string;
  schemaVersion: number;
  taskId: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  independent: true;
  sourceSnapshot: SourceSnapshot;
  limits: ReviewLimits;
  usage: { state: 'unknown'; reason: string };
  reviewers: ReviewItem[];
  createdAt: string;
  updatedAt: string;
  findings?: Finding[];
};
type ReviewState = { schemaVersion: number; reviews: Review[] };
type ReviewLimits = {
  maxReviewers: number;
  concurrency: number;
  timeoutMs: number;
  maxIterations: number;
};
type Adapter = {
  contract: Readonly<ProviderContract>;
  operations: {
    planInvocation: (input: {
      prompt: string;
      cwd: string;
      sandbox?: unknown;
      approvalPolicy?: unknown;
    }) => unknown;
  };
};
type Launch = (options?: RunProviderProcessOptions) => Promise<ProcessRunResult>;
type WorkspaceFactory = (root: string, input?: { taskId?: string }) => Promise<unknown>;
type Source = (root: string) => Promise<SourceSnapshot>;
type RunInput = {
  taskId?: unknown;
  reviewers?: unknown;
  executionAuthorized?: boolean;
  sandbox?: unknown;
  approvalPolicy?: unknown;
  limits?: unknown;
  depth?: unknown;
  signal?: AbortSignal;
};
type OrchestratorOptions = {
  root?: string;
  launch?: Launch;
  workspace?: WorkspaceFactory;
  source?: Source;
  reviewerAdapters?: Map<string, unknown>;
  clock?: () => Date;
};

const adapters = new Map<string, unknown>([
  ['claude', CLAUDE_ADAPTER],
  ['codex', codexAdapter],
]);
const ACTIVE = new Map<string, AbortController>();
const REVIEW_RESULT_INSTRUCTIONS = `Return exactly one JSON object with this shape and no prose or code fence: {"schemaVersion":1,"state":"completed","findings":[{"severity":"blocker|high|medium|low|info","title":"non-empty title","detail":"non-empty detail","path":"optional repository-relative path"}],"summary":"optional summary"}. Use an empty findings array when no issues exist. The state must be one of completed, failed, timed-out, cancelled, or unavailable.`;

export class ReviewOrchestrationError extends Error {
  code: string;
  constructor(message: string, code = 'REVIEW_INVALID') {
    super(message);
    this.name = 'ReviewOrchestrationError';
    this.code = code;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new ReviewOrchestrationError(`${name} is required.`);
  return value;
};

export function validateReviewResult(value: unknown): ReviewResult {
  if (!isRecord(value))
    throw new ReviewOrchestrationError('Review result must be an object.', 'REVIEW_RESULT_INVALID');
  if (
    value.schemaVersion !== REVIEW_SCHEMA_VERSION ||
    typeof value.state !== 'string' ||
    !['completed', 'failed', 'timed-out', 'cancelled', 'unavailable'].includes(value.state)
  )
    throw new ReviewOrchestrationError(
      'Review result schema or state is invalid.',
      'REVIEW_RESULT_INVALID',
    );
  if (!Array.isArray(value.findings))
    throw new ReviewOrchestrationError(
      'Review findings must be an array.',
      'REVIEW_RESULT_INVALID',
    );
  const findings = value.findings.map((finding: unknown, index: number): Finding => {
    if (!isRecord(finding))
      throw new ReviewOrchestrationError(`Finding ${index} is invalid.`, 'REVIEW_RESULT_INVALID');
    for (const key of ['severity', 'title', 'detail'])
      text(finding[key], `findings[${index}].${key}`);
    const severity = text(finding.severity, `findings[${index}].severity`);
    if (!['blocker', 'high', 'medium', 'low', 'info'].includes(severity))
      throw new ReviewOrchestrationError(
        `Finding ${index} has an invalid severity.`,
        'REVIEW_RESULT_INVALID',
      );
    return {
      severity: severity as Finding['severity'],
      title: text(finding.title, `findings[${index}].title`),
      detail: text(finding.detail, `findings[${index}].detail`),
      ...(finding.path ? { path: text(finding.path, `findings[${index}].path`) } : {}),
    };
  });
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    state: value.state as ReviewResult['state'],
    findings,
    ...(value.summary ? { summary: String(value.summary) } : {}),
  };
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function reviewPayload(stdout: string, providerId: string): unknown {
  const direct = parseJson(stdout);
  if (
    providerId === 'claude' &&
    isRecord(direct) &&
    direct.type === 'result' &&
    typeof direct.result === 'string'
  )
    return direct.result;
  if (direct) return direct;
  if (providerId === 'codex') {
    const records = String(stdout ?? '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseJson)
      .filter(Boolean);
    const message = records.findLast(
      (record): record is Record<string, unknown> =>
        isRecord(record) &&
        record.type === 'item.completed' &&
        isRecord(record.item) &&
        record.item.type === 'agent_message' &&
        typeof record.item.text === 'string',
    );
    if (message && isRecord(message.item) && typeof message.item.text === 'string')
      return message.item.text;
  }
  return stdout;
}

function parseResult(stdout: string, providerId: string): ReviewResult {
  let value: unknown;
  try {
    const payload = reviewPayload(stdout, providerId);
    value = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    throw new ReviewOrchestrationError(
      'Reviewer output was not valid JSON.',
      'REVIEW_RESULT_MALFORMED',
    );
  }
  return validateReviewResult(redact(value));
}

async function readState(root: string): Promise<ReviewState> {
  const raw = await readOptional(root, REVIEW_STATE_PATH);
  if (raw === null) return { schemaVersion: REVIEW_SCHEMA_VERSION, reviews: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ReviewOrchestrationError('Review state is invalid JSON.', 'REVIEW_STATE_INVALID');
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== REVIEW_SCHEMA_VERSION ||
    !Array.isArray(value.reviews)
  )
    throw new ReviewOrchestrationError(
      'Review state has an unsupported shape.',
      'REVIEW_STATE_INVALID',
    );
  return value as ReviewState;
}

async function saveState(root: string, review: Review): Promise<Review> {
  return withTaskStateLock(root, async () => {
    const state = await readState(root);
    const index = state.reviews.findIndex((item) => item.id === review.id);
    if (index < 0) state.reviews.push(review);
    else state.reviews[index] = review;
    await writeAtomic(root, REVIEW_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    return review;
  });
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = digest(`${finding.path ?? ''}\0${finding.title}\0${finding.detail}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Runs observation-only, independent provider reviews. It does not write to the
 * reviewed checkout, complete tasks, approve findings, merge, or publish comments. */
function isAdapter(value: unknown): value is Adapter {
  return (
    isRecord(value) &&
    isRecord(value.contract) &&
    isRecord(value.operations) &&
    typeof value.operations.planInvocation === 'function'
  );
}

function positiveLimit(value: unknown, fallback: number): number {
  return value === undefined ? fallback : typeof value === 'number' ? value : Number.NaN;
}

function sameSource(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return left.revision === right.revision && left.dirtyFingerprint === right.dirtyFingerprint;
}

function enforceReviewPlan(providerId: string, value: unknown) {
  let candidate = value;
  if (providerId === 'claude' && isRecord(candidate) && Array.isArray(candidate.args)) {
    const args = candidate.args.map(String);
    if (!args.some((item, index) => item === '--permission-mode' && args[index + 1] === 'plan'))
      args.push('--permission-mode', 'plan');
    candidate = { ...candidate, args };
  }
  const plan = validateCommandPlan(candidate);
  const codexReadOnly =
    providerId === 'codex' &&
    plan.args.some(
      (item: string, index: number) => item === '--sandbox' && plan.args[index + 1] === 'read-only',
    );
  const claudeReadOnly =
    providerId === 'claude' &&
    plan.args.some(
      (item: string, index: number) =>
        item === '--permission-mode' && plan.args[index + 1] === 'plan',
    );
  if (!codexReadOnly && !claudeReadOnly)
    throw new ReviewOrchestrationError(
      'Reviewer does not have an enforceable read-only mode.',
      'REVIEW_READONLY_UNAVAILABLE',
    );
  return plan;
}

function parseLimits(value: unknown, reviewerCount: number): ReviewLimits {
  const limits = isRecord(value) ? value : {};
  const maxReviewers = positiveLimit(limits.maxReviewers, 4);
  const concurrency = positiveLimit(limits.concurrency, Math.min(2, maxReviewers));
  const timeoutMs = positiveLimit(limits.timeoutMs, 120000);
  const maxIterations = positiveLimit(limits.maxIterations, 1);
  if (
    ![maxReviewers, concurrency, timeoutMs, maxIterations].every(
      (item) => typeof item === 'number' && Number.isInteger(item) && item > 0,
    ) ||
    maxIterations !== 1 ||
    reviewerCount > maxReviewers ||
    concurrency > maxReviewers
  )
    throw new ReviewOrchestrationError(
      'Review limits are invalid or exceeded.',
      'REVIEW_BUDGET_EXCEEDED',
    );
  return { maxReviewers, concurrency, timeoutMs, maxIterations };
}

export function createReviewOrchestrator({
  root,
  launch = runProviderProcess,
  workspace = createReviewWorkspace,
  source = captureSource,
  reviewerAdapters = adapters,
  clock = () => new Date(),
}: OrchestratorOptions = {}) {
  if (!root || typeof launch !== 'function' || typeof workspace !== 'function')
    throw new TypeError('Review root and execution functions are required.');
  const projectRoot = path.resolve(root);
  async function run({
    taskId,
    reviewers,
    executionAuthorized = false,
    sandbox,
    approvalPolicy,
    limits = {},
    depth = 0,
    signal,
  }: RunInput = {}) {
    const task = text(taskId, 'taskId');
    if (executionAuthorized !== true)
      throw new ReviewOrchestrationError(
        'Reviews require explicit host-local execution authorization.',
        'REVIEW_AUTHORIZATION_REQUIRED',
      );
    if (depth !== 0)
      throw new ReviewOrchestrationError(
        'Nested review orchestration is not allowed.',
        'REVIEW_NESTING_LIMIT',
      );
    if (sandbox !== 'read-only')
      throw new ReviewOrchestrationError(
        'Reviews require an enforceable read-only sandbox.',
        'REVIEW_READONLY_UNAVAILABLE',
      );
    if (!Array.isArray(reviewers) || reviewers.length === 0)
      throw new ReviewOrchestrationError(
        'At least one reviewer is required.',
        'REVIEW_REVIEWERS_REQUIRED',
      );
    const assignments = reviewers.map((assignment): ReviewerAssignment => {
      if (!isRecord(assignment))
        throw new ReviewOrchestrationError(
          'Reviewer assignment must be an object.',
          'REVIEW_REVIEWERS_REQUIRED',
        );
      return { id: assignment.id, providerId: assignment.providerId, prompt: assignment.prompt };
    });
    const budget = parseLimits(limits, assignments.length);
    const snapshot = await source(projectRoot);
    const review: Review = {
      id: `review_${randomUUID()}`,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      taskId: task,
      state: 'running',
      independent: true,
      sourceSnapshot: snapshot,
      limits: budget,
      usage: {
        state: 'unknown',
        reason:
          'Opted-in token observations are in the source project usage ledger; provider billing remains unknown.',
      },
      reviewers: [],
      createdAt: clock().toISOString(),
      updatedAt: clock().toISOString(),
    };
    await saveState(projectRoot, review);
    const abort = new AbortController();
    const externalAbort = () => abort.abort();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener('abort', externalAbort, { once: true });
    ACTIVE.set(review.id, abort);
    let cursor = 0;
    const results: ReviewItem[] = [];
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= assignments.length) return;
        const assignment = assignments[index];
        if (!assignment) return;
        const item: ReviewItem = {
          id: `assignment_${randomUUID()}`,
          reviewerId: text(assignment.id ?? `${assignment.providerId}-${index + 1}`, 'reviewer id'),
          providerId: text(assignment.providerId, 'providerId'),
          state: 'running',
          independent: true,
          sourceSnapshot: snapshot,
          startedAt: clock().toISOString(),
        };
        review.reviewers.push(item);
        await saveState(projectRoot, review);
        try {
          const adapter = reviewerAdapters.get(item.providerId);
          if (
            !isAdapter(adapter) ||
            !['supported', 'partial'].includes(adapter.contract.capabilities.invocation.state)
          )
            throw new ReviewOrchestrationError(
              'Reviewer invocation is unavailable.',
              'REVIEW_PROVIDER_UNAVAILABLE',
            );
          const child = await createTask(projectRoot, {
            title: `Independent review ${item.reviewerId}`,
            authorizationRequired: false,
          });
          const owned = await workspace(projectRoot, { taskId: child.id });
          const workspacePath =
            isRecord(owned) && typeof owned.path === 'string' ? owned.path : undefined;
          if (!workspacePath)
            throw new ReviewOrchestrationError(
              'Independent review workspace is unavailable.',
              'REVIEW_WORKSPACE_UNAVAILABLE',
            );
          item.childTaskId = child.id;
          item.workspace = workspacePath;
          if (isRecord(owned) && typeof owned.snapshotDigest === 'string')
            item.snapshotDigest = owned.snapshotDigest;
          if (!item.snapshotDigest)
            throw new ReviewOrchestrationError(
              'Independent review snapshot proof is unavailable.',
              'REVIEW_SNAPSHOT_UNAVAILABLE',
            );
          if (!sameSource(await source(projectRoot), snapshot))
            throw new ReviewOrchestrationError(
              'Reviewed source changed during snapshot setup.',
              'REVIEW_SOURCE_CHANGED',
            );
          const plan = enforceReviewPlan(
            item.providerId,
            adapter.operations.planInvocation({
              prompt: text(
                `Review task ${taskId} at source ${JSON.stringify(snapshot)} and manifest ${item.snapshotDigest}. Inspect only; do not edit files. ${assignment.prompt ?? ''}\n\n${REVIEW_RESULT_INSTRUCTIONS}`,
                'prompt',
              ),
              cwd: workspacePath,
              sandbox,
              approvalPolicy,
            }),
          );
          if (abort.signal.aborted)
            throw new ReviewOrchestrationError(
              'Review was cancelled before launch.',
              'REVIEW_CANCELLED',
            );
          const processResult = await observeProviderInvocation({
            root: projectRoot,
            providerId: item.providerId,
            taskId: task,
            invocationId: item.id,
            launch,
            clock,
            input: {
              provider: adapter.contract,
              plan,
              executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
              timeoutMs: budget.timeoutMs,
              signal: abort.signal,
            },
          });
          item.process = redact(processResult);
          item.state =
            processResult.status === 'cancelled'
              ? 'cancelled'
              : processResult.status === 'timed-out'
                ? 'timed-out'
                : processResult.status === 'exited' && processResult.exitCode === 0
                  ? 'completed'
                  : 'failed';
          item.result =
            item.state === 'completed'
              ? parseResult(processResult.stdout ?? '', item.providerId)
              : { schemaVersion: REVIEW_SCHEMA_VERSION, state: item.state, findings: [] };
          if (item.result.state !== 'completed') item.state = item.result.state;
          if (!sameSource(await source(projectRoot), snapshot))
            throw new ReviewOrchestrationError(
              'Reviewed source changed during provider review.',
              'REVIEW_SOURCE_CHANGED',
            );
        } catch (error) {
          item.state = abort.signal.aborted
            ? 'cancelled'
            : errorCode(error) === 'REVIEW_RESULT_MALFORMED'
              ? 'failed'
              : errorCode(error) === 'REVIEW_PROVIDER_UNAVAILABLE'
                ? 'unavailable'
                : 'failed';
          item.error = redact({ code: errorCode(error), message: errorMessage(error) });
          item.result = { schemaVersion: REVIEW_SCHEMA_VERSION, state: item.state, findings: [] };
        }
        item.finishedAt = clock().toISOString();
        await saveState(projectRoot, review);
        results.push(item);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(budget.concurrency, assignments.length) }, worker),
      );
      review.state = abort.signal.aborted
        ? 'cancelled'
        : results.length === assignments.length &&
            results.every(
              (item) =>
                item.state === 'completed' &&
                item.result?.state === 'completed' &&
                isRecord(item.process) &&
                item.process.status === 'exited' &&
                item.process.exitCode === 0 &&
                typeof item.snapshotDigest === 'string' &&
                sameSource(item.sourceSnapshot, snapshot),
            ) &&
            sameSource(await source(projectRoot), snapshot)
          ? 'completed'
          : 'failed';
      review.findings = dedupe(results.flatMap((item) => item.result?.findings ?? []));
      review.updatedAt = clock().toISOString();
      await saveState(projectRoot, review);
      return review;
    } finally {
      ACTIVE.delete(review.id);
      signal?.removeEventListener('abort', externalAbort);
    }
  }
  async function cancel({ reviewId }: { reviewId?: unknown } = {}) {
    const id = text(reviewId, 'reviewId');
    const controller = ACTIVE.get(id);
    if (!controller)
      throw new ReviewOrchestrationError(
        'Review is not active in this process.',
        'REVIEW_NOT_ACTIVE',
      );
    controller.abort();
    return { reviewId: id, state: 'cancelling' };
  }
  return Object.freeze({ run, cancel, inspect: () => readState(projectRoot) });
}
