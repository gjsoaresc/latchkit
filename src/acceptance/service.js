import { createHash, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { redact } from '../diagnostics/redact.js';
import { providerById } from '../providers/registry.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';
import { inspectTask, recordEvidence } from '../task-state/service.js';
import { safePath } from '../storage.js';
import { AcceptanceError, safeArtifactLocation, validateAcceptanceDocument } from './contracts.js';

const MAX_ARTIFACTS_PER_TASK = 25;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ACTIVE = new Map();
const runtimeProvider = {
  ...providerById('codex'),
  id: 'acceptance-runtime',
  label: 'Latchkit acceptance runtime',
  capabilities: {
    ...providerById('codex').capabilities,
    invocation: {
      state: 'supported',
      reason: 'Explicit acceptance commands use the host-local process runner.',
      versionRange: '*',
      evidenceUrl: 'docs/acceptance-verification.md',
    },
  },
};

const key = (root, taskId) => `${path.resolve(root)}\0${taskId}`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sourceEqual = (a, b) =>
  a?.revision === b?.revision && a?.dirtyFingerprint === b?.dirtyFingerprint;

function safeTargetSummary(value) {
  const parsed = new URL(value.replaceAll('${PORT}', '1'));
  const port = value.includes('${PORT}') ? ':${PORT}' : parsed.port ? `:${parsed.port}` : '';
  return redact(`${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`);
}

function declaredSecrets(check) {
  const values = [];
  const collect = (value) => {
    if (typeof value === 'string' && value.length >= 8) values.push(value);
  };
  if (check.plan) {
    check.plan.args.forEach(collect);
    Object.values(check.plan.environment ?? {}).forEach(collect);
  }
  if (check.fixture) Object.values(check.fixture.plan.environment ?? {}).forEach(collect);
  collect(check.body);
  for (const action of check.actions ?? []) collect(action.value);
  try {
    const target = new URL(check.target?.replaceAll('${PORT}', '1'));
    collect(target.search);
    collect(target.hash);
  } catch {
    // Contract validation reports malformed targets before artifact creation.
  }
  return values;
}

function declarationSummary(check) {
  const common = {
    sha256: sha256(JSON.stringify(check)),
    timeoutMs: check.timeoutMs,
    outputLimitBytes: check.outputLimitBytes,
    fixture: check.fixture
      ? {
          executable: path.basename(check.fixture.plan.executable),
          argumentCount: check.fixture.plan.args.length,
          requestedPort: check.fixture.port,
          readinessPath: check.fixture.readinessPath,
        }
      : null,
  };
  if (check.type === 'cli')
    return {
      ...common,
      executable: path.basename(check.plan.executable),
      argumentCount: check.plan.args.length,
    };
  if (check.type === 'http')
    return {
      ...common,
      method: check.method,
      target: safeTargetSummary(check.target),
      followRedirects: check.followRedirects,
      assertions: check.assertions.map((item) => item.kind),
    };
  if (check.type === 'browser')
    return {
      ...common,
      browser: check.browser,
      target: safeTargetSummary(check.target),
      actions: check.actions.map((item) => item.kind),
      assertions: check.assertions.map((item) => item.kind),
      captureScreenshot: check.captureScreenshot,
      captureTrace: check.captureTrace,
    };
  return { ...common, mode: 'manual' };
}

function substitutePort(value, port) {
  return typeof value === 'string' ? value.replaceAll('${PORT}', String(port)) : value;
}

async function availablePort(requested) {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', (error) => reject(error));
    server.listen(requested, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function boundedResponse(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: 0, text: '' };
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      const error = new AcceptanceError(
        'Response exceeded its declared size limit.',
        'RESPONSE_TOO_LARGE',
      );
      error.bytes = bytes;
      throw error;
    }
    chunks.push(value);
  }
  return { bytes, text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

function jsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((item, part) => item?.[part], value);
}

function httpAssertions(check, response, body) {
  let parsed;
  const results = check.assertions.map((assertion) => {
    let actual;
    let passed = false;
    if (assertion.kind === 'status') {
      actual = response.status;
      passed = actual === assertion.equals;
    } else if (assertion.kind === 'header') {
      actual = response.headers.get(assertion.name) ?? null;
      passed =
        assertion.equals !== undefined
          ? actual === assertion.equals
          : actual?.includes(assertion.includes);
    } else if (assertion.kind === 'body-includes') {
      passed = body.includes(assertion.value);
      actual = passed ? 'matched' : 'did-not-match';
    } else if (assertion.kind === 'json') {
      try {
        parsed ??= JSON.parse(body);
        const selected = jsonPointer(parsed, assertion.pointer);
        passed = JSON.stringify(selected) === JSON.stringify(assertion.equals);
        actual = passed ? 'matched' : 'did-not-match';
      } catch {
        actual = 'invalid-json';
      }
    } else actual = 'unsupported-assertion';
    return { kind: assertion.kind, passed, actual: redact(actual) };
  });
  return { passed: results.every((item) => item.passed), results };
}

async function runHttp(check, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), check.timeoutMs);
  const abort = () => controller.abort('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(check.target, {
      method: check.method,
      body: check.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400 && !check.followRedirects)
      return { status: 'redirected', outcome: 'failed', response: { status: response.status } };
    if (response.status >= 300 && response.status < 400 && check.followRedirects) {
      const location = response.headers.get('location');
      if (!location)
        return { status: 'redirected', outcome: 'failed', response: { status: response.status } };
      const redirected = new URL(location, check.target);
      if (redirected.origin !== new URL(check.target).origin)
        return {
          status: 'redirect-refused',
          outcome: 'failed',
          response: { status: response.status },
        };
      const next = { ...check, target: redirected.href, followRedirects: false };
      return runHttp(next, signal);
    }
    const captured = await boundedResponse(response, check.outputLimitBytes);
    const assertions = httpAssertions(check, response, captured.text);
    return {
      status: assertions.passed ? 'assertions-passed' : 'assertions-failed',
      outcome: assertions.passed ? 'passed' : 'failed',
      response: { status: response.status, bytes: captured.bytes },
      assertions: assertions.results,
    };
  } catch (error) {
    if (error.code === 'RESPONSE_TOO_LARGE')
      return { status: 'response-too-large', outcome: 'failed', response: { bytes: error.bytes } };
    if (controller.signal.aborted)
      return {
        status: controller.signal.reason === 'cancelled' ? 'cancelled' : 'timed-out',
        outcome: controller.signal.reason === 'cancelled' ? 'cancelled' : 'timed-out',
      };
    return { status: 'missing-runtime', outcome: 'failed', error: redact(error.message) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function runBrowser(check, signal, directory) {
  let playwright;
  try {
    playwright = await import('@playwright/test');
  } catch {
    return { status: 'missing-browser-runtime', outcome: 'unsupported' };
  }
  const browserType = playwright[check.browser];
  if (!browserType) return { status: 'missing-browser-runtime', outcome: 'unsupported' };
  let browser;
  let context;
  let timedOut = false;
  const abort = () => void browser?.close();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, check.timeoutMs);
  try {
    browser = await browserType.launch({ headless: true });
    context = await browser.newContext();
    if (check.captureTrace)
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await context.newPage();
    await page.goto(check.target, { waitUntil: 'domcontentloaded' });
    for (const action of check.actions) {
      if (action.kind === 'click') await page.locator(action.selector).click();
      else if (action.kind === 'fill') await page.locator(action.selector).fill(action.value);
      else if (action.kind === 'press') await page.locator(action.selector).press(action.key);
      else if (action.kind === 'goto') {
        const destination = new URL(action.path, check.target);
        if (destination.origin !== new URL(check.target).origin)
          throw new AcceptanceError(
            'Browser actions cannot leave the declared local origin.',
            'REMOTE_BROWSER_TARGET_REFUSED',
          );
        await page.goto(destination.href);
      } else if (action.kind === 'close') await page.close();
      else
        throw new AcceptanceError(
          `Unsupported browser action ${action.kind}.`,
          'BROWSER_ACTION_INVALID',
        );
    }
    const assertions = [];
    for (const assertion of check.assertions) {
      let actual;
      let passed = false;
      if (assertion.kind === 'visible') {
        actual = await page.locator(assertion.selector).isVisible();
        passed = actual;
      } else if (assertion.kind === 'text') {
        const value = await page.locator(assertion.selector).textContent();
        passed =
          assertion.equals !== undefined
            ? value === assertion.equals
            : value?.includes(assertion.includes);
        actual = passed ? 'matched' : 'did-not-match';
      } else if (assertion.kind === 'url') {
        actual = page.url();
        passed =
          assertion.equals !== undefined
            ? actual === assertion.equals
            : actual.includes(assertion.includes);
      } else if (assertion.kind === 'title') {
        const value = await page.title();
        passed =
          assertion.equals !== undefined
            ? value === assertion.equals
            : value.includes(assertion.includes);
        actual = passed ? 'matched' : 'did-not-match';
      }
      assertions.push({ kind: assertion.kind, passed, actual: redact(actual) });
    }
    const files = [];
    if (check.captureScreenshot) {
      const file = path.join(directory, 'screenshot.png');
      await page.screenshot({ path: file, fullPage: false });
      files.push('screenshot.png');
    }
    if (check.captureTrace) {
      await context.tracing.stop({ path: path.join(directory, 'trace.zip') });
      files.push('trace.zip');
    }
    return {
      status: assertions.every((item) => item.passed) ? 'assertions-passed' : 'assertions-failed',
      outcome: assertions.every((item) => item.passed) ? 'passed' : 'failed',
      assertions,
      files: await Promise.all(
        files.map(async (name) => {
          const file = path.join(directory, name);
          const info = await stat(file);
          if (info.size > MAX_ATTACHMENT_BYTES) {
            await rm(file, { force: true });
            throw new AcceptanceError('Browser attachment exceeds 5 MB.', 'ARTIFACT_TOO_LARGE');
          }
          return { name, bytes: info.size, sha256: sha256(await readFile(file)) };
        }),
      ),
      privacy:
        check.captureScreenshot || check.captureTrace
          ? 'explicit-opt-in-capture'
          : 'no-page-capture',
    };
  } catch (error) {
    if (signal?.aborted)
      return { status: 'cancelled', outcome: 'cancelled', error: redact(error.message) };
    if (timedOut)
      return { status: 'timed-out', outcome: 'timed-out', error: redact(error.message) };
    if (error.code === 'ARTIFACT_TOO_LARGE')
      return { status: 'artifact-too-large', outcome: 'failed', error: redact(error.message) };
    if (/executable doesn't exist|browser.*not found/i.test(error.message))
      return {
        status: 'missing-browser-runtime',
        outcome: 'unsupported',
        error: redact(error.message),
      };
    return { status: 'browser-crashed', outcome: 'failed', error: redact(error.message) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function processResult(result) {
  const outcome =
    result.status === 'exited' && result.exitCode === 0
      ? 'passed'
      : result.status === 'timed-out'
        ? 'timed-out'
        : result.status === 'cancelled'
          ? 'cancelled'
          : result.status === 'refused'
            ? 'unsupported'
            : 'failed';
  return {
    status: result.status,
    outcome,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    outputBytes: result.outputBytes ?? 0,
    stdout: redact(result.stdout ?? ''),
    stderr: redact(result.stderr ?? result.message ?? ''),
  };
}

async function startFixture(check, signal) {
  if (!check.fixture) return { check, stop: async () => {}, summary: null };
  let port;
  try {
    port = await availablePort(check.fixture.port);
  } catch (error) {
    return {
      error: { status: 'fixture-port-conflict', outcome: 'failed', error: redact(error.message) },
    };
  }
  const abort = new AbortController();
  const outerAbort = () => abort.abort();
  signal?.addEventListener('abort', outerAbort, { once: true });
  const plan = {
    ...check.fixture.plan,
    args: check.fixture.plan.args.map((value) => substitutePort(value, port)),
    environment: {
      ...(check.fixture.plan.environment ?? {}),
      [check.fixture.portEnvironment]: String(port),
    },
  };
  const execution = runProviderProcess({
    provider: runtimeProvider,
    plan,
    executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
    outputLimitBytes: check.outputLimitBytes,
    signal: abort.signal,
  });
  const deadline = Date.now() + check.fixture.readinessTimeoutMs;
  const readiness = new URL(check.fixture.readinessPath, substitutePort(check.target, port)).href;
  let early;
  while (Date.now() < deadline && !signal?.aborted) {
    const race = await Promise.race([
      execution.then((value) => ({ process: value })),
      fetch(readiness, { signal: AbortSignal.timeout(300) }).then(
        (response) => ({ ready: response.ok }),
        () => ({ ready: false }),
      ),
    ]);
    if (race.process) {
      early = race.process;
      break;
    }
    if (race.ready) {
      return {
        check: { ...check, target: substitutePort(check.target, port) },
        summary: { status: 'ready', assignedPort: port },
        stop: async () => {
          abort.abort();
          const stopped = await execution;
          signal?.removeEventListener('abort', outerAbort);
          return { status: stopped.status, outputBytes: stopped.outputBytes ?? 0 };
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  abort.abort();
  const stopped = early ?? (await execution);
  signal?.removeEventListener('abort', outerAbort);
  return {
    error: {
      status: signal?.aborted
        ? 'cancelled'
        : early
          ? 'fixture-exited'
          : 'fixture-readiness-timeout',
      outcome: signal?.aborted ? 'cancelled' : early ? 'failed' : 'timed-out',
      fixture: processResult(stopped),
    },
  };
}

async function writeArtifact(root, taskId, artifactId, document, suppliedSecrets = []) {
  const location = safeArtifactLocation(taskId, artifactId);
  const destination = await safePath(root, location);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(redact(document, suppliedSecrets), null, 2)}\n`);
  if (bytes.length > MAX_ARTIFACT_BYTES)
    throw new AcceptanceError('Sanitized artifact exceeds 256 KB.', 'ARTIFACT_TOO_LARGE');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const taskDirectory = path.dirname(directory);
  const entries = [];
  for (const entry of await readdir(taskDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = await stat(path.join(taskDirectory, entry.name));
    entries.push({ name: entry.name, time: info.mtimeMs });
  }
  for (const expired of entries.sort((a, b) => b.time - a.time).slice(MAX_ARTIFACTS_PER_TASK))
    await rm(path.join(taskDirectory, expired.name), { recursive: true, force: true });
  return { location, sha256: sha256(bytes), bytes: bytes.length };
}

async function executeOne({ root, task, check, signal, launch }) {
  const artifactId = `acceptance_${randomUUID()}`;
  const location = safeArtifactLocation(task.id, artifactId);
  const directory = path.dirname(await safePath(root, location));
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const fixture = await startFixture(check, signal);
  let result;
  let stopped = null;
  if (fixture.error) result = fixture.error;
  else {
    try {
      if (check.type === 'cli')
        result = processResult(
          await launch({
            provider: runtimeProvider,
            plan: check.plan,
            executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
            timeoutMs: check.timeoutMs,
            outputLimitBytes: check.outputLimitBytes,
            signal,
          }),
        );
      else if (check.type === 'http') result = await runHttp(fixture.check, signal);
      else if (check.type === 'browser')
        result = await runBrowser(fixture.check, signal, directory);
      else result = { status: 'manual-verification-required', outcome: 'unsupported' };
    } finally {
      stopped = await fixture.stop();
    }
  }
  const after = await inspectTask(root, task.id);
  if (!sourceEqual(task.source, after.reconciliation.currentSource) && result.outcome === 'passed')
    result = { ...result, status: 'source-changed', outcome: 'failed' };
  const document = {
    schemaVersion: 1,
    artifactId,
    check: {
      id: check.id,
      type: check.type,
      label: check.label,
      declaration: declarationSummary(check),
    },
    binding: {
      taskId: task.id,
      runId: task.owner.runId,
      criterionId: check.criterionId,
      criterionRevision: task.criteria.find((item) => item.id === check.criterionId).revision,
      source: task.source,
    },
    provenance: {
      driver:
        check.type === 'browser'
          ? 'playwright'
          : check.type === 'http'
            ? 'node-fetch'
            : 'process-runner',
      platform: process.platform,
      node: process.version,
      executionBoundary:
        check.type === 'http' || check.type === 'browser'
          ? 'local-runtime'
          : HOST_LOCAL_EXECUTION_PROFILE,
    },
    startedAt,
    endedAt: new Date().toISOString(),
    fixture: fixture.summary ?? null,
    fixtureCleanup: stopped,
    result,
  };
  const stored = await writeArtifact(root, task.id, artifactId, document, declaredSecrets(check));
  return { result, stored };
}

export function createAcceptanceVerifier({ root, launch = runProviderProcess } = {}) {
  if (!root) throw new AcceptanceError('Project root is required.');
  root = path.resolve(root);
  async function verify({ taskId, document, executionAuthorized, signal } = {}) {
    if (executionAuthorized !== true)
      throw new AcceptanceError(
        'Acceptance execution requires explicit host-local authorization.',
        'EXECUTION_AUTHORIZATION_REQUIRED',
      );
    const declared = validateAcceptanceDocument(document);
    let inspected = await inspectTask(root, taskId);
    if (inspected.task.state !== 'running' || !inspected.task.owner)
      throw new AcceptanceError('Acceptance checks require a running task.', 'TASK_NOT_RUNNING');
    for (const check of declared.checks) {
      if (!inspected.task.criteria.some((criterion) => criterion.id === check.criterionId))
        throw new AcceptanceError(
          `Check ${check.id} references an unknown criterion.`,
          'CRITERION_NOT_FOUND',
        );
    }
    if (ACTIVE.has(key(root, taskId)))
      throw new AcceptanceError(
        'Acceptance verification is already running.',
        'ACCEPTANCE_ALREADY_RUNNING',
      );
    const abort = new AbortController();
    const externalAbort = () => abort.abort();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener('abort', externalAbort, { once: true });
    ACTIVE.set(key(root, taskId), abort);
    const results = [];
    try {
      for (const check of declared.checks) {
        if (abort.signal.aborted) break;
        const task = inspected.task;
        // Capture the exact pre-execution source in the artifact and reject a pass
        // when the source moves before evidence is committed.
        task.source = inspected.reconciliation.currentSource;
        const executed = await executeOne({ root, task, check, signal: abort.signal, launch });
        const criterion = task.criteria.find((item) => item.id === check.criterionId);
        const artifact = JSON.stringify({
          schemaVersion: 1,
          type: check.type,
          status: executed.result.status,
          location: executed.stored.location,
          sha256: executed.stored.sha256,
          bytes: executed.stored.bytes,
        });
        const updated = await recordEvidence(root, {
          taskId: task.id,
          runId: task.owner.runId,
          expectedRevision: task.revision,
          criterionId: criterion.id,
          criterionRevision: criterion.revision,
          outcome: executed.result.outcome,
          command: check.label,
          environmentDetails: `acceptance-${check.type}; artifact=${executed.stored.location}`,
          artifact,
        });
        results.push({
          checkId: check.id,
          criterionId: criterion.id,
          outcome: executed.result.outcome,
          status: executed.result.status,
          artifact: executed.stored,
        });
        inspected = {
          task: updated,
          reconciliation: (await inspectTask(root, taskId)).reconciliation,
        };
      }
      return {
        schemaVersion: 1,
        status:
          results.length === declared.checks.length &&
          results.every((item) => item.outcome === 'passed')
            ? 'passed'
            : 'failed',
        results,
        task: inspected.task,
      };
    } finally {
      ACTIVE.delete(key(root, taskId));
      signal?.removeEventListener('abort', externalAbort);
    }
  }
  function cancel(taskId) {
    const active = ACTIVE.get(key(root, taskId));
    if (active) active.abort();
    return { taskId, cancelled: Boolean(active) };
  }
  return Object.freeze({ verify, cancel });
}
