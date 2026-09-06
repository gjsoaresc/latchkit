import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkLocalMcpHealth } from '../dist/src/integrations/mcp/health.js';

async function listening(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

test('MCP health refuses redirects before contacting the destination', async (t) => {
  let reached = 0;
  const destination = await listening(t, (_request, response) => {
    reached += 1;
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 'latchkit-health', result: { tools: [] } }));
  });
  const endpoint = await listening(t, (_request, response) => {
    response.writeHead(307, { location: destination });
    response.end();
  });
  const result = await checkLocalMcpHealth(endpoint);
  assert.equal(result.connected, false);
  assert.equal(reached, 0);
});

test('MCP health does not call tools/list before protocol initialization', async (t) => {
  const methods = [];
  const endpoint = await listening(t, (request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const message = JSON.parse(body);
      methods.push(message.method);
      response.setHeader('content-type', 'application/json');
      if (message.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  const result = await checkLocalMcpHealth(endpoint);
  assert.equal(result.connected, true);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
});

async function rpcFixture(t, handle) {
  const messages = [];
  const endpoint = await listening(t, (request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const message = JSON.parse(body);
      messages.push(message);
      const reply = (result, headers = {}) => {
        response.writeHead(200, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (handle({ request, response, message, reply })) return;
      if (message.method === 'initialize')
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        });
      else if (message.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
      } else reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
    });
  });
  return { endpoint, messages };
}

test('MCP health distinguishes protocol failures, absent tool capability, and malformed tools', async (t) => {
  const malformed = await rpcFixture(t, ({ message, response }) => {
    if (message.method !== 'initialize') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'token=never-echo-this' },
      }),
    );
    return true;
  });
  const rejected = await checkLocalMcpHealth(malformed.endpoint);
  assert.equal(rejected.connected, false);
  assert.equal(rejected.reason, 'malformed-response');
  assert.ok(!JSON.stringify(rejected).includes('never-echo-this'));
  assert.equal(malformed.messages.length, 1);
  const noTools = await rpcFixture(t, ({ message, reply }) => {
    if (message.method !== 'initialize') return false;
    reply({
      protocolVersion: '2025-06-18',
      capabilities: {},
      serverInfo: { name: 'fixture', version: '1' },
    });
    return true;
  });
  const unsupported = await checkLocalMcpHealth(noTools.endpoint);
  assert.equal(unsupported.connected, true);
  assert.equal(unsupported.toolsDiscovered, false);
  assert.equal(unsupported.reason, 'tools-unsupported');
  assert.equal(noTools.messages.length, 2);
  const badTools = await rpcFixture(t, ({ message, reply }) => {
    if (message.method !== 'tools/list') return false;
    reply({ tools: [{ name: 'read' }] });
    return true;
  });
  const bad = await checkLocalMcpHealth(badTools.endpoint);
  assert.equal(bad.connected, true);
  assert.equal(bad.toolsDiscovered, false);
  assert.equal(bad.reason, 'malformed-tools');
});

test('MCP health enforces response bounds, cancellation and one total deadline', async (t) => {
  const big = await rpcFixture(t, ({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('a'.repeat(65537));
    return true;
  });
  assert.equal((await checkLocalMcpHealth(big.endpoint)).reason, 'response-limit');
  const hanging = await rpcFixture(t, () => true);
  assert.equal((await checkLocalMcpHealth(hanging.endpoint, { timeoutMs: 50 })).reason, 'timeout');
  const cancelled = new AbortController();
  cancelled.abort();
  const before = hanging.messages.length;
  assert.equal(
    (await checkLocalMcpHealth(hanging.endpoint, { signal: cancelled.signal })).reason,
    'cancelled',
  );
  assert.equal(hanging.messages.length, before);
  for (const endpoint of [
    'https://example.com/mcp',
    'http://127.0.0.1/mcp?auth=secret',
    'ftp://127.0.0.1/mcp',
    'http://localhost/mcp',
  ])
    await assert.rejects(checkLocalMcpHealth(endpoint), { code: 'MCP_HEALTH_REFUSED' });
});

test('MCP health maintains session/protocol headers and reads bounded SSE responses and pages', async (t) => {
  let listed = 0;
  const fixture = await rpcFixture(t, ({ request, response, message, reply }) => {
    assert.equal(request.headers.accept, 'application/json, text/event-stream');
    if (message.method === 'initialize') {
      reply(
        {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        },
        { 'mcp-session-id': 'credential-free-session' },
      );
      return true;
    }
    assert.equal(request.headers['mcp-session-id'], 'credential-free-session');
    assert.equal(request.headers['mcp-protocol-version'], '2025-06-18');
    if (message.method === 'tools/list') {
      listed += 1;
      const result =
        listed === 1
          ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }], nextCursor: 'second' }
          : { tools: [{ name: 'inspect', inputSchema: { type: 'object' } }] };
      if (listed === 2) assert.equal(message.params.cursor, 'second');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
      );
      return true; // The client must stop after its response, without waiting for EOF.
    }
    return false;
  });
  const result = await checkLocalMcpHealth(fixture.endpoint);
  assert.equal(result.toolsDiscovered, true);
  assert.deepEqual(result.tools, ['read', 'inspect']);
});
