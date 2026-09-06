import { McpContractError } from './contracts.js';
export async function checkLocalMcpHealth(
  endpoint: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
) {
  const url = new URL(endpoint);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new McpContractError(
      'Health checks are limited to explicit localhost endpoints.',
      'MCP_HEALTH_REFUSED',
    );
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000)
    throw new McpContractError('Health timeout must be 1-5000 ms.', 'MCP_HEALTH_INVALID');
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'latchkit-health',
        method: 'tools/list',
        params: {},
      }),
    });
    const body: unknown = await response.json();
    const tools =
      body &&
      typeof body === 'object' &&
      'result' in body &&
      (body as { result?: { tools?: unknown } }).result?.tools;
    return {
      configured: true,
      enabled: true,
      connected: response.ok,
      tools: Array.isArray(tools)
        ? tools
            .filter((tool): tool is { name: string } =>
              Boolean(
                tool &&
                typeof tool === 'object' &&
                typeof (tool as { name?: unknown }).name === 'string',
              ),
            )
            .map((tool) => tool.name)
        : [],
    };
  } catch (error) {
    return {
      configured: true,
      enabled: true,
      connected: false,
      tools: [],
      reason: error instanceof Error ? error.name : 'health-failed',
    };
  }
}
