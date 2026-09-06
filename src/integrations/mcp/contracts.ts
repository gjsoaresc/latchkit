import { createHash } from 'node:crypto';
import { isRecord } from '../../types.js';

export const MCP_INTEGRATION_VERSION = 1;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const TOOL = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;

export type McpTransport = 'stdio' | 'http' | 'sse';
export interface McpIntegration {
  schemaVersion: 1;
  id: string;
  transport: McpTransport;
  endpoint?: string;
  executable?: string;
  args?: string[];
  providers: string[];
  scope: 'project';
  requiredEnvironment: string[];
  toolAllowlist?: string[];
  enabled: boolean;
}
export interface RuntimeMcpGrant {
  provider: string;
  serverId: string;
  authorized: boolean;
  tools: string[];
}
export class McpContractError extends Error {
  readonly code: string;
  constructor(message: string, code = 'MCP_CONFIG_INVALID') {
    super(message);
    this.code = code;
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const entryHash = (entry: unknown) => digest(JSON.stringify(entry));

function strings(value: unknown, name: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
    throw new McpContractError(`${name} must be a non-empty string array.`);
  if (new Set(value).size !== value.length)
    throw new McpContractError(`${name} contains duplicates.`);
  if (pattern && value.some((item) => !pattern.test(item)))
    throw new McpContractError(`${name} contains an unsafe identifier.`);
  return [...value];
}

function safeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpContractError('MCP endpoint must be an absolute URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new McpContractError('MCP endpoint must be an unauthenticated HTTP(S) URL.');
  if ([...url.searchParams.keys()].some((key) => /token|secret|key|password/i.test(key)))
    throw new McpContractError('Credential-like endpoint query parameters are not allowed.');
  return url.toString();
}

/** Configuration is inert by default. This contract carries only environment names,
 * never environment values or OAuth/keychain material. */
export function validateMcpIntegration(value: unknown): McpIntegration {
  if (!isRecord(value)) throw new McpContractError('MCP integration must be an object.');
  const allowed = [
    'schemaVersion',
    'id',
    'transport',
    'endpoint',
    'executable',
    'args',
    'providers',
    'scope',
    'requiredEnvironment',
    'toolAllowlist',
    'enabled',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new McpContractError('MCP integration has an unknown field.');
  if (
    value.schemaVersion !== MCP_INTEGRATION_VERSION ||
    typeof value.id !== 'string' ||
    !ID.test(value.id)
  )
    throw new McpContractError(
      'MCP integration requires schemaVersion 1 and a portable server ID.',
    );
  if (!['stdio', 'http', 'sse'].includes(value.transport as string))
    throw new McpContractError('Unsupported MCP transport.');
  if (value.scope !== 'project')
    throw new McpContractError('Only project-scoped MCP configuration is supported.');
  if (typeof value.enabled !== 'boolean')
    throw new McpContractError('MCP enabled must be boolean.');
  const providers = strings(value.providers, 'providers', ID);
  const requiredEnvironment = strings(value.requiredEnvironment, 'requiredEnvironment', ENV);
  const toolAllowlist =
    value.toolAllowlist === undefined
      ? undefined
      : strings(value.toolAllowlist, 'toolAllowlist', TOOL);
  if (value.transport === 'stdio') {
    if (
      typeof value.executable !== 'string' ||
      !value.executable ||
      /[\r\n\0]/.test(value.executable)
    )
      throw new McpContractError('Stdio MCP requires a direct executable name or path.');
    if (['npx', 'npx.cmd', 'uvx', 'uvx.cmd'].includes(value.executable.toLowerCase()))
      throw new McpContractError(
        'Package-download launchers are not allowed for managed MCP.',
        'MCP_DOWNLOAD_REFUSED',
      );
    const args = value.args === undefined ? [] : strings(value.args, 'args');
    if (args.includes('-y') || args.includes('--yes'))
      throw new McpContractError(
        'Automatic package-install arguments are not allowed.',
        'MCP_DOWNLOAD_REFUSED',
      );
    if (value.endpoint !== undefined)
      throw new McpContractError('Stdio MCP cannot declare an endpoint.');
    return {
      schemaVersion: 1,
      id: value.id,
      transport: 'stdio',
      executable: value.executable,
      args,
      providers,
      scope: 'project',
      requiredEnvironment,
      ...(toolAllowlist ? { toolAllowlist } : {}),
      enabled: value.enabled,
    };
  }
  if (value.executable !== undefined || value.args !== undefined)
    throw new McpContractError('HTTP/SSE MCP cannot declare an executable or arguments.');
  if (typeof value.endpoint !== 'string')
    throw new McpContractError('HTTP/SSE MCP requires an endpoint.');
  return {
    schemaVersion: 1,
    id: value.id,
    transport: value.transport as 'http' | 'sse',
    endpoint: safeEndpoint(value.endpoint),
    providers,
    scope: 'project',
    requiredEnvironment,
    ...(toolAllowlist ? { toolAllowlist } : {}),
    enabled: value.enabled,
  };
}

/** Runtime callers must consult this separately from configuration serialization.
 * A configuration entry cannot grant itself a tool or survive a withdrawn grant. */
export function runtimeAllowsMcpTool(
  value: unknown,
  provider: string,
  tool: string,
  grants: readonly RuntimeMcpGrant[],
): boolean {
  const integration = validateMcpIntegration(value);
  if (!integration.enabled || !integration.providers.includes(provider)) return false;
  if (integration.toolAllowlist && !integration.toolAllowlist.includes(tool)) return false;
  return Boolean(
    grants.find(
      (grant) =>
        grant.provider === provider &&
        grant.serverId === integration.id &&
        grant.authorized &&
        grant.tools.includes(tool),
    ),
  );
}
