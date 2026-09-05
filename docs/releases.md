# Releases

Latchkit is distributed as the `latchkit` npm package. The package version in
`package.json` is the only release version source; `latchkit --version`, the
archive, and a release tag must all agree. Stable releases use `vX.Y.Z` tags.
Prereleases use a SemVer prerelease such as `vX.Y.Z-rc.1`; npm's prerelease
semantics ensure they do not replace the `latest` stable channel unless a
maintainer deliberately assigns a dist-tag.

## Maintainer procedure

Before creating a tag, run `npm ci`, `npm run check`, `npm test`,
`npm run smoke:artifact`, and `npm run release:dry-run`. The dry run creates a
fresh archive, SHA-256 checksum, deterministic SPDX dependency/license
inventory, and release manifest in `release-artifacts/`; it does not contact a
registry or require credentials. Review the archive with `npm pack --dry-run`.

Push the exact matching `vX.Y.Z` tag only after reviewing those results. The
tag workflow rebuilds and rechecks the tagged commit, executes installed
artifact smoke, and uploads the archive, checksum, SBOM, and manifest. Its
`publish` job is protected by the `npm-production` GitHub environment. That
environment must require maintainer approval and must be configured as an npm
trusted-publishing publisher for this repository and workflow. No npm token is
stored in this repository or used by the workflow.

The workflow publishes only stable tag pushes after environment approval.
Prerelease tags prepare evidence but do not publish. A manual workflow run is
credential-free by default; publication requires an explicit `publish` input,
an exact tag, and the same environment approval. Repository administrators
must configure package ownership and the GitHub environment outside this code.

## Install, upgrade, uninstall, and recovery

Install with `npm install --global latchkit` (or run `npx latchkit`). On WSL,
install and run the package with Node inside the Linux distribution; it does
not alter native Windows provider settings. Upgrade with the same command and
then use `latchkit sync --dry-run` before applying any project change.

To remove generated skills while preserving `.latchkit/config.json`, custom
skills, and notes, run `latchkit remove --project <path>`. Uninstall the CLI
with `npm uninstall --global latchkit`. A bad package release is recovered by
installing a known prior version (`npm install --global latchkit@X.Y.Z`) and
reviewing `sync --dry-run`; Latchkit refuses to overwrite locally edited
managed files. For interrupted project mutations, use `latchkit recover
--dry-run` before `latchkit recover`.
