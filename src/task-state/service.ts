import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  EVIDENCE_OUTCOMES,
  PLAN_ARTIFACT_PATH_PATTERN,
  TASK_STATE_SCHEMA_VERSION,
  TaskStateError,
  validateStableId,
} from './contracts.js';
import { cleanupTaskStateTemps, readTaskState, writeTaskState } from './store.js';
import { withTaskStateLock } from './lock.js';
import { isVerificationMode } from '../verification/contracts.js';
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
  VerificationMode,
} from './contracts.js';
import type { StateWriteOptions } from './store.js';
import { errorCode } from '../types.js';
import { readOptional, resolveProjectRoot, safePath, writeAtomic } from '../storage.js';
import { TASK_STATE_PATH } from './store.js';
import {
  buildRecordDependencyEdges,
  DEFAULT_RECORD_LIST_LIMIT,
  detectRecordDependencyCycle,
  isRecordAuthoritativeStatus,
  isRecordStatusTerminal,
  isRecordTransitionValid,
  MAX_RECORD_HISTORY,
  MAX_RECORD_LINKS,
  MAX_RECORD_LIST_LIMIT,
  MAX_RECORD_REASON_BYTES,
  MAX_RECORD_REFERENCE_BYTES,
  MAX_RECORD_TEXT_BYTES,
  MAX_RECORDS_PER_TASK,
  RECORD_INITIAL_STATUS,
  RECORD_KINDS,
  RECORD_PROVENANCE_KINDS,
  RECORD_STATUSES,
  reconcileSourceLinkStatus,
  recordTransitionRequiresAuthority,
} from './records.js';
import type { RecordKind, RecordLink, RecordProvenanceKind, TaskRecord } from './records.js';
import { inspectProjectMemory } from '../project-memory/service.js';

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
  /** Explicit fast/standard selection for this task's verification. Ignored
   * on a store below schema version 3; defaults to standard. */
  verificationMode?: VerificationMode;
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
  if (input.verificationMode !== undefined && !isVerificationMode(input.verificationMode))
    throw new TaskStateError(
      'verificationMode must be fast or standard.',
      'TASK_STATE_INVALID',
      '$.verificationMode',
    );
  const request = {
    mutationId: input.mutationId,
    title: input.title,
    criteria: input.criteria ?? [],
    authorizationRequired: input.authorizationRequired ?? true,
    authorization: input.authorization ?? null,
    verificationMode: input.verificationMode ?? null,
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
      if (state.schemaVersion >= 3) task.verificationMode = input.verificationMode ?? 'standard';
      if (state.schemaVersion >= 4) task.records = [];
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
  if (typeof relative !== 'string' || !PLAN_ARTIFACT_PATH_PATTERN.test(relative)) {
    throw new TaskStateError(
      'Import path must be a Markdown plan under docs/plans/ or the legacy .latchkit/notes/.',
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
    !PLAN_ARTIFACT_PATH_PATTERN.test(input.path.replaceAll('\\', '/'))
  )
    throw new TaskStateError(
      'Enhanced artifacts must be Markdown plans under docs/plans/ or the legacy .latchkit/notes/.',
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

/** Explicitly change a task's persisted verification mode. Ordinary resume
 * never calls this: a task keeps its existing mode until an explicit,
 * authorized change like this one. Requires task-state schema version 3. */
export async function setVerificationMode(
  root: string,
  input: TaskMutationInput & { verificationMode: VerificationMode },
  options: MutationOptions = {},
) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    verificationMode: input.verificationMode,
  };
  return mutate(
    root,
    request,
    async ({ state, clock, mutationId, hash }) => {
      if (state.schemaVersion < 3)
        throw new TaskStateError(
          'Changing verification mode requires an explicit task-state migration to version 3.',
          'TASK_STATE_MIGRATION_REQUIRED',
          '$.schemaVersion',
        );
      if (!isVerificationMode(input.verificationMode))
        throw new TaskStateError(
          'verificationMode must be fast or standard.',
          'TASK_STATE_INVALID',
          '$.verificationMode',
        );
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      task.verificationMode = input.verificationMode;
      commitEvent(state, task, {
        mutationId,
        type: `verification-mode.changed:${input.verificationMode}`,
        hash,
        clock,
      });
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

function migrateTaskStep(state: TaskState, fromVersion: number): TaskState {
  if (fromVersion === 1)
    return {
      ...state,
      schemaVersion: 2,
      tasks: state.tasks.map((task) => ({ ...task, enhancedWorkflow: null })),
    };
  if (fromVersion === 2)
    return {
      ...state,
      schemaVersion: 3,
      tasks: state.tasks.map((task) => ({ ...task, verificationMode: 'standard' as const })),
    };
  if (fromVersion === 3)
    return {
      ...state,
      schemaVersion: 4,
      tasks: state.tasks.map((task) => ({ ...task, records: [] })),
    };
  throw new TaskStateError(
    `No migration is available from version ${fromVersion}.`,
    'TASK_STATE_MIGRATION_UNSUPPORTED',
    '$.schemaVersion',
  );
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
      return {
        action: 'current' as const,
        fromVersion: TASK_STATE_SCHEMA_VERSION,
        toVersion: TASK_STATE_SCHEMA_VERSION,
        backup: null,
        state,
      };
    }
    const state = await readTaskState(root, { allowMissing: false });
    const fromVersion = state.schemaVersion;
    if (fromVersion === TASK_STATE_SCHEMA_VERSION)
      return {
        action: 'current' as const,
        fromVersion,
        toVersion: TASK_STATE_SCHEMA_VERSION,
        backup: null,
        state,
      };
    let migrated: TaskState = state;
    for (let version = fromVersion; version < TASK_STATE_SCHEMA_VERSION; version += 1)
      migrated = migrateTaskStep(migrated, version);
    const backup = `.latchkit/backups/task-state.v${fromVersion}.${digest(raw)}.json`;
    if (dryRun)
      return {
        action: 'migrate' as const,
        fromVersion,
        toVersion: TASK_STATE_SCHEMA_VERSION,
        backup,
        state: migrated,
      };
    const existing = await readOptional(root, backup);
    if (existing !== null && existing !== raw)
      throw new TaskStateError(
        `Migration backup already exists with different contents: ${backup}.`,
        'TASK_STATE_MIGRATION_BACKUP_CONFLICT',
        '$.backup',
      );
    if (existing === null) await writeAtomic(root, backup, raw, 0o600);
    await writeTaskState(root, migrated, { faultBoundary });
    return {
      action: 'migrated' as const,
      fromVersion,
      toVersion: TASK_STATE_SCHEMA_VERSION,
      backup,
      state: migrated,
    };
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

// ---------------------------------------------------------------------------
// Task records: decision/assumption/observation/question knowledge state with
// explicit provenance (task-state schema version 4). See docs/task-state.md.
// ---------------------------------------------------------------------------

export type RecordLinkInput =
  | { type: 'record'; recordId: string; recordRevision?: number }
  | { type: 'criterion'; criterionId: string; criterionRevision?: number }
  | { type: 'evidence'; evidenceId: string }
  | { type: 'memory'; memoryId: string; memoryRevision: number }
  | { type: 'source'; path: string; digestUnavailable?: boolean };

export type RecordCreateInput = TaskMutationInput & {
  kind: RecordKind;
  text: string;
  provenance: { kind: RecordProvenanceKind; reference: string };
  links?: RecordLinkInput[];
  /** ID of a prior same-kind record this one explicitly supersedes. */
  supersedes?: string;
  /** Authority used only when the superseded record was in an authoritative status. */
  authorizationId?: string;
  authorization?: AuthorizationInput;
};

export type RecordReviseInput = TaskMutationInput & {
  recordId: string;
  recordRevision: number;
  text?: string;
  links?: RecordLinkInput[];
  reason?: string;
};

export type RecordTransitionInput = TaskMutationInput & {
  recordId: string;
  recordRevision: number;
  status: string;
  reason: string;
  authorizationId?: string;
  authorization?: AuthorizationInput;
  /** Required to move an observation to `verified`: current, passing task evidence. */
  evidenceId?: string;
};

export type RecordListInput = {
  taskId: string;
  kind?: RecordKind;
  status?: string;
  limit?: number;
  cursor?: string;
};

export type RecordInspectInput = { taskId: string; recordId: string };

function assertRecordsMigrated(state: TaskState) {
  if (state.schemaVersion < 4)
    throw new TaskStateError(
      'Task records require an explicit task-state migration to version 4.',
      'TASK_STATE_MIGRATION_REQUIRED',
      '$.schemaVersion',
    );
}

function findRecord(task: Task, recordId: string): TaskRecord {
  const validId = validateStableId(recordId, 'record', '$.recordId');
  const target = (task.records ?? []).find((item) => item.id === validId);
  if (!target)
    throw new TaskStateError(
      `Record ${validId} does not exist.`,
      'TASK_RECORD_NOT_FOUND',
      '$.recordId',
    );
  return target;
}

function assertRecordExpected(
  target: TaskRecord,
  expectedRevision: unknown,
  path = '$.recordRevision',
) {
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw new TaskStateError('Expected a positive record revision.', 'TASK_STATE_INVALID', path);
  }
  if (target.revision !== expectedRevision) {
    const error = new TaskStateError(
      `Expected record revision ${expectedRevision}, found ${target.revision}.`,
      'TASK_RECORD_STALE',
      path,
    );
    error.expectedRevision = expectedRevision;
    error.actualRevision = target.revision;
    throw error;
  }
}

function normalizeRecordText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TaskStateError('Record text is required.', 'TASK_STATE_INVALID', path);
  if (Buffer.byteLength(value, 'utf8') > MAX_RECORD_TEXT_BYTES)
    throw new TaskStateError(
      'Record text exceeds the maximum size.',
      'TASK_RECORD_TEXT_TOO_LARGE',
      path,
    );
  return value;
}

function normalizeRecordReason(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TaskStateError('A reason is required.', 'TASK_STATE_INVALID', path);
  if (Buffer.byteLength(value, 'utf8') > MAX_RECORD_REASON_BYTES)
    throw new TaskStateError(
      'Reason exceeds the maximum size.',
      'TASK_RECORD_TEXT_TOO_LARGE',
      path,
    );
  return value;
}

function normalizeRecordProvenance(
  value: unknown,
  path: string,
): { kind: RecordProvenanceKind; reference: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TaskStateError('Record provenance is required.', 'TASK_STATE_INVALID', path);
  const provenance = value as { kind?: unknown; reference?: unknown };
  if (
    typeof provenance.kind !== 'string' ||
    !(RECORD_PROVENANCE_KINDS as readonly string[]).includes(provenance.kind)
  )
    throw new TaskStateError(
      'Unknown record provenance kind.',
      'TASK_STATE_INVALID',
      `${path}.kind`,
    );
  if (typeof provenance.reference !== 'string' || !provenance.reference.trim())
    throw new TaskStateError(
      'Record provenance reference is required.',
      'TASK_STATE_INVALID',
      `${path}.reference`,
    );
  if (Buffer.byteLength(provenance.reference, 'utf8') > MAX_RECORD_REFERENCE_BYTES)
    throw new TaskStateError(
      'Record provenance reference exceeds the maximum size.',
      'TASK_RECORD_TEXT_TOO_LARGE',
      `${path}.reference`,
    );
  return { kind: provenance.kind as RecordProvenanceKind, reference: provenance.reference };
}

async function normalizeRecordLink(
  root: string,
  input: RecordLinkInput,
  task: Task,
  records: TaskRecord[],
  path: string,
  clock: () => Date,
): Promise<RecordLink> {
  if (!input || typeof input !== 'object')
    throw new TaskStateError('Expected a link object.', 'TASK_STATE_INVALID', path);
  if (input.type === 'record') {
    const recordId = validateStableId(input.recordId, 'record', `${path}.recordId`);
    const target = records.find((item) => item.id === recordId);
    if (!target)
      throw new TaskStateError(
        'Linked record does not exist.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.recordId`,
      );
    const recordRevision = input.recordRevision ?? target.revision;
    if (!Number.isInteger(recordRevision) || recordRevision < 1 || recordRevision > target.revision)
      throw new TaskStateError(
        'Record link references an unknown revision.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.recordRevision`,
      );
    return { type: 'record', recordId, recordRevision };
  }
  if (input.type === 'criterion') {
    const criterionId = validateStableId(input.criterionId, 'criterion', `${path}.criterionId`);
    const criterion = task.criteria.find((item) => item.id === criterionId);
    if (!criterion)
      throw new TaskStateError(
        'Linked criterion does not exist.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.criterionId`,
      );
    const criterionRevision = input.criterionRevision ?? criterion.revision;
    if (
      !Number.isInteger(criterionRevision) ||
      criterionRevision < 1 ||
      criterionRevision > criterion.revision
    )
      throw new TaskStateError(
        'Criterion link references an unknown revision.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.criterionRevision`,
      );
    return { type: 'criterion', criterionId, criterionRevision };
  }
  if (input.type === 'evidence') {
    const evidenceId = validateStableId(input.evidenceId, 'evidence', `${path}.evidenceId`);
    if (!task.evidence.some((item) => item.id === evidenceId))
      throw new TaskStateError(
        'Linked evidence does not exist.',
        'TASK_RECORD_LINK_INVALID',
        `${path}.evidenceId`,
      );
    return { type: 'evidence', evidenceId };
  }
  if (input.type === 'memory') {
    if (typeof input.memoryId !== 'string' || !/^memory_[0-9a-f-]{36}$/i.test(input.memoryId))
      throw new TaskStateError(
        'Expected a stable memory ID.',
        'TASK_STATE_INVALID',
        `${path}.memoryId`,
      );
    if (!Number.isInteger(input.memoryRevision) || input.memoryRevision < 1)
      throw new TaskStateError(
        'Expected a positive memory revision.',
        'TASK_STATE_INVALID',
        `${path}.memoryRevision`,
      );
    return { type: 'memory', memoryId: input.memoryId, memoryRevision: input.memoryRevision };
  }
  if (input.type === 'source') {
    const relative = typeof input.path === 'string' ? input.path.replaceAll('\\', '/') : '';
    if (
      !relative ||
      relative.startsWith('/') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new TaskStateError(
        'Source link path must be a repository-relative path.',
        'TASK_STATE_INVALID',
        `${path}.path`,
      );
    if (input.digestUnavailable)
      return { type: 'source', path: relative, digest: null, observedAt: iso(clock) };
    let bytes: Buffer;
    try {
      bytes = await readFile(await safePath(root, relative));
    } catch (error) {
      if (errorCode(error) === 'ENOENT')
        throw new TaskStateError(
          `Source link target does not exist: ${relative}. Pass digestUnavailable to link it anyway.`,
          'TASK_RECORD_SOURCE_MISSING',
          `${path}.path`,
        );
      throw error;
    }
    return { type: 'source', path: relative, digest: digest(bytes), observedAt: iso(clock) };
  }
  throw new TaskStateError('Unknown record link type.', 'TASK_STATE_INVALID', `${path}.type`);
}

function assertNoRecordCycle(records: TaskRecord[]) {
  const cycle = detectRecordDependencyCycle(buildRecordDependencyEdges(records));
  if (cycle)
    throw new TaskStateError(
      `Cyclic record dependency: ${cycle.join(' -> ')}.`,
      'TASK_RECORD_CYCLE',
      '$.links',
    );
}

function resolveRecordAuthorization(
  task: Task,
  clock: () => Date,
  input: { authorizationId?: string; authorization?: AuthorizationInput },
  path: string,
): { authorizationId: string; authorization: Authorization | null } {
  if (input.authorizationId) {
    const authorizationId = validateStableId(input.authorizationId, 'authorization', path);
    const existing = task.authorizations.find((item) => item.id === authorizationId);
    if (!existing)
      throw new TaskStateError(
        'Authorization does not exist on this task.',
        'TASK_AUTHORIZATION_INVALID',
        path,
      );
    return { authorizationId: existing.id, authorization: null };
  }
  if (input.authorization) {
    const authorization = normalizeAuthorization(input.authorization, clock);
    return { authorizationId: authorization.id, authorization };
  }
  throw new TaskStateError(
    "This change requires referencing the task's existing direct-user authorization " +
      '(authorizationId) or granting a new one (authorization).',
    'TASK_AUTHORIZATION_REQUIRED',
    path,
  );
}

/**
 * Create a new decision/assumption/observation/question record. Acceptance is never implied by
 * kind or provenance: every new record starts in its kind's non-authoritative status
 * (`RECORD_INITIAL_STATUS`), even when `provenance.kind` is `direct-user`. Optionally supersedes a
 * prior same-kind record in the same mutation; superseding a record that is currently in its
 * kind's authoritative status requires the same authority as an explicit transition would.
 */
export async function recordTaskRecord(
  root: string,
  input: RecordCreateInput,
  options: MutationOptions = {},
) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    kind: input.kind,
    text: input.text,
    provenance: input.provenance,
    links: input.links ?? [],
    supersedes: input.supersedes ?? null,
    authorizationId: input.authorizationId ?? null,
    authorization: input.authorization ?? null,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      assertRecordsMigrated(state);
      if (!(RECORD_KINDS as readonly string[]).includes(input.kind))
        throw new TaskStateError('Unknown record kind.', 'TASK_STATE_INVALID', '$.kind');
      const records = task.records ?? (task.records = []);
      if (records.length >= MAX_RECORDS_PER_TASK)
        throw new TaskStateError(
          'This task has reached its record limit.',
          'TASK_RECORD_LIMIT_EXCEEDED',
          '$.records',
        );
      const text = normalizeRecordText(input.text, '$.text');
      const provenance = normalizeRecordProvenance(input.provenance, '$.provenance');
      const linkInputs = input.links ?? [];
      if (linkInputs.length > MAX_RECORD_LINKS)
        throw new TaskStateError(
          'Too many declared links.',
          'TASK_RECORD_LIMIT_EXCEEDED',
          '$.links',
        );
      const links: RecordLink[] = [];
      for (const [index, linkInput] of linkInputs.entries())
        links.push(
          await normalizeRecordLink(
            projectRoot,
            linkInput,
            task,
            records,
            `$.links[${index}]`,
            clock,
          ),
        );
      let supersedesId: string | null = null;
      let supersededTarget: TaskRecord | null = null;
      if (input.supersedes) {
        supersedesId = validateStableId(input.supersedes, 'record', '$.supersedes');
        supersededTarget = records.find((item) => item.id === supersedesId) ?? null;
        if (!supersededTarget)
          throw new TaskStateError(
            'Superseded record does not exist.',
            'TASK_RECORD_NOT_FOUND',
            '$.supersedes',
          );
        if (supersededTarget.kind !== input.kind)
          throw new TaskStateError(
            'A record can only supersede a record of the same kind.',
            'TASK_STATE_INVALID',
            '$.supersedes',
          );
        if (isRecordStatusTerminal(supersededTarget.status))
          throw new TaskStateError(
            'That record has already been resolved and cannot be superseded again.',
            'TASK_RECORD_TRANSITION_INVALID',
            '$.supersedes',
          );
      }
      const at = iso(clock);
      const newId = id('record');
      const initialStatus = RECORD_INITIAL_STATUS[input.kind];
      const newRecord: TaskRecord = {
        id: newId,
        kind: input.kind,
        revision: 1,
        status: initialStatus,
        text,
        provenance,
        links,
        supersedes: supersedesId,
        supersededBy: null,
        history: [
          {
            revision: 1,
            status: initialStatus,
            text,
            action: 'created',
            reason: null,
            authorizationId: null,
            createdAt: at,
          },
        ],
        createdAt: at,
        updatedAt: at,
      };
      // Validate the dependency graph including the not-yet-committed record before mutating
      // anything else, so a cyclic `record`-type link is rejected before any side effect lands.
      assertNoRecordCycle([...records, newRecord]);
      if (supersededTarget) {
        let authorizationId: string | null = null;
        if (
          recordTransitionRequiresAuthority(
            supersededTarget.kind,
            supersededTarget.status,
            'superseded',
          )
        ) {
          const resolved = resolveRecordAuthorization(task, clock, input, '$.authorizationId');
          authorizationId = resolved.authorizationId;
          if (resolved.authorization) task.authorizations.push(resolved.authorization);
        }
        supersededTarget.status = 'superseded';
        supersededTarget.supersededBy = newId;
        supersededTarget.revision += 1;
        supersededTarget.updatedAt = at;
        supersededTarget.history.push({
          revision: supersededTarget.revision,
          status: 'superseded',
          text: supersededTarget.text,
          action: 'transitioned',
          reason: `Superseded by ${newId}.`,
          authorizationId,
          createdAt: at,
        });
      }
      records.push(newRecord);
      commitEvent(state, task, {
        mutationId,
        type: `record.created:${input.kind}`,
        hash,
        clock,
      });
      return task;
    },
    options,
  );
}

/**
 * Revise a record's text and/or declared links. Only records in a non-terminal,
 * non-authoritative status can be revised; an authoritatively accepted record must instead be
 * superseded (`recordTaskRecord` with `supersedes`) so acceptance can never be silently edited
 * away from what was actually authorized.
 */
export async function reviseTaskRecord(
  root: string,
  input: RecordReviseInput,
  options: MutationOptions = {},
) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    recordId: input.recordId,
    recordRevision: input.recordRevision,
    text: input.text ?? null,
    links: input.links ?? null,
    reason: input.reason ?? null,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      assertRecordsMigrated(state);
      const target = findRecord(task, input.recordId);
      assertRecordExpected(target, input.recordRevision);
      if (isRecordStatusTerminal(target.status))
        throw new TaskStateError(
          'A resolved or superseded record cannot be revised.',
          'TASK_RECORD_TRANSITION_INVALID',
          '$.recordId',
        );
      if (isRecordAuthoritativeStatus(target.kind, target.status))
        throw new TaskStateError(
          'An authoritatively accepted record cannot be revised; supersede it instead.',
          'TASK_RECORD_TRANSITION_INVALID',
          '$.recordId',
        );
      if (input.text === undefined && input.links === undefined)
        throw new TaskStateError('Revision requires new text or links.', 'TASK_STATE_INVALID', '$');
      if (target.history.length >= MAX_RECORD_HISTORY)
        throw new TaskStateError(
          'Record history limit reached; supersede this record instead of revising it further.',
          'TASK_RECORD_LIMIT_EXCEEDED',
          '$.history',
        );
      const records = task.records ?? [];
      if (input.text !== undefined) target.text = normalizeRecordText(input.text, '$.text');
      if (input.links !== undefined) {
        if (input.links.length > MAX_RECORD_LINKS)
          throw new TaskStateError(
            'Too many declared links.',
            'TASK_RECORD_LIMIT_EXCEEDED',
            '$.links',
          );
        const links: RecordLink[] = [];
        for (const [index, linkInput] of input.links.entries())
          links.push(
            await normalizeRecordLink(
              projectRoot,
              linkInput,
              task,
              records,
              `$.links[${index}]`,
              clock,
            ),
          );
        target.links = links;
        assertNoRecordCycle(records);
      }
      const at = iso(clock);
      target.revision += 1;
      target.updatedAt = at;
      target.history.push({
        revision: target.revision,
        status: target.status,
        text: target.text,
        action: 'revised',
        reason: input.reason ?? null,
        authorizationId: null,
        createdAt: at,
      });
      commitEvent(state, task, { mutationId, type: 'record.revised', hash, clock });
      return task;
    },
    options,
  );
}

/**
 * Move a record to a new kind-appropriate status. A transition into or out of the kind's
 * authoritative status (accepted/confirmed/answered) requires referencing the task's existing
 * direct-user authorization (`authorizationId`) or granting a new one (`authorization`); no
 * parser, import, or execution observation can reach that path implicitly. Moving an observation
 * to `verified` instead requires a linked, current, `passed` evidence record — a label or exit
 * status alone is never sufficient.
 */
export async function transitionTaskRecord(
  root: string,
  input: RecordTransitionInput,
  options: MutationOptions = {},
) {
  const request = {
    mutationId: input.mutationId,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    recordId: input.recordId,
    recordRevision: input.recordRevision,
    status: input.status,
    reason: input.reason,
    authorizationId: input.authorizationId ?? null,
    authorization: input.authorization ?? null,
    evidenceId: input.evidenceId ?? null,
  };
  return mutate(
    root,
    request,
    async ({ state, root: projectRoot, clock, mutationId, hash }) => {
      const task = findTask(state, input.taskId);
      assertExpected(task, input.expectedRevision);
      ensureMutable(task);
      assertRecordsMigrated(state);
      const target = findRecord(task, input.recordId);
      assertRecordExpected(target, input.recordRevision);
      const reason = normalizeRecordReason(input.reason, '$.reason');
      if (!RECORD_STATUSES[target.kind].includes(input.status))
        throw new TaskStateError(
          'Status is not valid for this record kind.',
          'TASK_STATE_INVALID',
          '$.status',
        );
      if (!isRecordTransitionValid(target.kind, target.status, input.status))
        throw new TaskStateError(
          `Cannot move a ${target.kind} record from ${target.status} to ${input.status}.`,
          'TASK_RECORD_TRANSITION_INVALID',
          '$.status',
        );
      if (target.history.length >= MAX_RECORD_HISTORY)
        throw new TaskStateError(
          'Record history limit reached; supersede this record instead of transitioning it further.',
          'TASK_RECORD_LIMIT_EXCEEDED',
          '$.history',
        );
      let authorizationId: string | null = null;
      if (recordTransitionRequiresAuthority(target.kind, target.status, input.status)) {
        const resolved = resolveRecordAuthorization(task, clock, input, '$.authorizationId');
        authorizationId = resolved.authorizationId;
        if (resolved.authorization) task.authorizations.push(resolved.authorization);
      }
      if (target.kind === 'observation' && input.status === 'verified') {
        if (!input.evidenceId)
          throw new TaskStateError(
            'Marking an observation verified requires linked passing evidence.',
            'TASK_RECORD_EVIDENCE_REQUIRED',
            '$.evidenceId',
          );
        const evidenceId = validateStableId(input.evidenceId, 'evidence', '$.evidenceId');
        const evidence = task.evidence.find((item) => item.id === evidenceId);
        if (!evidence)
          throw new TaskStateError(
            'Evidence does not exist.',
            'TASK_RECORD_LINK_INVALID',
            '$.evidenceId',
          );
        if (evidence.outcome !== 'passed')
          throw new TaskStateError(
            'Only passing evidence can verify an observation.',
            'TASK_RECORD_EVIDENCE_REQUIRED',
            '$.evidenceId',
          );
        const currentSource = await captureSource(projectRoot);
        if (!sourceEqual(evidence.source, currentSource))
          throw new TaskStateError(
            'Evidence source is no longer current.',
            'TASK_RECORD_EVIDENCE_REQUIRED',
            '$.evidenceId',
          );
        if (
          !target.links.some((link) => link.type === 'evidence' && link.evidenceId === evidenceId)
        )
          target.links = [...target.links, { type: 'evidence', evidenceId }];
      }
      const at = iso(clock);
      target.status = input.status;
      target.revision += 1;
      target.updatedAt = at;
      target.history.push({
        revision: target.revision,
        status: target.status,
        text: target.text,
        action: 'transitioned',
        reason,
        authorizationId,
        createdAt: at,
      });
      commitEvent(state, task, {
        mutationId,
        type: `record.transitioned:${input.status}`,
        hash,
        clock,
      });
      return task;
    },
    options,
  );
}

/** Read-only, paginated listing; never mutates and takes no lock. */
export async function listTaskRecords(root: string, input: RecordListInput) {
  root = await resolveProjectRoot(root);
  const state = await readTaskState(root, { allowMissing: false });
  const task = findTask(state, input.taskId);
  let records = task.records ?? [];
  if (input.kind !== undefined) {
    if (!(RECORD_KINDS as readonly string[]).includes(input.kind))
      throw new TaskStateError('Unknown record kind.', 'TASK_STATE_INVALID', '$.kind');
    records = records.filter((item) => item.kind === input.kind);
  }
  if (input.status !== undefined) records = records.filter((item) => item.status === input.status);
  const limit = input.limit ?? DEFAULT_RECORD_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORD_LIST_LIMIT)
    throw new TaskStateError(
      `limit must be between 1 and ${MAX_RECORD_LIST_LIMIT}.`,
      'TASK_STATE_INVALID',
      '$.limit',
    );
  let startIndex = 0;
  if (input.cursor !== undefined) {
    startIndex = records.findIndex((item) => item.id === input.cursor);
    if (startIndex === -1)
      throw new TaskStateError('Unknown list cursor.', 'TASK_RECORD_NOT_FOUND', '$.cursor');
    startIndex += 1;
  }
  const page = records.slice(startIndex, startIndex + limit);
  const last = page.at(-1);
  const nextCursor = startIndex + limit < records.length && last ? last.id : null;
  return {
    taskId: task.id,
    taskRevision: task.revision,
    total: records.length,
    records: structuredClone(page),
    nextCursor,
  };
}

/**
 * Read-only inspection of a single record plus current link reconciliation: every declared
 * source/record/criterion/evidence/memory link is resolved against current state and reported as
 * `current`, `stale`, `missing`, or `unknown` (an explicitly declared-unavailable source digest).
 * This never rewrites the persisted record; staleness is exposed, not silently repaired.
 */
export async function inspectTaskRecord(root: string, input: RecordInspectInput) {
  root = await resolveProjectRoot(root);
  const state = await readTaskState(root, { allowMissing: false });
  const task = findTask(state, input.taskId);
  const target = findRecord(task, input.recordId);
  const links = await Promise.all(
    target.links.map(async (link) => {
      if (link.type === 'source')
        return { link, status: await reconcileSourceLinkStatus(root, link) };
      if (link.type === 'record') {
        const linked = (task.records ?? []).find((item) => item.id === link.recordId);
        return {
          link,
          status: !linked
            ? 'missing'
            : linked.revision === link.recordRevision
              ? 'current'
              : 'stale',
        };
      }
      if (link.type === 'criterion') {
        const criterion = task.criteria.find((item) => item.id === link.criterionId);
        return {
          link,
          status: !criterion
            ? 'missing'
            : criterion.revision === link.criterionRevision
              ? 'current'
              : 'stale',
        };
      }
      if (link.type === 'evidence') {
        const exists = task.evidence.some((item) => item.id === link.evidenceId);
        return { link, status: exists ? 'current' : 'missing' };
      }
      try {
        const memory = await inspectProjectMemory(root, link.memoryId);
        return {
          link,
          status: memory.revision === link.memoryRevision ? 'current' : 'stale',
          memory,
        };
      } catch (error) {
        if (errorCode(error) !== 'PROJECT_MEMORY_NOT_FOUND') throw error;
        return { link, status: 'missing' as const };
      }
    }),
  );
  return { taskId: task.id, taskRevision: task.revision, record: structuredClone(target), links };
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
export {
  isDurablePlanPath,
  LEGACY_NOTE_DIRECTORY,
  migrateLegacyPlan,
  PLAN_DIRECTORY,
  resolveCollisionSafePlanPath,
  slugifyPlanTitle,
} from './plans.js';
export {
  DEFAULT_RECORD_LIST_LIMIT,
  MAX_RECORD_LINKS,
  MAX_RECORD_LIST_LIMIT,
  MAX_RECORD_TEXT_BYTES,
  MAX_RECORDS_PER_TASK,
  RECORD_INITIAL_STATUS,
  RECORD_KINDS,
  RECORD_PROVENANCE_KINDS,
  RECORD_STATUSES,
} from './records.js';
export type { RecordKind, RecordLink, RecordProvenanceKind, TaskRecord } from './records.js';
export type { PlanMigrationResult } from './plans.js';
