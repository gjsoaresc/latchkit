import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import {
  ProviderContractError,
  validateCommandPlan,
  validateProviderContract,
} from '../providers/contracts.js';

export const HOST_LOCAL_EXECUTION_PROFILE = 'host-local-authorized';
export const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const DEFAULT_GRACE_PERIOD_MS = 1_000;

const supportedInvocation = new Set(['supported', 'partial']);
const isWindowsShim = (executable: string) => /\.(cmd|bat)$/i.test(executable);

type CommandPlan = {
  executable: string;
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
};

type ProcessCause = 'timeout' | 'cancelled' | 'output-limit';

export type RunProviderProcessOptions = {
  provider?: unknown;
  plan?: unknown;
  executionProfile?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  outputLimitBytes?: number;
  gracePeriodMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: {
    type: 'process-start';
    pid: number | undefined;
    launch: ReturnType<typeof redactLaunchMetadata>;
  }) => void;
};

export type ProcessRunResult = {
  status: 'refused' | 'spawn-failed' | 'timed-out' | 'cancelled' | 'output-limit' | 'exited';
  code?: string;
  reason?: string;
  message?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  outputBytes?: number;
  sessionId?: string;
};

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Do not expose arguments, environment, or stdin through diagnostic hooks. */
export function redactLaunchMetadata(plan: CommandPlan) {
  return {
    executable: path.basename(plan.executable),
    argumentCount: plan.args.length,
    hasWorkingDirectory: Boolean(plan.cwd),
    hasEnvironmentOverrides: Boolean(plan.environment && Object.keys(plan.environment).length),
  };
}

/** Quote one CMD token. This is intentionally only used for a .cmd/.bat shim;
 * native executables always receive an argument vector directly. */
export function quoteWindowsCommandArgument(value: string) {
  if (typeof value !== 'string') throw new TypeError('Expected a string command argument.');
  // Tokens stay quoted; delayed expansion is disabled. Percent signs are caret
  // escaped so environment expansion cannot turn untrusted input into another
  // command. Quote characters are escaped for CMD's command-string parser.
  return `"${value.replace(/%/g, '^%').replace(/"/g, '^"')}"`;
}

function spawnArguments(plan: CommandPlan) {
  if (process.platform !== 'win32' || !isWindowsShim(plan.executable))
    return { executable: plan.executable, args: plan.args };
  const command = `"${[plan.executable, ...plan.args].map(quoteWindowsCommandArgument).join(' ')}"`;
  return {
    executable: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', command],
  };
}

function validPositiveInteger(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw new TypeError(`Expected positive ${name}.`);
}

function result(
  status: ProcessRunResult['status'],
  fields: Omit<ProcessRunResult, 'status'> = {},
): ProcessRunResult {
  return { status, ...fields };
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams, force: boolean) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn(
        'taskkill.exe',
        ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])],
        {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        },
      );
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}

/**
 * Start an already-authorized, contract-backed provider command. This function
 * never discovers executables, changes process.env, enables a shell for native
 * commands, or claims that host-local execution inherits provider sandboxing.
 */
export async function runProviderProcess({
  provider,
  plan,
  executionProfile,
  input,
  timeoutMs,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  signal,
  onEvent,
}: RunProviderProcessOptions = {}): Promise<ProcessRunResult> {
  const contract = validateProviderContract(provider);
  const command = validateCommandPlan(plan) as CommandPlan;
  validPositiveInteger(outputLimitBytes, 'output limit');
  validPositiveInteger(gracePeriodMs, 'grace period');
  if (timeoutMs !== undefined) validPositiveInteger(timeoutMs, 'timeout');
  if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input))
    throw new TypeError('Expected stdin input to be a string or Buffer.');
  if (onEvent !== undefined && typeof onEvent !== 'function')
    throw new TypeError('Expected onEvent to be a function.');

  if (executionProfile !== HOST_LOCAL_EXECUTION_PROFILE)
    return result('refused', {
      code: 'EXECUTION_PROFILE_UNAVAILABLE',
      reason: 'Host-local execution requires explicit authorization and is not provider-sandboxed.',
    });
  if (!supportedInvocation.has(contract.capabilities.invocation.state))
    return result('refused', {
      code: 'INVOCATION_CAPABILITY_UNAVAILABLE',
      reason: contract.capabilities.invocation.reason,
    });

  const launched = spawnArguments(command);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launched.executable, launched.args, {
      cwd: command.cwd,
      env: command.environment ? { ...process.env, ...command.environment } : process.env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: process.platform === 'win32' && isWindowsShim(command.executable),
      windowsHide: true,
    });
    // The PID is process-local ownership evidence, not a session identifier.
    // Callers may persist it for diagnostics but must not adopt it after restart.
    onEvent?.({ type: 'process-start', pid: child.pid, launch: redactLaunchMetadata(command) });
  } catch (error) {
    return result('spawn-failed', {
      code: errorCode(error) ?? 'SPAWN_FAILED',
      message: errorMessage(error),
    });
  }

  return new Promise((resolve) => {
    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let retainedBytes = 0;
    let outputTruncated = false;
    let cause: ProcessCause | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const finish = (value: ProcessRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      resolve(value);
    };
    const append = (name: 'stdout' | 'stderr', decoder: TextDecoder, chunk: Buffer) => {
      bytes += chunk.length;
      const remaining = outputLimitBytes - retainedBytes;
      if (remaining > 0) {
        const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        retainedBytes += retained.length;
        if (name === 'stdout') stdout += decoder.decode(retained, { stream: true });
        else stderr += decoder.decode(retained, { stream: true });
      }
      if (bytes > outputLimitBytes) {
        outputTruncated = true;
        if (!cause) cancel('output-limit');
      }
    };
    const cancel = (why: ProcessCause) => {
      if (cause || settled) return;
      cause = why;
      void terminateProcessTree(child, false);
      escalation = setTimeout(() => void terminateProcessTree(child, true), gracePeriodMs);
    };
    child.stdout.on('data', (chunk) => append('stdout', stdoutDecoder, chunk));
    child.stderr.on('data', (chunk) => append('stderr', stderrDecoder, chunk));
    child.once('error', (error) =>
      finish(
        result('spawn-failed', {
          code: errorCode(error) ?? 'SPAWN_FAILED',
          message: errorMessage(error),
        }),
      ),
    );
    child.once('close', (exitCode, exitSignal) => {
      // If the shared byte ceiling split a UTF-8 sequence, discard the
      // decoder's incomplete suffix instead of manufacturing U+FFFD. Complete
      // decoded text has already been emitted by the streaming decoder.
      if (!outputTruncated) {
        stdout += stdoutDecoder.decode();
        stderr += stderrDecoder.decode();
      }
      const terminal =
        cause === 'timeout'
          ? 'timed-out'
          : cause === 'cancelled'
            ? 'cancelled'
            : cause === 'output-limit'
              ? 'output-limit'
              : 'exited';
      finish(
        result(terminal, { exitCode, signal: exitSignal, stdout, stderr, outputBytes: bytes }),
      );
    });
    if (timeoutMs) timeout = setTimeout(() => cancel('timeout'), timeoutMs);
    if (signal) {
      if (signal.aborted) cancel('cancelled');
      else {
        abortListener = () => cancel('cancelled');
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export { ProviderContractError };
