/** Sanitized, operator-authorized native Windows evidence for Antigravity CLI. */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ANTIGRAVITY_ADAPTER,
  ANTIGRAVITY_RESUME_VERSION,
  applyAntigravityHookExport,
  parseAntigravitySessionIdentity,
  parseAntigravityVersion,
} from '../src/providers/antigravity.js';
import {
  HOST_LOCAL_EXECUTION_PROFILE,
  runProviderProcess,
  type ProcessRunResult,
} from '../src/runtime/process-runner.js';

const MAX_TURN_MS = 90_000;
const MAX_TOTAL_MS = 300_000;
const MAX_OUTPUT = 1024 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type FailureCode =
  | 'SETUP_FAILED'
  | 'VERSION_PROBE_FAILED'
  | 'VERSION_MISMATCH'
  | 'INITIAL_PROCESS_FAILED'
  | 'INITIAL_IDENTITY_FAILED'
  | 'INITIAL_ACCEPTANCE_FAILED'
  | 'INITIAL_RECEIPT_FAILED'
  | 'RESUME_PROCESS_FAILED'
  | 'RESUME_IDENTITY_FAILED'
  | 'RESUME_ACCEPTANCE_FAILED'
  | 'RESUME_RECEIPT_FAILED'
  | 'TOTAL_TIMEOUT';
type Observation = {
  hookInstalled: boolean;
  providerVersion: string | null;
  initialIdentityHash: string | null;
  initialAccepted: boolean;
  initialReceipt: boolean;
  resumedSameIdentity: boolean;
  resumeAccepted: boolean;
  resumeReceipt: boolean;
};
type Record = {
  schemaVersion: 1;
  recordedAt: string;
  commit: string;
  provider: { executable: string; version: string | null; model: string };
  runtime: { platform: string; release: string; node: string };
  bounds: { modelInvocations: 2; perInvocationMs: number; totalMs: number; outputBytes: number };
  result: { status: 'pass' | 'fail' | 'blocked'; code: FailureCode | null };
  observations: Observation;
  artifacts: { transcriptStored: false; commandStored: false; privateFixtureRetained: boolean };
  claims: string[];
  limitations: string[];
};
type Options = {
  executable: string;
  model: string;
  commandPrefix?: string[];
  launch?: typeof runProviderProcess;
};

function evidenceRecord(
  status: Record['result']['status'],
  code: FailureCode | null,
  executable: string,
  model: string,
  observations: Observation,
  retained: boolean,
): Record {
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? process.env.VERIFICATION_COMMIT ?? 'local-uncommitted',
    provider: {
      executable: path.basename(executable),
      version: observations.providerVersion,
      model,
    },
    runtime: { platform: process.platform, release: os.release(), node: process.version },
    bounds: {
      modelInvocations: 2,
      perInvocationMs: MAX_TURN_MS,
      totalMs: MAX_TOTAL_MS,
      outputBytes: MAX_OUTPUT,
    },
    result: { status, code },
    observations,
    artifacts: { transcriptStored: false, commandStored: false, privateFixtureRetained: retained },
    claims: [
      'Observed only on native Windows with the stated CLI version.',
      'The managed PostToolUse hook is advisory; provider permissions and sandbox settings were unchanged.',
      'Acceptance requires a fresh fixture challenge, validated hook receipt, and zero process exit status for each turn.',
    ],
    limitations: [
      'No claim of read-only enforcement or native Windows provider sandbox.',
      'Linux, macOS, WSL, other versions, compaction, and normalized usage remain unqualified.',
      'Private fixture and raw provider output are not committed or included.',
    ],
  };
}

function receiptMatches(raw: string, nonce: string, target: string, after: number): boolean {
  const expected = hash(JSON.stringify({ tool: 'view_file', target }));
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(after)
    .some((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return (
          typeof value === 'object' &&
          value !== null &&
          (value as { event?: unknown }).event === 'PostToolUse' &&
          (value as { nonce?: unknown }).nonce === nonce &&
          (value as { operationDigest?: unknown }).operationDigest === expected
        );
      } catch {
        return false;
      }
    });
}
const receiptText = (file: string) => fs.readFile(file, 'utf8').catch(() => '');
async function persistFailure(fixture: string, code: FailureCode) {
  const status = path.join(
    fixture,
    '.latchkit',
    'providers',
    'antigravity',
    'native-evidence-status.json',
  );
  await fs.mkdir(path.dirname(status), { recursive: true });
  await fs.writeFile(status, `${JSON.stringify({ schemaVersion: 1, code }, null, 2)}\n`, {
    mode: 0o600,
  });
}
async function failure(
  fixture: string,
  code: FailureCode,
  executable: string,
  model: string,
  observations: Observation,
) {
  await persistFailure(fixture, code);
  return { fixture, record: evidenceRecord('fail', code, executable, model, observations, true) };
}

export async function runAntigravityNativeEvidence({
  executable,
  model,
  commandPrefix = [],
  launch = runProviderProcess,
}: Options) {
  if (process.platform !== 'win32') throw new Error('This qualification is native Windows only.');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-antigravity-live-'));
  const receipt = path.join(fixture, '.latchkit', 'hook-receipts.ndjson');
  const observed: Observation = {
    hookInstalled: false,
    providerVersion: null,
    initialIdentityHash: null,
    initialAccepted: false,
    initialReceipt: false,
    resumedSameIdentity: false,
    resumeAccepted: false,
    resumeReceipt: false,
  };
  const started = Date.now();
  const execute = (args: string[], environment: { [key: string]: string } = {}) =>
    launch({
      provider: ANTIGRAVITY_ADAPTER.contract,
      plan: { executable, args: [...commandPrefix, ...args], cwd: fixture, environment },
      executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
      timeoutMs: MAX_TURN_MS,
      outputLimitBytes: MAX_OUTPUT,
    });
  const ok = (result: ProcessRunResult) => result.status === 'exited' && result.exitCode === 0;
  const exceeded = () => Date.now() - started > MAX_TOTAL_MS;
  try {
    const version = await execute(['--version']);
    observed.providerVersion = parseAntigravityVersion(version.stdout) ?? null;
    if (!ok(version)) return failure(fixture, 'VERSION_PROBE_FAILED', executable, model, observed);
    if (observed.providerVersion !== ANTIGRAVITY_RESUME_VERSION)
      return failure(fixture, 'VERSION_MISMATCH', executable, model, observed);
    await applyAntigravityHookExport(fixture, { enabled: true });
    observed.hookInstalled = true;
    const first = `marker-${randomUUID()}`;
    const firstFile = path.join(fixture, `challenge-${randomUUID()}.txt`);
    const firstNonce = randomUUID();
    await fs.writeFile(firstFile, `${first}\n`, { mode: 0o400 });
    const initial = await execute(
      [
        '-p',
        `Use the view_file tool to read ${firstFile}, then reply with its exact line only.`,
        '--output-format',
        'json',
        '--model',
        model,
      ],
      { LATCHKIT_ANTIGRAVITY_HOOK_RECEIPT: receipt, LATCHKIT_ANTIGRAVITY_HOOK_NONCE: firstNonce },
    );
    if (!ok(initial))
      return failure(fixture, 'INITIAL_PROCESS_FAILED', executable, model, observed);
    const initialOutput = initial.stdout ?? '';
    const identity = parseAntigravitySessionIdentity(initialOutput, {
      providerVersion: observed.providerVersion,
    });
    if (!identity) return failure(fixture, 'INITIAL_IDENTITY_FAILED', executable, model, observed);
    observed.initialIdentityHash = `sha256:${hash(identity)}`;
    observed.initialAccepted = initialOutput.includes(first);
    if (!observed.initialAccepted)
      return failure(fixture, 'INITIAL_ACCEPTANCE_FAILED', executable, model, observed);
    observed.initialReceipt = receiptMatches(await receiptText(receipt), firstNonce, firstFile, 0);
    if (!observed.initialReceipt)
      return failure(fixture, 'INITIAL_RECEIPT_FAILED', executable, model, observed);
    if (exceeded()) return failure(fixture, 'TOTAL_TIMEOUT', executable, model, observed);
    const beforeResume = (await receiptText(receipt)).trim().split(/\r?\n/).filter(Boolean).length;
    const second = `marker-${randomUUID()}`;
    const secondFile = path.join(fixture, `challenge-${randomUUID()}.txt`);
    const secondNonce = randomUUID();
    await fs.writeFile(secondFile, `${second}\n`, { mode: 0o400 });
    const resumed = await execute(
      [
        '-p',
        `Use the view_file tool to read ${secondFile}, then reply with its exact line only.`,
        '--output-format',
        'json',
        '--model',
        model,
        '--conversation',
        identity,
      ],
      { LATCHKIT_ANTIGRAVITY_HOOK_RECEIPT: receipt, LATCHKIT_ANTIGRAVITY_HOOK_NONCE: secondNonce },
    );
    if (!ok(resumed)) return failure(fixture, 'RESUME_PROCESS_FAILED', executable, model, observed);
    const resumedOutput = resumed.stdout ?? '';
    observed.resumedSameIdentity =
      parseAntigravitySessionIdentity(resumedOutput, {
        providerVersion: observed.providerVersion,
        expectedSessionId: identity,
      }) === identity;
    if (!observed.resumedSameIdentity)
      return failure(fixture, 'RESUME_IDENTITY_FAILED', executable, model, observed);
    observed.resumeAccepted = resumedOutput.includes(second);
    if (!observed.resumeAccepted)
      return failure(fixture, 'RESUME_ACCEPTANCE_FAILED', executable, model, observed);
    observed.resumeReceipt = receiptMatches(
      await receiptText(receipt),
      secondNonce,
      secondFile,
      beforeResume,
    );
    if (!observed.resumeReceipt)
      return failure(fixture, 'RESUME_RECEIPT_FAILED', executable, model, observed);
    if (exceeded()) return failure(fixture, 'TOTAL_TIMEOUT', executable, model, observed);
    return { fixture, record: evidenceRecord('pass', null, executable, model, observed, true) };
  } catch {
    await persistFailure(fixture, 'SETUP_FAILED');
    return {
      fixture,
      record: evidenceRecord('blocked', 'SETUP_FAILED', executable, model, observed, true),
    };
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      authorized: { type: 'boolean' },
      executable: { type: 'string' },
      model: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!values.authorized || !values.executable || !values.model || !values.output)
    throw new Error(
      'Usage: --authorized --executable <agy> --model <listed model> --output <report>',
    );
  const outcome = await runAntigravityNativeEvidence({
    executable: values.executable,
    model: values.model,
  });
  const output = path.resolve(values.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  if (outcome.record.result.status === 'pass') {
    await fs.rm(outcome.fixture, { recursive: true, force: true });
    outcome.record.artifacts.privateFixtureRetained = false;
  }
  await fs.writeFile(output, `${JSON.stringify(outcome.record, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: outcome.record.result.status, output }));
  if (outcome.record.result.status !== 'pass') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Antigravity native evidence failed.');
    process.exitCode = 1;
  });
