# ADR 0002: Inspectable local project memory

## Decision

Project memory uses the versioned, atomic JSON snapshot `.latchkit/memory/state-v1.json`. It is deliberately separate from task state: a small project-scoped collection of decisions, discoveries, constraints, and resolved defects needs direct inspection and portable export, not a controller/session database. The task-state live-proof lock serializes snapshot writers; optimistic per-memory revisions detect an edit based on an older inspection.

There is no embedding service, transcript ingestion, hidden cache, cloud sync, or automatic provider-store modification. Text search is bounded, deterministic local substring scoring over active records. Deletion overwrites managed title, text, tags, and source references and excludes the record from all search, recovery, and exports. It cannot delete copies already exported, backups, filesystem recovery artifacts, or Git history.

## Recovery boundary

Recovery builds an explicitly budgeted, on-demand context block only when the supplied provider contract has supported or partial compaction evidence. It labels records as historical and untrusted, checks source hashes/existence, and reports stale sources. Otherwise it returns a truthful manual mode rather than pretending to inject context.

## Privacy boundary

Capture is explicit. Latchkit rejects likely credentials and common secret-file paths; it does not claim perfect secret detection. Memories are historical data, never executable instructions or authorization grants.
