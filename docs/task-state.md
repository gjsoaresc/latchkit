# Task-state persistence

Latchkit stores workflow state separately from configuration and installer recovery in `.latchkit/tasks/state-v1.json`. The stable filename may contain either the published [v1 schema](../schemas/task-state-v1.schema.json) or [v2 schema](../schemas/task-state-v2.schema.json); reads validate both and never migrate either. New stores use v2. The atomic-file and concurrency rationale is recorded in [ADR 0001](adr/0001-local-task-state.md).

Version 2 adds nullable, versioned [enhanced-workflow metadata](../schemas/enhanced-workflow-v1.schema.json) to every task. A null value preserves ordinary task behavior. Explicit registration records PRD and technical-plan hashes plus declared criterion/check mappings in the same locked task revision. It never interprets Markdown as an executable contract.

## Records and verification

Stable prefixed UUIDs identify projects, tasks, runs, criteria, checkpoints, evidence, authorizations, owners, and mutation events. Task and store revisions provide optimistic concurrency. Callers should persist the returned task revision and supply it to the next mutation; a stale revision produces `TASK_REVISION_CONFLICT`.

Every mutating service call accepts an optional `mutationId` such as `event_123e4567-e89b-12d3-a456-426614174000`. Persist and reuse it when retrying an uncertain call. An identical retry is idempotent; different input with the same ID produces `TASK_IDEMPOTENCY_CONFLICT`.

Evidence is current only when its criterion revision and source snapshot match the current criterion and worktree. Required evidence must be `passed`; failed, timed-out, cancelled, skipped, unsupported, or explicitly missing checks prevent verification. An approval criterion needs `approval` evidence and new direct-user authorization provenance. A saved approval requirement remains part of the criterion after restart even when no approval has been recorded.

An enrolled enhanced task must have at least one required criterion, and every required criterion must map to at least one declared check. Final verification requires current passing `enhanced-check:<check-id>` evidence for every mapping; one passing check cannot conceal a missing or failed sibling. Ordinary tasks, including tasks with no required criteria, retain the v1 verification behavior.

`src/task-state/service.js` is the service boundary. In addition to the ordinary task operations, it exports `registerEnhancedWorkflow` and `migrateTaskState`. Mutations require an expected task revision except initial creation/import and explicit store migration. `resumeTask` reconciles the source tree and the recorded process; a missing process becomes interrupted and never completed. Integrations may inject a stronger platform process probe, but may not translate missing or unknown into success.

## Provider session controller

`src/runtime/task-controller.js` coordinates an explicitly authorized provider launch with a durable task run. Its session correlation and redacted process result are stored separately in `.latchkit/tasks/sessions-v1.json`; task-state v2 adds only nullable enhanced-spec metadata and does not absorb provider session records. The controller accepts only an adapter with evidenced invocation or resume capability and the `host-local-authorized` boundary. That boundary is local execution, not a provider sandbox or an approval-policy override.

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
latchkit spec migrate --project "path/to/project" --dry-run
latchkit spec migrate --project "path/to/project"
latchkit spec register --project "path/to/project" --task task_<uuid> --expected-revision 3 --file enhanced.json
latchkit spec inspect --project "path/to/project" --task task_<uuid>
latchkit spec verify --project "path/to/project" --task task_<uuid> --expected-revision 8
latchkit spec decision-present --project "path/to/project" --task task_<uuid> \
  --plan-ref <link-or-path> --plan-digest <sha256> --summary "<one-line summary>"
latchkit spec decision-approve --project "path/to/project" --task task_<uuid> --expected-revision 1 \
  --plan-digest <sha256> --scope "src/** and test/**" --reference "maintainer approval"
latchkit spec decision-notes --project "path/to/project" --task task_<uuid> --expected-revision 2 \
  --text "<revision notes>" --plan-digest <new-sha256>
latchkit spec decision-pause --project "path/to/project" --task task_<uuid> --expected-revision 2
latchkit spec decision-build --project "path/to/project" --task task_<uuid> --expected-revision 3
latchkit spec decision-inspect --project "path/to/project" --task task_<uuid>
```

The `spec decision-*` commands are the durable decision state machine behind the `latchkit-spec`
skill's end-of-spec offer (approve and build, add notes, or keep the plan for later); see
[workflow scenarios](workflows.md#plan-only-request-and-the-end-of-spec-decision). One decision
record exists per task, keyed to a caller-supplied plan reference and a SHA-256 digest of the
exact plan content, in `.latchkit/workflows/spec-decisions-v1.json`. `decision-approve` binds an
approval to that exact digest the same way the delivery workflow's approval binds to a plan
digest (see [delivery workflow policy](architecture.md#delivery-workflow-policy)); a plan that
changes afterward — for example through `decision-notes` — makes the approval stale
(`SPEC_DECISION_PLAN_STALE`) rather than silently carrying it forward. `decision-present` and
`decision-build` are idempotent for a repeated completion event: an unchanged plan or an
already-started build is returned unchanged rather than re-prompted or re-launched, and reusing a
`--mutation-id` with different input is rejected (`SPEC_DECISION_IDEMPOTENCY_CONFLICT`) rather than
silently applied.

Use `--mutation-id event_<uuid>` to retry resume or cancel safely. Creation, criteria, checkpoints, evidence, completion, and verification stay in the service boundary so the CLI cannot be mistaken for an automatic command runner or universal approval gate.

`task start` requires both an adapter provider ID and `--host-local-authorized`; it will not add bypass flags, authenticate an account, or claim the provider's sandbox. For provider-native continuation, use `task resume --session session_<uuid> --host-local-authorized` after a session with a provider-issued resumable identity. Cursor IDE is manual-only: Latchkit returns its adapter's manual instructions rather than launching Cursor CLI as a replacement.

## Importing existing Markdown notes

Notes under `.latchkit/notes/` remain untouched. Import one explicitly:

```sh
latchkit task import --project "path/to/project" --note .latchkit/notes/example-spec.md --title "Example"
```

This records the note path and SHA-256 provenance but leaves the task awaiting a real decision. If this command itself is carrying current direct user authorization, provide both `--authorization-scope` and `--authorization-reference`. Note contents, repository instructions, and approval recorded for another task are never treated as authorization.

There is no implicit v0 migration because Markdown had no machine state contract. `latchkit spec migrate --dry-run` previews the explicit v1-to-v2 task-state migration. Applying it writes the exact original bytes to a content-addressed `.latchkit/backups/task-state.v1.<sha256>.json` path before atomically replacing active state; a backup conflict fails closed. Back up `.latchkit/tasks/` before manual repair; malformed active state or lock metadata is never guessed into a valid record.
