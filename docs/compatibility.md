# Compatibility

Provider documentation checked September 5, 2026. These references establish supported formats and upstream platform claims. They do not prove that every Latchkit/provider/OS combination has passed a real-agent session.

## What the starter integrates

Latchkit installs project-local `SKILL.md` files and stores provider/skill selections in `.latchkit/config.json`. It does not launch model sessions, install provider hooks, rewrite provider permissions, manage provider credentials, or automate Cursor's interface.

| Provider | Latchkit skill destination | Official discovery evidence |
|---|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` | Project skills support automatic selection and slash invocation. [Claude skills](https://code.claude.com/docs/en/skills) |
| Codex | `.agents/skills/<name>/SKILL.md` | Codex discovers repository skills from the working directory up to the repository root; duplicate names can both appear. [OpenAI skills](https://learn.chatgpt.com/docs/build-skills) |
| Gemini CLI | `.agents/skills/<name>/SKILL.md` | `.agents/skills` is supported alongside `.gemini/skills`; activation and consent are managed by Gemini. [Gemini skills](https://geminicli.com/docs/cli/using-agent-skills/) |
| Cursor IDE | `.agents/skills/<name>/SKILL.md` | Cursor supports shared skills and `.cursor/skills`, plus other providers' discovery directories. [Cursor skills](https://cursor.com/docs/skills) |
| Cursor CLI | `.agents/skills/<name>/SKILL.md` | The CLI supports the editor's skills; upstream calls the executable `agent`. [Cursor 2.4](https://cursor.com/changelog/2-4), [CLI usage](https://cursor.com/docs/cli/using) |

Gemini CLI adapter notes

The Gemini adapter uses the documented headless vector `gemini --prompt <text> --output-format json`; it does not select a model, change approvals, enable YOLO mode, or authenticate. Resume plans use `--resume <session-id>` and retain JSON output. Cancellation is supplied by Latchkit's explicitly authorized bounded host runner, so it is reported as partial provider evidence rather than a Gemini-native guarantee. Missing flags in an installed `gemini --help` result keep invocation or resume unknown.

The opt-in hook bridge adds uniquely named entries to `.gemini/settings.json` for `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, and `PreCompress`. It preserves unknown settings and user hooks and can remove only unchanged `latchkit-*` entries through the registered-resource transaction workflow. Hook commands must emit exactly one JSON object on stdout; diagnostics belong on stderr. `SessionStart`, `SessionEnd`, and `PreCompress` remain advisory. `BeforeAgent`/`BeforeTool` may deny, and `AfterAgent` may request a finite retry or halt; no `Stop` alias or compaction block is inferred.

After installing or changing hooks, use Gemini's `/hooks panel` and reload/restart the CLI as required by its settings scope. Skills remain in the shared `.agents/skills` directory; inspect the provider's skill listing to confirm discovery. A real-agent test still requires a user-authorized Google account and is intentionally not part of ordinary CI.

Latchkit writes the shared destination once when multiple selected providers use it. It does not also create `.gemini/skills` or `.cursor/skills` copies. Provider selection determines export destinations, not visibility permissions: compatible tools may discover installed skills even when they are not selected. Cursor may discover duplicate names when Claude and shared-root copies coexist. Inspect the provider's skill listing when resolving duplicates.

Pack previews report this possible cross-root discovery duplication before mutation. It is informational: Latchkit deduplicates an identical shared destination, but never removes a Claude-root or another tool's file merely to hide a provider discovery collision.

## Capability evidence matrix

`src/providers/` exposes versioned, normalized provider metadata. As of the verification date above, every listed provider has evidence only for portable skill export. Detection on `PATH` means only that the executable was found; it does not establish login, project configuration, invocation, hook semantics, resumption, cancellation, compaction, usage, or an end-to-end session.

| Capability | Claude Code | Codex | Gemini CLI | Cursor IDE / CLI |
|---|---|---|---|---|
| Portable skill export | Supported, documented | Supported, documented | Supported, documented | Supported, documented |
| Invocation, resume, compaction, cancellation, usage | Independently evidenced by adapter; usage unknown | Adapter evidence for invocation, resume, compaction and cancellation; usage unknown | Unknown — no Latchkit adapter | Unknown — no Latchkit adapter |
| Lifecycle hooks and blocking decisions | Independently evidenced by adapter | Version-aware command/MCP hook translation; prompt/agent skipped; trust review required | Unknown — no Latchkit adapter | Unknown — no Latchkit adapter |
| Installed / authenticated / configured / end-to-end | Independently reported; only installation may be discovered | Independently reported; only installation may be discovered | Independently reported; only installation may be discovered | Independently reported; only installation may be discovered |

Each capability has a `supported`, `partial`, `unsupported`, or `unknown` state, a reason, version range, and evidence URL. Unknown or an unrecognized provider version is not permission to infer support. Compatible skills remain exportable; requested unavailable enforcement is refused. A blocking decision may use an explicitly supported advisory fallback, but the result is labeled advisory and never reported as a passed gate. Missing usage is unknown, never zero. Provider selection is an installation choice, not an account, permission, or filesystem access boundary.

The process runner is an adapter primitive, not evidence that a listed provider can be invoked. It refuses execution unless an adapter's contract has invocation evidence and the caller explicitly authorizes the `host-local-authorized` profile. Host-local execution is not reported as provider-sandboxed, interactive/PTY execution is not emulated, and provider approval settings are never changed.

## Upstream platform requirements

| Provider | Windows | Linux and macOS | Official source |
|---|---|---|---|
| Claude Code | Native Windows 10 1809+/Server 2019+ or WSL; PowerShell works without Git Bash. Native Windows sandboxing differs from WSL2. | Linux; macOS 13+. | [Setup](https://code.claude.com/docs/en/setup) |
| Codex | Native Windows CLI/PowerShell and Windows sandbox; Windows 11 recommended, recent Windows 10 best effort. WSL is optional. | Linux and macOS CLI. | [Windows](https://learn.chatgpt.com/docs/windows/windows-sandbox), [CLI](https://developers.openai.com/codex/cli/) |
| Gemini CLI | Windows 11 24H2+ and PowerShell. | Ubuntu 20.04+, macOS 15+; upstream requires Node 20+. | [Installation](https://geminicli.com/docs/get-started/installation/) |
| Cursor IDE | Windows 10+. | Linux packages/AppImage and macOS 12+. | [Quickstart](https://prod.cursor.com/docs/get-started/quickstart) |
| Cursor CLI | Native Windows installer is documented; WSL also has an installation path. | Linux and macOS installers. | [Installation](https://prod.cursor.com/docs/cli/installation) |

Latchkit's own runtime minimum is Node.js 22. Each selected provider retains its own installation requirements. On WSL, install and run Node and the chosen CLI inside the distribution; a working native Windows executable does not demonstrate a working WSL installation.

## Project instruction exports and future hooks

Latchkit now exports deterministic project instructions through documented file discovery surfaces. This is filesystem serialization, not a concrete provider adapter or an end-to-end provider verification. Hooks remain future adapter work; matching hook names do not establish matching event semantics.

| Provider | Latchkit instruction export | Hook surface |
|---|---|---|
| Claude Code | Scoped `.claude/rules/latchkit-*.md`, or narrow `CLAUDE.md` imports when sharing Codex `AGENTS.md`. [Memory](https://code.claude.com/docs/en/memory) | `.claude/settings.json`; provider event and command contracts. [Hooks](https://code.claude.com/docs/en/hooks) |
| Codex | Owned sections in the root-to-scope `AGENTS.md` hierarchy; a same-directory `AGENTS.override.md` shadow is reported. [OpenAI guidance](https://developers.openai.com/codex/guides/agents-md/) | Version-aware adapter for `hooks.json`/inline TOML planning and lifecycle translation; trust review remains Codex-owned. See [Codex adapter](codex.md). [OpenAI hooks](https://learn.chatgpt.com/docs/hooks) |
| Gemini CLI | Narrow `GEMINI.md` imports of shared `AGENTS.md` or separately owned canonical rules. A customized context filename can change discovery and must be reviewed. [Context](https://geminicli.com/docs/cli/gemini-md/) | `.gemini/settings.json`; Gemini event schemas. [Hooks](https://geminicli.com/docs/hooks/) |
| Cursor IDE/CLI | Scoped `.cursor/rules/latchkit-*.mdc` with `description`, `globs`, and `alwaysApply`; omitted when selected Codex `AGENTS.md` is already shared. [Rules](https://cursor.com/docs/rules), [CLI](https://cursor.com/docs/cli/using) | `.cursor/hooks.json`; do not assume identical IDE/CLI event coverage. [Hooks](https://cursor.com/docs/hooks) |

## Verification policy

The native CLI and local UI target Windows, Linux and macOS; the repository's CI matrix is the place to collect platform evidence. A configured matrix is not a completed run. Real-agent smoke tests must additionally record provider version, OS, skill discovery, invocation, artifact creation, and any unavailable feature before a combination is described as end-to-end verified. WSL needs its own smoke test.
