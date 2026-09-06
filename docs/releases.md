# Releases

Latchkit 1.0 is distributed through GitHub Releases as standalone, immutable
bundles. npm remains development tooling and is not the end-user installation
route. A qualified bundle contains the compiled application, generated BAML
SDK, complete production dependency closure, licenses and SBOM, and private
Node.js 24.20.0. End users do not need Node, npm, or the BAML compiler.

The supported release targets are Windows x64 (`win32-x64`), Linux x64 with
glibc (`linux-x64`, including WSL), macOS x64 (`darwin-x64`), and macOS arm64
(`darwin-arm64`). musl Linux and other architectures are not advertised.
Each archive has a SHA-256 sidecar and manifest. The manifest records the
exact source commit, runtime pins, target, package inventory, and archive
checksum; the SBOM covers Node and the native BAML dependency closure.

## Candidate qualification

The current version is `1.0.0-rc.2` and remains under qualification. Existing
RC1 evidence is historical evidence for the earlier application and cannot
qualify these bundles. CI workflow cells describe configured coverage; they do
not become release evidence until the exact archive produces passing evidence
for that target and environment.

Before a maintainer considers a release candidate, run on each matching build
host:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run release:artifacts
node scripts/bundle-smoke.js --directory release-artifacts
```

The release workflow also runs the Linux archive on Ubuntu 24.04 and in WSL,
including a mounted Windows checkout. Bundle smoke removes `node`, `npm`, and
`baml` from `PATH`, exercises the packaged CLI, UI/API, hooks, spaces and
Unicode, BAML async exit, installation, failed-upgrade preservation, rollback,
and uninstall retention. A release is not qualified until the corresponding
evidence files are reviewed for the exact archive bytes.

## GitHub Release publication

The controlled workflow is `.github/workflows/release.yml`. It builds on the
four native hosts with Node 24.20.0, runs the checks and bundle smoke, then
uploads the archives, checksums, manifests, SBOMs, and qualification evidence
as workflow artifacts. Publication downloads those already-qualified bytes and
verifies them against the exact tag commit before calling `gh release create`.
It does not rebuild during publication.

The publication job requires the protected `github-release-production`
environment, which is configured with required reviewer `willahealm` (GitHub
user ID `75096767`), plus explicit `publish: true` and an exact `vX.Y.Z` tag.
Publication approval remains a separate maintainer decision; no tag or release
has been created for this candidate. Prerelease tags prepare evidence; they do
not publish automatically.

## Install, upgrade, rollback, and uninstall

The install scripts download an archive and its `.sha256` file, verify the
checksum, unpack to a temporary directory, verify the expected bundle layout,
and ask the bundled runtime to stage and activate the version. A failed
installation leaves the prior active version in place. Both scripts support an
exact version, a custom user-local root, and local files or URLs:

```powershell
./install.ps1 -Version 1.0.0-rc.2 -Root "$env:LOCALAPPDATA\Latchkit"
```

```sh
sh install.sh --version 1.0.0-rc.2 --root "$HOME/.local/share/latchkit"
```

Use `-Artifact`/`-Checksum` on PowerShell or `--artifact`/`--checksum` on
POSIX when testing a local archive or a pinned mirror. The scripts require
Windows x64, Linux x64 with glibc, or macOS x64/arm64 as applicable; they do
not require elevation or symlinks.

Inside an installed bundle, the stable launcher exposes:

```text
latchkit self inspect
latchkit self upgrade --to <version> [--install-root <path>] --bundle <path>
latchkit self rollback --to <version> [--install-root <path>]
latchkit self uninstall [--install-root <path>]
```

The installation manager stages immutable version directories and atomically
updates the `current` pointer. Uninstall removes the managed launcher and
active pointer but conservatively retains every version directory and hook
compatibility directory currently present; reference-based garbage collection
is not implemented. It also retains all project data, including
`.latchkit/` state, notes, configuration, memory, and user-authored files.
Retained installation directories require deliberate manual cleanup after any
references are detached.

## Development and recovery

For repository development, use `npm ci`, `npm run build`, and the regular
checks. `npm pack` is useful for development inspection, but it is not the
release artifact. For an interrupted project mutation, run
`latchkit recover --dry-run` before `latchkit recover`. For a failed standalone
upgrade, inspect the active version and use `self rollback`; the previous
version remains usable because activation happens only after staging and smoke
checks succeed.
