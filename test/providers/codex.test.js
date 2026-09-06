import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexHookConfig,
  CODEX_CONTRACT,
  codexAdapter,
  inspectCodexVersion,
  parseCodexHookConfig,
  translateCodexEvent,
} from '../../dist/src/providers/codex.js';
import {
  validateCommandPlan,
  validateLifecycleEnvelope,
} from '../../dist/src/providers/contracts.js';

test('Codex version inspection is bounded and honest', () => {
  assert.deepEqual(inspectCodexVersion('codex-cli 0.42.1'), {
    version: '0.42.1',
    state: 'verified',
    reason: 'Version was returned by the bounded version probe.',
  });
  assert.equal(inspectCodexVersion('logged in').state, 'unknown');
});

test('Codex hook config detects supported and skipped handlers', () => {
  const result = parseCodexHookConfig(
    JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: 'node handler.js' },
              { type: 'prompt', prompt: 'no' },
            ],
          },
        ],
      },
    }),
  );
  assert.deepEqual(result.handlers, [
    { event: 'Stop', matcher: '*', type: 'command', async: false },
  ]);
  assert.equal(result.unsupported[0].type, 'prompt');
  assert.equal(result.reviewRequired, true);
});

test('Codex plans use argument vectors and never trust-bypass flags', () => {
  const invocation = codexAdapter.operations.planInvocation({
    prompt: 'hello --danger',
    cwd: 'C:\\work dir',
  });
  assert.deepEqual(validateCommandPlan(invocation), {
    executable: 'codex',
    args: [
      '--ask-for-approval',
      'on-request',
      'exec',
      '--sandbox',
      'read-only',
      '--json',
      '--',
      'hello --danger',
    ],
    cwd: 'C:\\work dir',
  });
  assert.ok(!JSON.stringify(invocation).includes('trust'));

  const resume = codexAdapter.operations.planResume({
    sessionId: 'thread-123',
    prompt: 'write the handoff',
    cwd: 'C:\\work dir',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
  });
  assert.deepEqual(validateCommandPlan(resume), {
    executable: 'codex',
    args: [
      '--ask-for-approval',
      'never',
      'exec',
      '--sandbox',
      'workspace-write',
      'resume',
      '--json',
      '--',
      'thread-123',
      'write the handoff',
    ],
    cwd: 'C:\\work dir',
  });
  assert.throws(
    () => codexAdapter.operations.planInvocation({ sandbox: 'danger-full-access' }),
    /read-only or workspace-write/,
  );
  assert.throws(
    () => codexAdapter.operations.planInvocation({ approvalPolicy: 'untrusted' }),
    /on-request or never/,
  );
});

test('Codex lifecycle translation validates normalized envelope', () => {
  const envelope = translateCodexEvent(
    {
      hook_event_name: 'Interrupt',
      session_id: 's',
      turn_id: 't',
      cwd: 'p',
      permission_mode: 'default',
    },
    { correlation: { projectId: 'p', taskId: 't', sessionId: 's' } },
  );
  assert.equal(validateLifecycleEnvelope(envelope).kind, 'interrupted');
  assert.equal(translateCodexEvent({ hook_event_name: 'SessionStart', session_id: 's' }), null);
});

test('Codex hook generation marks project handlers for review', () => {
  const config = buildCodexHookConfig({
    handlerPath: 'C:\\project\\handler.js',
    events: ['SessionEnd'],
  });
  assert.match(config.description, /review and trust/);
  assert.equal(config.hooks.SessionEnd[0].hooks[0].type, 'command');
  assert.equal(CODEX_CONTRACT.capabilities.usage.state, 'unknown');
});
