import { createHash } from 'node:crypto';
import { isRecord } from '../../types.js';
import { redactString } from '../../diagnostics/redact.js';

export const MCP_INTEGRATION_VERSION = 1;
export const MCP_RUNTIME_REVISION = 'claude-project-mcp-1';
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
  definitionDigest: string;
  runtimeDigest: string;
}
export class McpContractError extends Error {
  readonly code: string;
  constructor(message: string, code = 'MCP_CONFIG_INVALID') {
    super(message);
    this.code = code;
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const entryHash = (entry: unknown) => digest(JSON.stringify(canonical(entry)) ?? 'missing');
export const mcpRuntimeDigest = (contract: unknown) =>
  entryHash({ revision: MCP_RUNTIME_REVISION, contract });

function strings(value: unknown, name: string, pattern?: RegExp): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 4096)
  )
    throw new McpContractError(`${name} must be a non-empty string array.`);
  if (new Set(value).size !== value.length)
    throw new McpContractError(`${name} contains duplicates.`);
  if (pattern && value.some((item) => !pattern.test(item)))
    throw new McpContractError(`${name} contains an unsafe identifier.`);
  return [...value];
}

function safeEndpoint(value: string): string {
  if (value.length > 4096 || /[\r\n\0]/.test(value))
    throw new McpContractError('MCP endpoint is too long or contains control characters.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpContractError('MCP endpoint must be an absolute URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new McpContractError('MCP endpoint must be an unauthenticated HTTP(S) URL.');
  if (url.search || url.hash)
    throw new McpContractError(
      'Endpoint query parameters and fragments are not supported. Use provider-owned authentication.',
    );
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
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new McpContractError('MCP enabled must be boolean.');
  const providers = strings(value.providers, 'providers', ID);
  if (!providers.length) throw new McpContractError('Select at least one MCP provider.');
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
    if (/(^|[\\/])(npx|uvx)(\.cmd|\.exe)?$/i.test(value.executable))
      throw new McpContractError(
        'Package-download launchers are not allowed for managed MCP.',
        'MCP_DOWNLOAD_REFUSED',
      );
    if (value.executable.length > 4096) throw new McpContractError('MCP executable is too long.');
    const args = value.args === undefined ? [] : value.args;
    if (
      !Array.isArray(args) ||
      args.length > 128 ||
      args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || /[\r\n\0]/.test(arg))
    )
      throw new McpContractError(
        'MCP arguments must be a bounded string array without control characters.',
      );
    if (
      [value.executable, ...args].some(
        (arg) =>
          redactString(arg) !== arg ||
          /(?:^|--)(?:token|password|secret|api[-_]?key|authorization)(?:$|=)/i.test(arg),
      )
    )
      throw new McpContractError(
        'Use requiredEnvironment names for credentials, never command arguments.',
      );
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
      enabled: value.enabled === true,
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
    enabled: value.enabled === true,
  };
}

/** Grants authorize this exact configuration, not provider tools or permissions. */
export function assertMcpActivation(
  integration: McpIntegration,
  provider: string,
  runtimeDigest: string,
  grants: readonly RuntimeMcpGrant[],
): void {
  const grant = grants.find(
    (item) => item.provider === provider && item.serverId === integration.id,
  );
  if (
    !integration.enabled ||
    !grant?.authorized ||
    grant.definitionDigest !== entryHash(integration) ||
    grant.runtimeDigest !== runtimeDigest
  )
    throw new McpContractError(
      'The exact MCP definition and runtime contract require explicit local authorization.',
      'MCP_RUNTIME_DENIED',
    );
  // Exporting an allowlist alone cannot enforce the permissions of a provider-owned session.
  if (integration.toolAllowlist !== undefined)
    throw new McpContractError(
      'Managed MCP tool allowlists are unsupported until the provider runtime can enforce them.',
      'MCP_TOOL_POLICY_UNSUPPORTED',
    );
}
