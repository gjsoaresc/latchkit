import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { controllerProof, localRequest } from './fcc-process.js';
import type { ServerPlan, ControllerRecord } from './fcc-process.js';

// This entry point accepts its plan only through the private parent IPC channel.
// Control requests never select a PID, command or path. This process retains the
// ChildProcess handle and closes the child's stdin on every shutdown path.
if (!process.send) throw new Error('FCC controller requires its parent IPC channel.');
let committed = false;
let shutdown: (() => Promise<void>) | undefined;
const bootstrapTimer = setTimeout(() => process.exit(1), 10_000);
process.on('disconnect', () => {
  if (!committed) void shutdown?.();
});
process.on('message', (message: { plan?: ServerPlan; controlToken?: string; commit?: boolean }) => {
  if (message.commit && shutdown) {
    committed = true;
    process.send?.({ committed: true });
    return;
  }
  if (!message.plan || !message.controlToken || shutdown) return;
  clearTimeout(bootstrapTimer);
  void serve(message.plan, message.controlToken).catch(() => {
    process.send?.({ error: 'FCC controller failed; no ready service was recorded.' });
    if (shutdown) void shutdown().finally(() => process.exit(1));
    else process.exit(1);
  });
});

async function serve(plan: ServerPlan, token: string): Promise<void> {
  // Fail before launching if the requested inference port already belongs to
  // another process. Authentication probes also rule out an unrelated listener.
  const reservation = createSocketServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(plan.port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let ended = false;
  let stopping = false;
  let childError = false;
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const exited = new Promise<void>((resolve) => {
    child.once('error', () => {
      childError = true;
      ended = true;
      resolve();
    });
    child.once('exit', () => {
      ended = true;
      resolve();
      if (committed && !stopping) void shutdown?.();
    });
  });
  const control = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const challenge = url.searchParams.get('challenge') ?? '';
    if (
      req.method === 'GET' &&
      url.pathname === '/status' &&
      /^[a-f0-9]{64}$/.test(challenge) &&
      !ended &&
      !stopping
    ) {
      res.end(controllerProof(token, challenge, plan.installId));
    } else if (req.method === 'POST' && url.pathname === '/stop') {
      const expected = Buffer.from(`Bearer ${token}`);
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.writeHead(401).end();
        return;
      }
      void stopChild().then(
        () => {
          res.end('stopped');
          control.close(() => process.exit(0));
        },
        () => res.writeHead(503).end(),
      );
    } else res.writeHead(404).end();
  });
  control.headersTimeout = 5000;
  control.requestTimeout = 5000;
  control.maxConnections = 16;
  async function stopChild() {
    stopping = true;
    if (!ended) child.stdin.end('stop\n');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 7000).unref())]);
    if (!ended) {
      child.kill();
      await Promise.race([
        exited,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Child shutdown timed out.')), 2000).unref(),
        ),
      ]);
    }
  }
  shutdown = async () => {
    try {
      await stopChild();
    } finally {
      control.close();
      process.exit(ended ? 0 : 1);
    }
  };
  process.once('SIGTERM', () => void shutdown?.());
  process.once('SIGINT', () => void shutdown?.());
  const deadline = Date.now() + plan.timeoutMs;
  let ready = false;
  while (!ended && Date.now() < deadline) {
    try {
      const health = await localRequest(plan.port, '/health');
      const anonymous = await localRequest(plan.port, '/v1/messages', 'HEAD');
      const authorized = await localRequest(plan.port, '/v1/messages', 'HEAD', {
        authorization: `Bearer ${plan.proxyToken}`,
      });
      if (
        health.status === 200 &&
        anonymous.status === 401 &&
        authorized.status >= 200 &&
        authorized.status < 300 &&
        !ended
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Readiness is bounded and sends no inference request. */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) {
    process.send?.({
      error: childError
        ? 'FCC server command could not start.'
        : ended
          ? 'FCC server exited before authenticated readiness.'
          : 'FCC authenticated readiness timed out.',
    });
    await shutdown();
    return;
  }
  for (const asset of plan.requiredAssets ?? []) {
    const response = await localRequest(plan.port, asset, 'GET', {}, 2000, 512_000);
    if (response.status !== 200 || !response.body) {
      process.send?.({
        error:
          'FCC Admin assets are unavailable; the runtime was retained and no ready service was recorded.',
      });
      await shutdown();
      return;
    }
  }
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(0, '127.0.0.1', resolve);
  });
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Missing controller address.');
  const record: ControllerRecord = {
    schemaVersion: 2,
    installId: plan.installId,
    controllerPid: process.pid,
    controlPort: address.port,
    controlToken: token,
    port: plan.port,
    startedAt: new Date().toISOString(),
  };
  process.send?.({ ready: record });
  // A crashed parent cannot strand a ready but uncommitted child.
  setTimeout(() => {
    if (!committed) void shutdown?.();
  }, 15_000).unref();
}
