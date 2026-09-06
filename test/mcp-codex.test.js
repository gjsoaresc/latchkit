import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyCodexManagedMcp,
  assertCodexManagedMcpRuntime,
  codexManagedMcpSnapshotDigest,
  codexMcpQualification,
  planCodexManagedMcp,
} from '../dist/src/integrations/mcp/codex.js';
import { inspectManagedMcp } from '../dist/src/integrations/mcp/managed.js';
import { entryHash } from '../dist/src/integrations/mcp/contracts.js';

const version = 'codex-cli 0.153.2';
const definition = (overrides = {}) => ({
  schemaVersion: 1,
  id: 'fixture',
  transport: 'stdio',
  executable: 'fixture-mcp',
  args: ['--serve'],
  providers: ['codex'],
  scope: 'project',
  requiredEnvironment: ['FIXTURE_TOKEN'],
  toolAllowlist: ['read'],
  enabled: true,
  ...overrides,
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-codex-mcp-'));
  await fs.mkdir(path.join(root, '.latchkit'));
  await fs.writeFile(
    path.join(root, '.latchkit/manifest.json'),
    '{"schemaVersion":3,"files":{},"packs":[],"sections":{}}\n',
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Codex MCP qualification is exact and fails closed for unknown or upgraded CLI versions', () => {
  assert.deepEqual(codexMcpQualification(version), {
    version: '0.153.2',
    schema: 'mcp_servers-v1-enabled-tools',
  });
  for (const output of ['codex-cli 0.153.3', 'codex-cli 0.152.9', 'unrecognized'])
    assert.throws(() => codexMcpQualification(output), { code: 'MCP_RUNTIME_DENIED' });
});

test('Codex project serializer preserves user TOML and applies native enabled_tools narrowing', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.codex'));
  await fs.writeFile(
    path.join(root, '.codex/config.toml'),
    '# personal configuration\nmodel = "gpt-5"\n\n[mcp_servers.personal]\ncommand = "personal"\n',
  );
  const plan = await planCodexManagedMcp(root, [definition()], {
    authorized: true,
    versionOutput: version,
  });
  assert.deepEqual(plan.diagnostics, []);
  await applyCodexManagedMcp(root, [definition()], { authorized: true, versionOutput: version });
  const config = await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8');
  assert.match(config, /model = "gpt-5"/);
  assert.match(config, /\[mcp_servers\.personal\]/);
  assert.match(config, /\[mcp_servers\.fixture\]/);
  assert.match(config, /env_vars = \["FIXTURE_TOKEN"\]/);
  assert.match(config, /enabled_tools = \["read"\]/);
  assert.match(config, /enabled = true/);
  assert.deepEqual(
    (await inspectManagedMcp(root)).integrations.map((item) => item.provider),
    ['codex'],
  );
});

test('Codex rejects legacy SSE and preserves tool narrowing and owner state on incompatible upgrade', async (t) => {
  const root = await fixture(t);
  const rejected = await planCodexManagedMcp(
    root,
    [
      definition({
        transport: 'sse',
        endpoint: 'http://127.0.0.1/sse',
        executable: undefined,
        args: undefined,
      }),
    ],
    { authorized: true, versionOutput: version },
  );
  assert.equal(rejected.diagnostics[0].code, 'MCP_TRANSPORT_UNSUPPORTED');
  await applyCodexManagedMcp(root, [definition()], { authorized: true, versionOutput: version });
  await assertCodexManagedMcpRuntime(root, { versionOutput: version });
  const before = await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8');
  await assert.rejects(
    applyCodexManagedMcp(root, [definition()], {
      authorized: true,
      versionOutput: 'codex-cli 0.153.3',
    }),
    {
      code: 'MCP_RUNTIME_DENIED',
    },
  );
  await assert.rejects(assertCodexManagedMcpRuntime(root, { versionOutput: 'codex-cli 0.153.3' }), {
    code: 'MCP_RUNTIME_DENIED',
  });
  assert.equal(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8'), before);
});

test('Codex refuses malformed TOML and never records invalid or duplicate entries as owned', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.codex'));
  const config = path.join(root, '.codex/config.toml');
  await fs.writeFile(config, 'model = [\n');
  await assert.rejects(
    planCodexManagedMcp(root, [definition()], { authorized: true, versionOutput: version }),
    { code: 'MCP_TOML_CONFLICT' },
  );
  await fs.writeFile(config, 'model = nope\n');
  await assert.rejects(
    planCodexManagedMcp(root, [definition()], { authorized: true, versionOutput: version }),
    { code: 'MCP_TOML_CONFLICT' },
  );
  await fs.writeFile(config, 'model = "gpt-5"\n');
  const invalid = definition({
    id: 'legacy',
    transport: 'sse',
    endpoint: 'http://127.0.0.1/sse',
    executable: undefined,
    args: undefined,
  });
  const planned = await planCodexManagedMcp(root, [definition(), invalid, definition()], {
    authorized: true,
    versionOutput: version,
  });
  assert.deepEqual(planned.diagnostics.map((item) => item.code).sort(), [
    'MCP_DUPLICATE_ID',
    'MCP_TRANSPORT_UNSUPPORTED',
  ]);
  await assert.rejects(
    applyCodexManagedMcp(root, [definition(), invalid, definition()], {
      authorized: true,
      versionOutput: version,
    }),
    { code: 'MCP_PLAN_REFUSED' },
  );
  await assert.rejects(fs.readFile(path.join(root, '.latchkit/mcp-codex-state.json')), {
    code: 'ENOENT',
  });
  assert.equal(await fs.readFile(config, 'utf8'), 'model = "gpt-5"\n');
});

test('Codex apply rejects an exact reviewed snapshot that becomes stale', async (t) => {
  const root = await fixture(t);
  const options = { authorized: true, versionOutput: version };
  const plan = await planCodexManagedMcp(root, [definition()], options);
  const snapshot = await codexManagedMcpSnapshotDigest(root);
  await fs.mkdir(path.join(root, '.codex'));
  await fs.writeFile(path.join(root, '.codex/config.toml'), 'model = "changed"\n');
  await assert.rejects(
    applyCodexManagedMcp(root, [definition()], {
      ...options,
      expectedSnapshotDigest: snapshot,
      expectedPlanDigest: entryHash(plan),
    }),
    { code: 'MCP_EDIT_CONFLICT' },
  );
});
