import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EVIDENCE_OUTCOMES, TaskStateError, validateStableId } from './contracts.js';
import { cleanupTaskStateTemps, readTaskState, writeTaskState } from './store.js';
import { withTaskStateLock } from './lock.js';
import type {
  Authorization,
  Criterion,
  EnhancedArtifact,
  EnhancedCheck,
  ProcessIdentity,
  SourceSnapshot,
  Task,
  TaskImport,
  TaskRun,
  TaskState,
} from './contracts.js';
import type { StateWriteOptions } from './store.js';
import { errorCode } from '../types.js';
import { readOptional, resolveProjectRoot, safePath, writeAtomic } from '../storage.js';
import { TASK_STATE_PATH } from './store.js';

const execFileAsync = promisify(execFile);
const TERMINAL_TASK_STATES = new Set(['cancelled', 'verified']);
const IMPORT_RECORD = Symbol('importRecord');

export type AuthorizationInput = {
  source: string;
  scope: string;
  reference: string;
  provenanceKind?: 'direct-request' | 'explicit-cli';
};
export type CriterionInput = {
  id?: string;
  description: string;
  required?: boolean;
  approvalRequired?: boolean;
};
export type MutationOptions = StateWriteOptions & {
  clock?: () => Date;
  processProbe?: (run: TaskRun) => boolean | Promise<boolean>;
  [IMPORT_RECORD]?: TaskImport;
};
export type TaskMutationInput = { taskId: string; expectedRevision: number; mutationId?: string };
export type CreateTaskInput = {
  mutationId?: string;
  title: string;
  criteria?: CriterionInput[];
  authorizationRequired?: boolean;
  authorization?: AuthorizationInput;
};
export type EnhancedArtifactInput = { path: string; templateVersion: number };
export type EnhancedCheckInput = {
  id: string;
  criterionId: string;
  type: 'cli' | 'http' | 'browser' | 'manual';
};
export type EnhancedWorkflowInput = TaskMutationInput & {
  criteria?: CriterionInput[];
  artifacts: { prd: EnhancedArtifactInput; technicalPlan: EnhancedArtifactInput };
  checks: EnhancedCheckInput[];
};
export type ResumeTaskInput = TaskMutationInput & { ownerId?: string };
export type EvidenceInput = TaskMutationInput & {
  runId: string;
  criterionId: string;
  criterionRevision: number;
  outcome: string;
  kind?: string;
  authorization?: AuthorizationInput;
  command?: string;
  environmentDetails?: string;
  artifact?: string;
};
type MutationContext = {
  state: TaskState;
  root: string;
  clock: () => Date;
  mutationId: string;
  hash: string;
};
type VerificationFailure = { criterionId: string; reason: string };

const iso = (clock: () => Date) => clock().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value: object) {
  return digest(canonical(value)!);
}

function normalizeMutationId(value?: string) {
  value ??= id('event');
  return validateStableId(value, 'event', '$.mutationId');
}

function assertExpected(task: Task, expectedRevision: unknown) {
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
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

function findTask(state: TaskState, taskId: unknown): Task {
  validateStableId(taskId, 'task', '$.taskId');
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task)
    throw new TaskStateError(`Task ${taskId} does not exist.`, 'TASK_NOT_FOUND', '$.taskId');
  return task;
}

function ensureMutable(task: Task) {
  if (TERMINAL_TASK_STATES.has(task.state)) {
    throw new TaskStateError(
      `Task state ${task.state} is terminal.`,
      'TASK_TRANSITION_INVALID',
      '$.state',
    );
  }
}

function normalizeAuthorization(
  value: AuthorizationInput | undefined,
  clock: () => Date,
  provenanceKind: 'direct-request' | 'explicit-cli' = 'direct-request',
): Authorization {
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

function normalizeCriteria(criteria: CriterionInput[], clock: () => Date): Criterion[] {
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

async function gitState(root: string) {
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

async function fingerprintFiles(root: string) {
  const entries: string[] = [];
  async function visit(directory: string, relative = ''): Promise<void> {
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

export async function captureSource(root: string): Promise<SourceSnapshot> {
  root = await resolveProjectRoot(root);
  const git = await gitState(root);
  return {
    revision: git.revision,
    dirtyFingerprint: git.dirty ? await fingerprintFiles(root) : null,
  };
}

function processIdentity(): ProcessIdentity {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    platform: process.platform,
    runtime: process.release.name,
  };
}

export function isRecordedProcessLive(run: TaskRun) {
  if (run.process.hostname !== os.hostname()) return false;
  try {
    process.kill(run.process.pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EPERM') return true;
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

function sourceEqual(left: SourceSnapshot, right: SourceSnapshot) {
  return left.revision === right.revision && left.dirtyFingerprint === right.dirtyFingerprint;
}

function findPriorMutation(state: TaskState, mutationId: string, hash: string) {
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

function commitEvent(
  state: TaskState,
  task: Task,
  {
    mutationId,
    type,
    hash,
    runId,
    clock,
  }: { mutationId: string; type: string; hash: string; runId?: string; clock: () => Date },
) {
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

async function mutate(
  root: string,
  request: { mutationId?: string },
  operation: (context: MutationContext) => Promise<Task>,
  options: MutationOptions = {},
): Promise<Task> {
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

export async function createTask(
  root: string,
  input: CreateTaskInput,
  options: MutationOptions = {},
) {
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
      const task: Task = {
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
      if (state.schemaVersion >= 2) task.enhancedWorkflow = null;
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

export async function importMarkdownTask(
  root: string,
  input: CreateTaskInput & { notePath?: string },
  options: MutationOptions = {},
) {
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

function reconcileCriteria(
  currentCriteria: Criterion[],
  input: CriterionInput[],
  clock: () => Date,
) {
  if (!Array.isArray(input))
    throw new TaskStateError('Expected an array.', 'TASK_STATE_INVALID', '$.criteria');
  const current = new Map(currentCriteria.map((item) => [item.id, item]));
  const at = iso(clock);
  const next = input.map((item, index) => {
    if (!item || typeof item.description !== 'string' || !item.description.trim())
      throw new TaskStateError(
        'Criterion description is required.',
        'TASK_STATE_INVALID',
        `$.criteria[${index}].description`,
      );
    const suppliedId = item.id
      ? validateStableId(item.id, 'criterion', `$.criteria[${index}].id`)
      : null;
    const previous = suppliedId ? current.get(suppliedId) : null;
    const candidate = {
      description: item.description,
      required: item.required ?? true,
      approvalRequired: item.approvalRequired ?? false,
    };
    if (!previous)
      return {
        id: suppliedId ?? id('criterion'),
        revision: 1,
        ...candidate,
        createdAt: at,
        updatedAt: at,
      };
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
  if (new Set(next.map((item) => item.id)).size !== next.length)
    throw new TaskStateError('Criterion IDs must be unique.', 'TASK_STATE_INVALID', '$.criteria');
  return next;
}

async function enhancedArtifact(
  root: string,
  input: EnhancedArtifactInput,
  field: string,
): Promise<EnhancedArtifact> {
  if (
    !input ||
    typeof input.path !== 'string' ||
    !/^\.latchkit\/notes\/.+\.md$/.test(input.path.replaceAll('\\', '/'))
  )
    throw new TaskStateError(
      'Enhanced artifacts must be Markdown notes under .latchkit/notes/.',
      'TASK_ENHANCED_WORKFLOW_INVALID',
      `${field}.path`,
    );
  if (!Number.isInteger(input.templateVersion) || input.templateVersion < 1)
    throw new TaskStateError(
      'Artifact templateVersion must be a positive integer.',
      'TASK_ENHANCED_WORKFLOW_INVALID',
      `${field}.templateVersion`,
    );
  const artifactPath = input.path.replaceAll('\\', '/');
  const bytes = await readFile(await safePath(root, artifactPath));
  return { path: artifactPath, sha256: digest(bytes), templateVersion: input.templateVersion };
}

export async function registerEnhancedWorkflow(
  root: string,
  input: EnhancedWorkflowInput,
  options: MutationOptions = {},
) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    criteria: input.criteria ?? null,
    artifacts: input.artifacts,
    checks: input.checks,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      if (state.schemaVersion < 2)
        throw new TaskStateError(
          'Enhanced workflows require an explicit task-state migration to version 2.',
          'TASK_STATE_MIGRATION_REQUIRED',
          '$.schemaVersion',
        );
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      const criteria = input.criteria
        ? reconcileCriteria(task.criteria, input.criteria, clock)
        : task.criteria;
      const required = criteria.filter((criterion) => criterion.required);
      if (required.length === 0)
        throw new TaskStateError(
          'Enhanced workflows require at least one required criterion.',
          'TASK_ENHANCED_WORKFLOW_INVALID',
          '$.criteria',
        );
      if (!input.artifacts || !input.checks || !Array.isArray(input.checks))
        throw new TaskStateError(
          'Enhanced artifacts and checks are required.',
          'TASK_ENHANCED_WORKFLOW_INVALID',
          '$',
        );
      const criterionIds = new Set(criteria.map((criterion) => criterion.id));
      const checkIds = new Set<string>();
      const checks: EnhancedCheck[] = input.checks.map((check, index) => {
        const at = `$.checks[${index}]`;
        if (!check || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(check.id))
          throw new TaskStateError(
            'Check ID must be lowercase and portable.',
            'TASK_ENHANCED_WORKFLOW_INVALID',
            `${at}.id`,
          );
        if (checkIds.has(check.id))
          throw new TaskStateError(
            'Check IDs must be unique.',
            'TASK_ENHANCED_WORKFLOW_INVALID',
            `${at}.id`,
          );
        checkIds.add(check.id);
        validateStableId(check.criterionId, 'criterion', `${at}.criterionId`);
        if (!criterionIds.has(check.criterionId))
          throw new TaskStateError(
            'Check references an unknown criterion.',
            'TASK_ENHANCED_WORKFLOW_INVALID',
            `${at}.criterionId`,
          );
        if (!['cli', 'http', 'browser', 'manual'].includes(check.type))
          throw new TaskStateError(
            'Unknown check type.',
            'TASK_ENHANCED_WORKFLOW_INVALID',
            `${at}.type`,
          );
        return {
          ...check,
          definitionSha256: digest(canonical(check)!),
        };
      });
      for (const criterion of required) {
        if (!checks.some((check) => check.criterionId === criterion.id))
          throw new TaskStateError(
            'Every required criterion must map to at least one check.',
            'TASK_ENHANCED_WORKFLOW_INVALID',
            '$.checks',
          );
      }
      const artifacts = {
        prd: await enhancedArtifact(projectRoot, input.artifacts.prd, '$.artifacts.prd'),
        technicalPlan: await enhancedArtifact(
          projectRoot,
          input.artifacts.technicalPlan,
          '$.artifacts.technicalPlan',
        ),
      };
      const at = iso(clock);
      const previous = task.enhancedWorkflow;
      task.criteria = criteria;
      task.enhancedWorkflow = {
        schemaVersion: 1,
        revision: previous ? previous.revision + 1 : 1,
        enrolledAt: previous?.enrolledAt ?? at,
        updatedAt: at,
        artifacts,
        checks,
      };
      if (task.state === 'completed') task.state = 'planned';
      commitEvent(state, task, { mutationId, type: 'enhanced-workflow.registered', hash, clock });
      return task;
    },
    options,
  );
}

export async function reviseCriteria(
  root: string,
  input: TaskMutationInput & { criteria: CriterionInput[] },
  options: MutationOptions = {},
) {
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
      task.criteria = reconcileCriteria(task.criteria, input.criteria, clock);
      if (task.state === 'completed') task.state = 'planned';
      commitEvent(state, task, { mutationId, type: 'criteria.revised', hash, clock });
      return task;
    },
    options,
  );
}

export async function resumeTask(
  root: string,
  input: ResumeTaskInput,
  options: MutationOptions = {},
) {
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
        const activeRun = task.runs.find((run) => run.id === task.owner?.runId);
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

export async function authorizeTask(
  root: string,
  input: TaskMutationInput & { authorization: AuthorizationInput },
  options: MutationOptions = {},
) {
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

export async function pauseTask(
  root: string,
  input: TaskMutationInput & { state: string; reason?: string },
  options: MutationOptions = {},
) {
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
        const run = task.runs.find((item) => item.id === task.owner?.runId);
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

function activeRun(task: Task, runId: string): TaskRun {
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

export async function checkpointTask(
  root: string,
  input: TaskMutationInput & { runId: string; summary: string },
  options: MutationOptions = {},
) {
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

export async function recordEvidence(
  root: string,
  input: EvidenceInput,
  options: MutationOptions = {},
) {
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
      } else if (kind !== 'check' && !/^enhanced-check:[a-z0-9][a-z0-9._-]{0,127}$/.test(kind))
        throw new TaskStateError(
          'Evidence kind must be check, approval, or a registered enhanced check.',
          'TASK_STATE_INVALID',
          '$.kind',
        );
      if (
        kind.startsWith('enhanced-check:') &&
        !task.enhancedWorkflow?.checks.some((check) => `enhanced-check:${check.id}` === kind)
      )
        throw new TaskStateError(
          'Enhanced evidence must reference a registered check.',
          'TASK_EVIDENCE_REJECTED',
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

export async function completeTask(
  root: string,
  input: TaskMutationInput & { runId: string },
  options: MutationOptions = {},
) {
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

export async function cancelTask(
  root: string,
  input: TaskMutationInput & { reason?: string },
  options: MutationOptions = {},
) {
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
        const run = task.runs.find((item) => item.id === task.owner?.runId);
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

function verificationFailures(task: Task, source: SourceSnapshot): VerificationFailure[] {
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
  if (task.enhancedWorkflow) {
    const required = task.criteria.filter((item) => item.required);
    if (required.length === 0)
      failures.push({ criterionId: 'enhanced-workflow', reason: 'missing-required-criterion' });
    for (const criterion of required) {
      const checks = task.enhancedWorkflow.checks.filter(
        (check) => check.criterionId === criterion.id,
      );
      if (checks.length === 0) {
        failures.push({ criterionId: criterion.id, reason: 'missing-check-mapping' });
        continue;
      }
      for (const check of checks) {
        const evidence = task.evidence
          .filter(
            (item) =>
              item.criterionId === criterion.id &&
              item.criterionRevision === criterion.revision &&
              item.kind === `enhanced-check:${check.id}` &&
              sourceEqual(item.source, source),
          )
          .at(-1);
        if (!evidence)
          failures.push({ criterionId: criterion.id, reason: `missing-check:${check.id}` });
        else if (evidence.outcome !== 'passed')
          failures.push({
            criterionId: criterion.id,
            reason: `check-${check.id}-outcome-${evidence.outcome}`,
          });
      }
    }
  }
  return failures;
}

export async function migrateTaskState(
  root: string,
  { dryRun = false, faultBoundary }: { dryRun?: boolean } & StateWriteOptions = {},
) {
  root = await resolveProjectRoot(root);
  return withTaskStateLock(root, async () => {
    await cleanupTaskStateTemps(root);
    const raw = await readOptional(root, TASK_STATE_PATH);
    if (raw === null) {
      const state = await readTaskState(root);
      return { action: 'current' as const, fromVersion: 2, toVersion: 2, backup: null, state };
    }
    const state = await readTaskState(root, { allowMissing: false });
    if (state.schemaVersion === 2)
      return { action: 'current' as const, fromVersion: 2, toVersion: 2, backup: null, state };
    const backup = `.latchkit/backups/task-state.v1.${digest(raw)}.json`;
    const migrated: TaskState = {
      ...state,
      schemaVersion: 2,
      tasks: state.tasks.map((task) => ({ ...task, enhancedWorkflow: null })),
    };
    if (dryRun)
      return { action: 'migrate' as const, fromVersion: 1, toVersion: 2, backup, state: migrated };
    const existing = await readOptional(root, backup);
    if (existing !== null && existing !== raw)
      throw new TaskStateError(
        `Migration backup already exists with different contents: ${backup}.`,
        'TASK_STATE_MIGRATION_BACKUP_CONFLICT',
        '$.backup',
      );
    if (existing === null) await writeAtomic(root, backup, raw, 0o600);
    await writeTaskState(root, migrated, { faultBoundary });
    return { action: 'migrated' as const, fromVersion: 1, toVersion: 2, backup, state: migrated };
  });
}

export async function verifyTask(
  root: string,
  input: TaskMutationInput,
  options: MutationOptions = {},
) {
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

export async function inspectTask(root: string, taskId: string, options: MutationOptions = {}) {
  root = await resolveProjectRoot(root);
  const state = await readTaskState(root, { allowMissing: false });
  const task = findTask(state, taskId);
  const source = await captureSource(root);
  const active = task.owner ? task.runs.find((item) => item.id === task.owner?.runId) : null;
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

export async function listTasks(root: string) {
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
