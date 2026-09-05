import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../diagnostics/redact.js';
import { SKILL_EVALUATION_VERSION, validateEvaluationSpec } from './contracts.js';

const safe = (relative) => {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes('..')
  )
    throw new TypeError('Evaluation paths must be safe relative paths.');
  return relative;
};
const present = async (root, relative) => {
  try {
    return (await stat(path.join(root, safe(relative)))).isFile();
  } catch {
    return false;
  }
};
const boundedText = (value) => String(value ?? '').slice(0, 16 * 1024);

function score(spec, run, workspace) {
  const checks = [];
  const expect = spec.expectations;
  for (const file of expect.requiredFiles ?? [])
    checks.push({ check: `required-file:${file}`, passed: false, actual: 'missing', file });
  for (const file of expect.forbiddenFiles ?? [])
    checks.push({ check: `forbidden-file:${file}`, passed: false, actual: 'present', file });
  for (const item of expect.requiredContent ?? [])
    checks.push({
      check: `required-content:${item.path}`,
      passed: false,
      actual: 'missing',
      file: item.path,
      includes: item.includes,
    });
  return Promise.all(
    checks.map(async (check) => {
      const exists = await present(workspace, check.file);
      if (check.check.startsWith('required-content')) {
        const content = exists ? await readFile(path.join(workspace, check.file), 'utf8') : '';
        check.passed = content.includes(check.includes);
        check.actual = exists ? (check.passed ? 'matched' : 'mismatch') : 'missing';
        delete check.includes;
      } else {
        check.passed = check.check.startsWith('required') ? exists : !exists;
        check.actual = exists ? 'present' : 'missing';
      }
      delete check.file;
      return check;
    }),
  ).then(async (fileChecks) => {
    const all = [...fileChecks];
    if (expect.execution?.required) {
      const passed = run.execution?.status === 'exited' && run.execution.exitCode === 0;
      all.push({ check: 'execution-evidence', passed, actual: run.execution?.status ?? 'absent' });
    }
    if (expect.evidence?.required) {
      const passed =
        Array.isArray(run.taskEvidence) &&
        run.taskEvidence.some((item) => item.outcome === 'passed');
      all.push({
        check: 'task-evidence',
        passed,
        actual: passed ? 'passing' : 'absent-or-nonpassing',
      });
    }
    if (expect.response?.required) {
      const passed = typeof run.response === 'string' && run.response.trim().length > 0;
      all.push({ check: 'response', passed, actual: passed ? 'present' : 'absent' });
    }
    return all;
  });
}

/**
 * Evaluate a single run in a fresh copy of an original fixture. `execute` is
 * deliberately injected: default CI never starts a provider or spends tokens.
 */
export async function evaluateScenario({
  spec,
  fixturesRoot,
  execute,
  timeoutMs = 30_000,
  now = () => new Date().toISOString(),
}) {
  const scenario = validateEvaluationSpec(spec);
  if (typeof execute !== 'function')
    throw new TypeError('evaluateScenario requires an execute function.');
  const source = path.resolve(fixturesRoot, safe(scenario.fixture));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'latchkit-evaluation-'));
  try {
    await cp(source, workspace, { recursive: true, force: false, errorOnExist: false });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
      throw new TypeError('timeoutMs must be positive.');
    const controller = new AbortController();
    let timer;
    const run =
      (await Promise.race([
        Promise.resolve(
          execute({
            workspace,
            instructions: scenario.instructions,
            scenario,
            signal: controller.signal,
          }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({
              execution: { status: 'timed-out' },
              response: 'Evaluation execution timed out.',
            });
          }, timeoutMs);
        }),
      ])) ?? {};
    clearTimeout(timer);
    if (run.skip)
      return {
        id: scenario.id,
        kind: scenario.kind,
        status: 'skipped',
        reason: boundedText(redact(run.skip)),
        checks: [],
        execution: redact(run.execution ?? null),
        taskEvidence: [],
        response: boundedText(redact(run.response ?? '')),
        completedAt: now(),
      };
    const checks = await score(scenario, run, workspace);
    return {
      id: scenario.id,
      kind: scenario.kind,
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      checks,
      execution: redact(run.execution ?? null),
      taskEvidence: redact(run.taskEvidence ?? []),
      response: boundedText(redact(run.response ?? '')),
      completedAt: now(),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function evaluateSuite({
  specs,
  fixturesRoot,
  execute,
  metadata = {},
  now,
  timeoutMs,
} = {}) {
  if (!Array.isArray(specs) || !specs.length)
    throw new TypeError('Evaluation suite needs at least one scenario.');
  const scenarios = [];
  for (const spec of [...specs].sort((left, right) => left.id.localeCompare(right.id)))
    scenarios.push(await evaluateScenario({ spec, fixturesRoot, execute, now, timeoutMs }));
  const counts = Object.fromEntries(
    ['passed', 'failed', 'skipped'].map((status) => [
      status,
      scenarios.filter((item) => item.status === status).length,
    ]),
  );
  return {
    schemaVersion: SKILL_EVALUATION_VERSION,
    generatedAt: now ? now() : new Date().toISOString(),
    metadata: redact(metadata),
    counts,
    scenarios,
  };
}

export async function loadEvaluationSpecs(directory) {
  const index = JSON.parse(await readFile(path.join(directory, 'scenarios.json'), 'utf8'));
  if (!Array.isArray(index)) throw new TypeError('scenarios.json must be an array.');
  return index.map(validateEvaluationSpec);
}

export function renderEvaluationMarkdown(result) {
  const lines = [
    '# Latchkit skill evaluation',
    '',
    `Generated: ${result.generatedAt}`,
    '',
    '| Scenario | Kind | Result |',
    '| --- | --- | --- |',
    ...result.scenarios.map((item) => `| ${item.id} | ${item.kind} | ${item.status} |`),
    '',
    `Passed: ${result.counts.passed}; failed: ${result.counts.failed}; skipped: ${result.counts.skipped}.`,
  ];
  return `${lines.join('\n')}\n`;
}
