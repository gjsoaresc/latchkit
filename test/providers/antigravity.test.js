import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ANTIGRAVITY_ADAPTER,
  ANTIGRAVITY_HANDLER_PATH,
  ANTIGRAVITY_HOOKS_PATH,
  ANTIGRAVITY_HOOK_EVENTS,
  ANTIGRAVITY_STATE_PATH,
  applyAntigravityHookExport,
  inspectAntigravity,
  parseAntigravitySessionIdentity,
  parseAntigravityVersion,
  planAntigravityInvocation,
  planAntigravityHookExport,
  planAntigravityResume,
  translateAntigravityLifecycleOutput,
} from '../../dist/src/providers/antigravity.js';

const temporaryRoot = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-antigravity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
const runHook = (root, event, input, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, ANTIGRAVITY_HANDLER_PATH), '--event', event],
      {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (exitCode) =>
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.stdin.end(input);
  });

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
  assert.equal(ANTIGRAVITY_ADAPTER.contract.capabilities.hooks.PostToolUse.state, 'supported');
  assert.equal(ANTIGRAVITY_ADAPTER.contract.capabilities.hooks.Stop.state, 'unsupported');
});

test('Antigravity hook registration is explicit, reversible, and preserves unrelated settings', async (t) => {
  const root = await temporaryRoot(t);
  await fs.mkdir(path.join(root, '.agents'), { recursive: true });
  const original = `${JSON.stringify({ future: { keep: true }, other: { Stop: [{ command: 'user-hook' }] } }, null, 2)}\n`;
  await fs.writeFile(path.join(root, ANTIGRAVITY_HOOKS_PATH), original);
  const preview = await planAntigravityHookExport(root, {
    enabled: true,
    nodeExecutable: 'node',
    platform: 'win32',
  });
  assert.equal(preview.configured, true);
  assert.equal(preview.changes.length, 3);
  assert.equal(preview.backup.bytes, original);
  await applyAntigravityHookExport(root, {
    enabled: true,
    nodeExecutable: 'node',
    platform: 'win32',
  });
  const installed = JSON.parse(await fs.readFile(path.join(root, ANTIGRAVITY_HOOKS_PATH), 'utf8'));
  assert.deepEqual(installed.future, { keep: true });
  assert.deepEqual(installed.other, { Stop: [{ command: 'user-hook' }] });
  assert.deepEqual(Object.keys(installed.latchkit).sort(), [...ANTIGRAVITY_HOOK_EVENTS].sort());
  assert.match(installed.latchkit.PostToolUse[0].hooks[0].command, /--event PostToolUse/);
  assert.ok(await fs.readFile(path.join(root, ANTIGRAVITY_HANDLER_PATH), 'utf8'));
  const post = await runHook(
    root,
    'PostToolUse',
    JSON.stringify({ conversationId: 'opaque-id', toolCall: { name: 'read_file' }, stepIdx: 0 }),
  );
  assert.deepEqual(post, { exitCode: 0, stdout: '{}\n', stderr: '' });
  const receipt = path.join(root, '.latchkit', 'live-hook-receipt.ndjson');
  const receiptNonce = 'receipt-test-nonce';
  const target = path.join(root, 'fixture.txt');
  const receipted = await runHook(
    root,
    'PostToolUse',
    JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: target } }, stepIdx: 1 }),
    {
      ...process.env,
      LATCHKIT_ANTIGRAVITY_HOOK_RECEIPT: receipt,
      LATCHKIT_ANTIGRAVITY_HOOK_NONCE: receiptNonce,
    },
  );
  assert.deepEqual(receipted, { exitCode: 0, stdout: '{}\n', stderr: '' });
  assert.deepEqual(JSON.parse(await fs.readFile(receipt, 'utf8')), {
    event: 'PostToolUse',
    stepIdx: 1,
    nonce: receiptNonce,
    operationDigest: createHash('sha256')
      .update(JSON.stringify({ tool: 'view_file', target }))
      .digest('hex'),
  });
  for (const event of ['PreToolUse', 'PreInvocation', 'PostInvocation', 'Stop']) {
    const refused = await runHook(root, event, '{}');
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /Unsupported Antigravity hook event/);
  }
  const malformed = await runHook(root, 'PostToolUse', '{');
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /Invalid Antigravity hook JSON input/);
  const schemaInvalid = await runHook(root, 'PostToolUse', '{}');
  assert.equal(schemaInvalid.exitCode, 1);
  assert.match(schemaInvalid.stderr, /toolCall object and non-negative stepIdx/);
  await applyAntigravityHookExport(root, { enabled: false });
  // The original document's unrelated content survives, while an empty managed namespace is removed.
  const removed = JSON.parse(await fs.readFile(path.join(root, ANTIGRAVITY_HOOKS_PATH), 'utf8'));
  assert.deepEqual(removed, {
    future: { keep: true },
    other: { Stop: [{ command: 'user-hook' }] },
  });
  await assert.rejects(fs.readFile(path.join(root, ANTIGRAVITY_HANDLER_PATH)), /ENOENT/);
  await assert.rejects(fs.readFile(path.join(root, ANTIGRAVITY_STATE_PATH)), /ENOENT/);
});

test('Antigravity hook ownership conflicts refuse removal and transaction failures restore bytes', async (t) => {
  const root = await temporaryRoot(t);
  await applyAntigravityHookExport(root, {
    enabled: true,
    nodeExecutable: 'node',
    platform: 'win32',
  });
  const before = await fs.readFile(path.join(root, ANTIGRAVITY_HOOKS_PATH), 'utf8');
  const edited = JSON.parse(before);
  edited.latchkit.PostToolUse[0].hooks[0].timeout = 9;
  await fs.writeFile(
    path.join(root, ANTIGRAVITY_HOOKS_PATH),
    `${JSON.stringify(edited, null, 2)}\n`,
  );
  await assert.rejects(
    planAntigravityHookExport(root, { enabled: false }),
    /local edits or is missing/,
  );
  await fs.writeFile(path.join(root, ANTIGRAVITY_HOOKS_PATH), before);
  await assert.rejects(
    applyAntigravityHookExport(root, {
      enabled: false,
      faultBoundary: async (boundary) => {
        if (boundary === 'resource:0') throw new Error('injected Antigravity transaction failure');
      },
    }),
    /injected Antigravity transaction failure/,
  );
  assert.equal(await fs.readFile(path.join(root, ANTIGRAVITY_HOOKS_PATH), 'utf8'), before);
  assert.ok(await fs.readFile(path.join(root, ANTIGRAVITY_HANDLER_PATH), 'utf8'));
});

test('Antigravity lifecycle translation is advisory and refuses unsupported decisions and malformed correlation', () => {
  const translated = ANTIGRAVITY_ADAPTER.operations.translateLifecycleInput(
    { conversationId: 'conversation-1', toolCall: { name: 'run_command' } },
    {
      eventName: 'Stop',
      projectId: 'project-1',
      taskId: 'task-1',
      version: 'unknown',
      timestamp: 1,
    },
  );
  assert.equal(translated.envelope.kind, 'turn-completed');
  assert.deepEqual(translated.envelope.decisionModes, ['advisory']);
  assert.equal(
    ANTIGRAVITY_ADAPTER.operations.translateLifecycleInput({}, { eventName: 'PreInvocation' })
      .envelope,
    null,
  );
  assert.deepEqual(
    translateAntigravityLifecycleOutput('PostToolUse', { decision: 'advisory' }),
    {},
  );
  assert.throws(
    () => translateAntigravityLifecycleOutput('Stop', { decision: 'advisory' }),
    /Unsupported/,
  );
  assert.throws(
    () => ANTIGRAVITY_ADAPTER.operations.translateLifecycleInput({}, { eventName: 'Unknown' }),
    /Unsupported/,
  );
  assert.throws(
    () => translateAntigravityLifecycleOutput('PreToolUse', { decision: 'deny' }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      ANTIGRAVITY_ADAPTER.operations.translateLifecycleInput(
        {},
        { eventName: 'Stop', projectId: 'p', taskId: 't' },
      ),
    /sessionId/,
  );
  assert.throws(
    () => ANTIGRAVITY_ADAPTER.operations.translateLifecycleInput({}, { eventName: 'PostToolUse' }),
    /toolCall/,
  );
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
