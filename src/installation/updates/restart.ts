/**
 * Bounded restart handoff (issue #139 slice 2, acceptance criterion 5).
 *
 * The running server's `server.close()` cancels its own owned workflows, so
 * it is not a safe restart strategy by itself. Instead, this module spawns
 * a *replacement* server process directly from the staged, already
 * verified-and-smoked immutable version directory — using that version's
 * own bundled runtime and CLI, exactly the same "trusted local bundled
 * runtime/launcher" `src/installation/manager.ts`'s own `smoke()` already
 * spawns during staging/activation — waits for it to report its real
 * listening endpoint and confirms it is actually running the expected
 * version, before the caller (see `handoff.ts`) touches `current` or closes
 * the old server. The replacement never depends on `current` or the
 * managed launchers: it is launched directly against its own version
 * directory, so a failure here can never leave `current` pointed at an
 * unverified version.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { errorMessage } from '../../types.js';

export class RestartHandoffError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RestartHandoffError';
    this.code = code;
  }
}

export interface SpawnReplacementOptions {
  stagedDirectory: string;
  target: string;
  projectRoot: string;
  installRoot: string;
  /** Bounded wait for the replacement to print its own listening endpoint.
   * Defaults to 20s — generous for a local Node process start, still a hard
   * bound so a hung replacement can never hang the handoff indefinitely. */
  readyTimeoutMs?: number;
  /** Injectable for deterministic fixtures: a test can point this at a
   * small fixture script instead of a real bundled runtime/CLI. */
  spawnImpl?: typeof spawn;
  extraEnv?: Record<string, string>;
}

export interface ReplacementServer {
  child: ChildProcess;
  url: string;
  port: number;
  token: string;
}

const SESSION_URL = /(https?:\/\/127\.0\.0\.1:(\d+)\/#([a-f0-9]{64}))/;

/** Spawn the replacement and resolve once it has printed its real session
 * URL (the same line `latchkit ui` always prints — see `src/cli.ts`), or
 * reject on a spawn error, an early exit, or the bounded timeout. Never
 * resolves on anything less than an actual parsed `http://127.0.0.1:<port>/#<token>`
 * line, so a partially-started or misbehaving replacement can never be
 * mistaken for a ready one. */
export async function spawnReplacementServer(
  options: SpawnReplacementOptions,
): Promise<ReplacementServer> {
  const node = path.join(
    options.stagedDirectory,
    'runtime',
    options.target.startsWith('win32-') ? 'node.exe' : 'node',
  );
  const cli = path.join(options.stagedDirectory, 'app', 'dist', 'src', 'cli.js');
  const spawnFn = options.spawnImpl ?? spawn;
  const child = spawnFn(node, [cli, 'ui', '--project', options.projectRoot, '--port', '0'], {
    cwd: path.join(options.stagedDirectory, 'app'),
    env: {
      ...process.env,
      ...options.extraEnv,
      LATCHKIT_INSTALL_ROOT: options.installRoot,
      // The replacement's own `defaultInstallationRoot()` (src/installation/manager.js) must
      // resolve to this exact installation root, not whatever isolated default a test process
      // set for itself — see manager.ts's `LATCHKIT_INSTALL_DATA_ROOT` override.
      LATCHKIT_INSTALL_DATA_ROOT: options.installRoot,
    },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<ReplacementServer>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new RestartHandoffError(
          `The replacement did not report a listening session within ${String(options.readyTimeoutMs ?? 20_000)}ms.`,
          'UPDATE_RESTART_TIMEOUT',
        ),
      );
    }, options.readyTimeoutMs ?? 20_000);
    const finish = (error: unknown, value?: ReplacementServer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      if (error) reject(error as Error);
      else resolve(value!);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = SESSION_URL.exec(stdout);
      if (match) finish(null, { child, url: match[1]!, port: Number(match[2]), token: match[3]! });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      finish(
        new RestartHandoffError(
          `The replacement process failed to start: ${errorMessage(error)}`,
          'UPDATE_RESTART_SPAWN_FAILED',
        ),
      );
    });
    child.once('exit', (code, signal) => {
      finish(
        new RestartHandoffError(
          `The replacement process exited before it was ready (code ${String(code)}, signal ${String(signal)}). ${stderr.trim().slice(-2000)}`,
          'UPDATE_RESTART_EXITED_EARLY',
        ),
      );
    });
  });
}

export interface VerifyReplacementOptions {
  fetchImpl?: typeof fetch;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}

/**
 * Confirm the replacement is actually serving the expected version through
 * its own authenticated status route before the caller ever touches
 * `current` — never trusts the spawned process's mere existence. A few
 * bounded, short retries absorb the small window between the process
 * printing its URL and its HTTP server accepting the very first request.
 */
export async function verifyReplacementVersion(
  server: ReplacementServer,
  expectedVersion: string,
  options: VerifyReplacementOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
      let response: Response;
      try {
        response = await fetchImpl(`${server.url.split('#')[0]}api/updates`, {
          headers: { Authorization: `Bearer ${server.token}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok)
        throw new Error(`Replacement status check failed with status ${response.status}.`);
      const data = (await response.json()) as { status?: { installedVersion?: unknown } };
      const installedVersion = data.status?.installedVersion;
      if (installedVersion !== expectedVersion)
        throw new RestartHandoffError(
          `The replacement reported version "${String(installedVersion)}", expected "${expectedVersion}".`,
          'UPDATE_RESTART_VERSION_MISMATCH',
        );
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof RestartHandoffError) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new RestartHandoffError(
    `Could not verify the replacement's running version: ${errorMessage(lastError)}`,
    'UPDATE_RESTART_VERIFY_FAILED',
  );
}

/** Best-effort termination of a replacement that failed a later check
 * (e.g. version mismatch) so a half-verified process is never left
 * running unabandoned. */
export function killReplacement(server: ReplacementServer): void {
  try {
    server.child.kill();
  } catch {
    /* Already exited. */
  }
}

/** Let the replacement continue running independently of this process once
 * the handoff has fully succeeded. */
export function detachReplacement(server: ReplacementServer): void {
  server.child.unref();
}
