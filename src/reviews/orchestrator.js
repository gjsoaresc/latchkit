import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import { redact } from '../diagnostics/redact.js';
import { captureSource, createTask } from '../task-state/service.js';
import { withTaskStateLock } from '../task-state/lock.js';
import { createTaskWorkspace } from '../workspaces/git.js';
import { validateCommandPlan } from '../providers/contracts.js';
import { CLAUDE_ADAPTER } from '../providers/claude.js';
import { codexAdapter } from '../providers/codex.js';
import { runProviderProcess, HOST_LOCAL_EXECUTION_PROFILE } from '../runtime/process-runner.js';

export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_STATE_PATH = '.latchkit/reviews/state-v1.json';
const adapters = new Map([
  ['claude', CLAUDE_ADAPTER],
  ['codex', codexAdapter],
]);
const ACTIVE = new Map();

export class ReviewOrchestrationError extends Error {
  constructor(message, code = 'REVIEW_INVALID') {
    super(message);
    this.name = 'ReviewOrchestrationError';
    this.code = code;
  }
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim())
    throw new ReviewOrchestrationError(`${name} is required.`);
  return value;
};

export function validateReviewResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ReviewOrchestrationError('Review result must be an object.', 'REVIEW_RESULT_INVALID');
  if (
    value.schemaVersion !== REVIEW_SCHEMA_VERSION ||
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
  const findings = value.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object')
      throw new ReviewOrchestrationError(`Finding ${index} is invalid.`, 'REVIEW_RESULT_INVALID');
    for (const key of ['severity', 'title', 'detail'])
      text(finding[key], `findings[${index}].${key}`);
    if (!['blocker', 'high', 'medium', 'low', 'info'].includes(finding.severity))
      throw new ReviewOrchestrationError(
        `Finding ${index} has an invalid severity.`,
        'REVIEW_RESULT_INVALID',
      );
    return {
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      ...(finding.path ? { path: text(finding.path, `findings[${index}].path`) } : {}),
    };
  });
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    state: value.state,
    findings,
    ...(value.summary ? { summary: String(value.summary) } : {}),
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function reviewPayload(stdout, providerId) {
  const direct = parseJson(stdout);
  if (providerId === 'claude' && direct?.type === 'result' && typeof direct.result === 'string')
    return direct.result;
  if (direct) return direct;
  if (providerId === 'codex') {
    const records = String(stdout ?? '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseJson)
      .filter(Boolean);
    const message = records.findLast(
      (record) =>
        record.type === 'item.completed' &&
        record.item?.type === 'agent_message' &&
        typeof record.item.text === 'string',
    );
    if (message) return message.item.text;
  }
  return stdout;
}

function parseResult(stdout, providerId) {
  let value;
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

async function readState(root) {
  const raw = await readOptional(root, REVIEW_STATE_PATH);
  if (raw === null) return { schemaVersion: REVIEW_SCHEMA_VERSION, reviews: [] };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ReviewOrchestrationError('Review state is invalid JSON.', 'REVIEW_STATE_INVALID');
  }
  if (value.schemaVersion !== REVIEW_SCHEMA_VERSION || !Array.isArray(value.reviews))
    throw new ReviewOrchestrationError(
      'Review state has an unsupported shape.',
      'REVIEW_STATE_INVALID',
    );
  return value;
}

async function saveState(root, review) {
  return withTaskStateLock(root, async () => {
    const state = await readState(root);
    const index = state.reviews.findIndex((item) => item.id === review.id);
    if (index < 0) state.reviews.push(review);
    else state.reviews[index] = review;
    await writeAtomic(root, REVIEW_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    return review;
  });
}

function dedupe(findings) {
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
export function createReviewOrchestrator({
  root,
  launch = runProviderProcess,
  workspace = createTaskWorkspace,
  source = captureSource,
  reviewerAdapters = adapters,
  clock = () => new Date(),
} = {}) {
  if (!root || typeof launch !== 'function' || typeof workspace !== 'function')
    throw new TypeError('Review root and execution functions are required.');
  root = path.resolve(root);
  async function run({
    taskId,
    reviewers,
    executionAuthorized = false,
    sandbox,
    approvalPolicy,
    limits = {},
    depth = 0,
  } = {}) {
    text(taskId, 'taskId');
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
    if (!Array.isArray(reviewers) || reviewers.length === 0)
      throw new ReviewOrchestrationError(
        'At least one reviewer is required.',
        'REVIEW_REVIEWERS_REQUIRED',
      );
    const maxReviewers = limits.maxReviewers ?? 4;
    const concurrency = limits.concurrency ?? Math.min(2, maxReviewers);
    const timeoutMs = limits.timeoutMs ?? 120000;
    const maxIterations = limits.maxIterations ?? 1;
    if (
      ![maxReviewers, concurrency, timeoutMs, maxIterations].every(
        (value) => Number.isInteger(value) && value > 0,
      ) ||
      maxIterations !== 1 ||
      reviewers.length > maxReviewers ||
      concurrency > maxReviewers
    )
      throw new ReviewOrchestrationError(
        'Review limits are invalid or exceeded.',
        'REVIEW_BUDGET_EXCEEDED',
      );
    const snapshot = await source(root);
    const review = {
      id: `review_${randomUUID()}`,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      taskId,
      state: 'running',
      independent: true,
      sourceSnapshot: snapshot,
      limits: { maxReviewers, concurrency, timeoutMs, maxIterations },
      usage: { state: 'unknown', reason: 'Provider usage is not exposed by the review contract.' },
      reviewers: [],
      createdAt: clock().toISOString(),
      updatedAt: clock().toISOString(),
    };
    await saveState(root, review);
    const abort = new AbortController();
    ACTIVE.set(review.id, abort);
    let cursor = 0;
    const results = [];
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= reviewers.length) return;
        const assignment = reviewers[index];
        const item = {
          id: `assignment_${randomUUID()}`,
          reviewerId: text(assignment.id ?? `${assignment.providerId}-${index + 1}`, 'reviewer id'),
          providerId: text(assignment.providerId, 'providerId'),
          state: 'running',
          independent: true,
          sourceSnapshot: snapshot,
          startedAt: clock().toISOString(),
        };
        review.reviewers.push(item);
        await saveState(root, review);
        try {
          const adapter = reviewerAdapters.get(item.providerId);
          if (
            !adapter ||
            !['supported', 'partial'].includes(adapter.contract.capabilities.invocation.state)
          )
            throw new ReviewOrchestrationError(
              'Reviewer invocation is unavailable.',
              'REVIEW_PROVIDER_UNAVAILABLE',
            );
          const child = await createTask(root, {
            title: `Independent review ${item.reviewerId}`,
            authorizationRequired: false,
          });
          const owned = await workspace(root, { taskId: child.id });
          item.childTaskId = child.id;
          item.workspace = owned.path ?? null;
          const plan = validateCommandPlan(
            adapter.operations.planInvocation({
              prompt: text(
                assignment.prompt ?? `Review task ${taskId}. Inspect only; do not edit files.`,
                'prompt',
              ),
              cwd: owned.path ?? root,
              sandbox,
              approvalPolicy,
            }),
          );
          if (abort.signal.aborted)
            throw new ReviewOrchestrationError(
              'Review was cancelled before launch.',
              'REVIEW_CANCELLED',
            );
          const processResult = await launch({
            provider: adapter.contract,
            plan,
            executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
            timeoutMs,
            signal: abort.signal,
          });
          item.process = redact(processResult);
          item.state =
            processResult.status === 'cancelled'
              ? 'cancelled'
              : processResult.status === 'timed-out'
                ? 'timed-out'
                : 'completed';
          item.result =
            processResult.status === 'exited'
              ? parseResult(processResult.stdout ?? '', item.providerId)
              : { schemaVersion: REVIEW_SCHEMA_VERSION, state: item.state, findings: [] };
        } catch (error) {
          item.state = abort.signal.aborted
            ? 'cancelled'
            : error.code === 'REVIEW_RESULT_MALFORMED'
              ? 'failed'
              : error.code === 'REVIEW_PROVIDER_UNAVAILABLE'
                ? 'unavailable'
                : 'failed';
          item.error = redact({ code: error.code, message: error.message });
          item.result = { schemaVersion: REVIEW_SCHEMA_VERSION, state: item.state, findings: [] };
        }
        item.finishedAt = clock().toISOString();
        await saveState(root, review);
        results.push(item);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, reviewers.length) }, worker));
      review.state = abort.signal.aborted ? 'cancelled' : 'completed';
      review.findings = dedupe(results.flatMap((item) => item.result?.findings ?? []));
      review.updatedAt = clock().toISOString();
      await saveState(root, review);
      return review;
    } finally {
      ACTIVE.delete(review.id);
    }
  }
  async function cancel({ reviewId } = {}) {
    text(reviewId, 'reviewId');
    const controller = ACTIVE.get(reviewId);
    if (!controller)
      throw new ReviewOrchestrationError(
        'Review is not active in this process.',
        'REVIEW_NOT_ACTIVE',
      );
    controller.abort();
    return { reviewId, state: 'cancelling' };
  }
  return Object.freeze({ run, cancel, inspect: readState });
}
