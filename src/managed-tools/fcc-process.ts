import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

export type ServerPlan = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  proxyToken: string;
  port: number;
  timeoutMs: number;
  installId: string;
  requiredAssets?: string[];
};
export type ControllerRecord = {
  schemaVersion: 2;
  installId: string;
  controllerPid: number;
  controlPort: number;
  controlToken: string;
  port: number;
  startedAt: string;
};

// Intentionally exclude credentials, provider configuration, Python startup hooks,
// npm configuration and uv index overrides inherited from the calling process.
export function systemEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    'systemroot',
    'windir',
    'comspec',
    'path',
    'pathext',
    'temp',
    'tmp',
    'lang',
    'lc_all',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())),
  );
}

export async function runBounded(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let errorOutput = '';
    let failed: Error | undefined;
    const timer = setTimeout(() => {
      failed = new Error(`FCC subprocess timed out after ${timeoutMs}ms.`);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(failed);
    }, timeoutMs);
    child.stdout.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-16_384);
    });
    // Never echo arbitrary subprocess output: dependency URLs can contain secrets.
    child.stderr.on('data', (data: Buffer) => {
      errorOutput = (errorOutput + data.toString()).slice(-16_384);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `FCC subprocess could not start (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
        ),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else if (code !== 0)
        reject(
          new Error(
            `FCC subprocess exited ${code ?? 'without a code'}${errorOutput ? '; stderr was captured and withheld to protect secrets' : ''}.`,
          ),
        );
      else resolve(output.trim());
    });
  });
}

export function localRequest(
  port: number,
  pathname: string,
  method = 'GET',
  headers: Record<string, string> = {},
  timeoutMs = 1500,
  maxBytes = 8192,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (data: Buffer) => {
          body += data.toString();
          if (body.length > maxBytes)
            req.destroy(new Error('Local FCC response exceeded its limit.'));
        });
        res.once('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.once('error', reject);
      },
    );
    const deadline = setTimeout(
      () => req.destroy(new Error('Local FCC request deadline exceeded.')),
      timeoutMs,
    );
    req.once('close', () => clearTimeout(deadline));
    req.once('timeout', () => req.destroy(new Error('Local FCC request timed out.')));
    req.once('error', reject);
    req.end();
  });
}

export function controllerProof(token: string, challenge: string, installId: string): string {
  return createHmac('sha256', token).update(`${challenge}:${installId}`).digest('hex');
}

export async function controllerStatus(record: ControllerRecord): Promise<boolean> {
  const challenge = randomBytes(32).toString('hex');
  try {
    const response = await localRequest(record.controlPort, `/status?challenge=${challenge}`);
    if (response.status !== 200) return false;
    const expected = Buffer.from(controllerProof(record.controlToken, challenge, record.installId));
    const actual = Buffer.from(response.body);
    return actual.length === expected.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function stopController(record: ControllerRecord): Promise<void> {
  if (!(await controllerStatus(record)))
    throw new Error(
      'FCC controller ownership could not be proved; no process was signalled. Inspect or recover the record.',
    );
  const response = await localRequest(
    record.controlPort,
    '/stop',
    'POST',
    { authorization: `Bearer ${record.controlToken}` },
    12_000,
  );
  if (response.status !== 200)
    throw new Error('FCC controller could not confirm shutdown; active record was retained.');
}

export async function launchController(
  plan: ServerPlan,
): Promise<{ record: ControllerRecord; commit(): Promise<void>; abort(): Promise<void> }> {
  const controlToken = randomBytes(32).toString('hex');
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fcc-controller.js', import.meta.url))],
    {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: systemEnvironment(),
    },
  );
  let committed = false;
  const message = await new Promise<ControllerRecord>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.connected) child.disconnect();
      reject(new Error('FCC controller startup timed out.'));
    }, plan.timeoutMs + 5000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('FCC controller could not start.'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      if (!committed) reject(new Error('FCC controller exited before readiness.'));
    });
    child.on('message', (value: { ready?: ControllerRecord; error?: string }) => {
      if (value.ready) {
        clearTimeout(timer);
        resolve(value.ready);
      } else if (value.error) {
        clearTimeout(timer);
        reject(new Error(value.error));
      }
    });
    child.send({ plan, controlToken });
  });
  return {
    record: message,
    async commit() {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('FCC controller activation timed out.')),
          3000,
        );
        child.on('message', (value: { committed?: boolean }) => {
          if (value.committed) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.send({ commit: true }, (error) => {
          if (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
      committed = true;
      child.disconnect();
      child.unref();
    },
    async abort() {
      if (child.connected) child.disconnect();
      child.unref();
      // The controller treats pre-commit IPC closure as an abort, and owns shutdown.
      for (let count = 0; count < 100 && (await controllerStatus(message)); count += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}
