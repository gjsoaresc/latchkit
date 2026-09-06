import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import {
  validateWorkflowProviderOptions,
  workflowProviderInnerArgs,
  workflowProviderInvocation,
} from '../scripts/workflow-evidence-options.js';

const invocation = () => ({
  provider: { id: 'codex' },
  plan: {
    executable: 'codex',
    args: [
      '--ask-for-approval',
      'on-request',
      'exec',
      '--sandbox',
      'read-only',
      '--json',
      '--',
      'Review only.',
    ],
    cwd: 'C:/fixture with spaces',
  },
  timeoutMs: 120000,
});

test('qualification model selection defaults to medium without changing saved permission plans', () => {
  const source = invocation();
  const original = structuredClone(source);
  const result = workflowProviderInvocation(source, { model: 'gpt-5.6-luna' });
  assert.deepEqual(result.plan.args.slice(0, 4), [
    '--model',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort="medium"',
  ]);
  assert.deepEqual(result.plan.args.slice(4), original.plan.args);
  assert.equal(result.plan.cwd, source.plan.cwd);
  assert.deepEqual(source, original);
});

test('outer model and effort selection survive parsing by the private-Node inner process', () => {
  const outer = validateWorkflowProviderOptions({
    model: 'gpt-5.4-mini',
    'reasoning-effort': 'low',
  });
  const { values: inner } = parseArgs({
    args: workflowProviderInnerArgs(outer),
    options: { model: { type: 'string' }, 'reasoning-effort': { type: 'string' } },
  });
  const args = workflowProviderInvocation(invocation(), inner).plan.args;
  assert.deepEqual(args.slice(0, 4), [
    '--model',
    'gpt-5.4-mini',
    '-c',
    'model_reasoning_effort="low"',
  ]);
  const defaulted = workflowProviderInnerArgs({ model: 'gpt-5.6-luna' });
  assert.deepEqual(defaulted, ['--model', 'gpt-5.6-luna', '--reasoning-effort', 'medium']);
});

test('unselected model settings and other providers remain unchanged', () => {
  const source = invocation();
  assert.equal(workflowProviderInvocation(source, {}), source);
  const claude = { ...source, provider: { id: 'claude' } };
  assert.equal(
    workflowProviderInvocation(claude, { model: 'gpt-5.6-luna', 'reasoning-effort': 'medium' }),
    claude,
  );
});

test('qualification refuses malformed effort and model flags before invocation', () => {
  for (const effort of ['', 'automatic', 'medium\n', 'medium"', 'LOW', true])
    assert.throws(
      () => validateWorkflowProviderOptions({ 'reasoning-effort': effort }),
      /--reasoning-effort/,
    );
  for (const model of ['', '--other-flag', 'model with spaces', 'model\nflag'])
    assert.throws(() => validateWorkflowProviderOptions({ model }), /--model/);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    assert.equal(
      validateWorkflowProviderOptions({ 'reasoning-effort': effort })['reasoning-effort'],
      effort,
    );
});
