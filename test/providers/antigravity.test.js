import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTIGRAVITY_ADAPTER,
  planAntigravityInvocation,
  planAntigravityResume,
} from '../../dist/src/providers/antigravity.js';

test('Antigravity exposes the documented bounded print-mode contract', () => {
  assert.equal(ANTIGRAVITY_ADAPTER.contract.id, 'antigravity');
  assert.equal(ANTIGRAVITY_ADAPTER.contract.command, 'agy');
  assert.deepEqual(planAntigravityInvocation({ prompt: 'hello', cwd: '/tmp/project' }), {
    executable: 'agy',
    args: ['-p', 'hello', '--output-format', 'json'],
    cwd: '/tmp/project',
  });
  assert.deepEqual(
    planAntigravityInvocation({ prompt: 'hello', outputFormat: 'stream-json' }).args,
    ['-p', 'hello', '--output-format', 'stream-json'],
  );
});

test('Antigravity resume and lifecycle remain explicitly unsupported without an upstream contract', () => {
  assert.equal(planAntigravityResume().supported, false);
  assert.equal(ANTIGRAVITY_ADAPTER.contract.capabilities.resume.state, 'unknown');
  assert.equal(ANTIGRAVITY_ADAPTER.contract.capabilities.invocation.state, 'supported');
  assert.equal(ANTIGRAVITY_ADAPTER.operations.planInstall().supported, false);
});
