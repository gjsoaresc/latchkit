# Optional managed MCP configuration

MCP configuration is an optional post-1.0 expansion. Latchkit’s core skills, workflows, and normal synchronization do not require an MCP server.

The managed module accepts explicit project-scoped definitions only. Every definition starts disabled. A disabled definition is inert: planning and import validation do not launch a process, resolve a package, make a network request, or create a provider configuration file. Credentials are environment-variable names only; token values, OAuth material, keychain data, authorization headers, and credential-bearing endpoint query strings are refused.

`applyManagedMcp` currently serializes only the documented Claude Code project file, `.mcp.json`, for `stdio`, `http`, and `sse`. It writes a direct executable and argument array for stdio, rejects `npx`, `uvx`, `-y`, and `--yes`, and never starts the executable. It writes `${ENVIRONMENT_NAME}` references rather than values. Codex, Cursor, Cursor CLI, and Antigravity are reported as unsupported for managed project serialization in this slice because no reviewed provider adapter contract has been added for their current formats. This is not evidence that those products lack MCP support.

Enabling also requires a separate runtime grant for the exact provider/server identity. An optional configured tool allowlist must be a subset of that grant; configuration cannot create a grant, expand its tools, bypass provider authentication/OAuth/workspace trust, or auto-approve a tool. A future provider runtime adapter must enforce the same grant at its invocation boundary.

Managed entries are recorded under `.latchkit/mcp-state.json`. Latchkit merges only its recorded entry in `mcpServers`, preserves unrelated servers and unknown JSON fields, and refuses invalid JSON or a changed owned entry. Removal follows the same ownership check. Its changes and state record share the registered-resource transaction journal; callers can invoke `inspectManagedMcpRecovery` and `recoverManagedMcp` with the same definitions after an interruption. This module requires an initialized Latchkit project so its transaction can preserve the existing ownership manifest.

`checkLocalMcpHealth` is a separately invoked localhost-only JSON-RPC `tools/list` probe with a 1–5000 ms timeout. It never runs a configured stdio server and does not establish provider authentication or provider end-to-end verification. An unreachable optional endpoint returns `connected: false` and leaves the normal workflow unaffected.

Provider-format evidence: [Claude Code MCP configuration](https://code.claude.com/docs/en/agent-sdk/mcp) documents `.mcp.json`, stdio, HTTP/SSE, explicit tool permission, and environment-based credentials. Cursor’s [MCP documentation](https://cursor.com/docs) identifies `.cursor/mcp.json`, but this release has not added a reviewed serializer. Provider documentation is format evidence, not a claim that Latchkit has verified a provider session.
