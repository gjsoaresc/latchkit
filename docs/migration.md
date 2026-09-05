# Upgrade, migration, rollback, and removal

Latchkit does not perform background upgrades. Treat the project configuration, managed skills, notes, and provider settings as separate surfaces.

## Upgrade the CLI and project files

Install the desired package version, inspect the project, then migrate and preview synchronization:

```sh
npm install --global latchkit@X.Y.Z
latchkit --version
latchkit config --project <path>
latchkit migrate --project <path> --dry-run
latchkit migrate --project <path>
latchkit sync --project <path> --dry-run
latchkit sync --project <path>
```

Migration validates again under the mutation lock, writes the exact prior configuration to the content-addressed path shown by the preview under `.latchkit/backups/`, and atomically replaces the active file. Re-running at the current version is read-only. Installed skills are not implicitly changed by configuration migration.

Pack upgrades are deliberate: change the selected pack source/version, review `sync --dry-run`, then sync. Checksums prove copied-byte integrity, not publisher identity. An edited managed destination blocks either upgrade or rollback and is preserved for manual review.

## Roll back configuration or the CLI

Automatic downgrade is not supported. Stop Latchkit, preserve the newer configuration, restore a reviewed backup atomically to `.latchkit/config.json`, run `latchkit config`, and preview sync before applying it. To roll back the CLI, install a known package version and repeat the same preview:

```sh
npm install --global latchkit@X.Y.Z
latchkit migrate --project <path> --dry-run
latchkit sync --project <path> --dry-run
```

Never restore a backup over a newer file without reviewing provider and skill selections that may not exist in the older schema.

## Interrupted work and conflicts

```sh
latchkit recover --project <path> --dry-run
latchkit recover --project <path>
```

The preview is read-only. Recovery rolls back an uncommitted transaction or finalizes a committed one, but never changes a resource whose bytes match neither recorded state. A live, malformed, or ambiguous lock requires manual review; retain copies of `.latchkit/lock`, `.latchkit/transaction.json`, and `.latchkit/manifest.json`.

## Remove Latchkit from a project

First preview the installed resources, then remove only unchanged Latchkit skills:

```sh
latchkit sync --project <path> --dry-run
latchkit remove --project <path>
```

Removal preserves `.latchkit/config.json`, notes, user-authored text, custom skills, provider settings, and changed managed files. Uninstall the CLI separately:

```sh
npm uninstall --global latchkit
```

Removal is not deletion of history. Project memory deletion cannot revoke older exports, backups, or Git history; delete those separately after review.
