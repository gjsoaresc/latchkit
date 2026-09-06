# Releases

Latchkit 1.0 is distributed through GitHub Releases as a Windows 11 x64
standalone, immutable bundle. npm remains development tooling and is not the
end-user installation route. A qualified bundle contains the compiled
TypeScript application, licenses and SBOM, and private Node.js 24.20.0. End
users do not need Node, npm, or BAML. The BAML integration is retained on the
`feat/experimental-baml` branch.

The current release target is Windows x64 (`win32-x64`). Linux, WSL, macOS,
musl, and other architectures remain deferred experimental work. Each archive
has a SHA-256 sidecar and manifest. The manifest records the exact source
commit, runtime pins, target, package inventory, and archive checksum; the
SBOM covers the complete delivered application and Node runtime. See
[installation](installation.md) for the full supported/deferred target
matrix, PowerShell/shell installer usage, PATH and executable discovery, the
onboarding hand-off, and the current (unpublished) Homebrew/WinGet
packaging scaffolds.

## Candidate qualification

The current source prepares `1.0.0` for final maintainer approval after the
TypeScript `1.0.0-rc.2` native candidate checks. No tag or release is published. Existing
RC1 evidence is historical evidence for the earlier application and cannot
qualify these bundles. CI workflow cells describe configured coverage; they do
not become release evidence until the exact archive produces passing evidence
for that target and environment.

Before a maintainer considers a release candidate, run on Windows 11:

```powershell
npm ci --ignore-scripts
npm run check
npm test
npm run release:artifacts
Copy-Item install.ps1 -Destination release-artifacts
node scripts/bundle-smoke.js --directory release-artifacts
```

The release workflow builds the Windows archive with Node.js 24.20.0. Bundle
smoke removes `node`, `npm`, and `baml` from `PATH`, exercises the packaged
CLI, UI/API, hooks, spaces and Unicode, asynchronous policy execution,
installation, failed-upgrade preservation, rollback, and uninstall retention.
A release is not qualified until the corresponding evidence files are reviewed
for the exact archive bytes.

For a reproducible synthetic performance record against an extracted or installed
candidate, run the benchmark harness from that candidate's private Node runtime.
Pass its sibling `app` directory and a separate evidence filename:

```powershell
& 'C:\\candidate\\runtime\\node.exe' .\\scripts\\benchmarks.js `
  --app 'C:\\candidate\\app' `
  --output '.github\\release-evidence\\rc2\\benchmarks-standalone.json'
```

An installed version uses the same layout beneath `versions\\<version>-win32-x64`.
The harness verifies the local embedded manifest, clean commit, app receipts, and
private runtime binding before it imports application modules or runs a sample. It
does not assert an archive name or checksum; use the release artifact verifier for
archive-byte qualification. Without `--app`, `npm run benchmark:baseline` retains
the development-compiled-tree baseline and its default output path.

Dispatch a preparation run with `publish: false`. For a subsequent version,
set `prior_run_id` to the completed preparation run for its predecessor. This
downloads the exact prior Windows archive and proves installation, upgrade,
rollback, and continued dispatch through hooks bound to the prior version. A
smoke run without a prior archive is useful for initial candidate validation
but cannot satisfy the publication upgrade gate. Prior archives and their
checksum and manifest sidecars are retained under
`release-artifacts/previous/` for verification.

Qualify the downloaded Windows archive on Windows 11, and run the live workflow
harness against an exact candidate archive with an authenticated coding tool.
Keep the resulting sanitized `.evidence.json` records in
`.github/release-evidence/`. These records bind qualification to archive hashes;
they cannot qualify a later rebuild with different bytes.

## GitHub Release publication

The controlled workflow is `.github/workflows/release.yml`. It builds the
Windows x64 bundle with Node.js 24.20.0, runs the checks and bundle smoke, then
uploads its archive, checksum, manifest, SBOM, and qualification evidence as
workflow artifacts. Publication downloads those already-qualified bytes and
verifies them against the exact tag commit before calling `gh release create`.
It does not rebuild during publication.

After final maintainer approval, create the exact version tag at the candidate
source commit. Dispatch publication with that `tag`, `publish: true`, and
`artifact_run_id` set to the qualified preparation run. Set `evidence_ref` to the
reviewed repository ref containing the Windows 11 and live workflow records.
The verifier checks the Windows bundle's complete file inventory, prior-version
upgrade evidence, Windows 11 record, and completed delivery workflow before
the protected publication step can proceed.

The publication job requires the protected `github-release-production`
environment, which is configured with required reviewer `willahealm` (GitHub
user ID `75096767`), plus explicit `publish: true` and an exact `vX.Y.Z` tag.
Publication approval remains a separate maintainer decision; no tag or release
has been created for this candidate. Prerelease tags prepare evidence; they do
not publish automatically.

## Install, upgrade, rollback, and uninstall

The PowerShell installer downloads an archive and its `.sha256` file, verifies
the checksum, unpacks to a temporary directory, verifies the expected bundle
layout, and asks the bundled runtime to stage and activate the version. A
failed installation leaves the prior active version in place. It supports an
exact version, a custom user-local root, and local files or URLs:

```powershell
./install.ps1 -Version 1.0.0 -Root "$env:LOCALAPPDATA\Latchkit"
```

Use `-Artifact`/`-Checksum` when testing a local archive or a pinned mirror.
The installer requires Windows 11 x64 and does not require elevation or
symlinks. `install.sh` is retained for deferred experimental work and is not a
qualified 1.0 installation path. See [installation](installation.md) for the
exact-version/custom-destination options both scripts share, the
checksum-verification and previous-install-preservation guarantees, and the
onboarding hand-off printed on a successful interactive install.

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

`npm run build` reconciles `dist/` against the current source on every run
(removed or renamed `.ts`/`.cts` sources, skills, schemas, and stale browser
license version directories are all reclaimed, not just layered over) rather
than requiring `npm run build:clean`. For everything else this repository's
tooling generates -- `dist/`, `test-results/`, `coverage/`,
`.latchkit-typecheck.log`, `npm pack` archives, local `release-artifacts*`
staging, and orphaned temporary directories from an interrupted
build/bundle/smoke run -- `npm run clean` is a standalone, cleanup-only
command; run it bare for a dry-run report of what it would remove and why,
or `npm run clean:apply` to remove it. Local release staging is excluded
from the default scope (`npm run clean --scope release-artifacts --apply`
removes it explicitly) because deciding which staged release is still
referenced is release domain knowledge that command does not have. See the
[generated output inventory](generated-outputs.md) for the complete list,
ownership, retention policy, and cleanup entrypoint of every location, plus
how release archive and sidecar publication now stages and commits as a set
so a failure never leaves a partial, misleading artifact behind.
