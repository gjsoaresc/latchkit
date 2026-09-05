#!/usr/bin/env node
/**
 * Provider verification is deliberately separate from the test runner.  Its
 * fixture mode proves Latchkit's joins without an installed provider; live
 * mode is an operator-authorized, bounded smoke, never a CI default.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { redact } from '../src/diagnostics/redact.js';
import { CLAUDE_ADAPTER } from '../src/providers/claude.js';
import { codexAdapter } from '../src/providers/codex.js';
import { cursorCliAdapter } from '../src/providers/cursor-cli.js';
import { cursorIdeAdapter } from '../src/providers/cursor-ide.js';
import { createGeminiAdapter } from '../src/providers/gemini.js';
import { HOST_LOCAL_EXECUTION_PROFILE, runProviderProcess } from '../src/runtime/process-runner.js';

export const EVIDENCE_SCHEMA_VERSION = 1;
export const PROVIDER_IDS = Object.freeze(['claude', 'codex', 'gemini', 'cursor', 'cursor-cli']);
const adapters = new Map([
  ['claude', CLAUDE_ADAPTER],
  ['codex', codexAdapter],
  ['gemini', createGeminiAdapter()],
  ['cursor', cursorIdeAdapter],
  ['cursor-cli', cursorCliAdapter],
]);
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const timestamp = () => new Date().toISOString();

function reasonStatus(result) {
  if (!result) return ['blocked', 'No result was returned.'];
  if (result.status === 'exited' && result.exitCode === 0)
    return ['pass', 'Bounded command exited 0.'];
  if (result.status === 'cancelled' || result.status === 'timed-out')
    return ['blocked', `Execution ${result.status}.`];
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (/login|sign[ -]?in|authenti[ck]|approval|permission/i.test(text))
    return ['blocked', 'Provider requested login, approval, or permission.'];
  return ['fail', `Provider process ended as ${result.status ?? 'unknown'}.`];
}

function baseRecord({ providerId, mode, version, fixture, timeoutMs, maxTurns, maxRetries }) {
  const adapter = adapters.get(providerId);
  if (!adapter) throw new Error(`Unknown provider: ${providerId}.`);
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    testedAt: timestamp(),
    commit: process.env.GITHUB_SHA ?? process.env.VERIFICATION_COMMIT ?? 'local-uncommitted',
    provider: providerId,
    providerVersion: version,
    runtime: { platform: process.platform, release: os.release(), node: process.version },
    mode,
    fixture,
    bounds: { timeoutMs, maxTurns, maxRetries },
    configurationHash: digest(JSON.stringify(adapter.contract)),
    result: { status: 'unknown', reason: 'Not run.' },
    usage: { state: 'unknown', value: null },
    artifacts: { transcriptStored: false, commandStored: false },
  };
}

/** Run a fake/fixture result or a single operator-authorized provider command.
 * The returned record intentionally excludes command arguments and output. */
export async function runVerification(options, { launch = runProviderProcess } = {}) {
  const {
    providerId,
    mode = 'fixture',
    version = 'documented-fixture',
    fixture = 'default',
    timeoutMs = 30_000,
    maxTurns = 1,
    maxRetries = 0,
    authorized = false,
    signal,
    fakeResult,
  } = options;
  if (!PROVIDER_IDS.includes(providerId)) throw new Error('A known provider is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error('timeoutMs must be between 1 and 120000.');
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 3)
    throw new Error('maxTurns must be between 1 and 3.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2)
    throw new Error('maxRetries must be between 0 and 2.');
  const record = baseRecord({
    providerId,
    mode,
    version,
    fixture,
    timeoutMs,
    maxTurns,
    maxRetries,
  });
  const adapter = adapters.get(providerId);
  if (mode === 'fixture') {
    const plan = adapter.operations.planInvocation({ prompt: 'Latchkit fixture verification.' });
    record.result = {
      status: plan?.executable ? 'pass' : 'unsupported',
      reason: plan?.executable
        ? 'Credential-free adapter plan and contract fixture validated.'
        : 'This adapter has no executable invocation contract.',
    };
    return redact(record);
  }
  if (mode !== 'live') throw new Error('mode must be fixture or live.');
  if (!authorized) throw new Error('Live verification requires --authorized.');
  const plan = adapter.operations.planInvocation({ prompt: 'Reply only: Latchkit verification.' });
  if (!plan?.executable) {
    record.result = { status: 'unsupported', reason: 'Provider has no CLI invocation plan.' };
    return redact(record);
  }
  const raw =
    fakeResult ??
    (await launch({
      provider: adapter.contract,
      plan,
      executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
      timeoutMs,
      signal,
    }));
  const [status, reason] = reasonStatus(raw);
  record.result = {
    status,
    reason,
    resultId: digest(JSON.stringify({ status: raw?.status, exitCode: raw?.exitCode })),
  };
  return redact(record);
}

export async function writeEvidence(record, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return destination;
}

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      mode: { type: 'string' },
      version: { type: 'string' },
      fixture: { type: 'string' },
      timeout: { type: 'string' },
      turns: { type: 'string' },
      retries: { type: 'string' },
      output: { type: 'string' },
      authorized: { type: 'boolean' },
    },
  });
  if (!values.provider)
    throw new Error('Usage: npm run verify:providers -- --provider <id> [--mode fixture|live]');
  const record = await runVerification({
    providerId: values.provider,
    mode: values.mode,
    version: values.version,
    fixture: values.fixture,
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    maxTurns: values.turns ? Number(values.turns) : undefined,
    maxRetries: values.retries ? Number(values.retries) : undefined,
    authorized: values.authorized,
  });
  if (values.output) await writeEvidence(record, path.resolve(values.output));
  console.log(JSON.stringify(record, null, 2));
  if (record.mode === 'live' && record.result.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`Provider verification: ${error.message}`);
    process.exitCode = 1;
  });
