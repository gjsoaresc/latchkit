import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readConfigSnapshot,
  saveConfigIfRevision,
  planConfigMigration,
  migrateConfig,
  planSync,
  syncProject,
  doctor,
  PROVIDERS,
  SKILLS,
} from './core.js';
import { exportSupportBundle, previewSupportBundle } from './diagnostics/bundle.js';
import { appendEvent, clearDiagnostics } from './diagnostics/logger.js';
import { operationalError, statusForError } from './diagnostics/errors.js';
import { redactString } from './diagnostics/redact.js';
import { createTaskController } from './runtime/task-controller.js';
import {
  inspectFcc,
  installFcc,
  previewFccInstall,
  recoverFcc,
  removeFcc,
  startFcc,
  stopFcc,
} from './managed-tools/fcc.js';
import { createReviewOrchestrator } from './reviews/orchestrator.js';
import {
  createDiffAnnotation,
  inspectDiff,
  inspectDiffFile,
  listDiffAnnotations,
  updateDiffAnnotation,
} from './reviews/diff-annotations.js';
import { createAcceptanceVerifier } from './acceptance/service.js';
import {
  inspectTask,
  listTasks,
  migrateLegacyPlan,
  migrateTaskState,
  registerEnhancedWorkflow,
  resolveCollisionSafePlanPath,
  verifyTask,
} from './task-state/service.js';
import {
  addProjectMemory,
  deleteProjectMemory,
  exportProjectMemory,
  inspectProjectMemory,
  listProjectMemory,
  recoverProjectContext,
  searchProjectMemory,
  updateProjectMemory,
} from './project-memory/service.js';
import { providerById } from './providers/registry.js';
import {
  configureUsage,
  deleteUsage,
  exportUsage,
  inspectUsage,
  recordProviderUsage,
} from './usage/service.js';
import {
  createSavingsBaseline,
  deleteSavingsBaseline,
  exportSavingsBaselines,
  listSavingsBaselines,
  updateSavingsBaseline,
} from './usage/baseline-service.js';
import { inspectSavings, inspectUsageOverview } from './usage/overview-service.js';
import {
  applyOnboardingSetup,
  backStep as backOnboardingStep,
  completeOnboarding,
  dismissOnboarding,
  inspectOnboarding,
  previewOnboardingSetup,
  selectProject as selectOnboardingProject,
  skipStep as skipOnboardingStep,
  startOnboarding,
  updateProjectSelection as updateOnboardingProjectSelection,
  updateUsagePreference as updateOnboardingUsagePreference,
  updateVerificationPreference as updateOnboardingVerificationPreference,
  updateWorkspacePreference as updateOnboardingWorkspacePreference,
} from './onboarding/service.js';
import {
  inspectProject,
  listProjects,
  registerProject,
  removeProject,
} from './projects/service.js';
import { defaultProjectsRegistryRoot } from './projects/store.js';
import { errorCode, errorRecord, isRecord } from './types.js';

const MAX_BODY_BYTES = 64 * 1024;
export const LOCAL_API_VERSION = 1;
const WEB_ROOT = new URL('../web/', import.meta.url);
const ASSETS = new Map<string, [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  // Issue #90: the console is one bundle (see web/app.tsx) client-side routed by
  // `location.pathname`. Every page below is a distinct, directly addressable URL — a direct
  // load or refresh at any of these paths resolves the same index.html, and the bundle picks
  // the matching page. /projects predates this (#94) and keeps working unchanged.
  ['/projects', ['index.html', 'text/html; charset=utf-8']],
  ['/specs', ['index.html', 'text/html; charset=utf-8']],
  ['/memory', ['index.html', 'text/html; charset=utf-8']],
  ['/usage', ['index.html', 'text/html; charset=utf-8']],
  ['/settings', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/docs/managed-fcc.md', ['../../docs/managed-fcc.md', 'text/plain; charset=utf-8']],
]);

function fail(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function respond(res: http.ServerResponse, status: number, value: object) {
  if ('configRevision' in value && typeof value.configRevision === 'string')
    res.setHeader('ETag', value.configRevision);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ apiVersion: LOCAL_API_VERSION, ...value }));
}

function requiredRevision(req: http.IncomingMessage) {
  const revision = req.headers['if-match'];
  if (typeof revision !== 'string' || !/^"sha256:[a-f0-9]{64}"$/.test(revision)) {
    throw fail(428, 'Send the current configuration revision in If-Match.');
  }
  return revision;
}

function authenticated(req: http.IncomingMessage, token: string) {
  const supplied = req.headers.authorization;
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return false;
  const actual = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function listTasksForConsole(
  root: string,
  taskController: ReturnType<typeof createTaskController>,
  { limit, offset }: { limit?: number; offset?: number } = {},
) {
  try {
    const listed = await listTasks(root);
    const tasks = listed.tasks.slice(
      offset ?? 0,
      limit === undefined ? undefined : (offset ?? 0) + limit,
    );
    const inspected = await Promise.all(tasks.map((task) => taskController.inspect(task.id)));
    return {
      ...listed,
      total: listed.tasks.length,
      ...(limit === undefined ? {} : { limit, offset }),
      tasks: inspected.map((item) => ({
        ...item.task,
        reconciliation: item.reconciliation,
      })),
    };
  } catch (error) {
    if (errorCode(error) !== 'TASK_STATE_NOT_FOUND') throw error;
    return { schemaVersion: 1, revision: 0, tasks: [] };
  }
}

function optionalIsoParam(requestUrl: URL, name: string): string | undefined {
  const value = requestUrl.searchParams.get(name);
  if (value === null) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw fail(400, `${name} must be an ISO date-time.`);
  return value;
}

function usageRangeOptions(requestUrl: URL) {
  return { from: optionalIsoParam(requestUrl, 'from'), to: optionalIsoParam(requestUrl, 'to') };
}

function boundedNumber(
  value: string | null,
  { fallback, minimum, maximum }: { fallback: number; minimum: number; maximum: number },
) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw fail(400, 'Pagination values must be whole numbers.');
  const number = Number(value);
  if (number < minimum || number > maximum)
    throw fail(400, `Pagination values must be between ${minimum} and ${maximum}.`);
  return number;
}

async function memoryPage(root: string, requestUrl: URL) {
  const limit = boundedNumber(requestUrl.searchParams.get('limit'), {
    fallback: 25,
    minimum: 1,
    maximum: 100,
  });
  const offset = boundedNumber(requestUrl.searchParams.get('offset'), {
    fallback: 0,
    minimum: 0,
    maximum: 10_000,
  });
  const query = requestUrl.searchParams.get('query') ?? '';
  const results = query
    ? await searchProjectMemory(root, query, { limit: 100 })
    : (await listProjectMemory(root)).memories.map((memory) => ({ memory, score: null }));
  const listed = await listProjectMemory(root);
  return {
    project: listed.project,
    revision: listed.revision,
    query,
    limit,
    offset,
    total: results.length,
    memories: results.slice(offset, offset + limit),
  };
}

function taskPageOptions(requestUrl: URL) {
  return {
    limit: boundedNumber(requestUrl.searchParams.get('taskLimit'), {
      fallback: 25,
      minimum: 1,
      maximum: 100,
    }),
    offset: boundedNumber(requestUrl.searchParams.get('taskOffset'), {
      fallback: 0,
      minimum: 0,
      maximum: 10_000,
    }),
  };
}

async function readKnownArtifact(
  root: string,
  taskController: ReturnType<typeof createTaskController>,
  taskId: string,
  evidenceId: string,
) {
  const inspected = await taskController.inspect(taskId);
  const evidence = inspected.task.evidence.find((item) => item.id === evidenceId);
  if (!evidence) throw fail(404, 'Evidence does not belong to this task.');
  let location;
  try {
    location = JSON.parse(evidence.artifact ?? '{}').location;
  } catch {
    throw fail(404, 'Evidence has no readable artifact.');
  }
  if (
    typeof location !== 'string' ||
    !/^\.latchkit\/tasks\/acceptance-evidence\/task_[0-9a-f-]+\/[a-z0-9_-]+\/[^/]+\.json$/i.test(
      location,
    )
  )
    throw fail(404, 'Evidence has no readable artifact.');
  const target = path.resolve(root, ...location.split('/'));
  const artifactRoot = path.resolve(root, '.latchkit', 'tasks', 'acceptance-evidence');
  if (!target.startsWith(`${artifactRoot}${path.sep}`))
    throw fail(404, 'Artifact is outside project state.');
  const raw = await readFile(target, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw fail(404, 'Artifact is no longer available.');
    throw error;
  });
  if (Buffer.byteLength(raw) > 256 * 1024) throw fail(413, 'Artifact exceeds the console limit.');
  return { taskId, evidenceId, location, artifact: JSON.parse(raw) };
}

async function readJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw fail(415, 'Send JSON with Content-Type: application/json.');
  }
  const body = await new Promise<string>((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finished = true;
        chunks.length = 0;
        reject(fail(413, 'Request body exceeds 64 KB.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!finished) resolve(Buffer.concat(chunks).toString('utf8'));
      finished = true;
    });
    req.on('error', reject);
    req.on('aborted', () => reject(fail(400, 'Request was interrupted.')));
  });
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) throw fail(400, 'Request body must be a JSON object.');
    return value as T;
  } catch {
    throw fail(400, 'Request body must contain valid JSON.');
  }
}

/** Serve a single project's configuration UI on loopback with launch-scoped access. */
export async function startServer(root: string, { port = 0 }: { port?: number } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be an integer between 0 and 65535.');
  }
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let host = '';
  let pendingMutation: Promise<unknown> = Promise.resolve();
  const taskController = createTaskController({ root });
  const reviewOrchestrator = createReviewOrchestrator({ root });
  const acceptanceVerifier = createAcceptanceVerifier({ root });
  // Multi-project overview (issue #94): a user-local registry, independent of this server's
  // single fixed `root`. Failures here never block the console this project actually needs —
  // see docs/projects.md.
  const projectsRegistryRoot = defaultProjectsRegistryRoot();
  const touchProject = (source: 'ui-start' | 'task-run') =>
    void registerProject(projectsRegistryRoot, { root, source }).catch(() => {});
  touchProject('ui-start');
  const { createWorkflowController } = await import('./workflows/service.js');
  const { listWorkflows } = await import('./workflows/store.js');
  const workflowController = createWorkflowController({ root });
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pendingMutation.then(operation);
    pendingMutation = result.catch(() => {});
    return result;
  };

  const activeRequests = new Set<Promise<void>>();
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const request = handleRequest(req, res);
    activeRequests.add(request);
    void request.then(
      () => activeRequests.delete(request),
      () => activeRequests.delete(request),
    );
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      if (req.headers.host !== host)
        throw fail(403, 'Unrecognized host. Open the URL printed by Latchkit.');
      if (!req.url?.startsWith('/') || req.url.startsWith('//'))
        throw fail(400, 'Invalid request URL.');
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES)
        throw fail(413, 'Request body exceeds 64 KB.');
      const requestUrl = new URL(req.url, origin);
      const pathname = requestUrl.pathname;
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!authenticated(req, token))
          throw fail(401, 'Session key missing or expired. Reopen the URL printed by Latchkit.');
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== origin) {
          throw fail(403, 'Request origin must match this Latchkit session.');
        }
        if (pathname === '/api/state' && req.method === 'GET') {
          await pendingMutation;
          const snapshot = await readConfigSnapshot(root);
          respond(res, 200, {
            config: snapshot.config,
            configRevision: snapshot.revision,
            providers: PROVIDERS,
            skills: SKILLS,
            doctor: await doctor(root),
          });
        } else if (pathname === '/api/plan' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await planSync(root));
        } else if (pathname === '/api/config' && req.method === 'PUT') {
          const config = await readJson(req);
          const saved = await serialize(() =>
            saveConfigIfRevision(root, config, requiredRevision(req)),
          );
          respond(res, 200, saved);
        } else if (pathname === '/api/config/migration' && req.method === 'GET') {
          await pendingMutation;
          const toVersion = requestUrl.searchParams.get('to') ?? undefined;
          respond(res, 200, await planConfigMigration(root, { toVersion }));
        } else if (pathname === '/api/config/migration' && req.method === 'POST') {
          const body = await readJson<NonNullable<Parameters<typeof migrateConfig>[1]>>(req);
          respond(
            res,
            200,
            await serialize(() => migrateConfig(root, { toVersion: body.toVersion })),
          );
        } else if (pathname === '/api/sync' && req.method === 'POST') {
          const body = await readJson(req);
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            typeof body.planId !== 'string'
          )
            throw fail(400, 'Send the reviewed planId to apply a sync.');
          const planId = body.planId;
          respond(res, 200, await serialize(() => syncProject(root, { planId })));
        } else if (pathname === '/api/diagnostics' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await previewSupportBundle(root));
        } else if (pathname === '/api/diagnostics/export' && req.method === 'POST') {
          respond(res, 200, await serialize(() => exportSupportBundle(root)));
        } else if (pathname === '/api/diagnostics' && req.method === 'DELETE') {
          respond(res, 200, await serialize(() => clearDiagnostics(root)));
        } else if (pathname === '/api/tools/fcc' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await inspectFcc());
        } else if (pathname === '/api/tools/fcc/preview' && req.method === 'POST') {
          const body = await readJson<{ archive?: string; python?: string; root?: string }>(req);
          respond(res, 200, await previewFccInstall(body));
        } else if (pathname === '/api/tools/fcc/install' && req.method === 'POST') {
          const body = await readJson<{ archive?: string; python?: string; root?: string }>(req);
          respond(res, 200, await serialize(() => installFcc(body)));
        } else if (pathname === '/api/tools/fcc/start' && req.method === 'POST') {
          const body = await readJson<{ root?: string }>(req);
          respond(res, 200, await serialize(() => startFcc(body)));
        } else if (pathname === '/api/tools/fcc/recover' && req.method === 'POST') {
          const body = await readJson<{ root?: string; archive?: string }>(req);
          respond(res, 200, await serialize(() => recoverFcc(body)));
        } else if (pathname === '/api/tools/fcc/stop' && req.method === 'POST') {
          const body = await readJson<{ root?: string }>(req);
          respond(res, 200, await serialize(() => stopFcc(body)));
        } else if (pathname === '/api/tools/fcc' && req.method === 'DELETE') {
          const body = await readJson<{ root?: string }>(req);
          respond(res, 200, await serialize(() => removeFcc(body)));
        } else if (pathname === '/api/workflows' && req.method === 'GET') {
          const taskId = requestUrl.searchParams.get('task');
          respond(
            res,
            200,
            taskId
              ? { workflow: await workflowController.inspect(taskId) }
              : { workflows: await listWorkflows(root) },
          );
        } else if (pathname === '/api/workflows/run' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof workflowController.run>[0]>(req);
          if (body.executionAuthorized !== true)
            throw fail(400, 'Local coding-tool execution requires explicit authorization.');
          const workflow = await workflowController.run(body);
          touchProject('task-run');
          respond(res, 202, { workflow });
        } else if (
          ['/api/workflows/approve', '/api/workflows/resume', '/api/workflows/cancel'].includes(
            pathname,
          ) &&
          req.method === 'POST'
        ) {
          const body = await readJson(req);
          if (
            typeof body.expectedRevision !== 'number' ||
            !Number.isInteger(body.expectedRevision) ||
            body.expectedRevision < 1
          )
            throw fail(428, 'Send the current workflow revision as expectedRevision.');
          if (typeof body.taskId !== 'string') throw fail(400, 'Task ID is required.');
          const result = pathname.endsWith('/approve')
            ? await workflowController.approve(
                body as Parameters<typeof workflowController.approve>[0],
              )
            : pathname.endsWith('/resume')
              ? await workflowController.resume(
                  body as Parameters<typeof workflowController.resume>[0],
                )
              : await workflowController.cancel(
                  body as Parameters<typeof workflowController.cancel>[0],
                );
          respond(res, pathname.endsWith('/cancel') ? 200 : 202, { workflow: result });
        } else if (pathname === '/api/workbench' && req.method === 'GET') {
          await pendingMutation;
          const [tasks, memory] = await Promise.all([
            listTasksForConsole(root, taskController, taskPageOptions(requestUrl)),
            memoryPage(root, requestUrl),
          ]);
          respond(res, 200, { revision: `${tasks.revision}:${memory.revision}`, tasks, memory });
        } else if (pathname === '/api/memory' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await memoryPage(root, requestUrl));
        } else if (pathname === '/api/memory' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof addProjectMemory>[1]>(req);
          respond(res, 200, await serialize(() => addProjectMemory(root, body)));
        } else if (pathname === '/api/memory/export' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await exportProjectMemory(root));
        } else if (pathname === '/api/memory/recover' && req.method === 'POST') {
          const body = await readJson(req);
          if (
            typeof body.providerId !== 'string' ||
            (body.query !== undefined && typeof body.query !== 'string') ||
            (body.budget !== undefined && typeof body.budget !== 'number')
          )
            throw fail(400, 'Invalid context recovery request.');
          const provider = providerById(body.providerId);
          const config = await readConfigSnapshot(root);
          if (!provider || !config.config.providers.includes(body.providerId))
            throw fail(400, 'Select a configured provider for context recovery.');
          respond(
            res,
            200,
            await recoverProjectContext(root, {
              query: body.query ?? '',
              budget: body.budget ?? 4000,
              provider,
            }),
          );
        } else if (/^\/api\/memory\/memory_[0-9a-f-]+$/i.test(pathname)) {
          const id = pathname.slice('/api/memory/'.length);
          if (req.method === 'GET') {
            await pendingMutation;
            respond(res, 200, await inspectProjectMemory(root, id));
          } else if (req.method === 'PUT') {
            const body = await readJson<Parameters<typeof updateProjectMemory>[2]>(req);
            respond(res, 200, await serialize(() => updateProjectMemory(root, id, body)));
          } else if (req.method === 'DELETE') {
            const body = await readJson<Parameters<typeof deleteProjectMemory>[2]>(req);
            respond(res, 200, await serialize(() => deleteProjectMemory(root, id, body)));
          } else throw fail(405, 'Method not allowed.');
        } else if (pathname === '/api/usage' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await inspectUsage(root));
        } else if (pathname === '/api/usage/settings' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof configureUsage>[1]>(req);
          respond(res, 200, await serialize(() => configureUsage(root, body)));
        } else if (pathname === '/api/usage/import' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof recordProviderUsage>[1]>(req);
          respond(res, 200, await serialize(() => recordProviderUsage(root, body)));
        } else if (pathname === '/api/usage/export' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await exportUsage(root));
        } else if (pathname === '/api/usage' && req.method === 'DELETE') {
          respond(res, 200, await serialize(() => deleteUsage(root)));
        } else if (pathname === '/api/usage/overview' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await inspectUsageOverview([root], usageRangeOptions(requestUrl)));
        } else if (pathname === '/api/usage/savings' && req.method === 'GET') {
          await pendingMutation;
          const baselineId = requestUrl.searchParams.get('baselineId');
          if (!baselineId) throw fail(400, 'A baselineId query parameter is required.');
          respond(
            res,
            200,
            await inspectSavings([root], baselineId, usageRangeOptions(requestUrl)),
          );
        } else if (pathname === '/api/usage/baselines' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await listSavingsBaselines(root));
        } else if (pathname === '/api/usage/baselines' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof createSavingsBaseline>[1]>(req);
          respond(res, 200, await serialize(() => createSavingsBaseline(root, body)));
        } else if (pathname === '/api/usage/baselines/export' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await exportSavingsBaselines(root));
        } else if (/^\/api\/usage\/baselines\/baseline_[0-9a-f-]+$/i.test(pathname)) {
          const id = pathname.slice('/api/usage/baselines/'.length);
          if (req.method === 'PUT') {
            const body = await readJson<Parameters<typeof updateSavingsBaseline>[2]>(req);
            respond(res, 200, await serialize(() => updateSavingsBaseline(root, id, body)));
          } else if (req.method === 'DELETE') {
            respond(res, 200, await serialize(() => deleteSavingsBaseline(root, id)));
          } else throw fail(405, 'Method not allowed.');
          // --- Onboarding (#100): additive routes for the browser console's
          // onboarding page (web/onboarding.tsx). Every mutation reuses an
          // existing project primitive through src/onboarding/service.ts.
        } else if (pathname === '/api/onboarding' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await inspectOnboarding(root));
        } else if (pathname === '/api/onboarding/start' && req.method === 'POST') {
          respond(res, 200, await serialize(() => startOnboarding(root)));
        } else if (pathname === '/api/onboarding/project' && req.method === 'POST') {
          const body = await readJson<{ providers?: string[]; skills?: string[] }>(req);
          respond(res, 200, await serialize(() => selectOnboardingProject(root, body)));
        } else if (pathname === '/api/onboarding/providers' && req.method === 'POST') {
          const body = await readJson<{ providers?: string[]; skills?: string[] }>(req);
          respond(res, 200, await serialize(() => updateOnboardingProjectSelection(root, body)));
        } else if (pathname === '/api/onboarding/workspace' && req.method === 'POST') {
          const body =
            await readJson<Parameters<typeof updateOnboardingWorkspacePreference>[1]>(req);
          respond(res, 200, await serialize(() => updateOnboardingWorkspacePreference(root, body)));
        } else if (pathname === '/api/onboarding/verification' && req.method === 'POST') {
          const body = await readJson<{ mode?: string }>(req);
          if (body.mode !== 'fast' && body.mode !== 'standard')
            throw fail(400, 'mode must be fast or standard.');
          respond(
            res,
            200,
            await serialize(() =>
              updateOnboardingVerificationPreference(root, body.mode as 'fast' | 'standard'),
            ),
          );
        } else if (pathname === '/api/onboarding/usage' && req.method === 'POST') {
          const body = await readJson<{ enabled?: boolean }>(req);
          if (typeof body.enabled !== 'boolean') throw fail(400, 'enabled must be a boolean.');
          const enabled = body.enabled;
          respond(res, 200, await serialize(() => updateOnboardingUsagePreference(root, enabled)));
        } else if (pathname === '/api/onboarding/preview' && req.method === 'POST') {
          respond(res, 200, await serialize(() => previewOnboardingSetup(root)));
        } else if (pathname === '/api/onboarding/apply' && req.method === 'POST') {
          const body = await readJson<{ planId?: string }>(req);
          respond(res, 200, await serialize(() => applyOnboardingSetup(root, body)));
        } else if (
          (pathname === '/api/onboarding/skip' || pathname === '/api/onboarding/back') &&
          req.method === 'POST'
        ) {
          const body = await readJson<{ stepId?: string }>(req);
          if (typeof body.stepId !== 'string') throw fail(400, 'stepId is required.');
          respond(
            res,
            200,
            await serialize(() =>
              pathname.endsWith('/skip')
                ? skipOnboardingStep(root, body.stepId!)
                : backOnboardingStep(root, body.stepId!),
            ),
          );
        } else if (pathname === '/api/onboarding/complete' && req.method === 'POST') {
          respond(res, 200, await serialize(() => completeOnboarding(root)));
        } else if (pathname === '/api/onboarding/dismiss' && req.method === 'POST') {
          respond(res, 200, await serialize(() => dismissOnboarding(root)));
        } else if (pathname === '/api/tasks/artifact' && req.method === 'GET') {
          await pendingMutation;
          const taskId = requestUrl.searchParams.get('taskId');
          const evidenceId = requestUrl.searchParams.get('evidenceId');
          if (!taskId || !evidenceId) throw fail(400, 'Task and evidence IDs are required.');
          respond(res, 200, await readKnownArtifact(root, taskController, taskId, evidenceId));
        } else if (pathname === '/api/tasks' && req.method === 'GET') {
          await pendingMutation;
          const taskId = requestUrl.searchParams.get('task');
          respond(
            res,
            200,
            taskId
              ? await taskController.inspect(taskId)
              : await listTasksForConsole(root, taskController),
          );
        } else if (pathname === '/api/tasks/start' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof taskController.start>[0]>(req);
          const started = await serialize(() => taskController.start(body));
          touchProject('task-run');
          respond(res, 200, started);
        } else if (pathname === '/api/tasks/resume' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof taskController.resume>[0]>(req);
          respond(res, 200, await serialize(() => taskController.resume(body)));
        } else if (pathname === '/api/tasks/cancel' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof taskController.cancel>[0]>(req);
          respond(res, 200, await serialize(() => taskController.cancel(body)));
        } else if (pathname === '/api/tasks/events' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof taskController.observe>[0]>(req);
          respond(res, 200, await serialize(() => taskController.observe(body)));
        } else if (pathname === '/api/spec' && req.method === 'GET') {
          await pendingMutation;
          const taskId = requestUrl.searchParams.get('taskId');
          if (!taskId) throw fail(400, 'Task ID is required.');
          const inspected = await inspectTask(root, taskId);
          respond(res, 200, {
            taskId,
            taskRevision: inspected.task.revision,
            enhancedWorkflow: inspected.task.enhancedWorkflow ?? null,
          });
        } else if (pathname === '/api/spec/register' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof registerEnhancedWorkflow>[1]>(req);
          respond(res, 200, await serialize(() => registerEnhancedWorkflow(root, body)));
        } else if (pathname === '/api/spec/migration' && req.method === 'POST') {
          const body = await readJson<{ dryRun?: boolean }>(req);
          respond(res, 200, await serialize(() => migrateTaskState(root, body)));
        } else if (pathname === '/api/spec/plan-path' && req.method === 'GET') {
          await pendingMutation;
          const title = requestUrl.searchParams.get('title');
          if (!title) throw fail(400, 'A plan title is required.');
          respond(res, 200, { path: await resolveCollisionSafePlanPath(root, title) });
        } else if (pathname === '/api/spec/migrate-plan' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof migrateLegacyPlan>[1]>(req);
          respond(res, 200, await serialize(() => migrateLegacyPlan(root, body)));
        } else if (pathname === '/api/spec/verify' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof verifyTask>[1]>(req);
          respond(res, 200, await serialize(() => verifyTask(root, body)));
        } else if (pathname === '/api/reviews' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => reviewOrchestrator.run(body)));
        } else if (pathname === '/api/reviews/cancel' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => reviewOrchestrator.cancel(body)));
        } else if (pathname === '/api/diff' && req.method === 'GET') {
          await pendingMutation;
          const taskId = requestUrl.searchParams.get('taskId');
          if (!taskId) throw fail(400, 'Task ID is required.');
          respond(
            res,
            200,
            await inspectDiff(root, {
              taskId,
              base: requestUrl.searchParams.get('base') ?? undefined,
            }),
          );
        } else if (pathname === '/api/diff/file' && req.method === 'GET') {
          await pendingMutation;
          const taskId = requestUrl.searchParams.get('taskId');
          const file = requestUrl.searchParams.get('path');
          if (!taskId || !file) throw fail(400, 'Task ID and path are required.');
          respond(res, 200, await inspectDiffFile(root, { taskId, path: file }));
        } else if (pathname === '/api/annotations' && req.method === 'GET') {
          await pendingMutation;
          const taskId = requestUrl.searchParams.get('taskId');
          if (!taskId) throw fail(400, 'Task ID is required.');
          respond(res, 200, await listDiffAnnotations(root, { taskId }));
        } else if (pathname === '/api/annotations' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof createDiffAnnotation>[1]>(req);
          respond(res, 200, await serialize(() => createDiffAnnotation(root, body)));
        } else if (pathname === '/api/annotations/action' && req.method === 'POST') {
          const body = await readJson<Parameters<typeof updateDiffAnnotation>[1]>(req);
          respond(res, 200, await serialize(() => updateDiffAnnotation(root, body)));
        } else if (pathname === '/api/acceptance/verify' && req.method === 'POST') {
          const body =
            await readJson<NonNullable<Parameters<typeof acceptanceVerifier.verify>[0]>>(req);
          respond(
            res,
            200,
            await acceptanceVerifier.verify({
              taskId: body.taskId,
              document: body.document,
              executionAuthorized: body.executionAuthorized === true,
            }),
          );
        } else if (pathname === '/api/acceptance/cancel' && req.method === 'POST') {
          const body = await readJson<{ taskId: string }>(req);
          respond(res, 200, acceptanceVerifier.cancel(body.taskId));
        } else if (pathname === '/api/projects' && req.method === 'GET') {
          respond(res, 200, await listProjects(projectsRegistryRoot));
        } else if (pathname === '/api/projects' && req.method === 'POST') {
          const body = await readJson<{ root?: string; displayName?: string }>(req);
          respond(
            res,
            200,
            await serialize(() =>
              registerProject(projectsRegistryRoot, { ...body, source: 'manual' }),
            ),
          );
        } else if (/^\/api\/projects\/project_[0-9a-f-]+$/i.test(pathname)) {
          const id = pathname.slice('/api/projects/'.length);
          if (req.method === 'GET') {
            respond(
              res,
              200,
              await inspectProject(projectsRegistryRoot, id, usageRangeOptions(requestUrl)),
            );
          } else if (req.method === 'DELETE') {
            respond(res, 200, await serialize(() => removeProject(projectsRegistryRoot, id)));
          } else throw fail(405, 'Method not allowed.');
        } else {
          throw fail(404, 'API route or method not found.');
        }
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.');
      const asset = ASSETS.get(pathname);
      if (!asset) throw fail(404, 'Not found.');
      const data = await readFile(fileURLToPath(new URL(asset[0], WEB_ROOT)));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const details = errorRecord(error);
      const diagnostic = operationalError(error, { operation: 'api', stage: req.url ?? 'request' });
      await appendEvent(root, diagnostic).catch(() => {});
      const status = statusForError(error);
      respond(res, status, {
        error: redactString(diagnostic.message),
        code: diagnostic.code,
        operationId: diagnostic.operationId,
        retry: diagnostic.retry,
        ...(details.path ? { path: details.path } : {}),
        ...(details.conflicts ? { conflicts: details.conflicts } : {}),
        ...(details.revision ? { configRevision: details.revision } : {}),
        ...(details.planId ? { planId: details.planId } : {}),
        ...(details.configRevision ? { configRevision: details.configRevision } : {}),
      });
    }
  }
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  let shutdown: Promise<void> | undefined;
  const drain = () =>
    (shutdown ??= (async () => {
      // A disconnected socket does not stop its asynchronous handler. Finish
      // admitted requests before stopping workflows they may still schedule.
      await Promise.allSettled([...activeRequests]);
      await workflowController.shutdown();
    })());
  server.once('close', () => {
    void drain().catch(() => {});
  });
  const closeTransport = server.close;
  server.close = function (callback) {
    return closeTransport.call(this, function (this: http.Server | undefined, error) {
      // Preserve the native close event and return value; the callback also
      // guarantees that this server's requests and workflows have drained.
      void drain().then(
        () => callback?.call(this, error),
        (failure: unknown) =>
          callback?.call(
            this,
            error ?? (failure instanceof Error ? failure : new Error('Server shutdown failed.')),
          ),
      );
    });
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Loopback server has no TCP address.');
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  return { server, url: `${origin}/#${token}`, token };
}
