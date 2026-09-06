import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  applyManagedMcp,
  planManagedMcp,
  authorizeManagedMcp,
  inspectManagedMcp,
  assertManagedMcpRuntime,
  inspectManagedMcpRecovery,
  recoverManagedMcp,
} from '../dist/src/integrations/mcp/managed.js';
import { validateMcpIntegration } from '../dist/src/integrations/mcp/contracts.js';
import { checkManagedMcpHealth } from '../dist/src/integrations/mcp/health.js';
import { providerById } from '../dist/src/providers/registry.js';
import { runProviderProcess } from '../dist/src/runtime/process-runner.js';
const execute = promisify(execFile);
const cli = path.resolve('dist/src/cli.js');
const integration = (enabled = true) => ({
  schemaVersion: 1,
  id: 'fixture',
  transport: 'stdio',
  executable: 'fixture-mcp',
  args: ['--serve'],
  providers: ['claude'],
  scope: 'project',
  requiredEnvironment: [],
  enabled,
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-mcp-'));
  await fs.mkdir(path.join(root, '.latchkit'));
  await fs.writeFile(
    path.join(root, '.latchkit/manifest.json'),
    '{"schemaVersion":3,"files":{},"packs":[],"sections":{}}\n',
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const apply = (root, definitions, options) =>
  applyManagedMcp(root, definitions, authorizeManagedMcp(definitions, true), options);

test('new MCP defaults disabled; file declarations cannot authorize activation', async (t) => {
  const root = await fixture(t);
  const disabled = integration();
  delete disabled.enabled;
  assert.equal(validateMcpIntegration(disabled).enabled, false);
  await applyManagedMcp(root, [disabled]);
  await assert.rejects(fs.readFile(path.join(root, '.mcp.json')), { code: 'ENOENT' });
  assert.equal(
    (await planManagedMcp(root, [integration()])).diagnostics[0].code,
    'MCP_RUNTIME_DENIED',
  );
  await assert.rejects(applyManagedMcp(root, [integration()]), { code: 'MCP_PLAN_REFUSED' });
  const health = await checkManagedMcpHealth(root, 'fixture');
  assert.deepEqual(health, {
    configured: false,
    enabled: false,
    connected: false,
    toolsDiscovered: false,
    tools: [],
    reason: 'disabled-or-unauthorized',
  });
});

test('authorization binds exact configuration and runtime policy; unsupported narrowing refuses activation', async (t) => {
  const root = await fixture(t);
  const initial = integration();
  const grants = authorizeManagedMcp([initial], true);
  for (const changed of [
    { ...initial, executable: 'privileged-program' },
    { ...initial, args: ['--unsafe'] },
    { ...initial, requiredEnvironment: ['OTHER_TOKEN'] },
  ])
    assert.equal(
      (await planManagedMcp(root, [changed], grants)).diagnostics[0].code,
      'MCP_RUNTIME_DENIED',
    );
  assert.equal(
    (await planManagedMcp(root, [initial], [{ ...grants[0], runtimeDigest: 'a'.repeat(64) }]))
      .diagnostics[0].code,
    'MCP_RUNTIME_DENIED',
  );
  const narrowed = { ...initial, toolAllowlist: ['read'] };
  assert.equal(
    (await planManagedMcp(root, [narrowed], authorizeManagedMcp([narrowed], true))).diagnostics[0]
      .code,
    'MCP_TOOL_POLICY_UNSUPPORTED',
  );
  assert.equal(
    (await planManagedMcp(root, [{ ...initial, providers: ['codex'] }])).diagnostics[0].code,
    'MCP_RUNTIME_DENIED',
  );
});

test('missing credential names are reported without values; unsupported HTTP auth and unsafe inputs fail closed', async (t) => {
  const root = await fixture(t);
  const definition = { ...integration(), requiredEnvironment: ['FIXTURE_TOKEN'] };
  const grants = authorizeManagedMcp([definition], true);
  const missing = await planManagedMcp(root, [definition], grants, {});
  assert.equal(missing.diagnostics[0].code, 'MCP_ENVIRONMENT_MISSING');
  assert.deepEqual(missing.missingEnvironment, ['FIXTURE_TOKEN']);
  await applyManagedMcp(root, [definition], grants, {
    environment: { FIXTURE_TOKEN: 'test-secret-value' },
  });
  const bytes = await fs.readFile(path.join(root, '.mcp.json'), 'utf8');
  assert.ok(bytes.includes('${FIXTURE_TOKEN}'));
  assert.ok(!bytes.includes('test-secret-value'));
  await assert.rejects(assertManagedMcpRuntime(root, providerById('claude'), {}), {
    code: 'MCP_ENVIRONMENT_MISSING',
  });
  for (const executable of ['npx', 'C:\\tools\\npx.cmd', '/usr/bin/uvx'])
    assert.throws(() => validateMcpIntegration({ ...integration(), executable }), {
      code: 'MCP_DOWNLOAD_REFUSED',
    });
  assert.throws(
    () => validateMcpIntegration({ ...integration(), args: ['--token', 'do-not-echo'] }),
    /credentials/,
  );
  assert.throws(() => validateMcpIntegration({ ...integration(), providers: [] }), /at least one/);
  const httpDefinition = {
    schemaVersion: 1,
    id: 'http',
    transport: 'http',
    endpoint: 'http://127.0.0.1/mcp',
    providers: ['claude'],
    scope: 'project',
    requiredEnvironment: ['FIXTURE_TOKEN'],
    enabled: true,
  };
  assert.equal(
    (await planManagedMcp(root, [httpDefinition], authorizeManagedMcp([httpDefinition], true)))
      .diagnostics[0].code,
    'MCP_AUTH_UNSUPPORTED',
  );
  for (const endpoint of [
    'https://example.com/mcp?code=do-not-echo',
    'https://secret@example.com/mcp',
    'https://example.com/#do-not-echo',
  ])
    assert.throws(
      () => validateMcpIntegration({ ...httpDefinition, endpoint }),
      /endpoint|Endpoint/i,
    );
});

test('managed subentries preserve subsequent unrelated edits and remove only their owned server', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, '.mcp.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      unknown: { retain: true },
      mcpServers: { personal: { command: 'personal' } },
    }),
  );
  await apply(root, [integration()]);
  const configured = JSON.parse(await fs.readFile(file, 'utf8'));
  configured.unknown.retain = 'edited by user';
  configured.mcpServers.personal.extra = { retain: true };
  configured.mcpServers.other = { url: 'https://user.example' };
  await fs.writeFile(file, JSON.stringify(configured));
  await applyManagedMcp(root, []);
  delete configured.mcpServers.fixture;
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), configured);
  await assert.rejects(fs.readFile(path.join(root, '.latchkit/mcp-state.json')), {
    code: 'ENOENT',
  });
});

test('owned-entry edits and collisions block overwrite; unchanged original files are removed reversibly', async (t) => {
  const root = await fixture(t);
  await apply(root, [integration()]);
  await applyManagedMcp(root, []);
  await assert.rejects(fs.readFile(path.join(root, '.mcp.json')), { code: 'ENOENT' });
  await apply(root, [integration()]);
  const configured = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
  configured.mcpServers.fixture.args = ['--user-change'];
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify(configured));
  await assert.rejects(applyManagedMcp(root, []), { code: 'MCP_PLAN_REFUSED' });
  await assert.rejects(apply(root, [integration()]), { code: 'MCP_PLAN_REFUSED' });
  assert.equal((await inspectManagedMcp(root)).integrations[0].enabled, false);
  const other = await fixture(t);
  await fs.writeFile(path.join(other, '.mcp.json'), JSON.stringify(configured));
  assert.equal(
    (await planManagedMcp(other, [integration()], authorizeManagedMcp([integration()], true)))
      .diagnostics[0].code,
    'MCP_UNOWNED_CONFLICT',
  );
});

test('the provider process boundary denies changed configuration or a privileged runtime upgrade before spawning', async (t) => {
  const root = await fixture(t);
  await apply(root, [integration()]);
  const provider = providerById('claude');
  await assertManagedMcpRuntime(root, provider);
  const changed = structuredClone(provider);
  changed.capabilities.invocation.reason += ' changed authorization semantics';
  let spawned = false;
  const options = {
    plan: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    executionProfile: 'host-local-authorized',
    onEvent: () => {
      spawned = true;
    },
  };
  assert.equal(
    (await runProviderProcess({ ...options, provider: changed })).code,
    'MCP_RUNTIME_DENIED',
  );
  assert.equal(spawned, false);
  const config = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
  config.mcpServers.fixture.command = 'privileged-program';
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify(config));
  assert.equal((await runProviderProcess({ ...options, provider })).code, 'MCP_RUNTIME_DENIED');
  assert.equal(spawned, false);
});

test('MCP multi-resource failures roll back exact bytes and recover without imported definitions', async (t) => {
  const root = await fixture(t);
  const original = '{ "unknown": true, "mcpServers": {} }\r\n';
  await fs.writeFile(path.join(root, '.mcp.json'), original);
  for (const failAt of ['journal', 'resource:0', 'resource:1']) {
    await assert.rejects(
      apply(root, [integration()], {
        faultBoundary: (boundary) => {
          if (boundary === failAt) throw new Error('injected-fault');
        },
      }),
      /injected-fault/,
    );
    assert.equal(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'), original);
    assert.equal(
      (await inspectManagedMcpRecovery(root)).state,
      failAt === 'journal' ? 'pending' : 'none',
    );
    assert.equal(
      (await recoverManagedMcp(root)).state,
      failAt === 'journal' ? 'rolled-back' : 'none',
    );
  }
});

test('MCP preflight uses the replacement environment actually delivered to the provider child', async (t) => {
  const root = await fixture(t);
  await apply(root, [{ ...integration(), requiredEnvironment: ['ANTHROPIC_API_KEY'] }], {
    environment: { ANTHROPIC_API_KEY: 'fixture-inherited-key' },
  });
  const result = await execute(
    process.execPath,
    [path.resolve('test/fixtures/processes/environment-driver.js'), 'replace', root],
    { env: { ...process.env, ANTHROPIC_API_KEY: 'fixture-inherited-key' }, timeout: 10000 },
  );
  assert.deepEqual(JSON.parse(result.stdout), { status: 'refused', code: 'MCP_RUNTIME_DENIED' });
});

test('CLI preview/apply/inspect/health/remove exposes an explicit usable local configuration flow', async (t) => {
  const root = await fixture(t);
  const input = path.join(root, 'mcp-input.json');
  await fs.writeFile(input, JSON.stringify(integration()));
  const command = (...args) =>
    execute(process.execPath, [cli, 'mcp', ...args, '--project', root], { timeout: 15000 });
  await assert.rejects(command('apply', '--file', input), (error) => {
    assert.match(error.stderr, /MCP_PLAN_REFUSED/);
    return true;
  });
  await assert.rejects(command('preview', '--file', input), (error) => {
    assert.equal(JSON.parse(error.stdout).diagnostics[0].code, 'MCP_RUNTIME_DENIED');
    return true;
  });
  const preview = JSON.parse(
    (await command('apply', '--file', input, '--authorized', '--dry-run')).stdout,
  );
  assert.equal(preview.changes[0].action, 'create');
  assert.equal(preview.definitions[0].executable, 'fixture-mcp');
  await assert.rejects(fs.readFile(path.join(root, '.mcp.json')), { code: 'ENOENT' });
  await command('apply', '--file', input, '--authorized');
  assert.equal(JSON.parse((await command('inspect')).stdout).integrations[0].enabled, true);
  assert.equal(
    JSON.parse((await command('health', '--id', 'fixture')).stdout).reason,
    'transport-unsupported',
  );
  await command('remove');
  assert.equal(JSON.parse((await command('inspect')).stdout).integrations.length, 0);
});
