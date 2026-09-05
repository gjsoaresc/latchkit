import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_OPERATIONS,
  LIFECYCLE_ENVELOPE_VERSION,
  ProviderContractError,
  createLifecycleDispatcher,
  createProviderAdapter,
  negotiateCapabilities,
  validateCommandPlan,
  validateLifecycleEnvelope,
} from '../../src/providers/contracts.js';
import { PROVIDERS } from '../../src/providers/registry.js';

const evidence = (state, reason = state) => ({
  state,
  reason,
  versionRange: '>=1.0.0',
  evidenceUrl: 'https://example.test/evidence',
});
const fakeContract = () => ({
  schemaVersion: 1,
  id: 'fake',
  label: 'Fake adapter',
  command: 'fake',
  skillDirectory: '.fake/skills',
  capabilities: {
    skills: evidence('supported'),
    invocation: evidence('partial'),
    hooks: { turn: evidence('supported') },
    decisions: { blocking: evidence('unsupported'), advisory: evidence('supported') },
    compaction: evidence('unknown'),
    resume: evidence('unsupported'),
    cancellation: evidence('partial'),
    usage: evidence('unknown'),
  },
  verification: {
    installed: 'verified',
    authenticated: 'unknown',
    configured: 'unverified',
    endToEnd: 'unverified',
  },
});
const fakeOperations = () =>
  Object.fromEntries(
    ADAPTER_OPERATIONS.map((name) => [name, () => ({ executable: 'fake', args: [] })]),
  );
const event = (overrides = {}) => ({
  schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
  provider: { id: 'fake', version: '1.2.3', runtime: 'test' },
  correlation: { projectId: 'project-1', taskId: 'task-1', sessionId: 'session-1' },
  eventId: 'event-1',
  timestamp: 1_700_000_000_000,
  kind: 'turn-completed',
  payload: { summary: 'done' },
  decisionModes: ['advisory'],
  ...overrides,
});

test('registry preserves existing provider fields and reports only evidenced support', () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.id),
    ['claude', 'codex', 'gemini', 'cursor', 'cursor-cli'],
  );
  for (const provider of PROVIDERS) {
    assert.equal(provider.schemaVersion, 1);
    assert.equal(provider.capabilities.skills.state, 'supported');
    assert.equal(
      provider.capabilities.invocation.state,
      ['claude', 'cursor-cli'].includes(provider.id) ? 'supported' : 'unknown',
    );
    assert.equal(provider.verification.endToEnd, 'unverified');
  }
});

test('fake adapter requires every planning and translation operation without executing a command', () => {
  const adapter = createProviderAdapter(fakeContract(), fakeOperations());
  assert.equal(adapter.contract.id, 'fake');
  assert.throws(
    () => createProviderAdapter(fakeContract(), { inspect() {} }),
    ProviderContractError,
  );
  assert.deepEqual(validateCommandPlan(adapter.operations.planInvocation()), {
    executable: 'fake',
    args: [],
  });
});

test('capability negotiation refuses unknown support and describes advisory fallback', () => {
  const results = negotiateCapabilities(fakeContract(), [
    { capability: 'skills' },
    { capability: 'resume' },
    { capability: 'decision:blocking', decisionMode: 'blocking' },
    { capability: 'hook:missing' },
  ]);
  assert.equal(results[0].outcome, 'available');
  assert.equal(results[1].outcome, 'refused');
  assert.equal(results[2].outcome, 'advisory-fallback');
  assert.equal(results[2].fallback, 'advisory');
  assert.equal(results[3].state, 'unknown');
  assert.equal(results[3].outcome, 'refused');
});

test('lifecycle envelope rejects malformed correlation, unknown events, and oversized payloads', () => {
  assert.equal(validateLifecycleEnvelope(event()).correlation.taskId, 'task-1');
  assert.throws(
    () => validateLifecycleEnvelope(event({ correlation: { projectId: 'p', taskId: 't' } })),
    /Unknown field|Expected a non-empty/,
  );
  assert.throws(
    () => validateLifecycleEnvelope(event({ kind: 'completed' })),
    /Unknown lifecycle event/,
  );
  assert.throws(
    () => validateLifecycleEnvelope(event({ payload: { text: 'x'.repeat(64 * 1024) } })),
    /exceeds 64 KB/,
  );
});

test('injectable lifecycle dispatcher makes deduplication and failure states explicit', async () => {
  const dispatch = createLifecycleDispatcher({
    lookupTask: async (id) => (id === 'task-1' ? { id } : null),
    authorize: async () => true,
    handle: async (_task, received) => ({ decision: 'advisory', received: received.kind }),
  });
  assert.deepEqual(await dispatch(event()), {
    status: 'handled',
    result: { decision: 'advisory', received: 'turn-completed' },
  });
  assert.equal((await dispatch(event())).status, 'duplicate');
  assert.equal(
    (await dispatch(event({ eventId: 'event-old', timestamp: 1 }))).status,
    'out-of-order',
  );
  assert.equal(
    (
      await dispatch(
        event({
          eventId: 'event-2',
          correlation: { projectId: 'p', taskId: 'missing', sessionId: 's' },
        }),
      )
    ).status,
    'missing-task',
  );

  const failing = createLifecycleDispatcher({
    lookupTask: async () => ({}),
    authorize: async () => true,
    handle: async () => {
      throw new Error('fixture failure');
    },
  });
  const failed = await failing(event({ eventId: 'event-3' }));
  assert.deepEqual(failed, {
    status: 'handler-failed',
    decision: 'advisory',
    reason: 'fixture failure',
  });
});
