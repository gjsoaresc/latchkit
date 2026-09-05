# ADR 0001: Atomic local files for workflow state

- Status: accepted
- Date: 2026-09-05

## Context

Latchkit needs resumable project, task, run, criterion, checkpoint, evidence, and authorization records on Node.js 22+ across native Windows, Linux, macOS, and WSL. The data must remain inspectable without a service, survive process termination at a write boundary, reject concurrent stale writers, and evolve through explicit schema versions. Workflow persistence must not reuse the installer transaction journal or confuse an installation lock with task ownership.

The principal choices were an atomic JSON snapshot, an append-only file journal, and SQLite. SQLite provides strong transactions and indexing, but Node 22's SQLite API was experimental and adding a native dependency would increase installation and cross-platform packaging cost. A custom append-only journal improves write amplification, but requires framing, compaction, tail-corruption recovery, and migration logic before the expected local task volume justifies those costs. A JSON snapshot is easiest for users to inspect and back up, and the repository already has cross-platform fsync-and-rename primitives.

## Decision

Version 1 uses `.latchkit/tasks/state-v1.json`, a strictly validated atomic JSON snapshot. A replacement is written to a unique sibling file, flushed, renamed over the active snapshot, and followed by a best-effort parent-directory sync. A process killed before rename leaves the previous complete snapshot authoritative; a process killed after rename leaves the new complete snapshot authoritative. Orphan sibling temporary files are never read as state and may be removed during maintenance. Storage devices and network filesystems that do not honor these primitives are outside the durability guarantee.

Writers take the separate `.latchkit/tasks/lock`. Its loopback challenge proves the lock-owning process still possesses an ephemeral private key, avoiding PID-reuse assumptions. Contenders wait briefly; after acquisition they compare the task's expected revision. A proven-dead lock can be reclaimed, while malformed metadata requires manual inspection. The installer lock and installer transaction remain independent.

Each mutation has a caller-visible `event_*` idempotency ID and request digest. Retrying the same request returns the committed task without adding an event; reusing that ID for different input is rejected. Every task mutation increments both the task revision and store revision. Task ownership is a persisted `(runId, ownerId, task revision)` tuple; it is not inferred from the writer lock.

Task transitions are:

- `planned`, `blocked`, or `awaiting-decision` → `running` through resume, after explicit user authorization when required.
- `running` → `awaiting-decision` or `blocked` through pause, or → `completed` through completion.
- Any non-terminal state → `cancelled`; `cancelled` and `verified` are terminal.
- `completed` → `verified` only when every required criterion has passing evidence for its current criterion revision and the current source revision/dirty fingerprint. Revising criteria returns a completed task to `planned`.

A missing process makes an active run `interrupted` during resume; it never implies completion. A still-live recorded process prevents takeover. Cancellation clears ownership and marks the run cancelled, so a late completion fails its expected-revision and ownership checks and cannot resurrect the run.

Evidence records criterion revision, source revision or dirty-worktree fingerprint, run, command, Node/OS/runtime/cwd, outcome, optional artifact, and timestamp. `failed`, `skipped`, `unsupported`, and `missing` outcomes cannot verify a required criterion. Approval criteria additionally require approval evidence linked to a fresh authorization record whose source is `user`; repository text and another task are rejected as authorization provenance.

Markdown notes remain user-owned. Import is explicit, records note path/hash/time, and does not parse prose into authorization. Imports without separately supplied user authorization remain `awaiting-decision`.

## Consequences

The v1 store is dependency-free, portable, recoverable, and directly inspectable. Whole-file rewrites are acceptable for local task volumes but are not intended for high-throughput or cloud synchronization. Schema upgrades will use a new versioned file plus explicit preview/back-up migration, never an implicit read-time rewrite. If workload size or multi-host access later warrants SQLite, migration can consume this published v1 contract while retaining the original bytes.
