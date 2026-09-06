# Configuration contracts

Latchkit treats `.latchkit/config.json` as a versioned project contract. Reading configuration validates it but never rewrites, upgrades, or downgrades it. The CLI, local API, console, and skill synchronization all use the same validator. Published JSON Schemas live in `schemas/`.

## Supported versions

Version 1 contains `schemaVersion`, `providers`, and `skills`. Existing valid v1 files remain supported and are returned in their original shape.

Version 2 adds the required `providerSettings` object. Its keys must be registered provider IDs, but each value is an opaque JSON object owned by that provider's future adapter contract. Settings remain present when a provider is deselected so that selection changes do not erase user preferences. Credentials, workflow state, source-pack metadata, and global provider permission policy do not belong in this file.

Version 3 pack selections can also use an immutable Git source. A Git source names its `repository`, lowercase 40- or 64-character `commit`, and optional portable pack `path`; `pinned` must be `true`. It is not a branch or tag reference. Fetch it explicitly with `latchkit pack fetch --id <pack-id>`, which validates the exact commit, its MIT author/license attestation, the pack manifest, regular Git blob modes, and every declared SHA-256 before recording an inspectable project-local cache under `.latchkit/packs/git/`. Reads, previews, and `sync` use that cache only and never contact Git. If a source is unavailable before its first fetch, they return an actionable error and leave installed resources untouched.

All supported versions reject unknown top-level fields, unknown provider or skill IDs, duplicate selections, missing fields, and incorrect types. Validation errors use a stable code and a JSON-style field path. Future schema versions are refused until the running Latchkit version explicitly supports them.

## Explicit migration and recovery

Preview the current migration without modifying the project:

```sh
latchkit migrate --dry-run
```

Apply it with `latchkit migrate`. The operation takes the project mutation lock, validates the current file again, writes its exact bytes to the content-addressed path reported by the preview under `.latchkit/backups/`, and atomically replaces the active configuration. A conflicting backup is never overwritten. A backup failure or active-file replacement failure leaves the previous configuration usable; installed skills are not part of the migration.

Repeating migration at the current version is a read-only success. Automatic downgrade is not supported. To restore, stop Latchkit processes, review the reported backup, copy its exact contents back to `.latchkit/config.json` using an atomic file replacement, and rerun `latchkit config` before syncing. Keep the newer file separately if it contains provider settings that do not exist in the restored version.

The authenticated local API exposes the same operations through `GET /api/config/migration?to=2` and `POST /api/config/migration` with `{ "toVersion": 2 }`. API versioning, revisions, and stale-preview enforcement are tracked separately.
