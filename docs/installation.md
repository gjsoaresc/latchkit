# Installation

This document covers how to install Latchkit as a standalone, user-local
binary: which OS/architecture targets are supported, PowerShell and shell
bootstrap usage, executable discovery and PATH, the onboarding hand-off, and
the current status of the Homebrew and WinGet packaging scaffolds. For
publication, qualification, and release-evidence process, see
[releases](releases.md); for upgrade/rollback/uninstall CLI detail, see the
"Install, upgrade, rollback, and uninstall" section there.

Latchkit never requires Node.js, npm, a TypeScript runner, WSL, Bash on
Windows, symlinks, or administrator rights to install. The installer scripts
(`install.ps1`, `install.sh`) are thin, platform-specific bootstraps; all
verification, staging, and activation logic lives in
`src/installation/manager.ts`, which both scripts call into through the
private Node runtime shipped inside each release archive.

## Supported vs. deferred targets

| Target         | Status                                                      |
| -------------- | ------------------------------------------------------------ |
| `win32-x64`    | **Qualified 1.0 release target.** `install.ps1`.              |
| `linux-x64`    | Scripted (`install.sh` detects and accepts it) but **deferred experimental** — no qualified release archive exists yet. |
| `darwin-x64`   | Scripted but **deferred experimental** — same as above.       |
| `darwin-arm64` | Scripted but **deferred experimental** — same as above.       |
| `win32-arm64`  | **Unsupported.** `install.ps1` rejects it before making any change. |
| `linux-arm64`  | **Unsupported.** `install.sh` rejects this specific combination (each of `linux` and `arm64` is individually recognized, but the pair is not a supported target) before making any change. |
| Anything else (other `uname -s`/`uname -m`, non-glibc Linux, etc.) | **Unsupported.** Rejected before making any change. |

Both scripts detect an unsupported target and exit with a readable message
before writing anything to disk, staging anything, or making any network
call. See `test/install-scripts.test.js` for direct evidence: it drives the
genuine, unmodified scripts (not a reimplementation) with a faked `uname` to
prove `linux-arm64`, an unrecognized OS, and an unrecognized architecture are
all rejected first, and drives `install.ps1` on a real Windows host with an
overridden `PROCESSOR_ARCHITECTURE` to prove the same for a non-x64 target.

## Install on Windows (PowerShell)

Works in Windows PowerShell 5.1 and PowerShell 7. No administrator rights,
symlinks, or Bash required.

```powershell
./install.ps1 -Version 1.0.0 -Root "$env:LOCALAPPDATA\Latchkit"
```

- `-Version` — an exact release version. Omit (or pass `latest`) to resolve
  the newest GitHub Release.
- `-Root` — a custom, user-local installation destination. Defaults to
  `%LOCALAPPDATA%\Latchkit`.
- `-Artifact` / `-Checksum` — a local file path or a URL for the archive and
  its `.sha256` sidecar, for testing a local candidate or a pinned mirror
  without touching GitHub Releases.

The script downloads (or copies, for a local `-Artifact`) the archive and
its `.sha256` sidecar, verifies the SHA-256 digest, unpacks to a temporary
directory, and hands off to the bundled installation manager, which
independently re-verifies every file against the archive's embedded
`bundle-manifest.json` before staging, smoke-checks the staged bundle, and
only then atomically activates it. See
[Verification and failure preservation](#verification-and-failure-preservation)
below for exactly what "preserve the previous install on failure" means.

## Install on Linux/macOS (shell) — experimental, not a qualified 1.0 path

```sh
./install.sh --version 1.0.0 --root "$XDG_DATA_HOME/latchkit"
```

Same options as `install.ps1` (`--version`, `--root`, `--artifact`,
`--checksum`), POSIX `sh` compatible (no bashisms), no administrator rights
or symlinks required. **This path is retained for deferred experimental
work and is not a qualified 1.0 installation path** — see the target table
above. Do not rely on it for a supported install until `docs/releases.md`
qualifies a Linux/macOS release archive.

## Exact version, custom destination, repeatability

Both scripts accept an exact `--version`/`-Version` and a custom
`--root`/`-Root`. Re-running either script with the same version and root is
idempotent, but only at the manager's staging step, not the bootstrap's own
download: `install.ps1`/`install.sh` always download (or re-copy, for a local
`-Artifact`) the archive and its checksum sidecar first, exactly as on a first
install — the script itself has no way to know the requested version is
already staged before fetching it. Only after that download does the
installation manager recognize an already-staged, byte-identical version and
re-activate it without re-copying or re-staging its files, rather than
erroring. This split is intentional: staging/verification and activation are
separate operations in `src/installation/manager.ts` (`stageBundle` vs.
pointing `current` at an already-staged version), and only the latter is
deduplicated here. A console/CLI-driven update (issue #139) that already has
a local, verified candidate can skip the redundant re-download that the
bootstrap scripts cannot avoid. Running with a *different* version simply
stages and activates that version alongside the existing ones (see
[upgrade/rollback/uninstall](releases.md#install-upgrade-rollback-and-uninstall)).
Requesting a version that does not match the resolved archive's own embedded
version fails clearly (`Requested version does not match bundle version.`)
without disturbing whatever was previously active.

## Verification and failure preservation

Every install goes through two independent checks before anything is
activated:

1. **Archive-level:** the script itself verifies the downloaded/copied
   archive's SHA-256 against its `.sha256` sidecar before unpacking
   anything. A mismatch aborts immediately (`Archive SHA-256 verification
   failed.`) — nothing is unpacked, staged, or activated, and whatever was
   previously active (if anything) is untouched.
2. **Manifest-level:** the installation manager re-verifies every individual
   file inside the unpacked archive against the archive's own embedded
   `bundle-manifest.json` (per-file SHA-256 and byte length), then runs a
   smoke check (the staged bundle's own CLI and workflow-policy module must
   actually run and report the expected version) — all before the `current`
   activation pointer is updated. A failure at any point in staging,
   verification, or the smoke check leaves the previously active version's
   `current` pointer untouched and removes only the newly staged (not yet
   activated) directory.

`test/install-scripts.test.js` and `test/installation.test.js` both assert
this directly: a corrupted/mismatched checksum, or a corrupted bundle file,
leaves the previously active version's `current` pointer and installed
files exactly as they were, and the failed candidate is never staged
under `versions/`.

## Upgrade, rollback, and uninstall

Covered in [releases.md](releases.md#install-upgrade-rollback-and-uninstall).
In short: `latchkit self upgrade|rollback|uninstall|inspect` operate on an
installed root; uninstall removes the managed launcher and active pointer
but conservatively retains every staged version directory and all project
`.latchkit/` state (nothing project-scoped is ever touched by installation
management).

## Executable discovery and PATH

Neither `install.ps1` nor `install.sh` modifies your `PATH`. Each prints the
exact launcher path on success:

- Windows: `<root>\bin\latchkit.cmd` and `<root>\bin\latchkit.ps1`
- Linux/macOS: `<root>/bin/latchkit`

Use the printed path directly, or add its directory to `PATH` yourself:

- Windows (current user, no admin rights): System Properties → Environment
  Variables → User variables → `Path`, or
  `setx PATH "$($env:PATH);$root\bin"` in a **new** shell afterward (`setx`
  only affects future sessions).
- POSIX shells: add `export PATH="$root/bin:$PATH"` to your shell's rc file
  (`~/.bashrc`, `~/.zshrc`, etc.).

The launcher scripts resolve the active version relative to their own
location (`$PSScriptRoot` / `%~dp0` / a POSIX equivalent) — they are not
tied to the directory they happened to be invoked from, so adding the `bin`
directory to `PATH` is safe and is the only supported way to make `latchkit`
available as a bare command.

## Onboarding hook point

Issue #100's onboarding flow is `latchkit onboarding` (a CLI wizard that also
works as an accessible fallback with no browser) and the browser console's
onboarding page (`web/onboarding.tsx`, served by `latchkit ui`) — see
[Onboarding](#onboarding) below for what each step does. A successful
`install` run through `src/installation/entry.ts` (i.e., through
`install.ps1`/`install.sh`) prints one of two messages, decided by
`src/installation/onboarding.ts`:

- **Interactive** (both stdin and stdout are a TTY, and neither `CI` nor
  `LATCHKIT_NON_INTERACTIVE=1` is set, and `--non-interactive` was not
  passed): a suggested next command pointing at `latchkit onboarding` — e.g.
  `Next: run "<root>/bin/latchkit onboarding --project <your-project-path>"
  to see setup status, or add "ui" in place of "onboarding" to finish setup
  ... in the browser console.`
- **Non-interactive** (CI, a script, `--non-interactive`, or no attached
  TTY): a status line confirming the install is ready, that onboarding was
  deferred, and naming the same next command, and nothing else. **It never
  launches a server, opens a browser, or blocks waiting for input** — this is
  asserted directly by `test/installation-onboarding.test.js`, including the
  default (no flag) case, so automation that pipes `install.ps1`/`install.sh`
  output never hangs. `latchkit onboarding` itself is equally safe to name
  here: with no subcommand it only inspects and prints current onboarding
  state (see below) and exits — it never prompts or launches anything either.

This message is printed to stderr as plain text (not part of the JSON on
stdout), and it is scoped to the literal `install` command only — both
bootstrap scripts always invoke `install` (the manager itself distinguishes
a fresh install from an upgrade internally), so this covers exactly the
"run the installer interactively" scenario the hook point exists for.
`latchkit self install` invoked directly from an already-installed CLI does
not go through `entry.ts` and does not print this message.

## Onboarding

`latchkit onboarding [action] [options]` drives a resumable, skippable setup
wizard for one project. Every action prints its resulting JSON state and
exits immediately — there is no interactive prompt anywhere in this CLI, so
it is inherently safe to run from a script or a TTY-less shell:

```powershell
& $latchkit onboarding --project "C:/path/to/project"                              # inspect (default action)
& $latchkit onboarding project --project "C:/path/to/project"                      # select/initialize the project
& $latchkit onboarding providers --project "C:/path/to/project" --providers 'claude,codex' --skills 'spec,build'
& $latchkit onboarding workspace --project "C:/path/to/project" --execution ask
& $latchkit onboarding verification --project "C:/path/to/project" --verification-mode fast
& $latchkit onboarding usage enable --project "C:/path/to/project"
& $latchkit onboarding preview --project "C:/path/to/project"                      # reuses sync --dry-run
& $latchkit onboarding apply --project "C:/path/to/project"                        # reuses sync
& $latchkit onboarding complete --project "C:/path/to/project"
```

`skip <step>` and `back <step>` move between steps without losing anything
already saved (every step writes straight to its own existing store —
`config.json`, verification settings, usage settings — so nothing here is a
second copy); `dismiss`/`cancel` stop the current run without discarding
saved settings, and any later step action resumes it automatically. Progress
for one project lives in `.latchkit/onboarding/state-v1.json`; whether
onboarding has been offered/completed/dismissed *on this machine* (so an
ordinary launch or upgrade does not repeat it) is tracked separately, beside
the installation's own activation state
(`<install-root>/onboarding-state.json`, next to `current` and
`.launchers.json` — see `src/installation/onboarding-state.ts`).

The `project` step (`selectProject` in `src/onboarding/service.ts`) is also one of the
[multi-project overview](projects.md)'s registry capture points: once the selected project is
initialized, it is registered with `source: 'onboarding'` in the same user-local registry
`latchkit init`/`latchkit ui`/`latchkit projects add` capture into (`registerProject`, idempotent
by resolved root — see [projects.md](projects.md#where-a-project-is-captured-today)). This never
fails the step itself: an unavailable or unwritable registry root is caught and reported back as
an explicit `registryWarning` (`null` on success) on the step's result instead, so a wizard caller
(the CLI or the browser console) can surface it without the "project" step ever failing because of
it.

The same steps are available as a guided wizard in the browser console
(`latchkit ui`, `#onboarding` section): it distinguishes an agent that is
*unavailable* (not found on PATH), *installed* (found, not yet selected), and
*configured* (found and selected) — and reports authentication as *unknown*
always, since no adapter here can verify a signed-in provider session. It
previews the exact files a sync would change (reusing `sync --dry-run`)
before applying anything, through the same registered-resource transaction
layer as `latchkit sync`.

## Homebrew and WinGet

Both are **scaffolded, not published or submitted anywhere**:

- **Homebrew:** [`packaging/homebrew/latchkit.rb`](../packaging/homebrew/latchkit.rb)
  drives the real installation manager (the same code `install.sh` calls),
  so the mechanism is genuine — but every version/URL/checksum in it is a
  placeholder, because there is no qualified macOS/Linux release archive to
  point at yet (see the target table above). Not tapped, not audited, not
  build-tested. Details: [`packaging/homebrew/README.md`](../packaging/homebrew/README.md).
- **WinGet:** the current Windows release archive is not directly
  WinGet-portable-compatible (it needs the installation manager to run
  before a launcher exists) — see
  [`packaging/winget/README.md`](../packaging/winget/README.md) for why, and
  the two options considered. `packaging/winget/manifests/...` is a draft
  manifest set assuming a not-yet-built artifact variant; it is explicitly
  marked non-functional and every value is a placeholder.

Do not advertise `brew install latchkit` or `winget install latchkit` as
working. Publishing/submitting either is a separate, later maintainer
decision, out of scope for this change.

## Package-manager upgrade/uninstall ownership

Every installation operation (`install`, `self upgrade`, `self rollback`,
`self uninstall`) is scoped entirely to the `--root`/`-Root` directory it is
given. This means:

- A Homebrew-managed install (once real) is owned by Homebrew: `brew
  upgrade`/`brew uninstall` operate only on that formula's own prefix. They
  never touch a separately direct-installed root, and never touch any
  project's `.latchkit/` state (which lives inside each project directory,
  never inside the installation root).
- The same isolation applies to a future WinGet-installed root.
- Do not point a direct `install.ps1`/`install.sh` install and a
  package-manager-managed install at the same root — each manager's
  upgrade/uninstall assumes it owns that root's launcher files (the manager
  refuses to overwrite a launcher it does not recognize as its own, so a
  conflict fails loudly rather than corrupting either installation, but
  mixing them is still not a supported configuration).

## Update ownership and channel detection

Issue #139's console/CLI updater must never silently fall back to a direct
self-install on an installation it does not actually own. Ownership is
detected by `detectInstallationOwnership` in
`src/installation/updates/ownership.ts`, which classifies exactly four kinds
before any release check or staging is attempted:

- **`source-development`** — running directly from a source checkout (no
  `LATCHKIT_INSTALL_ROOT`, which only a stable launcher sets — see
  `createStableLaunchers` in `src/installation/manager.ts`). There is no
  standalone bundle to update; use `git`/`npm` on the checkout instead.
- **`unsupported-platform`** — the running `<platform>-<arch>` pair is not
  one either installer script even accepts (see the
  [supported/deferred target table](#supported-vs-deferred-targets) above).
  No update route exists.
- **`package-manager`** — the resolved root sits under a recognized
  Homebrew (`Cellar`/`homebrew`) or WinGet (`Microsoft\WinGet\Packages`) path
  segment. The updater must defer to that manager's own upgrade/uninstall
  commands (see [above](#package-manager-upgradeuninstall-ownership)), never
  overwrite that prefix directly.
- **`unowned`** — the root exists (or does not exist yet) but the manager's
  own `inspectInstallation` finds no active version and no recognized
  managed launcher there. Direct self-install is still refused; the correct
  action is running the installer to adopt the root, exactly as today.
- **`self-managed`** — a real direct install with its own recognized,
  owned launchers. This is the only kind the console/CLI updater may act on.

**Override contract:** `detectInstallationOwnership`'s `root` and
`runningFromInstallRoot` parameters must only ever come from a trusted
caller — the CLI (an operator's own `--install-root`, or the process's own
`LATCHKIT_INSTALL_ROOT`) or a test fixture. A future authenticated local API
(issue #139 slice 2) must resolve both only from the current server
process's own verified installation identity and must never accept a root,
path, or override from request/browser input; doing so would let a caller
nominate an arbitrary managed root for update operations to act on. This
mirrors the existing constraint that the registered-resource transaction
layer and the installation manager's own path checks already enforce for
every other managed-filesystem operation in this repository.

The narrow CLI fallback `latchkit update status|check|preview|stage|rollback`
(see `src/cli.ts`) operates the same way `latchkit self ...` already does:
`--install-root` is required explicitly (or `LATCHKIT_INSTALL_ROOT` from the
environment), never inferred from an unauthenticated source. `stage` never
activates — it downloads, verifies, extracts, and stages a compatible update
exactly like `self upgrade` does internally, but stops before touching
`current`, the managed launchers, or the runtime a new launch resolves to;
`rollback` reuses the existing `self rollback` activation primitive
directly. Restart handoff, the console UI, and onboarding/Settings
automation are later #139 slices.

## Console update and restart (issue #139 slice 2)

Settings → Updates (`web/updates.tsx`) adds authenticated local API routes
over the slice 1 update service, all under the same bearer-token/origin
protections and installation-identity contract as every other `/api/*`
route (see `src/installation/updates/routes.ts`):

- `GET /api/updates` — settings, status, and ownership; a pure read.
- `POST /api/updates/check` / `/preview` — a fresh release check and a
  server-cached preview (never trusts a client-supplied preview back; a
  `previewId` the server did not itself just hand out is rejected as stale).
- `POST /api/updates/stage` — downloads/verifies/extracts the exact cached
  preview; cancelling (a client disconnect) reports a distinct cancellation
  outcome and never activates anything or changes the persisted mode.
- `POST /api/updates/activate` / `/rollback` — bind to the current settings
  revision and staged update ID, then run the restart handoff below.
- `GET /api/updates/recovery` — the most recent handoff attempt's outcome
  and a copyable CLI recovery command.
- `POST /api/updates/activity` — a console reports its own unsaved-edit
  state for the installation-wide quiescence check.

**Installation-wide quiescence and the admission barrier** (see
`src/installation/updates/workload.ts`) read persisted task/workflow/review
state across every project registered on this installation, plus a small
cross-process activity heartbeat (`activity.ts`) for live unsaved-edit and
in-flight-request signals other server processes cannot otherwise expose.
A clear check atomically writes a small versioned installation lease
(`update-lease.json`) inside the same installation lock every other
mutating installation operation already uses, so a concurrent activation
from another console always observes the first one's lease rather than
racing it. While that lease is active, every server sharing the
installation rejects new mutating requests (503) except the lease-managing
routes themselves and bounded status/heartbeat traffic.

**Pending-work compatibility preflight** (`preflight.ts`) blocks manual
activation when pending (interrupted/awaiting-approval/awaiting-input/
blocked) workflows exist under a different workflow policy version than the
staged candidate reports — read by spawning the candidate's own bundled
runtime, the same technique `manager.ts`'s internal smoke check already
uses. It never fakes migration, deletes an approval, or resumes anything.

**Restart handoff** (`restart.ts`/`handoff.ts`) never touches `current`
until a replacement — spawned directly from the staged, already
verified-and-smoked immutable version directory, using that version's own
bundled runtime and `latchkit ui --project <root> --port 0` — has proven
itself healthy over its own authenticated `/api/updates` status route. Only
then does the existing manager activation primitive flip `current`; only
then does the browser receive the replacement's real endpoint to reconnect
to (an ephemeral port and a fresh session token every time — reloading the
old URL cannot work) and does the old server drain and close. Any failure
before that point leaves the previous installation completely untouched;
every attempt's outcome and a copyable recovery command are persisted for
`/api/updates/recovery` to report even after a failed replacement leaves the
old server as the survivor.
