<div align="center">

# Latchkit

### Your agents. One workflow.

Open-source skills and a local configuration console for the coding tools you already use.

[![Cross-platform CI](https://github.com/gjsoaresc/latchkit/actions/workflows/ci.yml/badge.svg)](https://github.com/gjsoaresc/latchkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-17806D.svg)](LICENSE)
[![Status: Alpha](https://img.shields.io/badge/status-alpha-E3A14B.svg)](docs/roadmap.md)

**Claude Code · Codex · Gemini CLI · Cursor · Cursor CLI**

**Windows native · Windows with WSL · Linux · macOS**

</div>

Latchkit gives your coding agents a shared set of development workflows, with a browser console to configure them. It runs locally, uses your existing provider accounts, and keeps its configuration in your project.

**This is an early working foundation, not full Pilot Shell feature parity.** Skill installation and configuration work today. Claude Code has a version-aware, project-local hook adapter; enforced quality gates, persistent memory services, and session orchestration remain outside this release.

## Install and try it

Install [Node.js 22 or newer](https://nodejs.org/) and Git, then install the released package:

```sh
npm install --global latchkit
latchkit --version
```

For the current alpha, or when the package is not available from your registry, run these commands from PowerShell, Terminal, or a Linux shell:

```sh
git clone https://github.com/gjsoaresc/latchkit.git
cd latchkit
npm ci
node src/cli.js init --project "path/to/your/project"
node src/cli.js sync --project "path/to/your/project" --dry-run
node src/cli.js sync --project "path/to/your/project"
node src/cli.js ui --project "path/to/your/project"
```

Replace the example path with an existing project directory. Open the local URL printed by `ui`. The console can select providers and skills, save configuration, preview changes, and apply them. Stop it with Ctrl+C.

For a command available from any directory in a source checkout, run `npm link` in the clone, then use `latchkit init`, `latchkit sync`, and `latchkit ui` in your project. See the [clean-machine quickstart](docs/getting-started.md) for package, native OS, and WSL paths.

No Bash installer, Homebrew, Python, symlinks, or WSL is required by Latchkit. Run Node inside WSL when you want a WSL environment. Install and authenticate your chosen coding tool separately.

## What works today

| Capability               | Alpha behavior                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Portable workflows       | Seven original skills: requirements, spec, build, fix, review, handoff, setup                             |
| Project configuration    | Provider and skill selection in `.latchkit/config.json`                                                   |
| Project instructions     | Offline manifest discovery and scoped, reviewable provider exports                                        |
| Local console            | Real configuration, executable discovery, install preview and sync                                        |
| Managed installation     | Hash-based ownership checks; conflicts block changes                                                      |
| Safe removal             | Removes unchanged owned files/sections; keeps user text and config                                        |
| Host diagnostics         | Detects native vs WSL and executables on PATH                                                             |
| Resumable workflow state | Versioned local tasks, atomic checkpoints, evidence binding, and stale-writer protection                  |
| Local project memory     | Explicit, inspectable decisions and discoveries with bounded, capability-aware recovery                   |
| Cross-platform checks    | Release-gating Node 22/24 installed-artifact smoke on native Windows, Linux, and macOS, plus WSL evidence |

`doctor` checks executable availability, not authentication or end-to-end agent behavior. CI validates the installed distributable, runtime/filesystem behavior, and bundled assets; real provider sessions remain outside this release gate. Contributors can run `npm run smoke:artifact` locally. See the [Claude adapter notes](docs/providers/claude.md) for hook activation and capability limitations.

## Use the skills

After syncing, restart your coding agent or reload its skills. Ask it to use:

- `latchkit-requirements` to clarify the problem, scope, decisions, and acceptance criteria.
- `latchkit-spec` to turn accepted requirements into a reviewable delivery plan.
- `latchkit-build` to implement authorized work with bounded verification evidence.
- `latchkit-fix` to reproduce and repair a defect.
- `latchkit-review` to inspect changes for actionable issues.
- `latchkit-handoff` to write a durable session handoff.
- `latchkit-setup` to prepare scoped provider guidance and preview conflicts.

Claude Code and Cursor expose slash invocation; Codex supports `$latchkit-spec` and the other skill names. Gemini discovers skills by description and manages activation through its skill system. See the current [provider notes](docs/compatibility.md).

Claude receives `.claude/skills/latchkit-*/SKILL.md`. Codex, Gemini and Cursor share `.agents/skills/latchkit-*/SKILL.md`. Provider selection chooses install destinations; it does not prevent another compatible tool from discovering those files.

```sh
latchkit doctor
latchkit config
latchkit migrate --dry-run
latchkit recover --dry-run
latchkit sync --dry-run
latchkit remove
latchkit memory add --title "Why snapshots" --text "Keep memory locally inspectable."
latchkit memory search --text "snapshots"
latchkit memory recover --provider codex --budget 2000
```

Sync preview includes the exact generated project-instruction sections, their provenance, declared command argument arrays, and provider discovery warnings. Latchkit never runs a discovered project command. It adds narrow owned sections to shared `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` files, or separately owned Claude/Cursor rule files, while preserving human-authored text and line endings. See [project instructions](docs/project-instructions.md).

If a managed file or managed instruction section has local edits, sync stops and reports its path. Preserve or reconcile your changes before trying again. There is no force-overwrite flag. Configuration saves and synchronization are separate actions.

Skill packs are explicit, versioned configuration selections. The bundled core pack is pinned by default; Latchkit never performs background upgrades. A trusted local pack declares its identity, version, provenance, compatibility and checksums in `latchkit-pack.json`; review `sync --dry-run` before deliberately changing a selected version. Checksums confirm content integrity, not publisher identity.

If a process stops during sync or removal, run `latchkit recover --dry-run` and review the proposed recovery before applying it. See [installer recovery](docs/recovery.md) for conflict and manual-recovery guidance.

Project memory is opt-in: `latchkit memory` stores concise decisions, discoveries, constraints, and resolved defects in `.latchkit/memory/state-v1.json`. It never ingests transcripts automatically. Search, inspection, and export are local; delete scrubs managed search material but cannot revoke older exports, backups, or Git history. Likely credentials and common secret-file paths are rejected, but this is a practical safeguard rather than a claim of perfect secret detection. Recovery selects only records within an explicit context budget and only returns an on-demand context block when the provider contract supports compaction; every block is labeled historical, untrusted context, not instructions or authorization.

## Build with us

The direction is an open engineering workflow layer: requirements → plan → implement → verify → review → handoff. Native Windows and transparent provider capabilities are first-class requirements. The bundled workflows remain instruction-led: task state and quality gates contribute evidence only when their capabilities are available and explicitly invoked.

- [Roadmap and Pilot Shell capability baseline](docs/roadmap.md)
- [Architecture and reliability boundaries](docs/architecture.md)
- [Compatibility and primary documentation](docs/compatibility.md)
- [Workflow scenarios](docs/workflows.md)
- [Contributing](CONTRIBUTING.md)

```sh
npm run check
npm test
npm pack --dry-run
```

See [release and recovery procedures](docs/releases.md) for installable npm
artifacts, dry-run evidence, controlled publication, upgrades, and rollback.

For task-oriented operations, see [support and troubleshooting](docs/support.md)
and [upgrade, migration, rollback, and removal](docs/migration.md).

## License and provenance

[MIT](LICENSE). All implementation and bundled skill text in this repository are original. Latchkit is an independent project inspired by the general idea of structured coding-agent workflows. It is not a fork of or affiliated with Pilot Shell or any provider. Provider software and services retain their own terms.
