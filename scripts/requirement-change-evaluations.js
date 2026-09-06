// Single documented, Windows-compatible command for issue #116: runs the
// offline requirement-change evaluation scenarios and emits sanitized,
// machine-readable results through the current evaluation contracts
// (schemas/skill-evaluation-v2.schema.json and
// skill-evaluation-result-v2.schema.json).
//
// The baseline arm always uses each fixture's own bundled, deterministic
// scripted controller (apply-change.mjs) — never a live model or provider
// call, so this command never spends on a provider session. The
// reconciliation arm exercises merged #110-#112 task-record, reconciliation,
// and context-brief APIs in a separate fixture copy. It passes the real bounded
// brief to the next scripted controller, but never starts a provider or claims
// that a provider consumed it. A future increment can drive the SAME API with a
// model-driven `applyChange`/`runAcceptance` pair; the result schema already
// distinguishes `controller: "scripted"` from `controller: "model"`, but no
// such run is authorized or executed by this command.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import {
  loadRequirementChangeSpecs,
  renderRequirementChangeMarkdown,
  runRequirementChangeSuite,
} from '../dist/src/evaluations/runner.js';

const root = path.resolve('test/fixtures/skill-evaluations');
const { values } = parseArgs({
  options: {
    format: { type: 'string', default: 'json' },
    output: { type: 'string' },
  },
});
if (!['json', 'markdown'].includes(values.format))
  throw new Error('--format must be json or markdown.');

const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
const execFileAsync = promisify(execFile);
const sourceRevision = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve('.') })
  .then(({ stdout }) => stdout.trim())
  .catch(() => 'unavailable');
const specs = await loadRequirementChangeSpecs(root);
const result = await runRequirementChangeSuite({
  specs,
  fixturesRoot: root,
  metadata: {
    generator: 'requirement-change-evaluations',
    latchkitVersion: packageJson.version,
    sourceRevision,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    baselineController: 'scripted',
    baselineConfiguration: 'fixture scripted controller v1',
    reconciliationController: 'scripted',
    reconciliationConfiguration:
      'task-record/reconcile/context-brief API integration v1 (#110-#112)',
    reconciliationStatus:
      'completed with merged #110-#112 APIs; context brief handed to scripted controller only',
    limitations:
      'The scripted-controller baseline is a deterministic fixed patch used to validate the ' +
      'harness and its correctness gate end to end offline; it is not a claim about live agent ' +
      'or human behavior on ordinary current Latchkit. totalElapsedTimeMs includes the whole ' +
      'harness arm and controllerElapsedTimeMs isolates the injected controller call; neither ' +
      'measures workflow latency, productivity, or cost.',
  },
});

const output =
  values.format === 'markdown'
    ? renderRequirementChangeMarkdown(result)
    : `${JSON.stringify(result, null, 2)}\n`;
if (values.output) {
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(path.resolve(values.output), output);
} else process.stdout.write(output);

const anyGateFailed = result.scenarios.some(
  (scenario) => scenario.arms.baseline.correctnessGate?.passed === false,
);
if (anyGateFailed) process.exitCode = 1;
