import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTING_POLICY_VERSION, selectRoute } from '../dist/src/workflows/routing.js';

test('routing keeps a local button colour edit lightweight without relying on size words', () => {
  const route = selectRoute({
    request: 'Change the settings button color.',
    changedPaths: ['web/settings.tsx'],
  });
  assert.equal(route.id, 'visual-local');
  assert.deepEqual(route.phases, ['implementation', 'verification']);
  assert.equal(route.requiresIndependentReview, false);
  assert.equal(route.policyVersion, ROUTING_POLICY_VERSION);
});

test('routing overlays high-impact authorization changes over an explicit lightweight route', () => {
  const route = selectRoute({
    request: 'Fix one authorization bypass.',
    requestedRoute: 'visual-local',
    changedPaths: ['src/auth.ts'],
  });
  assert.equal(route.id, 'high-impact');
  assert.deepEqual(route.phases, [
    'requirements',
    'plan',
    'implementation',
    'verification',
    'review',
  ]);
});

test('routing records unknown source scope as bounded investigation rather than silently selecting a full workflow', () => {
  const route = selectRoute({ request: 'Update the export flow.' });
  assert.equal(route.id, 'investigate');
  assert.equal(route.phases[0], 'requirements');
  assert.ok(route.unknowns.length);
});
