import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_ADAPTER,
  CLAUDE_HOOK_EVENTS,
  inspectClaude,
  planClaudeInvocation,
  planClaudeResume,
  planClaudeSettings,
  serializeNodeHookCommand,
  translateClaudeLifecycleInput,
  translateClaudeLifecycleOutput,
} from '../../src/providers/claude.js';

const fixture = (name) =>
  readFile(path.join('test', 'fixtures', 'providers', 'claude', name), 'utf8');

test('Claude adapter satisfies the shared contract without executing during construction', () => {
  assert.equal(CLAUDE_ADAPTER.contract.id, 'claude');
  assert.equal(CLAUDE_ADAPTER.contract.capabilities.skills.state, 'supported');
  assert.equal(CLAUDE_ADAPTER.contract.capabilities.usage.state, 'unknown');
  assert.deepEqual(planClaudeInvocation({ prompt: 'check files', cwd: 'C:/work tree' }), {
    executable: 'claude',
    args: ['-p', 'check files', '--output-format', 'json'],
    cwd: 'C:/work tree',
  });
});

test('version inspection is bounded to a redacted --version probe and missing binaries stay unavailable', async () => {
  const calls = [];
  const inspected = await inspectClaude({
    executable: 'C:/Program Files/Claude/claude.cmd',
    runner: async (request) => {
      calls.push(request);
      return {
        status: 'exited',
        exitCode: 0,
        stdout: 'claude 1.2.3\nsecret-token',
        stderr: 'noise',
      };
    },
  });
  assert.equal(inspected.version, '1.2.3');
  assert.deepEqual(calls[0].plan.args, ['--version']);
  assert.equal(inspected.result.stdout, undefined);
  const missing = await inspectClaude({
    runner: async () => ({ status: 'spawn-failed', message: 'not found' }),
  });
  assert.equal(missing.detected, false);
  assert.equal(missing.contract.capabilities.invocation.state, 'unknown');
});

test('settings planning preserves unrelated hooks, detects collisions, and returns a protected backup', async () => {
  const current = await fixture('settings-existing.json');
  const command = 'node "C:/Program Files/Latchkit/claude-hook.js" --event PreToolUse';
  const planned = planClaudeSettings({ current, handlers: { PreToolUse: command } });
  assert.equal(planned.status, 'planned');
  assert.equal(planned.backup.protected, true);
  const next = JSON.parse(planned.bytes);
  assert.equal(next.customSetting, 'preserve');
  assert.equal(next.hooks.Notification[0].hooks[0].command, 'keep-this-hook');
  assert.equal(next.hooks.PreToolUse[0].hooks[0].command, 'user-owned-hook');
  assert.equal(next.hooks.PreToolUse[1].hooks[0].command, command);
  const collision = planClaudeSettings({ current, handlers: { PreToolUse: 'user-owned-hook' } });
  assert.equal(collision.status, 'conflict');
});

test('removal only removes an unchanged owned command and retains user edits', () => {
  const command = 'node hook.js --event Stop';
  const applied = planClaudeSettings({ handlers: { Stop: command } });
  const removed = planClaudeSettings({
    current: applied.bytes,
    handlers: { Stop: command },
    owned: applied.owned,
    remove: true,
  });
  assert.equal(JSON.parse(removed.bytes).hooks, undefined);
  const edited = planClaudeSettings({
    current: applied.bytes.replace(command, `${command} --edited`),
    handlers: { Stop: command },
    owned: applied.owned,
    remove: true,
  });
  assert.match(edited.bytes, /--edited/);
});

test('hook command serialization handles spaces, apostrophes, dollars, Unicode, and missing Git Bash', () => {
  const script = "C:/Program Files/O'Reilly/$é/claude hook.js";
  const windows = serializeNodeHookCommand({
    scriptPath: script,
    event: 'PreToolUse',
    platform: 'win32',
  });
  assert.match(windows, /Program Files/);
  assert.match(windows, /O'Reilly/);
  assert.match(windows, /\$é/);
  const fallback = serializeNodeHookCommand({
    scriptPath: script,
    event: 'PreToolUse',
    platform: 'win32',
    directExecutionSupported: false,
  });
  assert.match(fallback, /^powershell\.exe -NoProfile -NonInteractive/);
  const posix = serializeNodeHookCommand({
    scriptPath: "/tmp/O'Reilly/$é/claude hook.js",
    event: 'Stop',
    platform: 'linux',
  });
  assert.match(posix, /'\\''/);
});

test('lifecycle translation maps documented events and never fabricates completion evidence', () => {
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: 'C:/work',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  };
  const event = translateClaudeLifecycleInput(input, {
    projectId: 'p1',
    taskId: 't1',
    version: '1.2.3',
  });
  assert.equal(event.kind, undefined);
  assert.equal(event.status, 'observed');
  assert.equal(
    translateClaudeLifecycleInput(
      { ...input, hook_event_name: 'Stop' },
      { projectId: 'p1', taskId: 't1', version: '1.2.3' },
    ).kind,
    'turn-completed',
  );
  assert.equal(
    translateClaudeLifecycleInput(
      { ...input, hook_event_name: 'SessionEnd' },
      { projectId: 'p1', taskId: 't1', version: '1.2.3' },
    ).kind,
    'session-terminated',
  );
  assert.deepEqual(
    translateClaudeLifecycleOutput({
      eventName: 'PreToolUse',
      response: { decision: 'block', reason: 'policy' },
    }),
    {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'policy',
      },
    },
  );
  assert.deepEqual(
    translateClaudeLifecycleOutput({
      eventName: 'UserPromptSubmit',
      response: { additionalContext: 'context' },
    }),
    { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'context' } },
  );
  assert.deepEqual(
    translateClaudeLifecycleOutput({
      eventName: 'PostToolUse',
      response: { decision: 'block', reason: 'late' },
    }),
    {},
  );
  assert.throws(() => translateClaudeLifecycleInput({ hook_event_name: 'Unknown' }), /Unsupported/);
  assert.deepEqual(CLAUDE_HOOK_EVENTS.length, 8);
  assert.deepEqual(planClaudeResume({ sessionId: 'session with spaces' }).args, [
    '--resume',
    'session with spaces',
  ]);
});
