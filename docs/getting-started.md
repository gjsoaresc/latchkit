# Getting started

This guide uses the Windows standalone candidate and a project on your machine. Latchkit is a local CLI and browser configuration console. Coding tools retain their own authentication and permissions.

## Requirements

- Windows 11 x64 for the standalone candidate. The bundle includes private Node.js 24.20.0; Node.js and npm are not end-user prerequisites.
- Git for Git projects and optional isolated-workspace commands.
- One separately installed and authenticated provider: [Claude Code](providers/claude.md), [Codex](codex.md), [Antigravity CLI](https://antigravity.google/docs/cli/overview), [Cursor IDE](providers/cursor-ide.md), or [Cursor CLI](cursor-cli.md).

Source development requires Node.js 22 or newer and npm. Windows is the current release qualification target; Linux, macOS, WSL, and other architectures are deferred. An installed provider executable does not establish authentication or a verified session.

## Install from a release

GitHub Releases is the planned distribution route. No stable release is published yet. To try a locally built candidate from this repository:

```powershell
npm ci
npm run release:artifacts
./install.ps1 -Version 1.0.0 -Root "$env:USERPROFILE/.local/share/latchkit" -Artifact "$PWD/release-artifacts/latchkit-1.0.0-win32-x64.zip" -Checksum "$PWD/release-artifacts/latchkit-1.0.0-win32-x64.zip.sha256"
$latchkit = "$env:USERPROFILE/.local/share/latchkit/bin/latchkit.ps1"
& $latchkit --version
```

The installer verifies the archive and installs a versioned user-local runtime without changing your PATH. Keep using the printed launcher path, or add its directory to PATH yourself. The explicit user-home root above also avoids AppData filesystem virtualization in packaged Windows hosts. The [release guide](releases.md) covers exact-version downloads after publication, upgrades, rollback, and qualification; [installation](installation.md) covers the supported/deferred target matrix, PATH setup, and the onboarding hand-off in detail. Preparing or installing a candidate does not publish or qualify it.

## Initialize and sync a project

From PowerShell, use the launcher variable above and an existing project path. Quote comma-separated selections so PowerShell passes them as one argument. Initialization and synchronization do not launch a provider session.

```powershell
& $latchkit init --project "C:/path/to/project" --providers 'claude,codex' --skills 'requirements,spec,build,fix,review,handoff,setup'
& $latchkit doctor --project "C:/path/to/project"
& $latchkit config --project "C:/path/to/project"
& $latchkit sync --project "C:/path/to/project" --dry-run
& $latchkit sync --project "C:/path/to/project"
```

The preview is the review boundary: it lists file actions, generated content, provenance, declared command arguments, and discovery warnings. Sync writes only registered, unchanged-or-owned resources. An edited managed file, a conflict, or a link/junction stops the operation; there is no force-overwrite flag.

Restart or reload the selected provider so it discovers the new skills. Exported skills are portable instructions; they are not proof that the provider can run a model session.

## Open the local console

```powershell
& $latchkit ui --project "C:/path/to/project"
```

Open the printed loopback URL. The console edits project configuration, previews installation, and applies synchronization. It is not a hosted account service or terminal. Stop it with Ctrl+C.

## Finish setup with onboarding

A successful interactive install suggests `latchkit onboarding` as the next command. It is a resumable wizard — select or initialize a project, discover agents, choose skills, set the worktree and fast/standard verification preferences, decide on local usage collection, preview the exact files a sync would change, then apply:

```powershell
& $latchkit onboarding --project "C:/path/to/project"
& $latchkit onboarding project --project "C:/path/to/project"
& $latchkit onboarding providers --project "C:/path/to/project" --providers 'claude,codex' --skills 'spec,build'
& $latchkit onboarding preview --project "C:/path/to/project"
& $latchkit onboarding apply --project "C:/path/to/project"
```

Every action prints JSON and exits — there is no prompt to answer, so this also works unattended. The same wizard is available step-by-step in the browser console's onboarding section. Dismissing or interrupting it never discards already-saved configuration; running any step again resumes from where it left off. See [installation](installation.md#onboarding) for the full action list and honest provider-state definitions (installed/configured/unavailable, and authentication always reported as unknown).

## First verified fixture check

The following is a credential-free check of Latchkit's filesystem behavior. It does not verify a live provider session:

```powershell
& $latchkit --version
& $latchkit init --project "C:/path/to/disposable-project" --providers codex --skills spec
& $latchkit sync --project "C:/path/to/disposable-project" --dry-run
& $latchkit sync --project "C:/path/to/disposable-project"
& $latchkit remove --project "C:/path/to/disposable-project"
```

Confirm that the generated skill is removed while `.latchkit/config.json`, custom files, and notes remain. Cross-platform release smoke additionally checks the packaged artifact, repeat sync, conflicts, CRLF files, read-only user files, the API, and shutdown; it does not authenticate providers. See the [provider evidence matrix](verification/provider-e2e.md).

## Supported surfaces at a glance

Provider selection chooses an installation destination, not an access or privacy boundary. Claude uses `.claude/skills/`; Codex, Antigravity, and Cursor use the shared `.agents/skills/` root. Cursor may discover compatible files from other roots according to Cursor's own rules. Read [compatibility](compatibility.md) before selecting more than one provider.
