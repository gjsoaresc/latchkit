import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTIGRAVITY_ADAPTER,
  inspectAntigravity,
  parseAntigravitySessionIdentity,
  parseAntigravityVersion,
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

const conversationId = '055a398f-db14-4c5f-abbb-1bf03f8120a7';
const otherId = '155a398f-db14-4c5f-abbb-1bf03f8120a7';
const result = (overrides = {}) => ({
  conversation_id: conversationId,
  status: 'SUCCESS',
  response: 'Original fixture response.',
  ...overrides,
});
const stream = (final = result()) =>
  [
    { event: 'init', conversation_id: conversationId, init: { permission_mode: 'request-review' } },
    {
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 0,
        state: 'DONE',
        step_type: 'agent_response',
      },
    },
    { event: 'result', result: final },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');

test('Antigravity resumes only an explicit conversation on the evidenced exact version', () => {
  assert.equal(planAntigravityResume().supported, false);
  for (const providerVersion of [
    undefined,
    '',
    'unknown',
    '1.1.26',
    '1.1.28',
    '1.1.27-beta',
    'v1.1.27',
  ])
    assert.equal(
      planAntigravityResume({ providerVersion, sessionId: conversationId, prompt: 'next' })
        .supported,
      false,
    );
  const plan = planAntigravityResume({
    providerVersion: '1.1.27',
    sessionId: conversationId,
    prompt: 'next "quoted" & $text',
    cwd: 'C:\\Work Space\\项目',
  });
  assert.deepEqual(plan, {
    executable: 'agy',
    args: [
      '-p',
      'next "quoted" & $text',
      '--output-format',
      'json',
      '--conversation',
      conversationId,
    ],
    cwd: 'C:\\Work Space\\项目',
  });
  for (const sessionId of [undefined, '', '--continue', 'not-a-uuid', `${conversationId}\n`])
    assert.throws(
      () => planAntigravityResume({ providerVersion: '1.1.27', sessionId, prompt: 'next' }),
      /conversation/i,
    );
  assert.equal(ANTIGRAVITY_ADAPTER.contract.capabilities.resume.versionRange, '1.1.27');
  assert.equal(ANTIGRAVITY_ADAPTER.contract.capabilities.resume.state, 'partial');
  assert.equal(
    inspectAntigravity({ versionOutput: 'Antigravity CLI 1.1.28' }).contract.capabilities.resume
      .state,
    'unknown',
  );
  assert.equal(
    inspectAntigravity({ versionOutput: 'Antigravity CLI 1.1.27' }).contract.capabilities.resume
      .state,
    'partial',
  );
  assert.equal(ANTIGRAVITY_ADAPTER.contract.capabilities.invocation.state, 'supported');
  assert.equal(ANTIGRAVITY_ADAPTER.operations.planInstall().supported, false);
});

test('Antigravity version inspection refuses ambiguous and prerelease output', () => {
  for (const output of ['1.1.27', 'v1.1.27\n', 'Antigravity CLI 1.1.27'])
    assert.equal(parseAntigravityVersion(output), '1.1.27');
  for (const output of [
    undefined,
    '',
    '1.1.27-beta',
    '1.1.27+build',
    '1.1.27 1.1.28',
    'x'.repeat(4097),
  ])
    assert.equal(parseAntigravityVersion(output), null);
});

test('Antigravity rejects permission overrides it cannot enforce', () => {
  for (const options of [
    { sandbox: 'read-only' },
    { sandbox: 'workspace-write' },
    { approvalPolicy: 'never' },
  ]) {
    assert.throws(
      () => planAntigravityInvocation({ prompt: 'hello', ...options }),
      /permission|sandbox/i,
    );
    assert.throws(
      () =>
        planAntigravityResume({
          prompt: 'hello',
          providerVersion: '1.1.27',
          sessionId: conversationId,
          ...options,
        }),
      /permission|sandbox/i,
    );
  }
});

test('Antigravity extracts only complete consistent successful conversation identities', () => {
  const options = { providerVersion: '1.1.27' };
  for (const output of [JSON.stringify(result()), JSON.stringify(result(), null, 2), stream()])
    assert.equal(parseAntigravitySessionIdentity(output, options), conversationId);
  const invalid = [
    'plain output',
    '',
    '{',
    JSON.stringify([result()]),
    JSON.stringify(result({ conversation_id: '--continue' })),
    JSON.stringify({ session_id: conversationId, status: 'SUCCESS', response: 'wrong field' }),
    JSON.stringify(result({ status: 'RUNNING' })),
    JSON.stringify(result({ status: 'WAITING' })),
    JSON.stringify(result({ status: 'ERROR' })),
    JSON.stringify(result({ status: 'INTERRUPTED' })),
    JSON.stringify(result({ status: 'CANCELED' })),
    JSON.stringify(result({ status: 'FUTURE' })),
    JSON.stringify(result({ response: null })),
    JSON.stringify(result({ denied_actions: ['command'] })),
    JSON.stringify(result({ error: 'refused' })),
    stream(result({ conversation_id: otherId })),
    stream().split('\n').slice(0, -1).join('\n'),
    `${stream()}\n{`,
    `${stream()}\n${JSON.stringify({ event: 'result', result: result() })}`,
    stream().replace('"step_index":0', '"step_index":-1'),
    stream().replace('"state":"DONE"', '"state":"FUTURE"'),
    `${JSON.stringify(result())}\n${JSON.stringify(result())}`,
  ];
  for (const output of invalid)
    assert.equal(parseAntigravitySessionIdentity(output, options), null, output);
  assert.equal(
    parseAntigravitySessionIdentity(JSON.stringify(result()), { providerVersion: '1.1.28' }),
    null,
  );
  assert.equal(
    parseAntigravitySessionIdentity(JSON.stringify(result()), {
      ...options,
      expectedSessionId: otherId,
    }),
    null,
  );
  assert.equal(
    parseAntigravitySessionIdentity(stream(), { ...options, expectedSessionId: conversationId }),
    conversationId,
  );
});
