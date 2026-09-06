import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyCodexManagedMcp,
  assertCodexManagedMcpRuntime,
  codexMcpQualification,
  planCodexManagedMcp,
} from '../dist/src/integrations/mcp/codex.js';

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
  const plan = await planCodexManagedMcp(root, [definition()], version);
  assert.deepEqual(plan.diagnostics, []);
  await applyCodexManagedMcp(root, [definition()], version);
  const config = await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8');
  assert.match(config, /model = "gpt-5"/);
  assert.match(config, /\[mcp_servers\.personal\]/);
  assert.match(config, /\[mcp_servers\.fixture\]/);
  assert.match(config, /env_vars = \["FIXTURE_TOKEN"\]/);
  assert.match(config, /enabled_tools = \["read"\]/);
  assert.match(config, /enabled = true/);
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
    version,
  );
  assert.equal(rejected.diagnostics[0].code, 'MCP_TRANSPORT_UNSUPPORTED');
  await applyCodexManagedMcp(root, [definition()], version);
  await assertCodexManagedMcpRuntime(root, version);
  const before = await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8');
  await assert.rejects(applyCodexManagedMcp(root, [definition()], 'codex-cli 0.153.3'), {
    code: 'MCP_RUNTIME_DENIED',
  });
  await assert.rejects(assertCodexManagedMcpRuntime(root, 'codex-cli 0.153.3'), {
    code: 'MCP_RUNTIME_DENIED',
  });
  assert.equal(await fs.readFile(path.join(root, '.codex/config.toml'), 'utf8'), before);
});
