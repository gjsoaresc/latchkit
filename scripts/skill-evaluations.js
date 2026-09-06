import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  evaluateSuite,
  loadEvaluationSpecs,
  renderEvaluationMarkdown,
} from '../dist/src/evaluations/runner.js';
import { CLAUDE_ADAPTER } from '../dist/src/providers/claude.js';
import { codexAdapter } from '../dist/src/providers/codex.js';
import {
  runProviderProcess,
  HOST_LOCAL_EXECUTION_PROFILE,
} from '../dist/src/runtime/process-runner.js';

const root = path.resolve('test/fixtures/skill-evaluations');
const { values } = parseArgs({
  options: {
    format: { type: 'string', default: 'json' },
    output: { type: 'string' },
    real: { type: 'boolean' },
    authorized: { type: 'boolean' },
    provider: { type: 'string' },
    mode: { type: 'string', default: 'skills' },
    'max-runs': { type: 'string', default: '8' },
    timeout: { type: 'string', default: '60000' },
  },
});
if (!['json', 'markdown'].includes(values.format))
  throw new Error('--format must be json or markdown.');
if (!['baseline', 'skills'].includes(values.mode))
  throw new Error('--mode must be baseline or skills.');
const maxRuns = Number(values['max-runs']);
const timeoutMs = Number(values.timeout);
if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 20)
  throw new Error('--max-runs must be 1 through 20.');
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
  throw new Error('--timeout must be 1 through 600000 milliseconds.');

const specs = (await loadEvaluationSpecs(root)).slice(0, maxRuns);
const adapters = new Map([
  ['claude', CLAUDE_ADAPTER],
  ['codex', codexAdapter],
]);
const simulated = async ({ workspace, scenario }) => {
  for (const file of scenario.expectations.requiredFiles ?? [])
    await writeFile(path.join(workspace, file), `fixture outcome for ${scenario.id}\n`);
  for (const item of scenario.expectations.requiredContent ?? [])
    await writeFile(path.join(workspace, item.path), item.includes);
  return {
    execution: scenario.expectations.execution?.required
      ? { status: 'exited', exitCode: 0 }
      : undefined,
    taskEvidence: scenario.expectations.evidence?.required ? [{ outcome: 'passed' }] : [],
    response: 'Fixture executor recorded an observable outcome.',
  };
};
const live = async ({ workspace, instructions }) => {
  const adapter = adapters.get(values.provider);
  if (!adapter)
    return {
      skip: `Unsupported provider ${values.provider ?? 'none'}; no provider process was started.`,
    };
  const prompt = `${instructions}\nWork only in the current workspace. Report actual commands and results.`;
  const plan = adapter.operations.planInvocation({ prompt, cwd: workspace });
  const execution = await runProviderProcess({
    provider: adapter.contract,
    plan,
    executionProfile: HOST_LOCAL_EXECUTION_PROFILE,
    timeoutMs,
  });
  return { execution, response: execution.stdout ?? execution.stderr ?? '' };
};
if (values.real && !values.authorized)
  throw new Error(
    'Live evaluation requires explicit --authorized; it may use provider credentials and incur cost.',
  );
const result = await evaluateSuite({
  specs,
  fixturesRoot: root,
  execute: values.real ? live : simulated,
  metadata: {
    runner: values.real ? 'provider-live' : 'offline-fixture',
    provider: values.real ? (values.provider ?? 'missing') : 'none',
    comparisonMode: values.mode,
    maxRuns,
    timeoutMs,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    limitations: values.real
      ? 'A provider exit is not task acceptance; missing task evidence fails the scenario.'
      : 'Offline fixture executor validates harness behavior only and is not a provider-quality result.',
  },
  timeoutMs,
});
const output =
  values.format === 'markdown'
    ? renderEvaluationMarkdown(result)
    : `${JSON.stringify(result, null, 2)}\n`;
if (values.output) {
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(path.resolve(values.output), output);
} else process.stdout.write(output);
