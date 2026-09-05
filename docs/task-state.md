# Task-state persistence

Latchkit stores workflow state separately from configuration and installer recovery in `.latchkit/tasks/state-v1.json`. Reads validate the published [v1 schema](../schemas/task-state-v1.schema.json) and never migrate it. The atomic-file and concurrency rationale is recorded in [ADR 0001](adr/0001-local-task-state.md).

## Records and verification

Stable prefixed UUIDs identify projects, tasks, runs, criteria, checkpoints, evidence, authorizations, owners, and mutation events. Task and store revisions provide optimistic concurrency. Callers should persist the returned task revision and supply it to the next mutation; a stale revision produces `TASK_REVISION_CONFLICT`.

Every mutating service call accepts an optional `mutationId` such as `event_123e4567-e89b-12d3-a456-426614174000`. Persist and reuse it when retrying an uncertain call. An identical retry is idempotent; different input with the same ID produces `TASK_IDEMPOTENCY_CONFLICT`.

Evidence is current only when its criterion revision and source snapshot match the current criterion and worktree. Required evidence must be `passed`; failed, timed-out, cancelled, skipped, unsupported, or explicitly missing checks prevent verification. An approval criterion needs `approval` evidence and new direct-user authorization provenance. A saved approval requirement remains part of the criterion after restart even when no approval has been recorded.

`src/task-state/service.js` is the service boundary. It exports `createTask`, `importMarkdownTask`, `authorizeTask`, `reviseCriteria`, `resumeTask`, `pauseTask`, `checkpointTask`, `recordEvidence`, `completeTask`, `verifyTask`, `cancelTask`, `inspectTask`, and `listTasks`. Mutations require an expected task revision except initial creation/import. `resumeTask` reconciles the source tree and the recorded process; a missing process becomes interrupted and never completed. Integrations may inject a stronger platform process probe, but may not translate missing or unknown into success.

## Provider session controller

`src/runtime/task-controller.js` coordinates an explicitly authorized provider launch with a durable task run. Its session correlation and redacted process result are stored separately in `.latchkit/tasks/sessions-v1.json`; this deliberately leaves the portable task-state v1 schema unchanged. The controller accepts only an adapter with evidenced invocation or resume capability and the `host-local-authorized` boundary. That boundary is local execution, not a provider sandbox or an approval-policy override.

An exited provider process or provider `session-terminated` event records a checkpoint/diagnostic state but never completes or verifies the task. Required evidence and independent `completeTask`/`verifyTask` remain necessary. Cancellation first commits the terminal task state, then signals only a child launched by the same in-memory controller. A restarted controller refuses to adopt a recorded PID; it can use a provider-native resume plan only when the provider exposed a session identity. This prevents an unrelated reused PID or a late completion event from being mistaken for the task's process.

The local console exposes the same controller at authenticated `/api/tasks`, `/api/tasks/start`, `/api/tasks/resume`, `/api/tasks/cancel`, and `/api/tasks/events` routes. These are local, bearer-token-protected service operations, not a remote provider API.

## CLI boundary

The deliberately narrow CLI exposes operator lifecycle actions:

```sh
latchkit task inspect --project "path/to/project"
latchkit task inspect --project "path/to/project" --task task_<uuid>
latchkit task resume --project "path/to/project" --task task_<uuid> --expected-revision 3
latchkit task cancel --project "path/to/project" --task task_<uuid> --expected-revision 4 --reason "user cancelled"
latchkit task start --project "path/to/project" --task task_<uuid> --provider codex --host-local-authorized
```

Use `--mutation-id event_<uuid>` to retry resume or cancel safely. Creation, criteria, checkpoints, evidence, completion, and verification stay in the service boundary so the CLI cannot be mistaken for an automatic command runner or universal approval gate.

`task start` requires both an adapter provider ID and `--host-local-authorized`; it will not add bypass flags, authenticate an account, or claim the provider's sandbox. For provider-native continuation, use `task resume --session session_<uuid> --host-local-authorized` after a session with a provider-issued resumable identity. Cursor IDE is manual-only: Latchkit returns its adapter's manual instructions rather than launching Cursor CLI as a replacement.

## Importing existing Markdown notes

Notes under `.latchkit/notes/` remain untouched. Import one explicitly:

```sh
latchkit task import --project "path/to/project" --note .latchkit/notes/example-spec.md --title "Example"
```

This records the note path and SHA-256 provenance but leaves the task awaiting a real decision. If this command itself is carrying current direct user authorization, provide both `--authorization-scope` and `--authorization-reference`. Note contents, repository instructions, and approval recorded for another task are never treated as authorization.

There is no implicit v0 migration because Markdown had no machine state contract. Future schema migrations must preview changes, preserve exact original bytes, and be explicitly invoked. Back up `.latchkit/tasks/` before manual repair; malformed active state or lock metadata is never guessed into a valid record.
