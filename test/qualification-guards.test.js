import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFccBoundLaunch,
  assertFixtureScope,
  createQualificationDeadline,
  validateArtifactBinding,
} from '../dist/scripts/qualification-guards.js';

test('wrong manifest binding refuses before any launch', () => {
  assert.throws(
    () =>
      validateArtifactBinding({
        dirty: false,
        commit: 'a',
        version: '1',
        nodeVersion: '22',
        packageVersion: '1',
        privateNodeVersion: 'v22',
        packageMatchesManifest: false,
        runtimeMatchesManifest: true,
      }),
    /INSTALLED_ARTIFACT_BINDING_MISMATCH/,
  );
});
test('FCC-bound review launch requires route, model, and retry cap', () => {
  assert.doesNotThrow(() =>
    assertFccBoundLaunch({
      args: ['--model', 'haiku', '--max-turns', '8'],
      environment: { ANTHROPIC_BASE_URL: 'http://127.0.0.1', CLAUDE_CODE_MAX_RETRIES: '0' },
    }),
  );
  assert.throws(
    () => assertFccBoundLaunch({ args: [], environment: {} }),
    /FCC_BOUND_LAUNCH_REQUIRED/,
  );
});
test('untracked files fail fixture scope proof', () => {
  assert.throws(
    () => assertFixtureScope(['src/calculator.js'], ['surprise.txt']),
    /FIXTURE_SCOPE_VIOLATION/,
  );
});
test('deadline invokes owned shutdown once and admits no post-expiry work', async () => {
  let calls = 0;
  const deadline = createQualificationDeadline(1, () => {
    calls += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deadline.expired(), true);
  assert.equal(calls, 1);
  deadline.clear();
});
