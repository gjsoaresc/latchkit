# Optional managed MCP configuration

This is a partial post-1.0 expansion of issue #19. Core skills and workflows do not require an MCP server. Latchkit does not install, download, start, authenticate, or call tools on a configured server. Provider-owned authentication, project trust and tool permissions still apply.

## Review and activate a definition

A definition is inert unless `enabled` is explicitly `true`. Omitting that field defaults to `false`. Reading or previewing a definition never starts a process or contacts its endpoint. Definitions are explicit input files; ordinary sync does not discover or import MCP files.

For an already-running, credential-free local fixture, save a definition such as:

```json
{
  "schemaVersion": 1,
  "id": "local-fixture",
  "transport": "http",
  "endpoint": "http://127.0.0.1:8765/mcp",
  "providers": ["claude"],
  "scope": "project",
  "requiredEnvironment": [],
  "enabled": false
}
```

After initializing and syncing the project, inspect it with:

```powershell
latchkit mcp preview --file mcp.json
```

Deliberately change `enabled` to `true`, then review the authorized configuration preview and apply it:

```powershell
latchkit mcp apply --file mcp.json --authorized --dry-run
latchkit mcp apply --file mcp.json --authorized
latchkit mcp inspect
latchkit mcp health --id local-fixture
latchkit mcp remove --dry-run
latchkit mcp remove
```

`--authorized` is an explicit local configuration action. An enabled JSON field alone cannot create its grant. Applying requires a grant bound to the exact normalized definition and the current Latchkit provider contract. A changed endpoint, command, argument, credential reference, or runtime contract requires a new explicit action. The preview includes the exact definition, execution/connection implications, missing environment names and provider diagnostics. An unapproved preview exits nonzero when activation would be refused.

The input may be one definition or an array, bounded to 64 definitions and 64 KiB through the CLI. It represents the complete desired set of Latchkit-managed integrations; omitted owned entries are removed. `mcp remove` removes the complete managed set. Disabled definitions are not persisted as active entries. Inspection reports configured, unchanged/enabled, and authorization status independently.

## Ownership and permissions

Only Claude Code's project `.mcp.json` serializer is currently supported. Managed server subentries are recorded in `.latchkit/mcp-state.json`; unrelated servers and unknown JSON fields remain user-owned. Later edits to unrelated entries do not block removal. A changed owned entry, duplicate identity, unowned collision, malformed JSON, or unsafe managed path blocks mutation. JSON formatting may be normalized; comments are unsupported by this JSON format and invalid JSON is refused. Global configuration and provider permission settings are never written.

Provider configuration and ownership state share the registered-resource transaction journal and protected snapshots. A provider file created by Latchkit is removed when it becomes empty; pre-existing files and unrelated content are preserved. After an interrupted mutation:

```powershell
latchkit mcp recover --dry-run
latchkit mcp recover
```

Recovery uses a fixed resource registry and needs no imported definition file. Conflicting user edits block recovery rather than overwrite them. A pending transaction from another subsystem must be recovered with that subsystem's command.

The shared provider process runner checks each managed entry immediately before launch. Changed configuration, missing required environment variables, or a changed Latchkit provider contract refuses that launch until the entry is reconciled, removed, or explicitly reauthorized. This checks the Latchkit runtime contract; it does not inspect the installed provider binary's version or guard sessions launched outside Latchkit. Project-local ownership records are bookkeeping, not a cryptographic authorization boundary against an attacker who can edit the repository. Provider trust and tool approvals remain the actual tool-execution boundary.

`toolAllowlist` is representable for import but **activation is unsupported**: writing an allowlist into configuration without runtime enforcement would falsely imply restricted tool access. Latchkit has no MCP tool-dispatch API and issues no tool grants. Enforceable tool narrowing, installed-provider version qualification, and other provider serializers remain open parts of issue #19.

## Local console and HTTP controls

The authenticated local console exposes a dedicated MCP panel at `/mcp`, linked from Settings. Paste a single definition or a bounded array, select **Review exact changes**, and inspect the changes, conflict diagnostics, missing environment *names*, and execution/connection implications. Preview is inert: it performs no provider invocation, process launch, or endpoint request.

**Explicitly activate reviewed definition** applies only the exact JSON bound to the session-scoped preview ID; edited, expired, or already-used previews are refused and must be reviewed again. Remove preserves unrelated `.mcp.json` entries. The panel also exposes transaction recovery and a separately initiated health check for an enabled supported HTTP entry. The API is intentionally narrow: `GET /api/mcp`, `POST /api/mcp/preview`, `POST /api/mcp/apply`, `POST /api/mcp/remove`, `GET`/`POST /api/mcp/recovery`, and `POST /api/mcp/health`; it accepts no arbitrary commands or tool calls.

## Credentials and health

Stdio definitions carry a direct executable, argument array, and `requiredEnvironment` names. The serializer writes `${NAME}` references, checks presence without exposing values, and never starts the program. Known download launchers (`npx`, `uvx`, including paths) and automatic-install arguments are refused. Latchkit cannot prove what an arbitrary explicitly selected executable will do when the provider starts it.

Do not put secrets in command arguments or URLs. Credential-like arguments, endpoint user information, query parameters and fragments are rejected. This practical validation is not perfect secret detection. HTTP/SSE environment-based headers are unsupported; use the provider's own authentication setup. No OAuth token, keychain material or authentication header is stored by this feature.

Health is a separately invoked diagnostic for already-enabled managed HTTP definitions with literal loopback addresses (`127.0.0.1` or `[::1]`). It never starts a stdio executable or follows a redirect. It performs MCP `initialize`, version/capability negotiation, `notifications/initialized`, then `tools/list`. JSON and bounded SSE responses, session headers, and up to eight discovery pages are supported. Each response is capped at 64 KiB, discovery at 256 tools, and the entire operation at 1–5000 ms (CLI default 1000 ms). Cancellation aborts the operation. Server instructions and requests are never executed, and error bodies/session identifiers are not returned. Tool discovery is distinct from a successful connection; neither is provider end-to-end verification. Remote endpoints and legacy SSE health are unsupported.

## Evidence and remaining scope

| Surface                                                         | Status                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Claude project stdio/HTTP/SSE JSON serialization                | Tested with local configuration fixtures; real-provider activation unknown                      |
| Explicit CLI activation, entry ownership, removal and recovery  | Tested on native Windows with credential-free fixtures                                          |
| Latchkit launch-time definition/runtime-contract fence          | Tested before a harmless process fixture; installed-provider version changes remain unqualified |
| Loopback HTTP MCP initialization and tool discovery             | Tested with local JSON/SSE fixtures, redirects, malformed replies, limits and cancellation      |
| Stdio health, remote health, legacy SSE health                  | Unsupported; no process or remote request is started                                            |
| Configured tool allowlists and runtime tool dispatch            | Unsupported; activation refuses allowlists                                                      |
| Codex, Cursor, Cursor CLI, Antigravity serializers              | Unsupported in this slice; these products may support MCP independently                         |
| Other operating systems and real-provider credentialed sessions | Unknown                                                                                         |

Format evidence comes from [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp). The fixture protocol follows MCP's [2025-06-18 lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) and [HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). Documentation evidence does not establish a credentialed provider test.
