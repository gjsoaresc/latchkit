# WinGet packaging — plan, not a working manifest

**This is a documented plan, not a functional WinGet package.** Do not
advertise `winget install latchkit` as working; it is not.

## Why the current release archive does not fit WinGet

WinGet's declarative manifest formats (`msi`, `msix`, `exe`, `zip` +
`NestedInstallerType: portable`, ...) all assume the archive/installer is
already runnable once placed on disk. Latchkit's actual Windows release
archive (`latchkit-<version>-win32-x64.zip`, built by
emitted `dist/scripts/release-artifacts.js`) is **not** that: it contains
`runtime/node.exe`, `app/dist/...`, and `bundle-manifest.json`, but
`bin/latchkit.cmd` / `bin/latchkit.ps1` do not exist until
`src/installation/manager.ts` (`createStableLaunchers`) actually stages and
activates the bundle — the same step `install.ps1` performs by running the
bundled Node against `app/dist/src/installation/entry.js install`. A
declarative WinGet manifest cannot run that step; it can only place files
and, optionally, point at a `NestedInstallerFiles` entry that must already
exist inside the archive.

Two ways to close that gap were considered:

1. **`InstallerType: exe` wrapping `install.ps1`.** WinGet can invoke an
   arbitrary installer executable with switches. This would need a small
   compiled or self-extracting stub that runs `install.ps1` non-interactively
   with a fixed `-Root`, which does not exist today and adds a new build
   artifact to qualify and sign.
2. **A distinct "pre-staged root" archive variant** (the plan drafted here):
   ship a *second* archive shaped like an already-activated install root —
   i.e. containing `bin/latchkit.cmd`, a `current` pointer file, and
   `versions/<version>-win32-x64/...` — so it is directly usable as a
   `zip` + `NestedInstallerType: portable` WinGet package with
   `NestedInstallerFiles: [{RelativeFilePath: bin\latchkit.cmd, ...}]`. This
   needs a new, small addition to the release pipeline (run the manager
   once at build time against an empty root, then re-archive that root) —
   not implemented yet.

Option 2 is the one `willahealm.Latchkit.installer.yaml` in this directory
sketches, because it requires no new installer executable and reuses the
exact same manager code and checksums as the direct-install path. It is
**not implemented**: emitted `dist/scripts/release-artifacts.js` does not produce this
artifact shape today.

## What is in this directory

- `manifests/w/willahealm/Latchkit/0.0.0/` — a draft, three-file WinGet
  manifest set (version / installer / locale) following the standard
  `winget-pkgs` layout and moniker convention. Every version, URL, and
  `InstallerSha256` is a placeholder. It assumes the not-yet-built
  "pre-staged root" archive from option 2 above.
- This file, documenting the gap explicitly.

## Before this can be submitted for real

1. Build the "pre-staged root" artifact variant (or the `exe` stub from
   option 1) in the release pipeline — out of scope for this change.
2. Qualify and publish it through the normal Windows release process
   (`docs/releases.md`).
3. Replace every placeholder in the manifest set with the real version,
   download URL, and `InstallerSha256`.
4. Validate with `winget validate --manifest packaging/winget/manifests/...`
   and `winget install --manifest ...` locally before submitting anything to
   `microsoft/winget-pkgs` — none of that validation has been run yet.
5. Submitting to `winget-pkgs` is a separate, later maintainer action (this
   issue only prepares the plan/scaffold; it does not publish or submit).
