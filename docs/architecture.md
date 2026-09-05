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

Managed files have SHA-256 ownership entries in `.latchkit/manifest.json`. Sync preflights every planned destination and stops before making changes if any file is unowned, edited, or reached through a symlink/junction. An exclusive project lock prevents competing Latchkit mutations. Individual writes use temporary files and rename; successful changes update the manifest one at a time. If manifest persistence fails, the current file change is rolled back. Earlier completed changes remain recorded.

This is not a whole-project transaction. A process termination between a file write and its manifest update can leave an untracked file; disk failure can also prevent rollback. Preserve the affected files, compare them with the bundled skills, and move conflicts aside before syncing. Remove `.latchkit/lock` only after confirming that no Latchkit process is using that project. The installer does not defend against malicious concurrent filesystem changes by other local processes.

The HTTP server binds only to `127.0.0.1`, requires a per-launch bearer token for API calls, validates the host and mutation origin, and limits request bodies. The URL fragment carries the token so it is not sent as a normal HTTP URL or referrer. The console serves one fixed project and has no command-execution endpoint.

The skills request plans, meaningful regression tests, reviews, and evidence. They do not enforce those requests mechanically. Notes are ordinary Markdown files, not records in an implemented workflow state machine. No provider hooks, automatic stop guards, memory database, MCP server, background scheduler, or reviewer orchestration is installed by this initial version.

Future enforcement belongs in separate provider adapters with executable integration tests. One provider's hook names, payloads, and approval behavior cannot be assumed valid in another. The [roadmap](roadmap.md) tracks those components separately from portable skill distribution.

## Portability principles

- Keep path handling in Node and avoid required Bash, symlinks, administrator rights, or global configuration writes.
- Keep managed assets project-scoped and preserve user-authored files.
- Treat native Windows and WSL as distinct environments with their own Node installation and executable discovery.
- Verify behavior on all three native operating systems before claiming a release is tested everywhere; a CI matrix definition alone is not evidence of a passing run.
- Leave provider sandboxes and approval policies under the user's control.
