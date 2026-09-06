import { readOptional } from '../../storage.js';
import { withProjectLock } from '../../installer/lock.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
  type TransactionInput,
} from '../../installer/transactions.js';
import {
  entryHash,
  McpContractError,
  validateMcpIntegration,
  type McpIntegration,
} from './contracts.js';

/** The exact CLI/schema pair qualified with `codex mcp get --json` on Windows.
 * A later CLI must be deliberately requalified; a config key that gains new
 * semantics must never inherit an earlier local activation grant. */
export const CODEX_MCP_SCHEMA = 'mcp_servers-v1-enabled-tools';
export const CODEX_MCP_QUALIFIED_VERSION = '0.153.2';
export const CODEX_MCP_EVIDENCE = 'https://learn.chatgpt.com/docs/extend/mcp';
const CONFIG = '.codex/config.toml';
const STATE = '.latchkit/mcp-codex-state.json';
const MANIFEST = '.latchkit/manifest.json';
const registry = createResourceRegistry([
  { id: 'mcp-codex-config', path: CONFIG },
  { id: 'mcp-codex-state', path: STATE },
]);

export interface CodexMcpQualification {
  version: string;
  schema: typeof CODEX_MCP_SCHEMA;
}
type StateEntry = {
  id: string;
  sha256: string;
  definition: McpIntegration;
  qualification: CodexMcpQualification;
};
type State = { schemaVersion: 1; entries: StateEntry[]; createdConfig?: boolean };
export type CodexMcpPlan = {
  changes: Array<{ action: 'create' | 'update' | 'remove' | 'unchanged'; path: string }>;
  diagnostics: Array<{ code: string; message: string; evidence: string }>;
  implications: string[];
};

export function codexMcpQualification(versionOutput: unknown): CodexMcpQualification {
  const version = String(versionOutput ?? '').match(
    /(?:codex(?:-cli)?\s+)?v?(\d+\.\d+\.\d+)/i,
  )?.[1];
  if (version !== CODEX_MCP_QUALIFIED_VERSION)
    throw new McpContractError(
      `Codex MCP activation requires qualified CLI ${CODEX_MCP_QUALIFIED_VERSION}; observed ${version ?? 'unknown'}.`,
      'MCP_RUNTIME_DENIED',
    );
  return { version, schema: CODEX_MCP_SCHEMA };
}
export const codexMcpRuntimeDigest = (qualification: CodexMcpQualification) =>
  entryHash({ provider: 'codex', qualification });

function quote(value: string) {
  return JSON.stringify(value);
}
function list(values: readonly string[]) {
  return `[${values.map(quote).join(', ')}]`;
}
function table(definition: McpIntegration): string {
  if (definition.transport === 'sse')
    throw new McpContractError(
      'Codex supports streamable HTTP, not legacy SSE.',
      'MCP_TRANSPORT_UNSUPPORTED',
    );
  const lines = [`[mcp_servers.${definition.id}]`];
  if (definition.transport === 'stdio') {
    lines.push(`command = ${quote(definition.executable!)}`);
    if (definition.args?.length) lines.push(`args = ${list(definition.args)}`);
    if (definition.requiredEnvironment.length)
      lines.push(`env_vars = ${list(definition.requiredEnvironment)}`);
  } else {
    if (definition.requiredEnvironment.length)
      throw new McpContractError(
        'Codex HTTP credential references need an explicit provider-owned bearer/OAuth setup.',
        'MCP_AUTH_UNSUPPORTED',
      );
    lines.push(`url = ${quote(definition.endpoint!)}`);
  }
  if (definition.toolAllowlist) lines.push(`enabled_tools = ${list(definition.toolAllowlist)}`);
  lines.push('enabled = true');
  return `${lines.join('\n')}\n`;
}
function parseState(raw: string | null): State {
  if (raw === null) return { schemaVersion: 1, entries: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new McpContractError('Codex MCP ownership state is invalid.', 'MCP_STATE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new McpContractError('Codex MCP ownership state is invalid.', 'MCP_STATE_INVALID');
  const state = value as Partial<State>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.entries))
    throw new McpContractError('Codex MCP ownership state is invalid.', 'MCP_STATE_INVALID');
  const ids = new Set<string>();
  const entries = state.entries.map((entry): StateEntry => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      ids.has(entry.id) ||
      typeof entry.sha256 !== 'string' ||
      !entry.definition ||
      !entry.qualification ||
      entry.qualification.schema !== CODEX_MCP_SCHEMA ||
      typeof entry.qualification.version !== 'string'
    )
      throw new McpContractError('Codex MCP ownership entry is invalid.', 'MCP_STATE_INVALID');
    const definition = validateMcpIntegration(entry.definition);
    if (
      !definition.enabled ||
      !definition.providers.includes('codex') ||
      definition.id !== entry.id
    )
      throw new McpContractError('Codex MCP ownership entry is invalid.', 'MCP_STATE_INVALID');
    ids.add(entry.id);
    return { id: entry.id, sha256: entry.sha256, definition, qualification: entry.qualification };
  });
  return {
    schemaVersion: 1,
    entries,
    ...(state.createdConfig === true ? { createdConfig: true } : {}),
  };
}
function range(raw: string, id: string): [number, number] | null {
  const match = new RegExp(
    `^\\[mcp_servers\\.${id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\]\\s*$`,
    'm',
  ).exec(raw);
  if (!match || match.index === undefined) return null;
  const after = match.index + match[0].length;
  const next = /^\s*\[[^\r\n]+\]\s*$/m;
  next.lastIndex = after;
  const tail = raw.slice(after);
  const nextMatch = next.exec(tail);
  return [match.index, nextMatch?.index === undefined ? raw.length : after + nextMatch.index];
}
function removeOwned(raw: string, entries: readonly StateEntry[]): string {
  let result = raw;
  for (const entry of entries) {
    const found = range(result, entry.id);
    if (!found || entryHash(result.slice(...found).trimEnd() + '\n') !== entry.sha256)
      throw new McpContractError(
        `Managed Codex MCP server ${entry.id} has local edits.`,
        'MCP_EDIT_CONFLICT',
      );
    result = `${result.slice(0, found[0])}${result.slice(found[1])}`
      .replace(/^\s+|\s+$/g, '')
      .replace(/\n{3,}/g, '\n\n');
    if (result) result += '\n';
  }
  return result;
}
function build(
  raw: string | null,
  old: State,
  definitions: readonly McpIntegration[],
  qualification: CodexMcpQualification,
) {
  let retained = raw ?? '';
  if (old.entries.length) retained = removeOwned(retained, old.entries);
  const active = definitions.filter((item) => item.enabled && item.providers.includes('codex'));
  const diagnostics: CodexMcpPlan['diagnostics'] = [];
  const seen = new Set<string>();
  const chunks: string[] = [];
  for (const definition of active) {
    if (seen.has(definition.id)) {
      diagnostics.push({
        code: 'MCP_DUPLICATE_ID',
        message: 'MCP server IDs must be unique.',
        evidence: CODEX_MCP_EVIDENCE,
      });
      continue;
    }
    seen.add(definition.id);
    if (range(retained, definition.id)) {
      diagnostics.push({
        code: 'MCP_UNOWNED_CONFLICT',
        message: `Codex MCP server ${definition.id} already exists and is not Latchkit-owned.`,
        evidence: CODEX_MCP_EVIDENCE,
      });
      continue;
    }
    try {
      chunks.push(table(definition));
    } catch (error) {
      diagnostics.push({
        code: error instanceof McpContractError ? error.code : 'MCP_RUNTIME_DENIED',
        message: error instanceof Error ? error.message : 'Codex MCP activation refused.',
        evidence: CODEX_MCP_EVIDENCE,
      });
    }
  }
  const rendered = chunks.length
    ? `${retained.trimEnd()}${retained.trim() ? '\n\n' : ''}${chunks.join('\n')}`
    : retained;
  const entries = chunks.length
    ? active
        .filter((definition) => !diagnostics.some((item) => item.message.includes(definition.id)))
        .map((definition) => ({
          id: definition.id,
          sha256: entryHash(table(definition)),
          definition,
          qualification,
        }))
    : [];
  const bytes = rendered || raw === null ? rendered || null : null;
  const stateBytes = entries.length
    ? `${JSON.stringify({ schemaVersion: 1, entries, ...(old.createdConfig || raw === null ? { createdConfig: true } : {}) }, null, 2)}\n`
    : null;
  return {
    bytes,
    stateBytes,
    plan: {
      changes:
        raw === bytes
          ? []
          : [
              {
                action: bytes === null ? 'remove' : raw === null ? 'create' : 'update',
                path: CONFIG,
              },
            ],
      diagnostics,
      implications: active.map((item) =>
        item.transport === 'stdio'
          ? `${item.id}: Codex may execute this program using its existing permissions.`
          : `${item.id}: Codex may connect to this endpoint using its existing authentication and approvals.`,
      ),
    } satisfies CodexMcpPlan,
  };
}
export async function planCodexManagedMcp(
  root: string,
  values: readonly unknown[],
  versionOutput: unknown,
): Promise<CodexMcpPlan> {
  const qualification = codexMcpQualification(versionOutput);
  const definitions = values.map(validateMcpIntegration);
  return build(
    await readOptional(root, CONFIG),
    parseState(await readOptional(root, STATE)),
    definitions,
    qualification,
  ).plan;
}
export async function applyCodexManagedMcp(
  root: string,
  values: readonly unknown[],
  versionOutput: unknown,
  options: { faultBoundary?: TransactionInput['faultBoundary'] } = {},
): Promise<CodexMcpPlan> {
  return withProjectLock(root, async () => {
    const manifest = await readOptional(root, MANIFEST);
    if (manifest === null)
      throw new McpContractError(
        'Initialize and sync Latchkit before managing MCP.',
        'MCP_PROJECT_UNINITIALIZED',
      );
    const qualification = codexMcpQualification(versionOutput);
    const raw = await readOptional(root, CONFIG);
    const stateRaw = await readOptional(root, STATE);
    const built = build(
      raw,
      parseState(stateRaw),
      values.map(validateMcpIntegration),
      qualification,
    );
    if (built.plan.diagnostics.length)
      throw new McpContractError('Codex MCP plan has diagnostics.', 'MCP_PLAN_REFUSED');
    const changes = [
      { resourceId: 'mcp-codex-config', bytes: built.bytes },
      { resourceId: 'mcp-codex-state', bytes: built.stateBytes },
    ].filter((item, index) => (index === 0 ? raw !== item.bytes : stateRaw !== item.bytes));
    if (changes.length)
      await applyRegisteredTransaction(root, {
        operation: 'mcp-codex-sync',
        registry,
        changes,
        manifest,
        faultBoundary: options.faultBoundary,
      });
    return built.plan;
  });
}

/** Call at the Codex launch boundary. It does not grant a provider permission;
 * it only refuses a stale local activation before a provider-owned session can
 * observe the managed configuration. */
export async function assertCodexManagedMcpRuntime(
  root: string,
  versionOutput: unknown,
): Promise<void> {
  const qualification = codexMcpQualification(versionOutput);
  const state = parseState(await readOptional(root, STATE));
  const raw = await readOptional(root, CONFIG);
  const config = raw ?? '';
  for (const entry of state.entries) {
    const found = range(config, entry.id);
    if (
      entry.qualification.version !== qualification.version ||
      entry.qualification.schema !== qualification.schema ||
      !found ||
      entryHash(config.slice(...found).trimEnd() + '\n') !== entry.sha256
    )
      throw new McpContractError(
        'Managed Codex MCP configuration, version, or schema changed. Remove it or explicitly reauthorize the reviewed definition.',
        'MCP_RUNTIME_DENIED',
      );
  }
}
