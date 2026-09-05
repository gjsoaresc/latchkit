import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CURSOR_CLI_PROVIDER,
  cursorCliAdapter,
  inspect,
  planInvocation,
  planProjectPermissions,
  planResume,
  translateLifecycleInput,
  translateLifecycleOutput,
} from '../../src/providers/cursor-cli.js';
import { PROVIDERS } from '../../src/providers/registry.js';

const fixture = fileURLToPath(
  new URL('../fixtures/providers/cursor-cli/stream-json.ndjson', import.meta.url),
);
const context = { providerVersion: '1.2.3', projectId: 'p', taskId: 't', sessionId: 's' };

test('registers Cursor CLI with evidence-backed invocation and resume only', () => {
  assert.equal(
    PROVIDERS.find((provider) => provider.id === 'cursor-cli').capabilities.invocation.state,
    'supported',
  );
  assert.equal(CURSOR_CLI_PROVIDER.capabilities.hooks.stop.state, 'unknown');
  assert.equal(cursorCliAdapter.contract.id, 'cursor-cli');
});

test('inspection is bounded and legacy executable selection is explicit', () => {
  assert.deepEqual(inspect().candidates, ['agent']);
  assert.deepEqual(inspect({ allowLegacy: true }).candidates, ['agent', 'cursor-agent']);
  assert.deepEqual(
    inspect().probes.map(({ args }) => args),
    [['--version'], ['--help']],
  );
  assert.equal(inspect().probes[0].timeoutMs, 2_000);
});

test('plans safe interactive, structured, resume, and Windows-compatible vectors without execution', () => {
  assert.deepEqual(
    planInvocation({
      print: true,
      outputFormat: 'stream-json',
      model: 'model with spaces',
      prompt: 'review & preserve "this"',
      cwd: 'C:\\project with spaces',
    }),
    {
      executable: 'agent',
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--model',
        'model with spaces',
        'review & preserve "this"',
      ],
      cwd: 'C:\\project with spaces',
    },
  );
  assert.deepEqual(planResume({ chatId: 'chat-1' }), {
    executable: 'agent',
    args: ['--resume=chat-1'],
  });
  assert.deepEqual(planResume(), { executable: 'agent', args: ['resume'] });
  assert.throws(() => planInvocation({ outputFormat: 'json' }), /requires print/);
});

test('translates partial stream records, stderr, cancellation, and termination', async () => {
  const stream = await readFile(fixture, 'utf8');
  const input = translateLifecycleInput(stream, context);
  assert.equal(input.length, 2);
  assert.equal(input[0].kind, 'turn-completed');
  assert.equal(input[0].correlation.sessionId, 's');
  const output = translateLifecycleOutput(
    { status: 'cancelled', stdout: stream, stderr: 'permission request\n' },
    context,
  );
  assert.equal(output.at(-1).kind, 'interrupted');
  assert.equal(
    output.some((event) => event.payload.stream === 'stderr'),
    true,
  );
});

test('limits project configuration to requested permissions and preserves global scope', () => {
  assert.deepEqual(planProjectPermissions({ allow: ['Shell(git)'], deny: ['Write(.env*)'] }), {
    path: '.cursor/cli.json',
    scope: 'project',
    fields: { permissions: { allow: ['Shell(git)'], deny: ['Write(.env*)'] } },
    preserve:
      'All unrelated settings, credentials, trust state, comments, and global cli-config.json remain untouched.',
    requested: false,
    transaction:
      'Use the registered-resource transaction and ownership layers before applying or removing this file.',
    evidenceUrl: 'https://prod.cursor.com/docs/cli/reference/configuration',
  });
});
