import { isRecord } from '../../types.js';
import { McpContractError, validateMcpIntegration } from './contracts.js';
import { inspectManagedMcp } from './managed.js';

const PROTOCOL = '2025-06-18';
const MAX_BYTES = 64 * 1024;
const MAX_TOOLS = 256;
export interface McpHealthResult {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  toolsDiscovered: boolean;
  tools: string[];
  reason?: string;
  missingEnvironment?: string[];
}
interface HealthOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
function localEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new McpContractError(
      'Health endpoint must be an absolute loopback HTTP URL.',
      'MCP_HEALTH_REFUSED',
    );
  }
  // Literal loopback addresses avoid trusting DNS resolution of a hostname.
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new McpContractError(
      'Health checks require a literal loopback HTTP(S) endpoint without credentials, query, or fragment.',
      'MCP_HEALTH_REFUSED',
    );
  return url;
}
function responseObject(value: unknown, id: number): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.jsonrpc !== '2.0' ||
    value.id !== id ||
    !isRecord(value.result) ||
    Object.hasOwn(value, 'error')
  )
    throw new Error('malformed-response');
  return value.result;
}
async function readRpc(response: Response, id: number): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status >= 300 && response.status < 400 ? 'redirect-refused' : 'http-error',
    );
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (!['application/json', 'text/event-stream'].includes(contentType ?? '') || !response.body) {
    await response.body?.cancel();
    throw new Error('unsupported-response');
  }
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_BYTES) {
    await response.body.cancel();
    throw new Error('response-limit');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error('response-limit');
      text += decoder.decode(next.value, { stream: true });
      if (contentType === 'text/event-stream') {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(text))) {
          const event = text.slice(0, boundary.index);
          text = text.slice(boundary.index + boundary[0].length);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const message: unknown = JSON.parse(data);
          if (isRecord(message) && message.id === id) return responseObject(message, id);
          // Notifications are ignored; server requests are unsupported, never dispatched.
          if (!isRecord(message) || message.jsonrpc !== '2.0')
            throw new Error('malformed-response');
        }
      }
    }
    text += decoder.decode();
    if (contentType !== 'application/json') throw new Error('malformed-response');
    return responseObject(JSON.parse(text), id);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Explicit diagnostic only: no executable launch, auth header, tool call, or redirect. */
export async function checkLocalMcpHealth(
  endpoint: string,
  options: HealthOptions = {},
): Promise<McpHealthResult> {
  const url = localEndpoint(endpoint);
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000)
    throw new McpContractError('Health timeout must be 1-5000 ms.', 'MCP_HEALTH_INVALID');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const base: McpHealthResult = {
    configured: true,
    enabled: true,
    connected: false,
    toolsDiscovered: false,
    tools: [],
  };
  let session: string | null = null;
  const request = (message: unknown, initialized = false) =>
    fetch(url, {
      method: 'POST',
      signal,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(initialized ? { 'MCP-Protocol-Version': PROTOCOL } : {}),
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify(message),
    });
  try {
    signal.throwIfAborted();
    const initial = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'latchkit-health', version: '1' },
      },
    });
    session = initial.headers.get('mcp-session-id');
    if (session !== null && !/^[\x21-\x7e]{1,256}$/.test(session)) {
      await initial.body?.cancel();
      throw new Error('invalid-session');
    }
    const initialized = await readRpc(initial, 1);
    if (
      initialized.protocolVersion !== PROTOCOL ||
      !isRecord(initialized.capabilities) ||
      !isRecord(initialized.serverInfo) ||
      typeof initialized.serverInfo.name !== 'string' ||
      typeof initialized.serverInfo.version !== 'string'
    )
      throw new Error('protocol-unsupported');
    const notification = await request(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      true,
    );
    await notification.body?.cancel();
    if (notification.status !== 202) throw new Error('initialization-refused');
    base.connected = true;
    if (!isRecord(initialized.capabilities.tools)) return { ...base, reason: 'tools-unsupported' };
    const tools: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const id = page + 2;
      const listed = await readRpc(
        await request(
          { jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} },
          true,
        ),
        id,
      );
      if (
        !Array.isArray(listed.tools) ||
        listed.tools.some(
          (tool) =>
            !isRecord(tool) ||
            typeof tool.name !== 'string' ||
            !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) ||
            !isRecord(tool.inputSchema) ||
            tool.inputSchema.type !== 'object',
        )
      )
        throw new Error('malformed-tools');
      for (const tool of listed.tools) {
        if (tools.includes(tool.name)) throw new Error('malformed-tools');
        tools.push(tool.name);
      }
      if (tools.length > MAX_TOOLS) throw new Error('tools-limit');
      if (listed.nextCursor === undefined) return { ...base, toolsDiscovered: true, tools };
      if (
        typeof listed.nextCursor !== 'string' ||
        listed.nextCursor.length > 1024 ||
        cursors.has(listed.nextCursor)
      )
        throw new Error('pagination-invalid');
      cursor = listed.nextCursor;
      cursors.add(cursor);
    }
    throw new Error('pagination-limit');
  } catch (error) {
    const known = [
      'malformed-response',
      'redirect-refused',
      'http-error',
      'unsupported-response',
      'response-limit',
      'protocol-unsupported',
      'invalid-session',
      'initialization-refused',
      'malformed-tools',
      'tools-limit',
      'pagination-invalid',
      'pagination-limit',
    ];
    return {
      ...base,
      reason: options.signal?.aborted
        ? 'cancelled'
        : timeout.aborted
          ? 'timeout'
          : error instanceof Error && known.includes(error.message)
            ? error.message
            : 'connection-or-response-failed',
    };
  } finally {
    // Best-effort session release shares the original absolute deadline.
    if (session && !signal.aborted) {
      await fetch(url, {
        method: 'DELETE',
        signal,
        redirect: 'manual',
        headers: { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': PROTOCOL },
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    }
  }
}
export async function checkManagedMcpHealth(
  root: string,
  id: string,
  options: HealthOptions = {},
): Promise<McpHealthResult> {
  const inspected = (await inspectManagedMcp(root)).integrations.find((entry) => entry.id === id);
  const base = {
    configured: inspected?.configured ?? false,
    enabled: inspected?.enabled ?? false,
    connected: false,
    toolsDiscovered: false,
    tools: [],
  };
  if (!inspected?.enabled || !inspected.authorized || !inspected.definition)
    return { ...base, reason: 'disabled-or-unauthorized' };
  if (inspected.missingEnvironment.length)
    return {
      ...base,
      missingEnvironment: inspected.missingEnvironment,
      reason: 'environment-missing',
    };
  const definition = validateMcpIntegration(inspected.definition);
  if (definition.transport !== 'http') return { ...base, reason: 'transport-unsupported' };
  return checkLocalMcpHealth(definition.endpoint!, options);
}
