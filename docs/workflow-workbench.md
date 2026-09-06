# Local workflow workbench

`latchkit ui` is a loopback-only, launch-token-protected local console. Its workbench reads the durable task state, acceptance evidence, and project-memory services; it does not create a second workflow database or a remote account. The workbench always reflects the one project this server instance was started against; see [the multi-project overview](projects.md) for the separate `/projects` page that lists every project Latchkit knows about and links into each one's own workbench-equivalent detail.

## Tasks and evidence

The workbench shows each persisted task's state, criteria, latest checkpoint, process-recovery status, and current evidence outcome. Evidence becomes visibly stale when its recorded source no longer matches the task's current source snapshot. Failed, unsupported, missing, cancelled, and stale results remain non-passing.

The console can cancel a task with its current task revision and an idempotency key. It commits task cancellation before signalling a process owned by its in-memory controller, so a late provider result cannot restore the task. Starting and resuming require the existing explicit host-local authorization API/CLI path; the browser does not invent an authorization prompt, provider permission, or adapter session.

`GET /api/tasks/artifact` accepts a task ID and evidence ID, finds that evidence in durable state, and reads only a matching bounded acceptance artifact beneath the project-owned evidence root. There is no browser route for arbitrary filesystem paths.

## Revision-bound diff feedback

For a task with a recorded owned worktree, the workbench and `latchkit diff` expose a read-only Git diff from that worktree's immutable base commit. Diff reads never stage, reset, commit, merge, or delete files. The API refuses caller-supplied worktree paths and bases, verifies the task/worktree registry binding, and bounds diff and individual-file output. Text, binary, large, deleted, renamed, CRLF, spaces, and Unicode paths remain explicit rather than being silently remapped.

Feedback is stored locally at `.latchkit/tasks/diff-annotations-v1.json` using the published `diff-annotations-v1` schema. Each annotation carries task identity, exact diff revision, file content digest, side and line, author kind, status, timestamps, and optional resolution evidence. Comments are untrusted text, are rendered as text only, and never grant permission or become commands. A changed worktree revision marks open feedback stale; Latchkit does not guess a new line. Resolving requires a task evidence ID linked to the current diff revision, while reopening remains explicit. Concurrent writers receive a revision conflict.

## Memory and recovery

Task and memory workbench lists default to 25 records and have bounded pagination parameters; memory search is capped to 100 results. The console does not inject whole state or transcripts into the DOM. Add, update, delete, export, and recovery calls use the project-memory service. Deletion scrubs the managed record but cannot retract prior exports, backups, or Git history. Exports download locally and are never uploaded.

Recovery requires a selected configured provider and uses its published compaction capability. When that capability is unavailable, the result is explicitly manual rather than pretending to produce usable provider context. On-demand blocks are bounded, label historical records as untrusted context rather than instructions, and expose stale/missing source status for revalidation.

## Reconnection and privacy

The console reloads authoritative task and memory snapshots after every mutation, on reconnect, and during a bounded ten-second foreground poll. Config and task revision conflicts are surfaced rather than overwritten. The page uses text nodes for task, evidence, and memory fields; Markdown is not executed or rendered as HTML. The local API requires the launch token, same-origin mutation requests, loopback host validation, strict CSP, no-store caching, bounded JSON request bodies, and diagnostics redaction.
