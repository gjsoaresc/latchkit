import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { applyManagedMcp, planManagedMcp } from '../dist/src/integrations/mcp/managed.js';
import { checkLocalMcpHealth } from '../dist/src/integrations/mcp/health.js';
import { runtimeAllowsMcpTool } from '../dist/src/integrations/mcp/contracts.js';

const integration = (enabled = true) => ({
  schemaVersion: 1,
  id: 'fixture',
  transport: 'stdio',
  executable: 'fixture-mcp',
  args: ['--serve'],
  providers: ['claude'],
  scope: 'project',
  requiredEnvironment: ['FIXTURE_TOKEN'],
  toolAllowlist: ['read'],
  enabled,
});
const grant = [{ provider: 'claude', serverId: 'fixture', authorized: true, tools: ['read'] }];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-mcp-'));
  await fs.mkdir(path.join(root, '.latchkit'));
  await fs.writeFile(
    path.join(root, '.latchkit', 'manifest.json'),
    '{"schemaVersion":3,"files":{},"packs":[],"sections":{}}\n',
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('disabled and denied MCP definitions are inert, while managed Claude entries preserve unrelated configuration', async (t) => {
  const root = await fixture(t);
  const disabled = await planManagedMcp(root, [integration(false)]);
  assert.deepEqual(disabled.changes, []);
  await applyManagedMcp(root, [integration(false)]);
  await assert.rejects(fs.readFile(path.join(root, '.mcp.json')), { code: 'ENOENT' });
  const denied = await planManagedMcp(root, [integration()], []);
  assert.equal(denied.diagnostics[0].code, 'MCP_RUNTIME_DENIED');
  assert.equal(runtimeAllowsMcpTool(integration(), 'claude', 'read', []), false);
  assert.equal(runtimeAllowsMcpTool(integration(), 'claude', 'write', grant), false);
  assert.equal(runtimeAllowsMcpTool(integration(), 'claude', 'read', grant), true);
  await fs.writeFile(
    path.join(root, '.mcp.json'),
    JSON.stringify(
      { unknown: { retain: true }, mcpServers: { personal: { command: 'personal' } } },
      null,
      2,
    ),
  );
  await applyManagedMcp(root, [integration()], grant);
  const configured = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
  assert.equal(configured.unknown.retain, true);
  assert.equal(configured.mcpServers.personal.command, 'personal');
  assert.equal(configured.mcpServers.fixture.env.FIXTURE_TOKEN, '${FIXTURE_TOKEN}');
  configured.mcpServers.fixture.url = 'http://changed.invalid';
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify(configured));
  await assert.rejects(applyManagedMcp(root, [integration(false)], grant), {
    code: 'MCP_PLAN_REFUSED',
  });
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers.fixture.url,
    'http://changed.invalid',
  );
});

test('unsupported providers and downloads are refused, and explicit localhost health discovery is bounded', async (t) => {
  const root = await fixture(t);
  const unsupported = await planManagedMcp(
    root,
    [{ ...integration(), providers: ['codex'] }],
    grant,
  );
  assert.equal(unsupported.diagnostics[0].code, 'MCP_PROVIDER_UNSUPPORTED');
  await assert.rejects(
    planManagedMcp(
      root,
      [
        {
          ...integration(),
          executable: 'npx',
          args: ['-y', 'bad'],
        },
      ],
      grant,
    ),
    { code: 'MCP_DOWNLOAD_REFUSED' },
  );
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'read' }] } }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const health = await checkLocalMcpHealth(`http://127.0.0.1:${port}/mcp`);
  assert.deepEqual(health, { configured: true, enabled: true, connected: true, tools: ['read'] });
  await assert.rejects(checkLocalMcpHealth('https://example.com/mcp'), {
    code: 'MCP_HEALTH_REFUSED',
  });
});
