# Upgrade, migration, rollback, and removal

Latchkit does not perform background upgrades. Treat the project configuration, managed skills, notes, and provider settings as separate surfaces.

## Upgrade the CLI and project files

Latchkit end users install and upgrade the CLI itself as a standalone,
user-local bundle from GitHub Releases (see [installation](installation.md)
and [releases](releases.md)) — never through npm. `npm install --global
latchkit` remains development tooling for working inside this repository's
own checkout; it is not the supported end-user installation or upgrade path.

Upgrade an already-installed standalone bundle in place, either directly:

```powershell
latchkit self upgrade --to X.Y.Z --bundle <path-to-extracted-candidate>
latchkit self inspect
```

or by re-running the bootstrap script with an explicit version, which
downloads, verifies, and hands off to the same installation manager (see
[install/upgrade/rollback/uninstall](releases.md#install-upgrade-rollback-and-uninstall)):

```powershell
./install.ps1 -Version X.Y.Z -Root "$env:LOCALAPPDATA\Latchkit"
```

A narrow console/CLI updater (`latchkit update status|check|preview|stage|rollback`,
issue #139) can check the configured official release source and stage a
compatible update without a separate bootstrap invocation — see
[Update ownership and channel detection](installation.md#update-ownership-and-channel-detection).
`stage` never activates the update it prepares; console-driven install-and-restart
and opt-in automatic updates are later slices of that same issue.

Once the CLI itself is at the desired version, inspect the project and
migrate/sync its configuration exactly as before:

```sh
latchkit --version
latchkit config --project <path>
latchkit migrate --project <path> --dry-run
latchkit migrate --project <path>
latchkit sync --project <path> --dry-run
latchkit sync --project <path>
```

Migration validates again under the mutation lock, writes the exact prior configuration to the content-addressed path shown by the preview under `.latchkit/backups/`, and atomically replaces the active file. Re-running at the current version is read-only. Installed skills are not implicitly changed by configuration migration.

Pack upgrades are deliberate: change the selected pack source/version, review `sync --dry-run`, then sync. Checksums prove copied-byte integrity, not publisher identity. An edited managed destination blocks either upgrade or rollback and is preserved for manual review.

For immutable Git packs, run `latchkit pack fetch --id <pack-id>` after changing the pinned commit and before the preview. The source cache records the repository, resolved commit, declared files, and exact hashes. Moving a branch or tag has no effect because Latchkit fetches the configured object ID only. Git sources must attest an original author and `MIT` license; Latchkit does not execute pack content, hooks, package installers, or pushes. A local edit to a managed pack resource is treated as a team customization: it remains in place and blocks the upgrade or rollback until the team reconciles it. Supporting resources below `skills/<skill-name>/` are owned and removed with the same rules as `SKILL.md`.

## Roll back configuration or the CLI

Automatic downgrade is not supported. Stop Latchkit, preserve the newer configuration, restore a reviewed backup atomically to `.latchkit/config.json`, run `latchkit config`, and preview sync before applying it. To roll back a standalone-installed CLI, point the installed bundle's own rollback command at a previously staged version — staging retains every prior version until explicitly detached (see [install/upgrade/rollback/uninstall](releases.md#install-upgrade-rollback-and-uninstall)) — and repeat the same preview:

```powershell
latchkit self rollback --to X.Y.Z
latchkit migrate --project <path> --dry-run
latchkit sync --project <path> --dry-run
```

Inside a repository development checkout, `npm install --global latchkit@X.Y.Z` remains available for local development use only; it is not the end-user rollback path.

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

Removal preserves `.latchkit/config.json`, notes, user-authored text, custom skills, provider settings, and changed managed files. Uninstall the standalone CLI itself separately — it retains every project's `.latchkit/` state and every staged version directory, both requiring deliberate manual cleanup (see [install/upgrade/rollback/uninstall](releases.md#install-upgrade-rollback-and-uninstall)):

```powershell
latchkit self uninstall
```

Inside a repository development checkout, `npm uninstall --global latchkit` removes the development-only global link; it is not the end-user uninstall path.

Removal is not deletion of history. Project memory deletion cannot revoke older exports, backups, or Git history; delete those separately after review.
