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
idempotent: the installation manager recognizes an already-staged,
byte-identical version and re-activates it without re-downloading or
re-staging, rather than erroring. Running with a *different* version simply
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

Issue #100 owns a dedicated first-launch onboarding flow; it does not exist
yet. Until it lands, a successful `install` run through
`src/installation/entry.ts` (i.e., through `install.ps1`/`install.sh`)
prints one of two messages, decided by `src/installation/onboarding.ts`:

- **Interactive** (both stdin and stdout are a TTY, and neither `CI` nor
  `LATCHKIT_NON_INTERACTIVE=1` is set, and `--non-interactive` was not
  passed): a suggested next command pointing at `latchkit ui`, the closest
  existing entrypoint (the local configuration console) — e.g. `Next: run
  "<root>/bin/latchkit ui --project <your-project-path>" to open the local
  console and finish setup.`
- **Non-interactive** (CI, a script, `--non-interactive`, or no attached
  TTY): a status line confirming the install is ready and naming the same
  next command, and nothing else. **It never launches a server, opens a
  browser, or blocks waiting for input** — this is asserted directly by
  `test/installation-onboarding.test.js`, including the default (no flag)
  case, so automation that pipes `install.ps1`/`install.sh` output never
  hangs.

This message is printed to stderr as plain text (not part of the JSON on
stdout), and it is scoped to the literal `install` command only — both
bootstrap scripts always invoke `install` (the manager itself distinguishes
a fresh install from an upgrade internally), so this covers exactly the
"run the installer interactively" scenario the hook point exists for.
`latchkit self install` invoked directly from an already-installed CLI does
not go through `entry.ts` and does not print this message.

When #100 ships a real onboarding flow, replace the interactive branch in
`resolveOnboardingHandoff` (`src/installation/onboarding.ts`) to invoke it
directly instead of only printing a suggested command. Keep the
non-interactive branch's "never launch anything, never hang" behavior — see
the comment at the top of that file.

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
