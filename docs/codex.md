# Codex adapter

Latchkit's Codex adapter is a plan-and-translation layer. It can inspect a bounded `codex --version` result, create non-executing `codex exec --json` invocation and `codex exec resume --json` plans, translate documented hook payloads to the normalized lifecycle envelope, and describe the shared `.agents/skills` and `AGENTS.md` exports. A successful JSONL `thread.started` event supplies the provider session identity used by an explicitly authorized continuation; free-form assistant text is never accepted as that identity.

Codex project hooks are discovered from `.codex/hooks.json` or inline `[hooks]` tables in `.codex/config.toml`. Latchkit's generated command handlers are owned resources and are reported as requiring Codex's review/trust step. Latchkit never records trust hashes, passes trust-bypass flags, changes approval or sandbox settings, or silently enables a changed hook.

Only `command` and `mcp_tool` handlers are represented as supported. Codex parses `prompt` and `agent` handlers but skips them, so the adapter reports those handlers as unsupported rather than exporting an apparently enforcing rule. `SessionEnd` output is advisory, and token counters remain unknown. A hook handler is bounded to 64 KiB of input/output metadata and redacts credentials by never echoing raw environment, command arguments, or transcript content.

On native Windows, use the tested Node command override emitted by `buildCodexHookConfig`. Keep native Windows and WSL installations separate: run Node and Codex inside WSL when the project uses WSL, and do not assume a Windows executable or path is valid in the distribution. Latchkit does not install Codex or authenticate an account.

The adapter's evidence is based on the official Codex CLI, AGENTS.md, and hooks documentation checked September 6, 2026:

- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
