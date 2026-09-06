import { readOptional } from '../../storage.js';
import { isRecord } from '../../types.js';
import { providerById } from '../../providers/registry.js';
import type { ProviderContract } from '../../providers/contracts.js';
import { withProjectLock } from '../../installer/lock.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  inspectTransaction,
  recoverTransaction,
  type TransactionInput,
} from '../../installer/transactions.js';
import {
  assertMcpActivation,
  entryHash,
  mcpRuntimeDigest,
  McpContractError,
  validateMcpIntegration,
  type McpIntegration,
  type RuntimeMcpGrant,
} from './contracts.js';

const STATE = '.latchkit/mcp-state.json';
const MANIFEST = '.latchkit/manifest.json';
const TARGET = '.mcp.json';
const EVIDENCE = 'https://code.claude.com/docs/en/mcp';
const registry = createResourceRegistry([
  { id: 'mcp-state', path: STATE },
  { id: 'mcp-config:.mcp.json', path: TARGET },
]);
type StateEntry = {
  provider: 'claude';
  id: string;
  path: typeof TARGET;
  sha256: string;
  definition?: McpIntegration;
  runtimeDigest?: string;
};
type State = { schemaVersion: 1; entries: StateEntry[]; createdConfig?: boolean };
type Diagnostic = { code: string; provider: string; message: string; evidence: string };
export interface McpPlan {
  changes: Array<{ action: 'create' | 'update' | 'remove' | 'unchanged'; path: string }>;
  definitions: McpIntegration[];
  diagnostics: Diagnostic[];
  implications: string[];
  missingEnvironment: string[];
}
function parseObject(raw: string | null, label: string): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
  } catch {
    /* Never reflect malformed file content in diagnostics. */
  }
  throw new McpContractError(`Refusing invalid JSON in ${label}.`, 'MCP_JSON_CONFLICT');
}
function parseState(raw: string | null): State {
  if (raw === null) return { schemaVersion: 1, entries: [] };
  const value = parseObject(raw, STATE);
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries) ||
    Object.keys(value).some(
      (key) => !['schemaVersion', 'entries', 'createdConfig'].includes(key),
    ) ||
    (value.createdConfig !== undefined && typeof value.createdConfig !== 'boolean')
  )
    throw new McpContractError('MCP ownership state is invalid.', 'MCP_STATE_INVALID');
  const ids = new Set();
  const entries = value.entries.map((item): StateEntry => {
    if (
      !isRecord(item) ||
      item.provider !== 'claude' ||
      item.path !== TARGET ||
      typeof item.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(item.id) ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      ids.has(item.id) ||
      Object.keys(item).some(
        (key) => !['provider', 'path', 'id', 'sha256', 'definition', 'runtimeDigest'].includes(key),
      )
    )
      throw new McpContractError('MCP ownership entry is invalid.', 'MCP_STATE_INVALID');
    ids.add(item.id);
    const definition =
      item.definition === undefined ? undefined : validateMcpIntegration(item.definition);
    if (
      (definition &&
        (definition.id !== item.id ||
          !definition.enabled ||
          !definition.providers.includes('claude'))) ||
      (item.runtimeDigest !== undefined &&
        (typeof item.runtimeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.runtimeDigest)))
    )
      throw new McpContractError('MCP authorization record is invalid.', 'MCP_STATE_INVALID');
    return {
      provider: 'claude',
      id: item.id,
      path: TARGET,
      sha256: item.sha256,
      ...(definition ? { definition } : {}),
      ...(typeof item.runtimeDigest === 'string' ? { runtimeDigest: item.runtimeDigest } : {}),
    };
  });
  return {
    schemaVersion: 1,
    entries,
    ...(value.createdConfig === true ? { createdConfig: true } : {}),
  };
}
function serversFrom(current: Record<string, unknown>) {
  if (current.mcpServers === undefined) return {};
  if (!isRecord(current.mcpServers))
    throw new McpContractError('mcpServers must be a JSON object.', 'MCP_JSON_CONFLICT');
  return current.mcpServers;
}
function server(integration: McpIntegration): Record<string, unknown> {
  if (integration.transport === 'stdio')
    return {
      type: 'stdio',
      command: integration.executable,
      args: integration.args ?? [],
      env: Object.fromEntries(integration.requiredEnvironment.map((name) => [name, `\${${name}}`])),
    };
  return { type: integration.transport, url: integration.endpoint };
}
export function authorizeManagedMcp(
  values: readonly unknown[],
  locallyAuthorized: boolean,
): RuntimeMcpGrant[] {
  if (!locallyAuthorized) return [];
  return values.map(validateMcpIntegration).flatMap((integration) =>
    integration.providers.map((provider) => ({
      provider,
      serverId: integration.id,
      authorized: true,
      definitionDigest: entryHash(integration),
      runtimeDigest: mcpRuntimeDigest(providerById(provider)),
    })),
  );
}
function environmentMissing(
  integrations: readonly McpIntegration[],
  environment: NodeJS.ProcessEnv,
) {
  return [
    ...new Set(
      integrations.flatMap((item) => item.requiredEnvironment).filter((name) => !environment[name]),
    ),
  ].sort();
}
async function buildPlan(
  root: string,
  values: readonly unknown[],
  grants: readonly RuntimeMcpGrant[],
  environment: NodeJS.ProcessEnv,
) {
  const integrations = values.map(validateMcpIntegration);
  const stateRaw = await readOptional(root, STATE);
  const old = parseState(stateRaw);
  const raw = await readOptional(root, TARGET);
  const current = parseObject(raw, TARGET);
  const servers = serversFrom(current);
  const nextServers = { ...servers };
  const diagnostics: Diagnostic[] = [];
  const diagnostic = (code: string, provider: string, message: string) =>
    diagnostics.push({ code, provider, message, evidence: EVIDENCE });
  const wanted = new Map<string, McpIntegration>();
  const missingEnvironment = environmentMissing(integrations, environment);
  const ids = new Set<string>();
  for (const integration of integrations) {
    if (ids.has(integration.id))
      diagnostic('MCP_DUPLICATE_ID', 'claude', 'MCP server IDs must be unique.');
    ids.add(integration.id);
    for (const provider of integration.providers) {
      if (provider !== 'claude') {
        diagnostic(
          'MCP_PROVIDER_UNSUPPORTED',
          provider,
          'This provider has no reviewed managed project MCP serializer.',
        );
        continue;
      }
      if (!integration.enabled) continue;
      try {
        assertMcpActivation(
          integration,
          provider,
          mcpRuntimeDigest(providerById(provider)),
          grants,
        );
        if (integration.transport !== 'stdio' && integration.requiredEnvironment.length)
          throw new McpContractError(
            'HTTP/SSE credential references are unsupported; configure provider authentication separately.',
            'MCP_AUTH_UNSUPPORTED',
          );
        if (integration.requiredEnvironment.some((name) => !environment[name]))
          throw new McpContractError(
            'Required MCP environment variables are missing. Inspect missingEnvironment names.',
            'MCP_ENVIRONMENT_MISSING',
          );
        wanted.set(integration.id, integration);
      } catch (error) {
        diagnostic(
          error instanceof McpContractError ? error.code : 'MCP_RUNTIME_DENIED',
          provider,
          error instanceof McpContractError ? error.message : 'MCP activation refused.',
        );
      }
    }
  }
  for (const entry of old.entries) {
    if (entryHash(servers[entry.id]) !== entry.sha256)
      diagnostic(
        'MCP_EDIT_CONFLICT',
        entry.provider,
        `Managed MCP server ${entry.id} has local edits.`,
      );
    else delete nextServers[entry.id];
  }
  for (const [id, integration] of wanted) {
    if (Object.hasOwn(servers, id) && !old.entries.some((item) => item.id === id))
      diagnostic(
        'MCP_UNOWNED_CONFLICT',
        'claude',
        `MCP server ${id} already exists and is not Latchkit-owned.`,
      );
    else nextServers[id] = server(integration);
  }
  const next = { ...current, mcpServers: nextServers };
  const entries: StateEntry[] = [...wanted.values()].map((definition) => ({
    provider: 'claude',
    id: definition.id,
    path: TARGET,
    sha256: entryHash(server(definition)),
    definition,
    runtimeDigest: mcpRuntimeDigest(providerById('claude')),
  }));
  const createdConfig = old.createdConfig === true || raw === null;
  const nextRaw =
    !entries.length &&
    createdConfig &&
    !Object.keys(nextServers).length &&
    Object.keys(current).every((key) => key === 'mcpServers')
      ? null
      : entryHash(current) === entryHash(next)
        ? raw
        : `${JSON.stringify(next, null, 2)}\n`;
  // An inert new definition must not materialize an empty provider file.
  const bytes = !entries.length && raw === null ? null : nextRaw;
  const stateBytes = entries.length
    ? `${JSON.stringify({ schemaVersion: 1, entries, ...(createdConfig ? { createdConfig: true } : {}) }, null, 2)}\n`
    : null;
  const plan: McpPlan = {
    changes:
      raw === bytes
        ? []
        : [
            {
              path: TARGET,
              action: bytes === null ? 'remove' : raw === null ? 'create' : 'update',
            },
          ],
    definitions: integrations,
    diagnostics,
    implications: integrations
      .filter((item) => item.enabled)
      .map((item) =>
        item.transport === 'stdio'
          ? `${item.id}: a provider may execute this program with the provider's existing permissions; Latchkit does not download or start it.`
          : `${item.id}: a provider may connect to this endpoint; authentication and tool approval remain provider-owned.`,
      ),
    missingEnvironment,
  };
  return { plan, raw, stateRaw, bytes, stateBytes };
}
export async function planManagedMcp(
  root: string,
  values: readonly unknown[],
  grants: readonly RuntimeMcpGrant[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<McpPlan> {
  return (await buildPlan(root, values, grants, environment)).plan;
}

/** Binds a reviewed console plan to the managed resources only. It deliberately excludes
 * unrelated project files and never exposes configuration bytes to API consumers. */
export async function managedMcpSnapshotDigest(root: string): Promise<string> {
  return entryHash({
    config: await readOptional(root, TARGET),
    state: await readOptional(root, STATE),
  });
}
export async function applyManagedMcp(
  root: string,
  values: readonly unknown[],
  grants: readonly RuntimeMcpGrant[] = [],
  options: {
    environment?: NodeJS.ProcessEnv;
    faultBoundary?: TransactionInput['faultBoundary'];
    expectedSnapshotDigest?: string;
    expectedPlanDigest?: string;
  } = {},
): Promise<McpPlan> {
  return withProjectLock(root, async () => {
    const manifest = await readOptional(root, MANIFEST);
    if (manifest === null)
      throw new McpContractError(
        'Initialize and sync Latchkit before managing MCP.',
        'MCP_PROJECT_UNINITIALIZED',
      );
    const built = await buildPlan(root, values, grants, options.environment ?? process.env);
    const snapshotDigest = entryHash({ config: built.raw, state: built.stateRaw });
    if (
      (options.expectedSnapshotDigest !== undefined &&
        options.expectedSnapshotDigest !== snapshotDigest) ||
      (options.expectedPlanDigest !== undefined &&
        options.expectedPlanDigest !== entryHash(built.plan))
    )
      throw new McpContractError(
        'The reviewed MCP preview no longer matches the managed configuration. Review it again.',
        'MCP_EDIT_CONFLICT',
      );
    if (built.plan.diagnostics.length)
      throw Object.assign(
        new McpContractError(
          'MCP plan has diagnostics. Run mcp preview for details.',
          'MCP_PLAN_REFUSED',
        ),
        { diagnostics: built.plan.diagnostics },
      );
    if (
      built.raw !== (await readOptional(root, TARGET)) ||
      built.stateRaw !== (await readOptional(root, STATE))
    )
      throw new McpContractError(
        'MCP configuration changed during planning. Retry preview.',
        'MCP_EDIT_CONFLICT',
      );
    const changes = [
      ...(built.raw !== built.bytes
        ? [{ resourceId: 'mcp-config:.mcp.json', bytes: built.bytes }]
        : []),
      ...(built.stateRaw !== built.stateBytes
        ? [{ resourceId: 'mcp-state', bytes: built.stateBytes }]
        : []),
    ];
    if (changes.length)
      await applyRegisteredTransaction(root, {
        operation: 'mcp-sync',
        registry,
        changes,
        manifest,
        faultBoundary: options.faultBoundary,
      });
    return built.plan;
  });
}
export async function inspectManagedMcp(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const state = parseState(await readOptional(root, STATE));
  const servers = serversFrom(parseObject(await readOptional(root, TARGET), TARGET));
  return {
    integrations: state.entries.map((entry) => ({
      id: entry.id,
      provider: entry.provider,
      configured: Object.hasOwn(servers, entry.id),
      enabled: entryHash(servers[entry.id]) === entry.sha256,
      authorized: Boolean(
        entry.definition &&
        entry.runtimeDigest === mcpRuntimeDigest(providerById(entry.provider)) &&
        entryHash(server(entry.definition)) === entry.sha256,
      ),
      definition: entry.definition,
      missingEnvironment: entry.definition
        ? environmentMissing([entry.definition], environment)
        : [],
    })),
  };
}
/** Called by the process runner immediately before launching provider-owned sessions.
 * It grants no tools; provider trust/authentication/permissions are retained. */
export async function assertManagedMcpRuntime(
  root: string,
  contract: ProviderContract,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (contract.id !== 'claude') return;
  const state = parseState(await readOptional(root, STATE));
  const entries = state.entries.filter((entry) => entry.provider === contract.id);
  if (!entries.length) return;
  const servers = serversFrom(parseObject(await readOptional(root, TARGET), TARGET));
  for (const entry of entries) {
    if (
      !entry.definition ||
      entry.runtimeDigest !== mcpRuntimeDigest(contract) ||
      entryHash(servers[entry.id]) !== entry.sha256 ||
      entryHash(server(entry.definition)) !== entry.sha256
    )
      throw new McpContractError(
        'Managed MCP configuration or runtime contract changed. Remove it or explicitly authorize the reviewed definition again.',
        'MCP_RUNTIME_DENIED',
      );
    assertMcpActivation(entry.definition, entry.provider, mcpRuntimeDigest(contract), [
      {
        provider: entry.provider,
        serverId: entry.id,
        authorized: true,
        definitionDigest: entryHash(entry.definition),
        runtimeDigest: entry.runtimeDigest,
      },
    ]);
    if (environmentMissing([entry.definition], environment).length)
      throw new McpContractError(
        'Managed MCP required environment variables are missing.',
        'MCP_ENVIRONMENT_MISSING',
      );
  }
}
export async function inspectManagedMcpRecovery(root: string) {
  return inspectTransaction(root, registry);
}
export async function recoverManagedMcp(root: string) {
  return withProjectLock(root, () => recoverTransaction(root, registry));
}
