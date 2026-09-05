import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
import { createReviewOrchestrator } from './reviews/orchestrator.js';
import { listTasks } from './task-state/service.js';

const MAX_BODY_BYTES = 64 * 1024;
export const LOCAL_API_VERSION = 1;
const WEB_ROOT = new URL('../web/', import.meta.url);
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function respond(res, status, value) {
  if (value?.configRevision) res.setHeader('ETag', value.configRevision);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ apiVersion: LOCAL_API_VERSION, ...value }));
}

function requiredRevision(req) {
  const revision = req.headers['if-match'];
  if (typeof revision !== 'string' || !/^"sha256:[a-f0-9]{64}"$/.test(revision)) {
    throw fail(428, 'Send the current configuration revision in If-Match.');
  }
  return revision;
}

function authenticated(req, token) {
  const supplied = req.headers.authorization;
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return false;
  const actual = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw fail(415, 'Send JSON with Content-Type: application/json.');
  }
  const body = await new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks = [];
    req.on('data', (chunk) => {
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
    return JSON.parse(body);
  } catch {
    throw fail(400, 'Request body must contain valid JSON.');
  }
}

/** Serve a single project's configuration UI on loopback with launch-scoped access. */
export async function startServer(root, { port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be an integer between 0 and 65535.');
  }
  const token = randomBytes(32).toString('hex');
  let origin;
  let host;
  let pendingMutation = Promise.resolve();
  const taskController = createTaskController({ root });
  const reviewOrchestrator = createReviewOrchestrator({ root });
  const serialize = (operation) => {
    const result = pendingMutation.then(operation);
    pendingMutation = result.catch(() => {});
    return result;
  };

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
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
          const body = await readJson(req);
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
          respond(res, 200, await serialize(() => syncProject(root, { planId: body.planId })));
        } else if (pathname === '/api/diagnostics' && req.method === 'GET') {
          await pendingMutation;
          respond(res, 200, await previewSupportBundle(root));
        } else if (pathname === '/api/diagnostics/export' && req.method === 'POST') {
          respond(res, 200, await serialize(() => exportSupportBundle(root)));
        } else if (pathname === '/api/diagnostics' && req.method === 'DELETE') {
          respond(res, 200, await serialize(() => clearDiagnostics(root)));
        } else if (pathname === '/api/tasks' && req.method === 'GET') {
          await pendingMutation;
          const taskId = requestUrl.searchParams.get('task');
          respond(res, 200, taskId ? await taskController.inspect(taskId) : await listTasks(root));
        } else if (pathname === '/api/tasks/start' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => taskController.start(body)));
        } else if (pathname === '/api/tasks/resume' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => taskController.resume(body)));
        } else if (pathname === '/api/tasks/cancel' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => taskController.cancel(body)));
        } else if (pathname === '/api/tasks/events' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => taskController.observe(body)));
        } else if (pathname === '/api/reviews' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => reviewOrchestrator.run(body)));
        } else if (pathname === '/api/reviews/cancel' && req.method === 'POST') {
          const body = await readJson(req);
          respond(res, 200, await serialize(() => reviewOrchestrator.cancel(body)));
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
      const diagnostic = operationalError(error, { operation: 'api', stage: req.url ?? 'request' });
      await appendEvent(root, diagnostic).catch(() => {});
      const status = statusForError(error);
      respond(res, status, {
        error: redactString(diagnostic.message),
        code: diagnostic.code,
        operationId: diagnostic.operationId,
        retry: diagnostic.retry,
        ...(error.path ? { path: error.path } : {}),
        ...(error.conflicts ? { conflicts: error.conflicts } : {}),
        ...(error.revision ? { configRevision: error.revision } : {}),
        ...(error.planId ? { planId: error.planId } : {}),
        ...(error.configRevision ? { configRevision: error.configRevision } : {}),
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  host = `127.0.0.1:${server.address().port}`;
  origin = `http://${host}`;
  return { server, url: `${origin}/#${token}`, token };
}
