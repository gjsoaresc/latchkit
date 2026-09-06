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

## Task workspace preference

An optional `workspace` object is accepted on every supported configuration version; it needs no migration and existing files remain valid without it. It records two independent, persisted project settings:

```json
"workspace": {
  "executionPreference": "ask",
  "worktreeRoot": ".latchkit/worktrees"
}
```

`executionPreference` is one of:

- `ask` — present the worktree/direct choice before each new task starts; starting nothing is the only safe behavior when no explicit choice is given.
- `always-worktree` — isolate every new task in a Git worktree without asking again.
- `direct` — never create a worktree for a new task; run in the project checkout.

A project without this setting behaves as `direct`, which is the only behavior every earlier release had, so an existing project's observable behavior is unchanged until this is set explicitly.

`worktreeRoot` is either a portable, project-relative path using forward slashes (the default is `.latchkit/worktrees`), or an explicit absolute native path. It is validated for shape when saved, and re-validated against the live repository — refusing a root that is, contains, or sits inside the project checkout or its Git directory — when a worktree is actually resolved. A project-relative root always resolves against the stable main checkout, identified through Git's own worktree listing, never the working directory a command happened to run from; starting a workspace operation from inside a linked worktree therefore cannot nest a worktree root inside another worktree.

Both fields are independent of any per-task override (an explicit `worktree`/`direct` choice, or an explicit `--worktree-root`, passed to a single task start) and of the separate, independently required isolation used for reviewer sessions (`latchkit review`), which never shares this preference. Changing the project preference or root only affects new tasks; an already-started or resumed task keeps whatever workspace (or lack of one) it was given at its first start and never re-decides, so a later default change cannot move an active task or weaken provider permissions.

Set or inspect it with:

```sh
latchkit workspace preference
latchkit workspace preference --execution always-worktree --worktree-root .latchkit/worktrees
latchkit workspace inspect --worktree-root <path>
```

`workspace preference` with no flags reports the effective, defaulted setting without requiring an initialized project; setting a value requires one (`latchkit init` first). `workspace inspect` reports the resolved effective worktree-creation location before any worktree is created. The same setting is also readable and writable through the existing `GET /api/state` / `PUT /api/config` configuration endpoints and is editable in the local console.

Saving a project-relative `worktreeRoot` (from `latchkit init`, `latchkit workspace preference`, or a configuration save) adds one owned exclusion line for it to the project's `.gitignore`, preserving existing content, so it never appears in `git status`, staging, recursive project discovery, or review snapshots. This is an explicit configuration-time action; creating a worktree itself never modifies the source checkout. A project that never runs `latchkit init` or explicitly sets this preference, and instead calls the lower-level `latchkit workspace create` directly against an unconfigured repository, does not get this exclusion automatically — the new worktree remains functionally isolated but may appear as an untracked path in `git status` until the root is explicitly configured or ignored.

Existing worktrees created by an earlier release at the previous deterministic hidden-sibling location keep working: their registry record already carries its own resolved path, independent of the current default, so resuming, cancelling, or cleaning up an existing task never moves it.
