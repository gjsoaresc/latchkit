import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  CURSOR_IDE_AGENT_EVENTS,
  CURSOR_IDE_HANDLER_PATH,
  CURSOR_IDE_HOOKS_PATH,
  CURSOR_IDE_STATE_PATH,
  applyCursorIdeHookExport,
  cursorIdeAdapter,
  cursorIdeHookCommand,
  inspectCursorIde,
  inspectCursorIdeRecovery,
  mergeCursorIdeHooks,
  planCursorIdeHookExport,
  recoverCursorIdeIntegration,
  translateCursorIdeLifecycleOutput,
} from '../../src/providers/cursor-ide.js';

const fixtures = path.resolve(
  fileURLToPath(new URL('../fixtures/providers/cursor-ide/', import.meta.url)),
);
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(fixtures, name), 'utf8'));
const crashHelper = path.resolve(
  fileURLToPath(
    new URL('../../scripts/test-helpers/cursor-ide-crash-hook-export.js', import.meta.url),
  ),
);
const temporaryRoot = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-cursor-ide-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

test('inspection separates editor installation, PATH launcher, configuration, and observation', async () => {
  for (const [platform, editor] of [
    ['win32', 'C:/Program Files/Cursor/Cursor.exe'],
    ['darwin', '/Applications/Cursor.app/Contents/MacOS/Cursor'],
    ['linux', '/opt/Cursor/cursor'],
  ]) {
    const product =
      platform === 'darwin'
        ? '/Applications/Cursor.app/Contents/Resources/app/product.json'
        : (platform === 'win32' ? path.win32 : path.posix).join(
            (platform === 'win32' ? path.win32 : path.posix).dirname(editor),
            'resources',
            'app',
            'product.json',
          );
    const io = {
      access: async (filename) => {
        if (filename !== editor) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      readFile: async (filename) => {
        if (filename === product) return '{"version":"2.4.1"}';
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    };
    const result = await inspectCursorIde({
      platform,
      env: { PATH: '' },
      editorCandidates: [editor],
      launcherCandidates: [],
      io,
      integrationConfigured: true,
      observedSessionId: 'opaque-id',
    });
    assert.equal(result.installed.state, 'verified');
    assert.equal(result.launcherAvailable.state, 'unverified');
    assert.equal(result.version, '2.4.1');
    assert.equal(result.integrationConfigured.state, 'verified');
    assert.equal(result.sessionObserved.evidence, 'user-supplied');
    assert.equal(result.authenticated.state, 'unknown');
    assert.equal(result.endToEnd.state, 'unverified');
  }
});

test('IDE and CLI capabilities stay separate and execution plans remain manual', () => {
  assert.equal(cursorIdeAdapter.contract.id, 'cursor');
  assert.equal(cursorIdeAdapter.contract.capabilities.hooks.sessionStart.state, 'supported');
  assert.equal(cursorIdeAdapter.contract.capabilities.invocation.state, 'unsupported');
  assert.deepEqual(cursorIdeAdapter.operations.planInvocation().command, null);
  assert.deepEqual(cursorIdeAdapter.operations.planResume().command, null);
  assert.deepEqual(cursorIdeAdapter.operations.planUsage().command, null);
  assert.match(cursorIdeAdapter.operations.planSkillExport().warning, /shared/);
});

test('hook merge preserves unknown keys and unrelated registrations without compatibility imports', () => {
  const original = `${JSON.stringify(
    {
      version: 1,
      policy: { managed: true, backup: 'protected' },
      hooks: {
        preToolUse: [{ command: 'existing', matcher: 'Read' }],
        beforeTabFileRead: [{ command: 'tab-handler' }],
        workspaceOpen: [{ command: 'startup-handler' }],
      },
      futureKey: ['keep'],
    },
    null,
    2,
  )}\n`;
  const command = cursorIdeHookCommand('C:\\Program Files\\nodejs\\node.exe', 'win32');
  const merged = JSON.parse(mergeCursorIdeHooks(original, command));
  assert.deepEqual(merged.policy, { managed: true, backup: 'protected' });
  assert.deepEqual(merged.futureKey, ['keep']);
  assert.deepEqual(merged.hooks.beforeTabFileRead, [{ command: 'tab-handler' }]);
  assert.deepEqual(merged.hooks.workspaceOpen, [{ command: 'startup-handler' }]);
  assert.equal(merged.hooks.preToolUse[0].command, 'existing');
  assert.ok(CURSOR_IDE_AGENT_EVENTS.every((event) => merged.hooks[event].length >= 1));
  assert.ok(CURSOR_IDE_AGENT_EVENTS.every((event) => merged.hooks[event].at(-1).timeout === 10));
  assert.doesNotMatch(JSON.stringify(merged), /claude|third.?party/i);
  assert.equal(
    command,
    '"C:\\Program Files\\nodejs\\node.exe" ".latchkit/providers/cursor-ide/hook-handler.cjs"',
  );
  assert.throws(() => cursorIdeHookCommand('node\nmalicious', 'win32'), /Unsafe/);
});

test('lifecycle translation accepts tested Agent events, redacts credentials, and rejects false sources', async () => {
  for (const name of ['session-start.json', 'tool-use.json', 'stop.json']) {
    const input = await fixture(name);
    const translated = cursorIdeAdapter.operations.translateLifecycleInput(input, {
      projectId: 'project-id',
      taskId: 'task-id',
      timestamp: 1_700_000_000_000,
    });
    assert.equal(translated.accepted, true);
    assert.equal(translated.source, 'agent');
    assert.equal(translated.correlation.sessionId, 'opaque-conversation-123');
    assert.doesNotMatch(JSON.stringify(translated), /super-secret|example\.test|transcript/);
  }
  const base = await fixture('session-start.json');
  for (const event of CURSOR_IDE_AGENT_EVENTS) {
    const translated = cursorIdeAdapter.operations.translateLifecycleInput(
      { ...base, hook_event_name: event },
      { projectId: 'project-id', taskId: 'task-id', timestamp: 1 },
    );
    assert.equal(translated.event, event);
  }
  const stop = cursorIdeAdapter.operations.translateLifecycleInput(await fixture('stop.json'), {
    projectId: 'project-id',
    taskId: 'task-id',
    timestamp: 1,
  });
  assert.equal(stop.envelope.kind, 'turn-completed');
  assert.deepEqual(stop.envelope.decisionModes, ['advisory']);
  const workspace = cursorIdeAdapter.operations.translateLifecycleInput(
    await fixture('workspace-open.json'),
  );
  assert.deepEqual(workspace, {
    accepted: false,
    source: 'workspace',
    reason: 'workspaceOpen is not an Agent task-progress event.',
  });
  assert.deepEqual(translateCursorIdeLifecycleOutput('preCompact', { decision: 'advisory' }), {});
  assert.deepEqual(
    translateCursorIdeLifecycleOutput('stop', { decision: 'continue', reason: 'Verify' }),
    {
      followup_message: 'Verify',
    },
  );
  assert.throws(
    () => translateCursorIdeLifecycleOutput('postToolUse', { decision: 'deny' }),
    /not supported/,
  );
});

test('opt-in export is transactional, stable, preserves conflicts, and removes only owned content', async (t) => {
  const root = await temporaryRoot(t);
  const original = {
    version: 1,
    custom: { unknown: true },
    hooks: { preToolUse: [{ command: 'human-handler', matcher: 'Read' }] },
  };
  await fs.mkdir(path.join(root, '.cursor'), { recursive: true });
  await fs.writeFile(
    path.join(root, CURSOR_IDE_HOOKS_PATH),
    `${JSON.stringify(original, null, 2)}\n`,
  );
  const preview = await planCursorIdeHookExport(root, {
    enabled: true,
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });
  assert.equal(preview.configured, true);
  assert.equal(
    await fs.readFile(path.join(root, CURSOR_IDE_HOOKS_PATH), 'utf8'),
    `${JSON.stringify(original, null, 2)}\n`,
  );
  assert.equal(preview.changes.length, 3);
  assert.equal(preview.backup.protected, true);
  assert.equal(preview.backup.bytes, `${JSON.stringify(original, null, 2)}\n`);
  await applyCursorIdeHookExport(root, {
    enabled: true,
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32',
  });
  const installed = JSON.parse(await fs.readFile(path.join(root, CURSOR_IDE_HOOKS_PATH), 'utf8'));
  assert.deepEqual(installed.custom, { unknown: true });
  assert.equal(installed.hooks.preToolUse[0].command, 'human-handler');
  assert.match(
    await fs.readFile(path.join(root, CURSOR_IDE_HANDLER_PATH), 'utf8'),
    /advisory no-op/,
  );
  assert.equal(
    (
      await planCursorIdeHookExport(root, {
        enabled: true,
        nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
        platform: 'win32',
      })
    ).changes.length,
    0,
  );
  const inspection = await inspectCursorIde({
    root,
    editorCandidates: [],
    launcherCandidates: [],
    trustedWorkspace: false,
  });
  assert.equal(inspection.integrationConfigured.state, 'verified');
  assert.equal(inspection.hookExecution.reason, 'The workspace is not trusted.');

  installed.custom.localEdit = 'preserve';
  await fs.writeFile(
    path.join(root, CURSOR_IDE_HOOKS_PATH),
    `${JSON.stringify(installed, null, 2)}\n`,
  );
  await applyCursorIdeHookExport(root, { enabled: false });
  const removed = JSON.parse(await fs.readFile(path.join(root, CURSOR_IDE_HOOKS_PATH), 'utf8'));
  assert.deepEqual(removed.custom, { unknown: true, localEdit: 'preserve' });
  assert.deepEqual(removed.hooks.preToolUse, [{ command: 'human-handler', matcher: 'Read' }]);
  await assert.rejects(fs.readFile(path.join(root, CURSOR_IDE_HANDLER_PATH)), /ENOENT/);
  await assert.rejects(fs.readFile(path.join(root, CURSOR_IDE_STATE_PATH)), /ENOENT/);
});

test('edited owned entries block removal and transaction failures restore exact bytes', async (t) => {
  const root = await temporaryRoot(t);
  await applyCursorIdeHookExport(root, {
    enabled: true,
    nodeExecutable: 'node',
    platform: 'linux',
  });
  const before = await fs.readFile(path.join(root, CURSOR_IDE_HOOKS_PATH), 'utf8');
  const edited = JSON.parse(before);
  edited.hooks.stop.at(-1).timeout = 9;
  await fs.writeFile(
    path.join(root, CURSOR_IDE_HOOKS_PATH),
    `${JSON.stringify(edited, null, 2)}\n`,
  );
  await assert.rejects(
    planCursorIdeHookExport(root, { enabled: false }),
    /local edits or is missing/,
  );

  await fs.writeFile(path.join(root, CURSOR_IDE_HOOKS_PATH), before);
  await assert.rejects(
    applyCursorIdeHookExport(root, {
      enabled: false,
      faultBoundary: async (boundary) => {
        if (boundary === 'resource:0') throw new Error('injected Cursor transaction failure');
      },
    }),
    /injected Cursor transaction failure/,
  );
  assert.equal(await fs.readFile(path.join(root, CURSOR_IDE_HOOKS_PATH), 'utf8'), before);
  assert.ok(await fs.readFile(path.join(root, CURSOR_IDE_HANDLER_PATH), 'utf8'));
  assert.ok(await fs.readFile(path.join(root, CURSOR_IDE_STATE_PATH), 'utf8'));
});

test('provider evidence record never claims a real editor session', async () => {
  const record = await fixture('provider-e2e.json');
  assert.equal(record.realEditorSession, false);
  assert.equal(record.claims.configuration, 'verified-offline');
  assert.equal(record.claims.hookObservation, 'unverified');
});

test('a killed hook export remains inspectable and recoverable with exact user bytes', async (t) => {
  const root = await temporaryRoot(t);
  await applyCursorIdeHookExport(root, {
    enabled: true,
    nodeExecutable: 'node',
    platform: 'linux',
  });
  const before = await fs.readFile(path.join(root, CURSOR_IDE_HOOKS_PATH), 'utf8');
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashHelper, root], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 91);
  assert.equal((await inspectCursorIdeRecovery(root)).state, 'pending');
  await recoverCursorIdeIntegration(root);
  assert.equal(await fs.readFile(path.join(root, CURSOR_IDE_HOOKS_PATH), 'utf8'), before);
  assert.equal((await inspectCursorIdeRecovery(root)).state, 'none');
});
