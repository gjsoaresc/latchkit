# Claude Code adapter

Latchkit's Claude Code adapter is project-local and credential-free. It exports the canonical skills to `.claude/skills`, and can plan command hooks in `.claude/settings.json` without enabling permissions, changing sandbox settings, or logging in.

## Detection and invocation

Detection runs only an explicitly authorized `claude --version` command through the bounded process runner. A missing executable or an unrecognized version leaves skills exportable while invocation, resume, and hook capabilities remain unknown. Latchkit never starts login or infers authentication from a version result. Print-mode invocation uses `-p --output-format json`; resumption uses `--resume <session-id-or-name>`. These plans are previews until a caller supplies the `host-local-authorized` execution profile.

## Hooks and ownership

The adapter targets documented command-hook events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, and `Stop`. It preserves unknown settings and unrelated hooks. Generated handlers are uniquely identified by their exact command and retain a protected, content-addressed backup when an existing settings file changes. A collision or edit to an owned handler blocks planning; removal deletes only an unchanged owned handler.

Review the dry-run before applying a settings transaction. Claude must reload or start a session before a settings change is observable; use `/hooks` to confirm activation. File installation alone is not reported as hook verification or end-to-end verification. Provider permission rules and managed policies remain authoritative: an adapter `allow` response cannot override them.

Hook commands use a Node executable and explicit script arguments when the installed version supports direct command hooks. The serializer has tested Windows and POSIX fallbacks and does not require Git Bash. Arguments are kept as data until the provider's documented command boundary; paths with spaces, apostrophes, dollar signs, Unicode, and missing shells are covered by offline fixtures.

## Lifecycle evidence

`SessionStart`, prompt, tool, and post-tool events are observational inputs unless their documented event semantics provide a decision. `PreToolUse` maps normalized allow/block responses to Claude's `permissionDecision`; `UserPromptSubmit` can add context; `PreCompact` and `Stop` can block with `decision: "block"`. `PostToolUse` and `PostToolUseFailure` cannot undo completed work. A `Stop` event is a completed turn, not a verified task completion. Missing task correlation, malformed JSON, duplicate events, cancellation, and handler timeout must remain non-success outcomes in the shared dispatcher.

Authenticated provider smoke tests are intentionally optional and are not run by the default test suite. A smoke procedure should record the Claude version, operating system, skill discovery, hook activation in `/hooks`, invocation, resume, and any unavailable capability; it must not be described as Latchkit verification unless each step was observed.

## Interactive decision surface

Claude Code documents an interactive question tool (commonly called `AskUserQuestion`) and a plan-mode approval flow for presenting an editable plan for user approval, including free-form notes. These are session features of the running Claude Code client, not something Latchkit's adapter installs, invokes, or verifies; the `latchkit-spec` skill's end-of-spec decision and the `latchkit-build`/`latchkit-fix` skills' end-of-execution result decision both prefer whichever is actually present in the current session's own toolset and otherwise fall back to a concise text choice. No other adapter in this repository (Codex, Antigravity CLI, Cursor IDE/CLI) currently has a documented equivalent control recorded here; skills must not assume one exists for those providers.

Sources: [CLI reference](https://code.claude.com/docs/en/cli-usage), [hooks](https://code.claude.com/docs/en/hooks), [hook guide](https://code.claude.com/docs/en/hooks-guide), [skills](https://code.claude.com/docs/en/skills), and [setup](https://code.claude.com/docs/en/setup).
