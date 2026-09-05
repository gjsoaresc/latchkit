# Getting started

This guide uses the released package and a disposable project. Latchkit is a local CLI and browser configuration console; it does not create a provider account, choose a model, or change provider permissions.

## Requirements

- Node.js 22 or newer (`node --version`).
- Git for Git projects and optional isolated-workspace commands.
- One separately installed and authenticated provider: [Claude Code](providers/claude.md), [Codex](codex.md), [Antigravity CLI](https://antigravity.google/docs/cli/overview), [Cursor IDE](providers/cursor-ide.md), or [Cursor CLI](cursor-cli.md).

Latchkit itself has no runtime package dependencies. Native Windows, Linux, and macOS are supported runtime targets. WSL is optional: install Node.js and the provider inside the WSL distribution when using WSL. A native Windows executable is not evidence that the WSL executable is installed.

## Install from a release

For a published stable release, install globally or invoke without a global installation:

```sh
npm install --global latchkit
latchkit --version
# or: npx latchkit --version
```

The repository currently describes the alpha distribution; if the package is not available on the configured registry, use the [release archive procedure](releases.md) or the source checkout instructions in the [README](../README.md).

## Initialize and sync a project

Run these commands from PowerShell, a POSIX shell, or a shell inside WSL. Use an existing project path; Latchkit does not create a provider session.

```sh
latchkit init --project "path/to/project" --providers codex --skills requirements,spec,build,fix,review,handoff,setup
latchkit doctor --project "path/to/project"
latchkit config --project "path/to/project"
latchkit sync --project "path/to/project" --dry-run
latchkit sync --project "path/to/project"
```

The preview is the review boundary: it lists file actions, generated content, provenance, declared command arguments, and discovery warnings. Sync writes only registered, unchanged-or-owned resources. An edited managed file, a conflict, or a link/junction stops the operation; there is no force-overwrite flag.

Restart or reload the selected provider so it discovers the new skills. Exported skills are portable instructions; they are not proof that the provider can run a model session.

## Open the local console

```sh
latchkit ui --project "path/to/project"
```

Open the printed loopback URL. The console edits project configuration, previews installation, and applies synchronization. It is not a hosted account service or terminal. Stop it with Ctrl+C.

## First verified fixture check

The following is a credential-free check of Latchkit's filesystem behavior. It does not verify a live provider session:

```sh
node --version
latchkit init --project "path/to/project" --providers codex --skills spec
latchkit sync --project "path/to/project" --dry-run
latchkit sync --project "path/to/project"
latchkit remove --project "path/to/project"
```

Confirm that the generated skill is removed while `.latchkit/config.json`, custom files, and notes remain. Cross-platform release smoke additionally checks the packaged artifact, repeat sync, conflicts, CRLF files, read-only user files, the API, and shutdown; it does not authenticate providers. See the [provider evidence matrix](verification/provider-e2e.md).

## Supported surfaces at a glance

Provider selection chooses an installation destination, not an access or privacy boundary. Claude uses `.claude/skills/`; Codex, Antigravity, and Cursor use the shared `.agents/skills/` root. Cursor may discover compatible files from other roots according to Cursor's own rules. Read [compatibility](compatibility.md) before selecting more than one provider.
