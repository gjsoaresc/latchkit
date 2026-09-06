import { readOptional } from '../../storage.js';
import { withProjectLock } from '../../installer/lock.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  type TransactionInspection,
  inspectTransaction,
  recoverTransaction,
} from '../../installer/transactions.js';
import {
  entryHash,
  McpContractError,
  validateMcpIntegration,
  type McpIntegration,
  type RuntimeMcpGrant,
} from './contracts.js';

const STATE = '.latchkit/mcp-state.json';
const MANIFEST = '.latchkit/manifest.json';
const targets: Record<string, { path: string; transports: readonly string[]; evidence: string }> = {
  claude: {
    path: '.mcp.json',
    transports: ['stdio', 'http', 'sse'],
    evidence: 'https://code.claude.com/docs/en/agent-sdk/mcp',
  },
  codex: { path: '', transports: [], evidence: 'https://developers.openai.com/codex/mcp/' },
  cursor: { path: '', transports: [], evidence: 'https://cursor.com/docs' },
  'cursor-cli': { path: '', transports: [], evidence: 'https://cursor.com/docs' },
  antigravity: {
    path: '',
    transports: [],
    evidence: 'https://antigravity.google/docs/cli/overview',
  },
};
type StateEntry = { provider: string; id: string; path: string; sha256: string };
type State = { schemaVersion: 1; entries: StateEntry[] };
const resourceId = (path: string) => (path === STATE ? 'mcp-state' : `mcp-config:${path}`);

function parseObject(raw: string | null, path: string): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Expected an object.');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new McpContractError(
      `Refusing invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'MCP_JSON_CONFLICT',
    );
  }
}
function parseState(raw: string | null): State {
  const value = parseObject(raw, STATE);
  if (value.schemaVersion === undefined && raw === null) return { schemaVersion: 1, entries: [] };
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries))
    throw new McpContractError('MCP state is invalid.', 'MCP_STATE_INVALID');
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new McpContractError('MCP state entry is invalid.', 'MCP_STATE_INVALID');
    const item = entry as Record<string, unknown>;
    if (
      typeof item.provider !== 'string' ||
      typeof item.id !== 'string' ||
      typeof item.path !== 'string' ||
      typeof item.sha256 !== 'string'
    )
      throw new McpContractError('MCP state entry is invalid.', 'MCP_STATE_INVALID');
    return item as unknown as StateEntry;
  });
  return { schemaVersion: 1, entries };
}
function server(integration: McpIntegration): Record<string, unknown> {
  const env = Object.fromEntries(
    integration.requiredEnvironment.map((name) => [name, `\${${name}}`]),
  );
  if (integration.transport === 'stdio')
    return { type: 'stdio', command: integration.executable, args: integration.args ?? [], env };
  return { type: integration.transport, url: integration.endpoint };
}
function grantFor(
  integration: McpIntegration,
  provider: string,
  grants: readonly RuntimeMcpGrant[],
) {
  const grant = grants.find(
    (item) => item.provider === provider && item.serverId === integration.id,
  );
  if (!grant?.authorized)
    throw new McpContractError(
      `Runtime has not authorized ${integration.id} for ${provider}.`,
      'MCP_RUNTIME_DENIED',
    );
  const requested = integration.toolAllowlist ?? [];
  if (requested.some((tool) => !grant.tools.includes(tool)))
    throw new McpContractError(
      `MCP tool allowlist exceeds the runtime grant for ${provider}.`,
      'MCP_RUNTIME_DENIED',
    );
}
export interface McpPlan {
  changes: Array<{ action: 'create' | 'update' | 'remove' | 'unchanged'; path: string }>;
  diagnostics: Array<{ code: string; provider: string; message: string; evidence: string }>;
}
export async function planManagedMcp(
  root: string,
  values: readonly unknown[],
  grants: readonly RuntimeMcpGrant[] = [],
): Promise<McpPlan> {
  const integrations = values.map(validateMcpIntegration);
  const state = parseState(await readOptional(root, STATE));
  const changes: McpPlan['changes'] = [];
  const diagnostics: McpPlan['diagnostics'] = [];
  const desired = new Map<string, Map<string, McpIntegration>>();
  for (const integration of integrations)
    for (const provider of integration.providers) {
      const target = targets[provider];
      if (!target || !target.transports.includes(integration.transport)) {
        diagnostics.push({
          code: 'MCP_PROVIDER_UNSUPPORTED',
          provider,
          message: `${provider} project MCP serialization is not supported by this release.`,
          evidence: target?.evidence ?? '',
        });
        continue;
      }
      if (!integration.enabled) continue;
      try {
        grantFor(integration, provider, grants);
      } catch (error) {
        diagnostics.push({
          code: error instanceof McpContractError ? error.code : 'MCP_RUNTIME_DENIED',
          provider,
          message: error instanceof Error ? error.message : 'Runtime denied MCP.',
          evidence: target.evidence,
        });
        continue;
      }
      const set = desired.get(provider) ?? new Map<string, McpIntegration>();
      if (set.has(integration.id))
        diagnostics.push({
          code: 'MCP_DUPLICATE_ID',
          provider,
          message: `Duplicate MCP server identity ${integration.id}.`,
          evidence: target.evidence,
        });
      else set.set(integration.id, integration);
      desired.set(provider, set);
    }
  for (const provider of new Set([
    ...desired.keys(),
    ...state.entries.map((entry) => entry.provider),
  ])) {
    const target = targets[provider];
    if (!target?.path) continue;
    const current = parseObject(await readOptional(root, target.path), target.path);
    const servers =
      current.mcpServers === undefined
        ? {}
        : parseObject(JSON.stringify(current.mcpServers), `${target.path}.mcpServers`);
    const nextServers = { ...servers };
    const wanted = desired.get(provider) ?? new Map();
    for (const entry of state.entries.filter((item) => item.provider === provider)) {
      if (entryHash(servers[entry.id]) !== entry.sha256) {
        diagnostics.push({
          code: 'MCP_EDIT_CONFLICT',
          provider,
          message: `Managed MCP server ${entry.id} has local edits.`,
          evidence: target.evidence,
        });
        continue;
      }
      if (!wanted.has(entry.id)) delete nextServers[entry.id];
    }
    for (const [id, integration] of wanted) {
      const known = state.entries.find((entry) => entry.provider === provider && entry.id === id);
      if (servers[id] !== undefined && !known)
        diagnostics.push({
          code: 'MCP_UNOWNED_CONFLICT',
          provider,
          message: `MCP server ${id} already exists and is not managed by Latchkit.`,
          evidence: target.evidence,
        });
      else nextServers[id] = server(integration);
    }
    const next = { ...current, mcpServers: nextServers };
    const before = JSON.stringify(current);
    const after = JSON.stringify(next);
    changes.push({
      action:
        before === after
          ? 'unchanged'
          : (await readOptional(root, target.path)) === null
            ? 'create'
            : 'update',
      path: target.path,
    });
  }
  return { changes: changes.sort((a, b) => a.path.localeCompare(b.path)), diagnostics };
}
export async function applyManagedMcp(
  root: string,
  values: readonly unknown[],
  grants: readonly RuntimeMcpGrant[] = [],
): Promise<McpPlan> {
  return withProjectLock(root, async () => {
    const manifest = await readOptional(root, MANIFEST);
    if (manifest === null)
      throw new McpContractError(
        'Initialize Latchkit before managing project MCP configuration.',
        'MCP_PROJECT_UNINITIALIZED',
      );
    const plan = await planManagedMcp(root, values, grants);
    if (plan.diagnostics.length)
      throw Object.assign(new McpContractError('MCP plan has diagnostics.', 'MCP_PLAN_REFUSED'), {
        diagnostics: plan.diagnostics,
      });
    const integrations = values.map(validateMcpIntegration);
    const stateRaw = await readOptional(root, STATE);
    const old = parseState(stateRaw);
    const entries: StateEntry[] = [];
    if (
      plan.changes.every((change) => change.action === 'unchanged') &&
      stateRaw === null &&
      !old.entries.length
    )
      return plan;
    const changes: Array<{ resourceId: string; bytes: string | null }> = [];
    for (const change of plan.changes)
      if (change.action !== 'unchanged') {
        const current = parseObject(await readOptional(root, change.path), change.path);
        const provider = Object.entries(targets).find(([, item]) => item.path === change.path)?.[0];
        if (!provider) continue;
        const servers =
          current.mcpServers === undefined
            ? {}
            : parseObject(JSON.stringify(current.mcpServers), `${change.path}.mcpServers`);
        const nextServers = { ...servers };
        for (const entry of old.entries.filter((item) => item.provider === provider))
          if (entryHash(servers[entry.id]) === entry.sha256) delete nextServers[entry.id];
        for (const integration of integrations.filter(
          (item) => item.enabled && item.providers.includes(provider),
        ))
          nextServers[integration.id] = server(integration);
        changes.push({
          resourceId: resourceId(change.path),
          bytes: `${JSON.stringify({ ...current, mcpServers: nextServers }, null, 2)}\n`,
        });
      }
    for (const integration of integrations.filter((item) => item.enabled))
      for (const provider of integration.providers)
        if (targets[provider]?.path)
          entries.push({
            provider,
            id: integration.id,
            path: targets[provider].path,
            sha256: entryHash(server(integration)),
          });
    changes.push({
      resourceId: resourceId(STATE),
      bytes: `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`,
    });
    const registry = createResourceRegistry(
      [...new Set([...plan.changes.map((change) => change.path), STATE])].map((path) => ({
        id: resourceId(path),
        path,
      })),
    );
    await applyRegisteredTransaction(root, { operation: 'mcp-sync', registry, changes, manifest });
    return plan;
  });
}
export async function inspectManagedMcpRecovery(
  root: string,
  values: readonly unknown[],
): Promise<TransactionInspection> {
  const integrations = values.map(validateMcpIntegration);
  const paths = new Set([STATE]);
  for (const item of integrations)
    for (const provider of item.providers)
      if (targets[provider]?.path) paths.add(targets[provider].path);
  return inspectTransaction(
    root,
    createResourceRegistry([...paths].map((path) => ({ id: resourceId(path), path }))),
  );
}
export async function recoverManagedMcp(root: string, values: readonly unknown[]) {
  const integrations = values.map(validateMcpIntegration);
  const paths = new Set([STATE]);
  for (const item of integrations)
    for (const provider of item.providers)
      if (targets[provider]?.path) paths.add(targets[provider].path);
  const registry = createResourceRegistry(
    [...paths].map((path) => ({ id: resourceId(path), path })),
  );
  return withProjectLock(root, () => recoverTransaction(root, registry));
}
