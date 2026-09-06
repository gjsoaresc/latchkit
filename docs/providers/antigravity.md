# Antigravity CLI adapter

Latchkit exports shared workspace skills and plans bounded `agy -p` sessions.
Authentication, model choice, workspace trust, and permissions remain owned by
Antigravity. No provider settings or hooks are installed by this adapter.

## Explicit conversation resume

The task controller now records the documented `conversation_id` field and uses
`--conversation <id>` to resume that exact conversation. It never selects the
most recent conversation through `--continue`. JSON and single-turn NDJSON
(`init`, `step_update`, `result`) are supported. Multi-turn stdin streaming is
outside this adapter. See the [official headless contract](https://antigravity.google/docs/cli/headless/)
and [resume reference](https://antigravity.google/docs/cli/commands/resume).

Every explicitly authorized task start or session resume first performs a
model-free `agy --version` probe, limited to five seconds and 4 KiB of output.
Only exact version **1.1.27** has resume parser fixtures. Unknown versions retain
ordinary print invocation, but cannot acquire a new resumable identity; resume
is refused before its prompt runs. A fresh probe on resume detects version
changes. This is a conservative adapter evidence boundary, not an upstream
claim that other versions lack resume support.

The parser requires a complete successful result, a canonical conversation UUID,
and matching stream identities. Errors, denied actions, malformed or truncated
JSON, multiple results, unexpected event/status values, output-limit exits, and
cancelled processes cannot establish a new resumable identity. A failed resume
retains its prior ID for deliberate retry and cannot replace it with another
conversation. Provider exit or a resumable ID never verifies task acceptance.

Use the existing `latchkit task start` and `latchkit task resume --session` flow
with `--host-local-authorized`; `--session` identifies Latchkit's task session,
not an arbitrary provider conversation. Resume still requires task ownership
and the original authorization. No configuration or state migration is needed.

## Capability and verification limits

Official documentation now describes hook input/output contracts, including CLI
conversation metadata. Hook installation and lifecycle translation remain
unimplemented here; compaction and normalized usage remain unknown. The
[shared hooks documentation](https://antigravity.google/docs/hooks) is distinct
from the IDE-specific hook contract.

Headless permission denials may return process exit zero. Existing permissions
must therefore be preserved and acceptance checked independently. The
[1.1.27 changelog](https://github.com/google-antigravity/antigravity-cli/blob/1ae9cb7b51667192c051b73a91099c71e816ca5f/CHANGELOG.md)
documents denied-action reporting and a print-mode history flush fix. Its earlier
entries identify structured output in 1.1.8 and streaming stdin in 1.1.15.

The [sandbox documentation](https://antigravity.google/docs/cli/sandbox/) names
Linux and macOS implementations. It does not establish native Windows sandbox
support. This adapter refuses requested sandbox or approval-policy overrides
instead of ignoring them. Host-local execution must not be described as enforced
read-only execution or a Windows provider sandbox. Fine-grained permission
behavior is separately documented in the [permission reference](https://antigravity.google/docs/cli/permissions/).

The regression suite uses synthetic, credential-free provider output. It covers
planning, strict parsing, version drift, and task-controller persistence. It
does not establish live authentication, real resume behavior, Windows hook
execution, or qualification on another OS. Issue #76 remains open for those
remaining integration and observed-evidence requirements.
