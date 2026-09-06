import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionChoice } from '../dist/src/workspaces/preference.js';

test('an explicit per-task override always wins, even against "ask"', () => {
  assert.deepEqual(resolveExecutionChoice({ projectPreference: 'ask', override: 'worktree' }), {
    decision: 'worktree',
    source: 'override',
  });
  assert.deepEqual(resolveExecutionChoice({ projectPreference: 'ask', override: 'direct' }), {
    decision: 'direct',
    source: 'override',
  });
  assert.deepEqual(
    resolveExecutionChoice({ projectPreference: 'always-worktree', override: 'direct' }),
    { decision: 'direct', source: 'override' },
  );
  assert.deepEqual(resolveExecutionChoice({ projectPreference: 'direct', override: 'worktree' }), {
    decision: 'worktree',
    source: 'override',
  });
});

test('the project preference decides when no override is given', () => {
  assert.deepEqual(resolveExecutionChoice({ projectPreference: 'always-worktree' }), {
    decision: 'worktree',
    source: 'preference',
  });
  assert.deepEqual(resolveExecutionChoice({ projectPreference: 'direct' }), {
    decision: 'direct',
    source: 'preference',
  });
});

test('"ask every time" with no override is undecided, never a silent default', () => {
  assert.deepEqual(resolveExecutionChoice({ projectPreference: 'ask' }), {
    decision: 'undecided',
    reason: 'ASK_REQUIRED',
  });
  assert.deepEqual(resolveExecutionChoice({ projectPreference: 'ask', override: undefined }), {
    decision: 'undecided',
    reason: 'ASK_REQUIRED',
  });
});
