import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { errorCode, errorMessage } from '../types.js';
import { listTasks } from '../task-state/service.js';
import { listWorkflows } from '../workflows/store.js';
import { listProjectMemory } from '../project-memory/service.js';
import { inspectUsageOverview } from '../usage/overview-service.js';
import type { UsageAggregate } from '../usage/aggregate.js';
import { mutateProjectRegistry, readProjectRegistry } from './store.js';
import {
  MAX_DISPLAY_NAME_BYTES,
  PROJECT_ID_PATTERN,
  PROJECT_SOURCES,
  ProjectError,
  type ProjectRecord,
  type ProjectSource,
} from './contracts.js';
import {
  canonicalizeForComparison,
  identityGroupKey,
  listRepositoryWorktrees,
  resolveProjectIdentity,
  type ProjectIdentity,
  type WorktreeInfo,
} from './identity.js';

export { resolveProjectIdentity } from './identity.js';
export type { ProjectIdentity } from './identity.js';
export type { ProjectRecord, ProjectSource } from './contracts.js';

/**
 * A task/workflow is treated as active only when its own persisted state says so (see
 * NON_TERMINAL_* below) — never inferred from installed provider tooling. If that state's
 * most recent timestamp is older than this window, the entry is still reported active (the
 * work is not known to be finished) but flagged `activityStale` so a stuck or abandoned
 * session is not shown with the same confidence as one updated moments ago.
 */
const ACTIVITY_STALE_MS = 30 * 60 * 1000;
const NON_TERMINAL_TASK_STATES = new Set(['running', 'awaiting-decision', 'blocked']);
const NON_TERMINAL_WORKFLOW_STATUSES = new Set([
  'running',
  'awaiting-input',
  'awaiting-approval',
  'blocked',
]);

function validSource(value: unknown): ProjectSource {
  if (value === undefined) return 'manual';
  if (typeof value !== 'string' || !PROJECT_SOURCES.includes(value as ProjectSource))
    throw new ProjectError(
      `Unknown project source. Expected one of ${PROJECT_SOURCES.join(', ')}.`,
      'PROJECT_SOURCE_INVALID',
    );
  return value as ProjectSource;
}

function displayNameFor(root: string, provided: unknown): string {
  if (provided !== undefined) {
    if (typeof provided !== 'string' || !provided.trim())
      throw new ProjectError(
        'Display name must be a non-empty string.',
        'PROJECT_DISPLAY_NAME_INVALID',
      );
    const trimmed = provided.trim();
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_DISPLAY_NAME_BYTES)
      throw new ProjectError('Display name is too long.', 'PROJECT_DISPLAY_NAME_INVALID');
    return trimmed;
  }
  const base = path.basename(root.replace(/[\\/]+$/, ''));
  return base || root;
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value))
    throw new ProjectError('A valid project ID is required.', 'PROJECT_ID_INVALID');
  return value;
}

/**
 * Register a project, or reconcile a repeated registration of the same resolved root: the
 * existing record's `lastSeenAt`/`lastSeenVia` are refreshed (and `displayName` updated only
 * when one is explicitly supplied) rather than creating a duplicate entry. The root must
 * exist and be a real directory — this call is for capturing a project Latchkit actually
 * touched or a caller explicitly points at, not for reserving a future path.
 */
export async function registerProject(
  registryRoot: string,
  input: { root?: unknown; displayName?: unknown; source?: unknown },
): Promise<ProjectRecord> {
  if (typeof input.root !== 'string' || !input.root.trim())
    throw new ProjectError('A project root path is required.', 'PROJECT_ROOT_INVALID');
  let real: string;
  try {
    real = await realpath(path.resolve(input.root));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      throw new ProjectError(
        `Project root does not exist: ${input.root}`,
        'PROJECT_ROOT_UNAVAILABLE',
      );
    throw error;
  }
  const info = await fsStat(real);
  if (!info.isDirectory())
    throw new ProjectError(`Project root is not a directory: ${real}`, 'PROJECT_ROOT_UNAVAILABLE');
  const source = validSource(input.source);
  const displayName = displayNameFor(real, input.displayName);
  const canonicalRoot = canonicalizeForComparison(real);
  return mutateProjectRegistry(registryRoot, (state) => {
    const now = new Date().toISOString();
    const existing = state.projects.find(
      (item) => canonicalizeForComparison(item.root) === canonicalRoot,
    );
    if (existing) {
      existing.lastSeenAt = now;
      existing.lastSeenVia = source;
      if (input.displayName !== undefined) existing.displayName = displayName;
      state.revision += 1;
      return structuredClone(existing);
    }
    const record: ProjectRecord = {
      schemaVersion: 1,
      id: `project_${randomUUID()}`,
      root: real,
      displayName,
      addedAt: now,
      addedVia: source,
      lastSeenAt: now,
      lastSeenVia: source,
    };
    state.projects.push(record);
    state.revision += 1;
    return structuredClone(record);
  });
}

/** Remove a project from the overview only. Never touches the project's own files, `.latchkit/`
 * state, or Git history — the registry is purely a pointer list. */
export async function removeProject(
  registryRoot: string,
  id: unknown,
): Promise<{ removed: true; id: string }> {
  const projectId = validId(id);
  return mutateProjectRegistry(registryRoot, (state) => {
    const index = state.projects.findIndex((item) => item.id === projectId);
    if (index < 0)
      throw new ProjectError(`Project ${projectId} is not registered.`, 'PROJECT_NOT_FOUND', 404);
    state.projects.splice(index, 1);
    state.revision += 1;
    return { removed: true as const, id: projectId };
  });
}

export type ProjectStatus = 'active' | 'idle' | 'unavailable';

export type ProjectIdentitySummary =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'plain'; groupKey: string }
  | {
      kind: 'git';
      groupKey: string;
      commonDir: string;
      mainRoot: string;
      isMainCheckout: boolean;
      bare: boolean;
    };

export type ProjectActivitySummary = {
  openTasks: number;
  totalTasks: number;
  openWorkflows: number;
  lastActivityAt: string | null;
};

export type ProjectOverviewEntry = {
  id: string;
  root: string;
  displayName: string;
  addedAt: string;
  addedVia: ProjectSource;
  lastSeenAt: string;
  lastSeenVia: ProjectSource;
  identity: ProjectIdentitySummary;
  status: ProjectStatus;
  activityStale: boolean;
  activity: ProjectActivitySummary;
  /** True for the one entry per identity group shown in a collapsed overview grid, so a main
   * checkout and its registered linked worktree(s) are not counted as separate projects. See
   * docs/projects.md#identity-and-grouping. */
  isRepresentative: boolean;
  /** IDs of every registered record sharing this entry's identity group, including itself. */
  groupMemberIds: string[];
};

async function projectActivity(root: string): Promise<{
  status: ProjectStatus;
  stale: boolean;
  openTasks: number;
  totalTasks: number;
  openWorkflows: number;
  lastActivityAt: string | null;
}> {
  let tasks: { state: string; updatedAt: string }[] = [];
  try {
    tasks = (await listTasks(root)).tasks;
  } catch (error) {
    if (errorCode(error) !== 'TASK_STATE_NOT_FOUND') throw error;
  }
  const workflows = await listWorkflows(root).catch(() => []);
  const openTasks = tasks.filter((task) => NON_TERMINAL_TASK_STATES.has(task.state));
  const openWorkflows = workflows.filter((workflow) =>
    NON_TERMINAL_WORKFLOW_STATUSES.has(workflow.status),
  );
  const timestamps = [
    ...tasks.map((task) => task.updatedAt),
    ...workflows.map((workflow) => workflow.updatedAt),
  ].filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value)));
  const lastActivityAt = timestamps.length
    ? timestamps.reduce((latest, value) => (value > latest ? value : latest))
    : null;
  const hasOpen = openTasks.length > 0 || openWorkflows.length > 0;
  return {
    status: hasOpen ? 'active' : 'idle',
    stale:
      hasOpen &&
      lastActivityAt !== null &&
      Date.now() - Date.parse(lastActivityAt) > ACTIVITY_STALE_MS,
    openTasks: openTasks.length,
    totalTasks: tasks.length,
    openWorkflows: openWorkflows.length,
    lastActivityAt,
  };
}

function identitySummary(
  identity: ProjectIdentity,
  groupKey: string | null,
): ProjectIdentitySummary {
  if (identity.kind === 'unavailable') return { kind: 'unavailable', reason: identity.reason };
  if (identity.kind === 'git')
    return {
      kind: 'git',
      groupKey: groupKey!,
      commonDir: identity.commonDir,
      mainRoot: identity.mainRoot,
      isMainCheckout: identity.isMainCheckout,
      bare: identity.bare,
    };
  return { kind: 'plain', groupKey: groupKey! };
}

/**
 * List every registered project with a live, evidence-based status. Never presents an
 * unavailable root or a project with no recorded activity as "0 usage" or an invented state
 * — unavailable and idle are distinct, explicit statuses (see docs/projects.md#status).
 * Entries sharing a Git common directory (a main checkout and any of its linked worktrees
 * that are also registered) are grouped: only one is `isRepresentative` so an overview grid
 * built from that flag alone never double-counts one repository as two projects, while every
 * member remains individually inspectable through `inspectProject`.
 */
export async function listProjects(
  registryRoot: string,
): Promise<{ schemaVersion: 1; revision: number; projects: ProjectOverviewEntry[] }> {
  const state = await readProjectRegistry(registryRoot);
  const entries = await Promise.all(
    state.projects.map(async (record): Promise<ProjectOverviewEntry> => {
      const identity = await resolveProjectIdentity(record.root);
      const groupKey = identityGroupKey(identity);
      const activity =
        identity.kind === 'unavailable'
          ? {
              status: 'unavailable' as const,
              stale: false,
              openTasks: 0,
              totalTasks: 0,
              openWorkflows: 0,
              lastActivityAt: null,
            }
          : await projectActivity(record.root);
      return {
        id: record.id,
        root: record.root,
        displayName: record.displayName,
        addedAt: record.addedAt,
        addedVia: record.addedVia,
        lastSeenAt: record.lastSeenAt,
        lastSeenVia: record.lastSeenVia,
        identity: identitySummary(identity, groupKey),
        status: activity.status,
        activityStale: activity.stale,
        activity: {
          openTasks: activity.openTasks,
          totalTasks: activity.totalTasks,
          openWorkflows: activity.openWorkflows,
          lastActivityAt: activity.lastActivityAt,
        },
        isRepresentative: false,
        groupMemberIds: [],
      };
    }),
  );
  const groups = new Map<string, ProjectOverviewEntry[]>();
  for (const entry of entries) {
    const key =
      entry.identity.kind === 'unavailable' ? `self:${entry.id}` : entry.identity.groupKey;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  for (const bucket of groups.values()) {
    const memberIds = bucket.map((item) => item.id);
    const representative =
      bucket.find((item) => item.identity.kind === 'git' && item.identity.isMainCheckout) ??
      [...bucket].sort((left, right) => Date.parse(left.addedAt) - Date.parse(right.addedAt))[0];
    for (const item of bucket) {
      item.groupMemberIds = memberIds;
      item.isRepresentative = item.id === representative?.id;
    }
  }
  return { schemaVersion: 1, revision: state.revision, projects: entries };
}

export type ProjectSpec = { path: string; bytes: number; modifiedAt: string };
export type ProjectTaskSummary = {
  id: string;
  title: string;
  state: string;
  revision: number;
  updatedAt: string;
};
export type ProjectWorkflowSummary = {
  workflowId: string;
  taskId: string;
  status: string;
  phase: string;
  updatedAt: string;
};
export type ProjectDetail = {
  project: ProjectOverviewEntry;
  /** Every registered record sharing this project's identity group, including itself. */
  group: ProjectOverviewEntry[];
  worktrees: (WorktreeInfo & { isRegistered: boolean; registeredProjectId: string | null })[];
  specs: ProjectSpec[];
  tasks: ProjectTaskSummary[] | null;
  workflows: ProjectWorkflowSummary[] | null;
  memory: { revision: number; count: number } | null;
  usage:
    { status: 'available'; overview: UsageAggregate } | { status: 'unavailable'; reason: string };
};

async function listSpecs(root: string): Promise<ProjectSpec[]> {
  const results: ProjectSpec[] = [];
  for (const directory of ['docs/plans', '.latchkit/notes']) {
    const absolute = path.resolve(root, ...directory.split('/'));
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const info = await fsStat(path.join(absolute, entry.name)).catch(() => null);
      if (!info) continue;
      results.push({
        path: `${directory}/${entry.name}`,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
  }
  return results.sort((left, right) => (left.modifiedAt < right.modifiedAt ? 1 : -1));
}

/**
 * Full detail for one registered project, resolved fresh from its own validated identity —
 * never from a client-supplied path, and never from another project's already-open state.
 * Every read below targets `identity.root`/`identity.mainRoot`, derived in this call from the
 * registry record for `id`, so switching which project is open cannot mix data between them.
 */
export async function inspectProject(
  registryRoot: string,
  id: unknown,
  options: { from?: string; to?: string } = {},
): Promise<ProjectDetail> {
  const projectId = validId(id);
  const overview = await listProjects(registryRoot);
  const project = overview.projects.find((item) => item.id === projectId);
  if (!project)
    throw new ProjectError(`Project ${projectId} is not registered.`, 'PROJECT_NOT_FOUND', 404);
  const group = overview.projects.filter((item) => project.groupMemberIds.includes(item.id));
  const unavailable = (reason: string): ProjectDetail => ({
    project,
    group,
    worktrees: [],
    specs: [],
    tasks: null,
    workflows: null,
    memory: null,
    usage: { status: 'unavailable', reason },
  });
  if (project.status === 'unavailable') return unavailable('Project root is unavailable.');
  const registry = await readProjectRegistry(registryRoot);
  const record = registry.projects.find((item) => item.id === projectId);
  if (!record)
    throw new ProjectError(`Project ${projectId} is not registered.`, 'PROJECT_NOT_FOUND', 404);
  const identity = await resolveProjectIdentity(record.root);
  if (identity.kind === 'unavailable') return unavailable('Project root became unavailable.');
  const root = identity.root;
  const [specs, tasks, workflows, memory, usage] = await Promise.all([
    listSpecs(root),
    listTasks(root)
      .then((result) => result.tasks)
      .catch((error) => {
        if (errorCode(error) === 'TASK_STATE_NOT_FOUND') return [];
        throw error;
      }),
    listWorkflows(root).catch(() => []),
    listProjectMemory(root)
      .then((result) => ({ revision: result.revision, count: result.memories.length }))
      .catch(() => null),
    inspectUsageOverview([root], options)
      .then((overviewResult) => ({ status: 'available' as const, overview: overviewResult }))
      .catch((error) => ({ status: 'unavailable' as const, reason: errorMessage(error) })),
  ]);
  const worktreesRaw =
    identity.kind === 'git' ? await listRepositoryWorktrees(identity.mainRoot) : [];
  const worktrees = worktreesRaw.map((worktree) => {
    const matching = registry.projects.find(
      (item) => canonicalizeForComparison(item.root) === canonicalizeForComparison(worktree.path),
    );
    return {
      ...worktree,
      isRegistered: Boolean(matching),
      registeredProjectId: matching?.id ?? null,
    };
  });
  return {
    project,
    group,
    worktrees,
    specs,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      state: task.state,
      revision: task.revision,
      updatedAt: task.updatedAt,
    })),
    workflows: workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      taskId: workflow.taskId,
      status: workflow.status,
      phase: workflow.phase,
      updatedAt: workflow.updatedAt,
    })),
    memory,
    usage,
  };
}
