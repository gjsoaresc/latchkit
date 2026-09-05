import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EVIDENCE_OUTCOMES, TaskStateError, validateStableId } from './contracts.js';
import { cleanupTaskStateTemps, readTaskState, writeTaskState } from './store.js';
import { withTaskStateLock } from './lock.js';
import { resolveProjectRoot, safePath } from '../storage.js';

const execFileAsync = promisify(execFile);
const TERMINAL_TASK_STATES = new Set(['cancelled', 'verified']);
const IMPORT_RECORD = Symbol('importRecord');

const iso = (clock) => clock().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value) {
  return digest(canonical(value));
}

function normalizeMutationId(value) {
  value ??= id('event');
  return validateStableId(value, 'event', '$.mutationId');
}

function assertExpected(task, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new TaskStateError(
      'Expected a positive task revision.',
      'TASK_REVISION_REQUIRED',
      '$.expectedRevision',
    );
  }
  if (task.revision !== expectedRevision) {
    const error = new TaskStateError(
      `Expected task revision ${expectedRevision}, found ${task.revision}.`,
      'TASK_REVISION_CONFLICT',
      '$.expectedRevision',
    );
    error.expectedRevision = expectedRevision;
    error.actualRevision = task.revision;
    throw error;
  }
}

function findTask(state, taskId) {
  validateStableId(taskId, 'task', '$.taskId');
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task)
    throw new TaskStateError(`Task ${taskId} does not exist.`, 'TASK_NOT_FOUND', '$.taskId');
  return task;
}

function ensureMutable(task) {
  if (TERMINAL_TASK_STATES.has(task.state)) {
    throw new TaskStateError(
      `Task state ${task.state} is terminal.`,
      'TASK_TRANSITION_INVALID',
      '$.state',
    );
  }
}

function normalizeAuthorization(value, clock, provenanceKind = 'direct-request') {
  if (!value || value.source !== 'user' || typeof value.scope !== 'string' || !value.scope.trim()) {
    throw new TaskStateError(
      'Authorization must name the explicit user scope.',
      'TASK_AUTHORIZATION_INVALID',
      '$.authorization',
    );
  }
  const reference = value.reference;
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new TaskStateError(
      'Authorization provenance requires a direct request reference.',
      'TASK_AUTHORIZATION_INVALID',
      '$.authorization.reference',
    );
  }
  return {
    id: id('authorization'),
    source: 'user',
    scope: value.scope,
    provenance: { kind: provenanceKind, reference },
    grantedAt: iso(clock),
  };
}

function normalizeCriteria(criteria, clock) {
  if (!Array.isArray(criteria))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', '$.criteria');
  const at = iso(clock);
  return criteria.map((criterion, index) => {
    if (!criterion || typeof criterion.description !== 'string' || !criterion.description.trim()) {
      throw new TaskStateError(
        'Criterion description is required.',
        'TASK_STATE_INVALID',
        `$.criteria[${index}].description`,
      );
    }
    return {
      id: criterion.id
        ? validateStableId(criterion.id, 'criterion', `$.criteria[${index}].id`)
        : id('criterion'),
      revision: 1,
      description: criterion.description,
      required: criterion.required ?? true,
      approvalRequired: criterion.approvalRequired ?? false,
      createdAt: at,
      updatedAt: at,
    };
  });
}

async function gitState(root) {
  try {
    const [{ stdout: revision }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true }),
      execFileAsync(
        'git',
        [
          '-C',
          root,
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
          '--',
          '.',
          ':(exclude).latchkit',
        ],
        { windowsHide: true },
      ),
    ]);
    return { revision: revision.trim(), dirty: Boolean(status) };
  } catch {
    return { revision: null, dirty: true };
  }
}

async function fingerprintFiles(root) {
  const entries = [];
  async function visit(directory, relative = '') {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!relative && ['.git', '.latchkit', 'node_modules'].includes(child.name)) continue;
      const item = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) await visit(absolute, item);
      else if (child.isSymbolicLink()) entries.push(`${item}\0link\0${await readlink(absolute)}\0`);
      else if (child.isFile()) entries.push(`${item}\0file\0${digest(await readFile(absolute))}\0`);
    }
  }
  await visit(root);
  return digest(entries.join(''));
}

export async function captureSource(root) {
  root = await resolveProjectRoot(root);
  const git = await gitState(root);
  return {
    revision: git.revision,
    dirtyFingerprint: git.dirty ? await fingerprintFiles(root) : null,
  };
}

function processIdentity() {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    platform: process.platform,
    runtime: process.release.name,
  };
}

export function isRecordedProcessLive(run) {
  if (run.process.hostname !== os.hostname()) return false;
  try {
    process.kill(run.process.pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function sourceEqual(left, right) {
  return left.revision === right.revision && left.dirtyFingerprint === right.dirtyFingerprint;
}

function findPriorMutation(state, mutationId, hash) {
  for (const task of state.tasks) {
    const event = task.events.find((item) => item.id === mutationId);
    if (!event) continue;
    if (event.requestHash !== hash) {
      throw new TaskStateError(
        'Mutation ID was already committed with different input.',
        'TASK_IDEMPOTENCY_CONFLICT',
        '$.mutationId',
      );
    }
    return task;
  }
  return null;
}

function commitEvent(state, task, { mutationId, type, hash, runId, clock }) {
  const at = iso(clock);
  task.revision += 1;
  task.updatedAt = at;
  state.revision += 1;
  state.updatedAt = at;
  task.events.push({
    id: mutationId,
    type,
    requestHash: hash,
    taskRevision: task.revision,
    runId: runId ?? null,
    createdAt: at,
  });
}

async function mutate(root, request, operation, options = {}) {
  root = await resolveProjectRoot(root);
  const clock = options.clock ?? (() => new Date());
  const mutationId = normalizeMutationId(request.mutationId);
  const hashedRequest = { ...request, mutationId };
  const hash = requestHash(hashedRequest);
  return withTaskStateLock(root, async () => {
    await cleanupTaskStateTemps(root);
    const state = await readTaskState(root, { clock });
    const prior = findPriorMutation(state, mutationId, hash);
    if (prior) return structuredClone(prior);
    const result = await operation({ state, root, clock, mutationId, hash });
    await writeTaskState(root, state, { faultBoundary: options.faultBoundary });
    return structuredClone(result);
  });
}

export async function createTask(root, input, options = {}) {
  const importRecord = options[IMPORT_RECORD] ?? null;
  const request = {
    mutationId: input.mutationId,
    title: input.title,
    criteria: input.criteria ?? [],
    authorizationRequired: input.authorizationRequired ?? true,
    authorization: input.authorization ?? null,
    importRecord,
  };
  return mutate(
    root,
    request,
    async ({ state, clock, mutationId, hash }) => {
      if (typeof input.title !== 'string' || !input.title.trim())
        throw new TaskStateError('Task title is required.', 'TASK_STATE_INVALID', '$.title');
      const at = iso(clock);
      const authorizations = input.authorization
        ? [
            normalizeAuthorization(
              input.authorization,
              clock,
              input.authorization.provenanceKind ?? 'direct-request',
            ),
          ]
        : [];
      const task = {
        id: id('task'),
        title: input.title,
        state:
          input.authorizationRequired !== false && !authorizations.length
            ? 'awaiting-decision'
            : 'planned',
        revision: 0,
        createdAt: at,
        updatedAt: at,
        authorizationRequired: input.authorizationRequired ?? true,
        authorizations,
        owner: null,
        criteria: normalizeCriteria(input.criteria ?? [], clock),
        runs: [],
        checkpoints: [],
        evidence: [],
        events: [],
        import: importRecord,
      };
      state.tasks.push(task);
      commitEvent(state, task, {
        mutationId,
        type: importRecord ? 'task.imported' : 'task.created',
        hash,
        clock,
      });
      return task;
    },
    options,
  );
}

export async function importMarkdownTask(root, input, options = {}) {
  root = await resolveProjectRoot(root);
  const relative = input.notePath?.replaceAll('\\', '/');
  if (
    typeof relative !== 'string' ||
    !relative.startsWith('.latchkit/notes/') ||
    !relative.endsWith('.md')
  ) {
    throw new TaskStateError(
      'Import path must be a Markdown note under .latchkit/notes/.',
      'TASK_IMPORT_INVALID',
      '$.notePath',
    );
  }
  const note = await readFile(await safePath(root, relative));
  return createTask(root, input, {
    ...options,
    [IMPORT_RECORD]: {
      path: relative,
      sha256: digest(note),
      importedAt: iso(options.clock ?? (() => new Date())),
    },
  });
}

export async function reviseCriteria(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    criteria: input.criteria,
  };
  return mutate(
    root,
    request,
    async ({ state, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      if (!Array.isArray(input.criteria))
        throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', '$.criteria');
      const current = new Map(task.criteria.map((item) => [item.id, item]));
      const at = iso(clock);
      const next = input.criteria.map((item, index) => {
        if (!item || typeof item.description !== 'string' || !item.description.trim())
          throw new TaskStateError(
            'Criterion description is required.',
            'TASK_STATE_INVALID',
            `$.criteria[${index}].description`,
          );
        const previous = item.id
          ? current.get(validateStableId(item.id, 'criterion', `$.criteria[${index}].id`))
          : null;
        const candidate = {
          description: item.description,
          required: item.required ?? true,
          approvalRequired: item.approvalRequired ?? false,
        };
        if (!previous)
          return { id: id('criterion'), revision: 1, ...candidate, createdAt: at, updatedAt: at };
        const changed =
          previous.description !== candidate.description ||
          previous.required !== candidate.required ||
          previous.approvalRequired !== candidate.approvalRequired;
        return {
          ...previous,
          ...candidate,
          revision: changed ? previous.revision + 1 : previous.revision,
          updatedAt: changed ? at : previous.updatedAt,
        };
      });
      const ids = new Set(next.map((item) => item.id));
      if (ids.size !== next.length)
        throw new TaskStateError(
          'Criterion IDs must be unique.',
          'TASK_STATE_INVALID',
          '$.criteria',
        );
      task.criteria = next;
      if (task.state === 'completed') task.state = 'planned';
      commitEvent(state, task, { mutationId, type: 'criteria.revised', hash, clock });
      return task;
    },
    options,
  );
}

export async function resumeTask(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    ownerId: input.ownerId ?? null,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      if (task.authorizationRequired && !task.authorizations.length) {
        throw new TaskStateError(
          'Explicit user authorization is required before this task can run.',
          'TASK_AUTHORIZATION_REQUIRED',
          '$.authorizations',
        );
      }
      if (task.owner) {
        const activeRun = task.runs.find((run) => run.id === task.owner.runId);
        const processProbe = options.processProbe ?? isRecordedProcessLive;
        if (activeRun && (await processProbe(activeRun))) {
          throw new TaskStateError(
            'The recorded task owner is still live.',
            'TASK_RUN_ACTIVE',
            '$.owner',
          );
        }
        if (activeRun?.state === 'running') {
          activeRun.state = 'interrupted';
          activeRun.endedAt = iso(clock);
        }
        task.owner = null;
      }
      const runId = id('run');
      const ownerId = input.ownerId
        ? validateStableId(input.ownerId, 'owner', '$.ownerId')
        : id('owner');
      const at = iso(clock);
      const run = {
        id: runId,
        ownerId,
        state: 'running',
        startedAt: at,
        endedAt: null,
        process: processIdentity(),
        source: await captureSource(projectRoot),
      };
      task.runs.push(run);
      task.state = 'running';
      task.owner = { runId, ownerId, revision: task.revision + 1, acquiredAt: at };
      commitEvent(state, task, { mutationId, type: 'task.resumed', hash, runId, clock });
      return task;
    },
    options,
  );
}

export async function authorizeTask(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    authorization: input.authorization,
  };
  return mutate(
    root,
    request,
    async ({ state, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      task.authorizations.push(normalizeAuthorization(input.authorization, clock));
      if (task.state === 'awaiting-decision') task.state = 'planned';
      commitEvent(state, task, { mutationId, type: 'authorization.recorded', hash, clock });
      return task;
    },
    options,
  );
}

export async function pauseTask(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    state: input.state,
    reason: input.reason ?? null,
  };
  return mutate(
    root,
    request,
    async ({ state, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      if (!['awaiting-decision', 'blocked'].includes(input.state)) {
        throw new TaskStateError(
          'Pause state must be awaiting-decision or blocked.',
          'TASK_TRANSITION_INVALID',
          '$.state',
        );
      }
      if (task.owner) {
        const run = task.runs.find((item) => item.id === task.owner.runId);
        if (run?.state === 'running') {
          run.state = 'interrupted';
          run.endedAt = iso(clock);
        }
      }
      task.owner = null;
      task.state = input.state;
      commitEvent(state, task, { mutationId, type: `task.${input.state}`, hash, clock });
      return task;
    },
    options,
  );
}

function activeRun(task, runId) {
  validateStableId(runId, 'run', '$.runId');
  if (!task.owner || task.owner.runId !== runId)
    throw new TaskStateError(
      'Run does not own the current task revision.',
      'TASK_OWNERSHIP_CONFLICT',
      '$.runId',
    );
  const run = task.runs.find((item) => item.id === runId);
  if (!run || run.state !== 'running')
    throw new TaskStateError('Run is not active.', 'TASK_OWNERSHIP_CONFLICT', '$.runId');
  return run;
}

export async function checkpointTask(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    runId: input.runId,
    expectedRevision: input.expectedRevision,
    summary: input.summary,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      activeRun(task, input.runId);
      if (typeof input.summary !== 'string' || !input.summary.trim())
        throw new TaskStateError(
          'Checkpoint summary is required.',
          'TASK_STATE_INVALID',
          '$.summary',
        );
      task.checkpoints.push({
        id: id('checkpoint'),
        runId: input.runId,
        taskRevision: task.revision + 1,
        summary: input.summary,
        source: await captureSource(projectRoot),
        createdAt: iso(clock),
      });
      commitEvent(state, task, {
        mutationId,
        type: 'checkpoint.recorded',
        hash,
        runId: input.runId,
        clock,
      });
      return task;
    },
    options,
  );
}

export async function recordEvidence(root, input, options = {}) {
  const request = {
    ...input,
    mutationId: input.mutationId,
    authorization: input.authorization ?? null,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      const run = activeRun(task, input.runId);
      const criterion = task.criteria.find((item) => item.id === input.criterionId);
      if (!criterion)
        throw new TaskStateError(
          'Criterion does not exist.',
          'TASK_EVIDENCE_REJECTED',
          '$.criterionId',
        );
      if (input.criterionRevision !== criterion.revision)
        throw new TaskStateError(
          'Evidence targets a stale criterion revision.',
          'TASK_EVIDENCE_STALE',
          '$.criterionRevision',
        );
      if (!EVIDENCE_OUTCOMES.includes(input.outcome))
        throw new TaskStateError('Unknown evidence outcome.', 'TASK_STATE_INVALID', '$.outcome');
      const kind = input.kind ?? 'check';
      if (criterion.approvalRequired && kind !== 'approval')
        throw new TaskStateError(
          'This criterion requires explicit approval evidence.',
          'TASK_AUTHORIZATION_REQUIRED',
          '$.kind',
        );
      let authorizationId = null;
      if (kind === 'approval') {
        const authorization = normalizeAuthorization(input.authorization, clock);
        task.authorizations.push(authorization);
        authorizationId = authorization.id;
      } else if (kind !== 'check')
        throw new TaskStateError(
          'Evidence kind must be check or approval.',
          'TASK_STATE_INVALID',
          '$.kind',
        );
      task.evidence.push({
        id: id('evidence'),
        criterionId: criterion.id,
        criterionRevision: criterion.revision,
        runId: run.id,
        kind,
        command: input.command ?? null,
        environment: {
          platform: process.platform,
          runtime: process.release.name,
          node: process.version,
          cwd: projectRoot,
          details: input.environmentDetails ?? null,
        },
        outcome: input.outcome,
        artifact: input.artifact ?? null,
        source: await captureSource(projectRoot),
        authorizationId,
        createdAt: iso(clock),
      });
      commitEvent(state, task, {
        mutationId,
        type: 'evidence.recorded',
        hash,
        runId: run.id,
        clock,
      });
      return task;
    },
    options,
  );
}

export async function completeTask(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    runId: input.runId,
    expectedRevision: input.expectedRevision,
  };
  return mutate(
    root,
    request,
    async ({ state, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      const run = activeRun(task, input.runId);
      run.state = 'completed';
      run.endedAt = iso(clock);
      task.owner = null;
      task.state = 'completed';
      commitEvent(state, task, { mutationId, type: 'task.completed', hash, runId: run.id, clock });
      return task;
    },
    options,
  );
}

export async function cancelTask(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    reason: input.reason ?? null,
  };
  return mutate(
    root,
    request,
    async ({ state, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      if (task.owner) {
        const run = task.runs.find((item) => item.id === task.owner.runId);
        if (run?.state === 'running') {
          run.state = 'cancelled';
          run.endedAt = iso(clock);
        }
      }
      task.owner = null;
      task.state = 'cancelled';
      commitEvent(state, task, {
        mutationId,
        type: input.reason ? `task.cancelled:${input.reason}` : 'task.cancelled',
        hash,
        clock,
      });
      return task;
    },
    options,
  );
}

function verificationFailures(task, source) {
  const failures = [];
  for (const criterion of task.criteria.filter((item) => item.required)) {
    const candidates = task.evidence.filter(
      (item) => item.criterionId === criterion.id && item.criterionRevision === criterion.revision,
    );
    const evidence = candidates.findLast((item) => sourceEqual(item.source, source));
    if (!evidence) failures.push({ criterionId: criterion.id, reason: 'missing-current-evidence' });
    else if (evidence.outcome !== 'passed')
      failures.push({ criterionId: criterion.id, reason: `outcome-${evidence.outcome}` });
    else if (
      criterion.approvalRequired &&
      (evidence.kind !== 'approval' ||
        !task.authorizations.some((item) => item.id === evidence.authorizationId))
    ) {
      failures.push({ criterionId: criterion.id, reason: 'approval-required' });
    }
  }
  return failures;
}

export async function verifyTask(root, input, options = {}) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      if (task.state !== 'completed')
        throw new TaskStateError(
          'Only a completed task can be verified.',
          'TASK_TRANSITION_INVALID',
          '$.state',
        );
      const failures = verificationFailures(task, await captureSource(projectRoot));
      if (failures.length) {
        const error = new TaskStateError(
          'Required acceptance evidence is missing, stale, or unsuccessful.',
          'TASK_NOT_VERIFIABLE',
          '$.evidence',
        );
        error.failures = failures;
        throw error;
      }
      task.state = 'verified';
      commitEvent(state, task, { mutationId, type: 'task.verified', hash, clock });
      return task;
    },
    options,
  );
}

export async function inspectTask(root, taskId, options = {}) {
  root = await resolveProjectRoot(root);
  const state = await readTaskState(root, { allowMissing: false });
  const task = findTask(state, taskId);
  const source = await captureSource(root);
  const active = task.owner ? task.runs.find((item) => item.id === task.owner.runId) : null;
  const processProbe = options.processProbe ?? isRecordedProcessLive;
  return {
    task: structuredClone(task),
    reconciliation: {
      currentSource: source,
      recordedProcess: active ? ((await processProbe(active)) ? 'live' : 'missing') : 'none',
      verifiable: task.state === 'completed' && verificationFailures(task, source).length === 0,
      verificationFailures: verificationFailures(task, source),
    },
  };
}

export async function listTasks(root) {
  root = await resolveProjectRoot(root);
  const state = await readTaskState(root, { allowMissing: false });
  return {
    schemaVersion: state.schemaVersion,
    project: state.project,
    revision: state.revision,
    tasks: structuredClone(state.tasks),
  };
}

export {
  TASK_STATE_SCHEMA_VERSION,
  TASK_STATES,
  RUN_STATES,
  EVIDENCE_OUTCOMES,
  TaskStateError,
} from './contracts.js';
