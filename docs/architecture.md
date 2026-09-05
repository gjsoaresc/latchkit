# Architecture

Latchkit is an original open-source toolkit that adds shared engineering skills and project configuration to existing coding agents. The initial implementation is a CLI and local configuration interface. The provider still owns authentication, model execution, tool permissions, and the conversation.

## Current components

| Component | Responsibility |
|---|---|
| Node.js CLI | Project initialization, provider discovery, configuration, and skill synchronization. |
| Project configuration | `.latchkit/config.json` records the selected providers and selected skill IDs. |
| Canonical skills | `skills/latchkit-*/SKILL.md` contains original portable instructions. |
| Provider destinations | Project-local copies in supported discovery roots. |
| Local UI | A browser interface for viewing providers and editing project configuration. |
| Workflow notes | Agents following the skills write task evidence under `.latchkit/notes/`. |

The core targets Node.js 22 or newer and has no runtime package dependencies. Node's filesystem, path, HTTP, and process facilities provide a common implementation for Windows, Linux, and macOS. WSL runs the Linux path; it is optional for native Windows use.

The frontend is served locally. It is a configuration surface, not an embedded terminal, hosted account service, or provider session viewer. Authentication and model selection remain in each provider's own tools.

Project configuration and the ownership manifest are independently versioned contracts. Configuration reads never migrate files implicitly; supported schemas, provider extension boundaries, validation behavior, and explicit backup-backed migration are documented in [configuration contracts](configuration.md). Source-pack metadata and workflow state use separate future contracts rather than adding unrelated state to project configuration.

## Skill synchronization

The configuration uses the skill IDs `spec`, `fix`, `review`, and `handoff`. They map to the folders `latchkit-spec`, `latchkit-fix`, `latchkit-review`, and `latchkit-handoff`.

| Selected provider | Destination relative to the target project |
|---|---|
| Claude Code | `.claude/skills/` |
| Codex | `.agents/skills/` |
| Gemini CLI | `.agents/skills/` |
| Cursor IDE | `.agents/skills/` |
| Cursor CLI | `.agents/skills/` |

Shared destinations are deduplicated during synchronization. Generated copies are distribution artifacts; edit the canonical bundled skill to develop a new version.

Selecting a provider controls where Latchkit installs files. It does not isolate other agents from those files. Gemini and Cursor recognize shared roots, and Cursor can also discover other providers' skill directories. Selecting Claude alongside a shared-root provider can expose matching skills through multiple roots in Cursor. A single managed destination avoids unnecessary copies, but provider discovery rules still govern what appears. See [compatibility](compatibility.md).

## Runtime boundary

Managed files have SHA-256 ownership entries in `.latchkit/manifest.json`. Sync preflights every planned destination and stops before changes if any file is unowned, edited, or reached through a symlink/junction. The installer publishes `.latchkit/transaction.json` with exact before/after bytes before its first resource mutation and commits the complete manifest last. A crash before that commit rolls back; a crash after it finalizes. Files that match neither recorded state are preserved as conflicts.

The project lock contains a unique identity and an ephemeral Ed25519 proof endpoint on loopback. Contenders verify the live process rather than trusting a reusable PID. `latchkit recover --dry-run` is read-only; `latchkit recover` only reclaims a cryptographically well-formed lock whose owner no longer answers. Malformed or ambiguous metadata requires manual review. Writes fsync temporary files before rename and sync parent directories where the platform supports it. Storage devices, network filesystems, or operating systems that do not honor these primitives remain outside the durability guarantee. The installer does not defend against a malicious process with equivalent local privileges.

The transaction core accepts registered resource IDs rather than caller-supplied target paths. It journals whole files; provider serializers remain responsible for preserving unrelated JSON, TOML, comments, and marked sections before submitting their rendered bytes.

The HTTP server binds only to `127.0.0.1`, requires a per-launch bearer token for API calls, validates the host and mutation origin, and limits request bodies. The URL fragment carries the token so it is not sent as a normal HTTP URL or referrer. The console serves one fixed project and has no command-execution endpoint.

The skills request plans, meaningful regression tests, reviews, and evidence. They do not enforce those requests mechanically. Notes are ordinary Markdown files, not records in an implemented workflow state machine. No provider hooks, automatic stop guards, memory database, MCP server, background scheduler, or reviewer orchestration is installed by this initial version.

Future enforcement belongs in separate provider adapters with executable integration tests. One provider's hook names, payloads, and approval behavior cannot be assumed valid in another. The [roadmap](roadmap.md) tracks those components separately from portable skill distribution.

## Portability principles

- Keep path handling in Node and avoid required Bash, symlinks, administrator rights, or global configuration writes.
- Keep managed assets project-scoped and preserve user-authored files.
- Treat native Windows and WSL as distinct environments with their own Node installation and executable discovery.
- Verify behavior on all three native operating systems before claiming a release is tested everywhere; a CI matrix definition alone is not evidence of a passing run.
- Leave provider sandboxes and approval policies under the user's control.
