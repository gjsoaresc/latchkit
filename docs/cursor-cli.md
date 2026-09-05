# Cursor CLI adapter

Latchkit's `cursor-cli` adapter targets the documented `agent` executable on Windows, macOS, Linux, and WSL. It does not install Cursor, sign in, update the CLI, select a model, or modify global preferences.

The adapter creates argument-vector plans only. Interactive sessions use `agent [prompt]`; non-interactive sessions add `--print`, with `--output-format text|json|stream-json` only when print mode is requested. Resume uses the documented `resume` command for the latest session or `--resume=<chat-id>` for a specific chat. The process runner supplies explicit host-local authorization, bounded output, cancellation, timeout, and Windows shim handling.

`inspect()` returns bounded `--version` and `--help` probes. The default executable is `agent`. The older `cursor-agent` name is considered only when the caller explicitly sets `allowLegacy: true`; Latchkit never guesses a subcommand or silently falls back.

Skills use the existing shared `.agents/skills` destination. Project rules go through the canonical rule-generation serializer and are owned by the existing transaction layer. Cursor can discover `AGENTS.md` and `.cursor/rules`; when Codex is selected, the shared export is reported instead of duplicating it as a `.mdc` file.

Only project permissions belong in `.cursor/cli.json`. The adapter never writes global `cli-config.json`, credentials, trust state, or unrelated settings. Hooks are not enabled: current evidence describes Cursor hook behavior for cloud agents, while local CLI payloads and blocking/continuation semantics remain unknown. Missing or unknown CLI versions therefore preserve portable skill export but do not imply hook or end-to-end support.

Evidence checked 2026-09-05:

- [CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)
- [CLI output formats](https://docs.cursor.com/en/cli/reference/output-format)
- [Using Cursor CLI](https://docs.cursor.com/en/cli/using)
- [CLI configuration](https://prod.cursor.com/docs/cli/reference/configuration)
- [Cursor hooks](https://prod.cursor.com/docs/hooks)
