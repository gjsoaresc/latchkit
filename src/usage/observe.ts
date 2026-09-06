import { validateCommandPlan } from '../providers/contracts.js';
import type { ProcessRunResult, RunProviderProcessOptions } from '../runtime/process-runner.js';
import { isRecord } from '../types.js';
import { recordProviderUsage } from './service.js';
import { readUsageState } from './store.js';

type Launch = (input?: RunProviderProcessOptions) => Promise<ProcessRunResult>;
const supported = new Set(['claude', 'codex']);
const VERSION_TIMEOUT_MS = 5000;
const VERSION_OUTPUT_BYTES = 4096;

/** The workflow review wrapper may forward only this bounded, prompt-free probe
 * without adding inference permission flags. Extra arguments never qualify. */
export function isUsageVersionProbe(input: RunProviderProcessOptions): boolean {
  if (!isRecord(input.provider) || !supported.has(String(input.provider.id))) return false;
  try {
    const plan = validateCommandPlan(input.plan);
    return (
      input.executionProfile === 'host-local-authorized' &&
      input.input === undefined &&
      plan.args.length === 1 &&
      plan.args[0] === '--version' &&
      Number.isInteger(input.timeoutMs) &&
      (input.timeoutMs ?? 0) > 0 &&
      (input.timeoutMs ?? Infinity) <= VERSION_TIMEOUT_MS &&
      Number.isInteger(input.outputLimitBytes) &&
      (input.outputLimitBytes ?? 0) > 0 &&
      (input.outputLimitBytes ?? Infinity) <= VERSION_OUTPUT_BYTES
    );
  } catch {
    return false;
  }
}

function sessionIdentity(providerId: string, result: ProcessRunResult): string | null {
  if (typeof result.sessionId === 'string') return result.sessionId;
  const stdout = result.stdout ?? '';
  if (Buffer.byteLength(stdout, 'utf8') > 1024 * 1024) return null;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) continue;
      if (
        providerId === 'claude' &&
        event.type === 'result' &&
        typeof event.session_id === 'string'
      )
        return event.session_id;
      if (
        providerId === 'codex' &&
        event.type === 'thread.started' &&
        typeof event.thread_id === 'string'
      )
        return event.thread_id;
    } catch {
      /* Provider text is optional untrusted evidence. */
    }
  }
  return null;
}

/** Observe one explicit inference invocation, never arbitrary commands. The caller
 * owns authorization, execution bounds, and provider policy. Usage is advisory. */
export async function observeProviderInvocation({
  root,
  providerId,
  taskId,
  invocationId,
  launch,
  input,
  clock = () => new Date(),
}: {
  root: string;
  providerId: string;
  taskId: string;
  invocationId: string;
  launch: Launch;
  input: RunProviderProcessOptions;
  clock?: () => Date;
}): Promise<ProcessRunResult> {
  const enabled =
    supported.has(providerId) &&
    isRecord(input.provider) &&
    input.provider.id === providerId &&
    input.executionProfile === 'host-local-authorized' &&
    (await readUsageState(root, { clock })
      .then((state) => state.settings.enabled)
      .catch(() => false));
  if (!enabled) return launch(input);
  let providerVersion: string | null = null;
  if (!input.signal?.aborted) {
    try {
      const plan = validateCommandPlan(input.plan);
      const version = await launch({
        provider: input.provider,
        plan: { ...plan, args: ['--version'] },
        executionProfile: input.executionProfile,
        ...(input.environmentMode ? { environmentMode: input.environmentMode } : {}),
        timeoutMs: Math.min(input.timeoutMs ?? VERSION_TIMEOUT_MS, VERSION_TIMEOUT_MS),
        outputLimitBytes: Math.min(
          input.outputLimitBytes ?? VERSION_OUTPUT_BYTES,
          VERSION_OUTPUT_BYTES,
        ),
        signal: input.signal,
      });
      if (
        version.status === 'exited' &&
        version.exitCode === 0 &&
        Buffer.byteLength(version.stdout ?? '', 'utf8') <= VERSION_OUTPUT_BYTES
      )
        providerVersion =
          version.stdout
            ?.trim()
            .match(
              /^(?:(?:codex(?:-cli)?|claude)\s+)?v?(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/i,
            )?.[1] ?? null;
    } catch {
      /* Unknown version stays unavailable; it cannot fail the workflow. */
    }
  }
  if (input.signal?.aborted) return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
  const record = async (result: ProcessRunResult) => {
    await recordProviderUsage(
      root,
      {
        provider: providerId,
        providerVersion,
        taskId,
        sourceEventId: invocationId,
        sessionId: sessionIdentity(providerId, result),
        output: result.stdout ?? '',
        observedAt: clock().toISOString(),
      },
      { clock },
    ).catch(() => {});
  };
  let result: ProcessRunResult;
  try {
    result = await launch(input);
  } catch (error) {
    await record({ status: 'spawn-failed' });
    throw error;
  }
  await record(result);
  return result;
}
