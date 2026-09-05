import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  HOOK_EVENTS,
  createGeminiAdapter,
  inspectGemini,
  mergeGeminiSettings,
  planGeminiInvocation,
  planGeminiResume,
  removeGeminiSettings,
  runGeminiHook,
  translateGeminiHookInput,
  translateGeminiHookOutput,
} from '../../src/providers/gemini.js';

const fixture = (name) => path.join('test', 'fixtures', 'providers', 'gemini', name);
const settings = JSON.parse(await readFile(fixture('settings.json'), 'utf8'));

test('Gemini inspection only reports flags documented by the installed help fixture', async () => {
  const result = inspectGemini({
    versionOutput: await readFile(fixture('version.txt'), 'utf8'),
    helpOutput: await readFile(fixture('help.txt'), 'utf8'),
  });
  assert.equal(result.version, '0.3.1');
  assert.deepEqual(result.missingFlags, []);
  assert.equal(result.contract.capabilities.invocation.state, 'partial');
  assert.equal(result.contract.capabilities.usage.state, 'unknown');
  assert.equal(
    inspectGemini({ helpOutput: '--prompt' }).contract.capabilities.invocation.state,
    'unknown',
  );
});

test('Gemini plans use safe argument vectors and JSON-only output', () => {
  assert.deepEqual(
    planGeminiInvocation({ prompt: 'quote " and % and &', cwd: 'C:/project with spaces' }),
    {
      executable: 'gemini',
      args: ['--prompt', 'quote " and % and &', '--output-format', 'json'],
      cwd: 'C:/project with spaces',
    },
  );
  assert.deepEqual(
    planGeminiResume({ sessionId: 'session-id', prompt: 'continue', cwd: 'project' }).args,
    ['--resume', 'session-id', '--prompt', 'continue', '--output-format', 'json'],
  );
  assert.throws(() => planGeminiInvocation({ prompt: 'x', outputFormat: 'text' }), /JSON output/);
});

test('Gemini input/output translation preserves native event semantics', async () => {
  const input = {
    session_id: 's1',
    cwd: 'C:/project',
    hook_event_name: 'BeforeTool',
    tool_name: 'write_file',
    tool_input: { path: 'x' },
    timestamp: '2026-09-05T10:00:00.000Z',
  };
  const envelope = translateGeminiHookInput(input, {
    projectId: 'p1',
    taskId: 't1',
    providerVersion: '0.3.1',
  });
  assert.equal(envelope.kind, 'turn-completed');
  assert.deepEqual(envelope.decisionModes, ['blocking', 'advisory']);
  assert.deepEqual(
    translateGeminiHookOutput('SessionStart', {
      decision: 'deny',
      continue: false,
      systemMessage: 'ready',
    }),
    { systemMessage: 'ready' },
  );
  assert.deepEqual(
    translateGeminiHookOutput('BeforeTool', { decision: 'deny', reason: 'unsafe' }),
    { decision: 'deny', reason: 'unsafe' },
  );
  assert.deepEqual(
    translateGeminiHookOutput('AfterAgent', { retry: true, reason: 'retry once', maxRetries: 2 }),
    { decision: 'deny', reason: 'retry once', retry: true, maxRetries: 2 },
  );
  assert.equal(
    await runGeminiHook({
      stdin: JSON.stringify(input),
      handler: async () => ({ systemMessage: 'ok' }),
    }),
    '{"systemMessage":"ok"}',
  );
  await assert.rejects(
    () => runGeminiHook({ stdin: 'not-json', eventName: 'BeforeAgent' }),
    /Invalid Gemini hook JSON/,
  );
  assert.deepEqual(
    translateGeminiHookOutput('PreCompress', { decision: 'deny', systemMessage: 'saved' }),
    { systemMessage: 'saved' },
  );
});

test('Gemini settings merge/remove preserves user settings and uniquely owns hooks', () => {
  const merged = mergeGeminiSettings(settings, { command: 'node .latchkit/gemini-hook.js' });
  assert.deepEqual(merged.context, settings.context);
  assert.deepEqual(merged.permissions, settings.permissions);
  assert.deepEqual(merged.unknownSetting, settings.unknownSetting);
  assert.equal(merged.hooks.BeforeTool.length, 2);
  for (const eventName of HOOK_EVENTS)
    assert.ok(
      merged.hooks[eventName].some((group) =>
        group.hooks.some((hook) => hook.name === `latchkit-${eventName}`),
      ),
    );
  const removed = removeGeminiSettings(merged);
  assert.deepEqual(removed.context, settings.context);
  assert.deepEqual(removed.hooks.BeforeTool, settings.hooks.BeforeTool);
  assert.equal(removed.hooks.SessionStart, undefined);
});

test('Gemini adapter exposes every shared operation without executing commands', () => {
  const adapter = createGeminiAdapter({
    helpOutput: '--prompt --output-format --resume',
    versionOutput: 'Gemini CLI 0.3.1',
  });
  assert.equal(adapter.contract.id, 'gemini');
  assert.equal(typeof adapter.operations.translateLifecycleInput, 'function');
  assert.equal(adapter.operations.planUsage().state, 'unknown');
  assert.equal(adapter.operations.planInstall({ settings }).path, '.gemini/settings.json');
});
