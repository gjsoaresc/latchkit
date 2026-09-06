import assert from 'node:assert/strict';
import test from 'node:test';
import { resultStatus } from '../scripts/live-provider-adapter-evidence.js';

const nonce = 'LATCHKIT_ADAPTER_OK_fixture';
const exited = (stdout, stderr = '') => ({ status: 'exited', exitCode: 0, stdout, stderr });

test('Claude completion accepts normal permission metadata only with the exact result', () => {
  const result = resultStatus(
    'claude',
    exited(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: nonce,
        permission_denials: [],
        permission_mode: 'plan',
        approval_policy: 'on-request',
      }),
    ),
    nonce,
    true,
  );
  assert.equal(result.status, 'passed');
});

test('Claude completion blocks actual denials and authentication failures', () => {
  assert.deepEqual(
    resultStatus(
      'claude',
      exited(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: nonce,
          permission_denials: [{ tool_name: 'Read' }],
        }),
      ),
      nonce,
      true,
    ),
    { status: 'blocked', reason: 'Claude reported a permission denial.' },
  );
  assert.deepEqual(
    resultStatus(
      'claude',
      exited(
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Authentication required.',
          permission_denials: [],
        }),
      ),
      nonce,
      true,
    ),
    { status: 'blocked', reason: 'Claude reported an authentication failure.' },
  );
});

test('Claude completion rejects malformed output and nonce echoes outside the result', () => {
  assert.equal(resultStatus('claude', exited('{broken'), nonce, true).status, 'failed');
  assert.equal(
    resultStatus(
      'claude',
      exited(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'different response',
          prompt_echo: nonce,
          permission_denials: [],
        }),
      ),
      nonce,
      true,
    ).status,
    'failed',
  );
});

test('Codex completion requires an assistant message and completed turn', () => {
  const stdout = [
    { type: 'thread.started', thread_id: 'thread-fixture' },
    { type: 'item.completed', item: { type: 'user_message', text: nonce } },
    { type: 'item.completed', item: { type: 'agent_message', text: nonce } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ]
    .map(JSON.stringify)
    .join('\n');
  assert.equal(resultStatus('codex', exited(stdout), nonce, true).status, 'passed');
  assert.equal(
    resultStatus(
      'codex',
      exited(
        [
          JSON.stringify({ type: 'item.completed', item: { type: 'user_message', text: nonce } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      ),
      nonce,
      true,
    ).status,
    'failed',
  );
});

test('Codex completion blocks structured auth errors and rejects malformed JSONL', () => {
  assert.equal(
    resultStatus(
      'codex',
      exited(JSON.stringify({ type: 'turn.failed', error: { message: 'Login required.' } })),
      nonce,
      true,
    ).status,
    'blocked',
  );
  assert.equal(resultStatus('codex', exited('{broken'), nonce, true).status, 'failed');
});

test('process and source failures take precedence over provider completion content', () => {
  assert.equal(resultStatus('claude', exited('{}'), nonce, false).status, 'failed');
  assert.equal(
    resultStatus(
      'claude',
      { status: 'exited', exitCode: 1, stdout: '', stderr: 'Permission approval required.' },
      nonce,
      true,
    ).status,
    'blocked',
  );
  assert.equal(
    resultStatus('codex', { status: 'timed-out', stdout: '', stderr: '' }, nonce, true).status,
    'blocked',
  );
});
