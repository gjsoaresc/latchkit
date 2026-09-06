import { createHash, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { redact } from '../diagnostics/redact.js';
import { errorCode, errorMessage } from '../types.js';
import { providerById } from '../providers/registry.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../runtime/process-runner.js';
import type { ProcessRunResult, RunProviderProcessOptions } from '../runtime/process-runner.js';
import { inspectTask, recordEvidence } from '../task-state/service.js';
import type { SourceSnapshot, Task } from '../task-state/contracts.js';
import { safePath, writeAtomic } from '../storage.js';
import { AcceptanceError, safeArtifactLocation, validateAcceptanceDocument } from './contracts.js';
import type {
  AcceptanceCheck,
  AcceptanceDocument,
  BrowserAcceptanceCheck,
  HttpAcceptanceCheck,
} from './contracts.js';
import type { Browser, BrowserContext, BrowserType } from 'playwright';

const MAX_ARTIFACTS_PER_TASK = 25;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ACTIVE = new Map<string, AbortController>();
const codexProvider = providerById('codex');
if (!codexProvider)
  throw new AcceptanceError(
    'Codex provider contract is unavailable.',
    'RUNTIME_PROVIDER_UNAVAILABLE',
  );
const runtimeProvider = {
  ...codexProvider,
  id: 'acceptance-runtime',
  label: 'Latchkit acceptance runtime',
  capabilities: {
    ...codexProvider.capabilities,
    invocation: {
      state: 'supported',
      reason: 'Explicit acceptance commands use the host-local process runner.',
      versionRange: '*',
      evidenceUrl: 'docs/acceptance-verification.md',
    },
  },
};

const key = (root: string, taskId: string) => `${path.resolve(root)}\0${taskId}`;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sourceEqual = (a: SourceSnapshot | undefined, b: SourceSnapshot | undefined) =>
  a?.revision === b?.revision && a?.dirtyFingerprint === b?.dirtyFingerprint;

type CheckResult = {
  status: string;
  outcome: string;
  response?: { status?: number; bytes?: number };
  assertions?: { kind: string; passed: boolean; actual: unknown }[];
  error?: unknown;
  files?: { name: string; bytes: number; sha256: string }[];
  privacy?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  outputBytes?: number;
  stdout?: unknown;
  stderr?: unknown;
  fixture?: CheckResult;
};
type StoredArtifact = { location: string; sha256: string; bytes: number };
type Launch = (options?: RunProviderProcessOptions) => Promise<ProcessRunResult>;
type VerificationOptions = { root?: string; launch?: Launch };
type VerifyInput = {
  taskId?: string;
  document?: unknown;
  executionAuthorized?: boolean;
  signal?: AbortSignal;
};

function safeTargetSummary(value: string): unknown {
  const parsed = new URL(value.replaceAll('${PORT}', '1'));
  const port = value.includes('${PORT}') ? ':${PORT}' : parsed.port ? `:${parsed.port}` : '';
  return redact(`${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`);
}

function declaredSecrets(check: AcceptanceCheck): string[] {
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 8) values.push(value);
  };
  if (check.type === 'cli') {
    check.plan.args.forEach(collect);
    Object.values(check.plan.environment ?? {}).forEach(collect);
  }
  if (check.fixture) Object.values(check.fixture.plan.environment ?? {}).forEach(collect);
  if (check.type === 'http') collect(check.body);
  if (check.type === 'browser')
    for (const action of check.actions) if (action.kind === 'fill') collect(action.value);
  try {
    const targetValue =
      check.type === 'http' || check.type === 'browser' ? check.target : undefined;
    if (!targetValue) return values;
    const target = new URL(targetValue.replaceAll('${PORT}', '1'));
    collect(target.search);
    collect(target.hash);
  } catch {
    // Contract validation reports malformed targets before artifact creation.
  }
  return values;
}

function declarationSummary(check: AcceptanceCheck): Record<string, unknown> {
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

function substitutePort(value: string, port: number): string {
  return typeof value === 'string' ? value.replaceAll('${PORT}', String(port)) : value;
}

async function availablePort(requested: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', (error) => reject(error));
    server.listen(requested, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() =>
          reject(
            new AcceptanceError('Fixture did not expose a TCP port.', 'FIXTURE_PORT_UNAVAILABLE'),
          ),
        );
        return;
      }
      const port = (address as AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function boundedResponse(
  response: Response,
  limit: number,
): Promise<{ bytes: number; text: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: 0, text: '' };
  const chunks: Uint8Array[] = [];
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

function jsonPointer(value: unknown, pointer: unknown): unknown {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((item, part) => {
      if (item !== null && typeof item === 'object') return (item as Record<string, unknown>)[part];
      return undefined;
    }, value);
}

function httpAssertions(check: HttpAcceptanceCheck, response: Response, body: string) {
  let parsed: unknown;
  const results = check.assertions.map((assertion) => {
    let actual: unknown;
    let passed = false;
    if (assertion.kind === 'status') {
      actual = response.status;
      passed = actual === assertion.equals;
    } else if (assertion.kind === 'header') {
      actual = response.headers.get(String(assertion.name)) ?? null;
      passed =
        assertion.equals !== undefined
          ? actual === assertion.equals
          : typeof actual === 'string' && actual.includes(String(assertion.includes));
    } else if (assertion.kind === 'body-includes') {
      passed = body.includes(String(assertion.value));
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

async function runHttp(check: HttpAcceptanceCheck, signal?: AbortSignal): Promise<CheckResult> {
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
    if (errorCode(error) === 'RESPONSE_TOO_LARGE')
      return {
        status: 'response-too-large',
        outcome: 'failed',
        response: { bytes: error instanceof AcceptanceError ? error.bytes : undefined },
      };
    if (controller.signal.aborted)
      return {
        status: controller.signal.reason === 'cancelled' ? 'cancelled' : 'timed-out',
        outcome: controller.signal.reason === 'cancelled' ? 'cancelled' : 'timed-out',
      };
    return { status: 'missing-runtime', outcome: 'failed', error: redact(errorMessage(error)) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function runBrowser(
  check: BrowserAcceptanceCheck,
  signal: AbortSignal | undefined,
  directory: string,
): Promise<CheckResult> {
  let playwright: { chromium: BrowserType; firefox: BrowserType; webkit: BrowserType };
  try {
    playwright = await import('playwright');
  } catch {
    return { status: 'missing-browser-runtime', outcome: 'unsupported' };
  }
  const browserType = playwright[check.browser];
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
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
    }
    const assertions: { kind: string; passed: boolean; actual: unknown }[] = [];
    for (const assertion of check.assertions) {
      let actual: unknown;
      let passed = false;
      if (assertion.kind === 'visible') {
        actual = await page.locator(String(assertion.selector)).isVisible();
        passed = actual === true;
      } else if (assertion.kind === 'text') {
        const value = await page.locator(String(assertion.selector)).textContent();
        passed =
          assertion.equals !== undefined
            ? value === assertion.equals
            : value?.includes(String(assertion.includes)) === true;
        actual = passed ? 'matched' : 'did-not-match';
      } else if (assertion.kind === 'url') {
        actual = page.url();
        passed =
          assertion.equals !== undefined
            ? actual === assertion.equals
            : typeof actual === 'string' && actual.includes(String(assertion.includes));
      } else if (assertion.kind === 'title') {
        const value = await page.title();
        passed =
          assertion.equals !== undefined
            ? value === assertion.equals
            : value.includes(String(assertion.includes));
        actual = passed ? 'matched' : 'did-not-match';
      }
      assertions.push({ kind: assertion.kind, passed, actual: redact(actual) });
    }
    const files: string[] = [];
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
      return { status: 'cancelled', outcome: 'cancelled', error: redact(errorMessage(error)) };
    if (timedOut)
      return { status: 'timed-out', outcome: 'timed-out', error: redact(errorMessage(error)) };
    if (errorCode(error) === 'ARTIFACT_TOO_LARGE')
      return {
        status: 'artifact-too-large',
        outcome: 'failed',
        error: redact(errorMessage(error)),
      };
    if (/executable doesn't exist|browser.*not found/i.test(errorMessage(error)))
      return {
        status: 'missing-browser-runtime',
        outcome: 'unsupported',
        error: redact(errorMessage(error)),
      };
    return { status: 'browser-crashed', outcome: 'failed', error: redact(errorMessage(error)) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function processResult(result: ProcessRunResult): CheckResult {
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

type TargetCheck = HttpAcceptanceCheck | BrowserAcceptanceCheck;
type FixtureStart =
  | { check: AcceptanceCheck; stop: () => Promise<unknown>; summary: unknown; error?: undefined }
  | { check?: undefined; stop?: undefined; summary?: undefined; error: CheckResult };

async function startFixture(check: AcceptanceCheck, signal?: AbortSignal): Promise<FixtureStart> {
  if (!check.fixture || (check.type !== 'http' && check.type !== 'browser'))
    return { check, stop: async () => undefined, summary: null };
  const targetCheck: TargetCheck = check;
  const declaredFixture = targetCheck.fixture;
  if (!declaredFixture)
    throw new AcceptanceError(
      'Fixture was lost after acceptance validation.',
      'ACCEPTANCE_INVALID',
    );
  let port: number;
  try {
    port = await availablePort(declaredFixture.port);
  } catch (error) {
    return {
      error: {
        status: 'fixture-port-conflict',
        outcome: 'failed',
        error: redact(errorMessage(error)),
      },
    };
  }
  const abort = new AbortController();
  const outerAbort = () => abort.abort();
  signal?.addEventListener('abort', outerAbort, { once: true });
  const plan = {
    ...declaredFixture.plan,
    args: declaredFixture.plan.args.map((value) => substitutePort(value, port)),
    environment: {
      ...(declaredFixture.plan.environment ?? {}),
      [declaredFixture.portEnvironment]: String(port),
    },
  };
  const execution = runProviderProcess({
    provider: runtimeProvider,
    plan,
    executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
    outputLimitBytes: targetCheck.outputLimitBytes,
    signal: abort.signal,
  });
  const deadline = Date.now() + declaredFixture.readinessTimeoutMs;
  const readiness = new URL(declaredFixture.readinessPath, substitutePort(targetCheck.target, port))
    .href;
  let early: ProcessRunResult | undefined;
  while (Date.now() < deadline && !signal?.aborted) {
    const race = await Promise.race([
      execution.then((value) => ({ process: value })),
      fetch(readiness, { signal: AbortSignal.timeout(300) }).then(
        (response) => ({ ready: response.ok }),
        () => ({ ready: false }),
      ),
    ]);
    if ('process' in race) {
      early = race.process;
      break;
    }
    if ('ready' in race && race.ready) {
      return {
        check: { ...targetCheck, target: substitutePort(targetCheck.target, port) },
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

async function writeArtifact(
  root: string,
  taskId: string,
  artifactId: string,
  document: unknown,
  suppliedSecrets: readonly string[] = [],
): Promise<StoredArtifact> {
  const location = safeArtifactLocation(taskId, artifactId);
  const destination = await safePath(root, location);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(redact(document, suppliedSecrets), null, 2)}\n`);
  if (bytes.length > MAX_ARTIFACT_BYTES)
    throw new AcceptanceError('Sanitized artifact exceeds 256 KB.', 'ARTIFACT_TOO_LARGE');
  await writeAtomic(root, location, bytes);
  const taskDirectory = path.dirname(directory);
  const entries: { name: string; time: number }[] = [];
  for (const entry of await readdir(taskDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = await stat(path.join(taskDirectory, entry.name));
    entries.push({ name: entry.name, time: info.mtimeMs });
  }
  for (const expired of entries.sort((a, b) => b.time - a.time).slice(MAX_ARTIFACTS_PER_TASK))
    await rm(path.join(taskDirectory, expired.name), { recursive: true, force: true });
  return { location, sha256: sha256(bytes), bytes: bytes.length };
}

async function executeOne({
  root,
  task,
  check,
  signal,
  launch,
  source,
}: {
  root: string;
  task: Task;
  check: AcceptanceCheck;
  signal: AbortSignal;
  launch: Launch;
  source: SourceSnapshot;
}): Promise<{ result: CheckResult; stored: StoredArtifact }> {
  const artifactId = `acceptance_${randomUUID()}`;
  const location = safeArtifactLocation(task.id, artifactId);
  const directory = path.dirname(await safePath(root, location));
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const fixture = await startFixture(check, signal);
  let result: CheckResult;
  let stopped: unknown = null;
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
      else if (check.type === 'http' && fixture.check?.type === 'http')
        result = await runHttp(fixture.check, signal);
      else if (check.type === 'browser' && fixture.check?.type === 'browser')
        result = await runBrowser(fixture.check, signal, directory);
      else result = { status: 'manual-verification-required', outcome: 'unsupported' };
    } finally {
      stopped = await fixture.stop();
    }
  }
  const after = await inspectTask(root, task.id);
  if (!sourceEqual(source, after.reconciliation.currentSource) && result.outcome === 'passed')
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
      runId: task.owner?.runId ?? null,
      criterionId: check.criterionId,
      criterionRevision:
        task.criteria.find((item) => item.id === check.criterionId)?.revision ?? null,
      source,
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

export function createAcceptanceVerifier({
  root,
  launch = runProviderProcess,
}: VerificationOptions = {}) {
  if (!root) throw new AcceptanceError('Project root is required.');
  const projectRoot = path.resolve(root);
  async function verify({ taskId, document, executionAuthorized, signal }: VerifyInput = {}) {
    if (executionAuthorized !== true)
      throw new AcceptanceError(
        'Acceptance execution requires explicit host-local authorization.',
        'EXECUTION_AUTHORIZATION_REQUIRED',
      );
    const declared: AcceptanceDocument = validateAcceptanceDocument(document);
    if (typeof taskId !== 'string')
      throw new AcceptanceError('Task ID is required.', 'TASK_NOT_FOUND');
    let inspected = await inspectTask(projectRoot, taskId);
    if (inspected.task.state !== 'running' || !inspected.task.owner)
      throw new AcceptanceError('Acceptance checks require a running task.', 'TASK_NOT_RUNNING');
    for (const check of declared.checks) {
      if (!inspected.task.criteria.some((criterion) => criterion.id === check.criterionId))
        throw new AcceptanceError(
          `Check ${check.id} references an unknown criterion.`,
          'CRITERION_NOT_FOUND',
        );
    }
    if (ACTIVE.has(key(projectRoot, taskId)))
      throw new AcceptanceError(
        'Acceptance verification is already running.',
        'ACCEPTANCE_ALREADY_RUNNING',
      );
    const abort = new AbortController();
    const externalAbort = () => abort.abort();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener('abort', externalAbort, { once: true });
    ACTIVE.set(key(projectRoot, taskId), abort);
    const results: {
      checkId: string;
      criterionId: string;
      outcome: string;
      status: string;
      artifact: StoredArtifact;
    }[] = [];
    try {
      for (const check of declared.checks) {
        if (abort.signal.aborted) break;
        const task = inspected.task;
        // Capture the exact pre-execution source in the artifact and reject a pass
        // when the source moves before evidence is committed.
        const source = inspected.reconciliation.currentSource;
        const executed = await executeOne({
          root: projectRoot,
          task,
          check,
          signal: abort.signal,
          launch,
          source,
        });
        const criterion = task.criteria.find((item) => item.id === check.criterionId);
        if (!criterion || !task.owner)
          throw new AcceptanceError(
            'Task criterion or ownership changed during verification.',
            'TASK_NOT_RUNNING',
          );
        const artifact = JSON.stringify({
          schemaVersion: 1,
          type: check.type,
          status: executed.result.status,
          location: executed.stored.location,
          sha256: executed.stored.sha256,
          bytes: executed.stored.bytes,
        });
        const updated = await recordEvidence(projectRoot, {
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
          reconciliation: (await inspectTask(projectRoot, taskId)).reconciliation,
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
      ACTIVE.delete(key(projectRoot, taskId));
      signal?.removeEventListener('abort', externalAbort);
    }
  }
  function cancel(taskId: string) {
    const active = ACTIVE.get(key(projectRoot, taskId));
    if (active) active.abort();
    return { taskId, cancelled: Boolean(active) };
  }
  return Object.freeze({ verify, cancel });
}
