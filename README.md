<div align="center">

# Latchkit

### Your agents. One workflow.

Open-source skills and a local configuration console for the coding tools you already use.

[![Windows CI](https://github.com/willahealm/latchkit/actions/workflows/ci.yml/badge.svg)](https://github.com/willahealm/latchkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-17806D.svg)](LICENSE)
[![Status: 1.0 candidate](https://img.shields.io/badge/status-1.0%20candidate-E3A14B.svg)](docs/roadmap.md)

**Claude Code · Codex · Antigravity CLI · Cursor · Cursor CLI**

**Windows 11 x64 primary release · Other platforms deferred**

</div>

Latchkit is an open-source toolkit for shared coding-agent workflows. This repository is its reference implementation: portable skills, a Node.js CLI, and a local browser console for project configuration. It runs locally, works with your existing coding tools, and keeps its configuration in your project.

**The current 1.0 candidate supports skill installation, durable task state, local project memory, capability-aware gates, acceptance verification, and delivery workflows.** Provider enforcement remains capability-dependent; unrestricted browser/device control and hosted session orchestration remain outside this release.

## Install and try it

GitHub Releases and the PowerShell installer are the primary Windows 11 x64
distribution route for 1.0. The candidate is still being qualified; no 1.0 release is published.
The [release guide](docs/releases.md) explains exact-version installation, local
candidate archives, upgrades, and rollback. Standalone bundles include private
Node and require neither npm nor BAML.

For development, install [Node.js 22 or newer](https://nodejs.org/) and Git, then install the repository tooling:

```sh
npm install
npm run build
node dist/src/cli.js --version
npm link
```

Then run these commands from your project directory:

```sh
latchkit init
latchkit sync --dry-run
latchkit sync
latchkit ui
```

Open the local URL printed by `latchkit ui`. The console can select providers and skills, save configuration, preview changes, and apply them. Stop it with Ctrl+C.

See the [clean-machine quickstart](docs/getting-started.md) for the Windows path.

For development, no Bash installer, Homebrew, Python, symlinks, or WSL is required. The Windows standalone GitHub Release installer uses PowerShell, installs into user-local versioned directories without elevation or symlinks, and includes private Node.js 24.20.0. It prints the full launcher path; add that directory to `PATH` yourself if desired. Linux and macOS installers remain deferred experimental work. See [installation](docs/installation.md) for the full target matrix, PowerShell/shell usage, and the current Homebrew/WinGet packaging scaffolds (not yet published or installable).

## What works today

| Capability               | 1.0 candidate behavior                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Portable workflows       | Seven original skills: requirements, spec, build, fix, review, handoff, setup                                               |
| Project configuration    | Provider and skill selection in `.latchkit/config.json`                                                                     |
| Project instructions     | Offline manifest discovery and scoped, reviewable provider exports                                                          |
| Local console            | Real configuration, executable discovery, install preview and sync                                                          |
| Managed installation     | Hash-based ownership checks; conflicts block changes                                                                        |
| Safe removal             | Removes unchanged owned files/sections; keeps user text and config                                                          |
| Host diagnostics         | Detects native vs WSL and executables on PATH                                                                               |
| Resumable workflow state | Versioned local tasks, atomic checkpoints, evidence binding, and stale-writer protection                                    |
| Delivery orchestration   | Requirements, exact plan approval, implementation with three repair attempts, verification, independent review, and handoff |
| Acceptance verification  | Bounded CLI, HTTP, and optional Playwright checks with revision-bound sanitized artifacts                                   |
| Local project memory     | Explicit, inspectable decisions and discoveries with bounded, capability-aware recovery                                     |
| Windows release checks   | Windows 11 emitted application and standalone artifact qualification; evidence is recorded per exact archive                |

`doctor` checks executable availability, not authentication or end-to-end agent behavior. CI validates the installed distributable, runtime/filesystem behavior, and bundled assets. Publication additionally requires a credentialed delivery workflow against an exact release archive. Contributors can run `npm run smoke:artifact` locally. See the [Claude adapter notes](docs/providers/claude.md) for hook activation and capability limitations.

## Use the skills

After syncing, restart your coding agent or reload its skills. Ask it to use:

- `latchkit-requirements` to clarify the problem, scope, decisions, and acceptance criteria.
- `latchkit-spec` to turn accepted requirements into a reviewable delivery plan.
- `latchkit-build` to implement authorized work with bounded verification evidence.
- `latchkit-fix` to reproduce and repair a defect.
- `latchkit-review` to inspect changes for actionable issues.
- `latchkit-handoff` to write a durable session handoff.
- `latchkit-setup` to prepare scoped provider guidance and preview conflicts.

Claude Code and Cursor expose slash invocation; Codex supports `$latchkit-spec` and the other skill names. Antigravity uses its documented print-mode prompt flow. See the current [provider notes](docs/compatibility.md).

Claude receives `.claude/skills/latchkit-*/SKILL.md`. Codex, Antigravity and Cursor share `.agents/skills/latchkit-*/SKILL.md`. Provider selection chooses install destinations; it does not prevent another compatible tool from discovering those files.

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
latchkit acceptance verify --task task_... --file acceptance.json --host-local-authorized
latchkit spec migrate --dry-run
latchkit spec register --task task_... --expected-revision 3 --file enhanced.json
latchkit spec plan-path --title "Enhanced spec enrollment"
latchkit spec migrate-plan --from .latchkit/notes/example-spec.md
```

Sync preview includes the exact generated project-instruction sections, their provenance, declared command argument arrays, and provider discovery warnings. Latchkit never runs a discovered project command. It adds narrow owned sections to shared `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` files, or separately owned Claude/Cursor rule files, while preserving human-authored text and line endings. See [project instructions](docs/project-instructions.md).

If a managed file or managed instruction section has local edits, sync stops and reports its path. Preserve or reconcile your changes before trying again. There is no force-overwrite flag. Configuration saves and synchronization are separate actions.

Skill packs are explicit, versioned configuration selections. The bundled core pack is pinned by default; Latchkit never performs background upgrades. A trusted local pack declares its identity, version, provenance, compatibility and checksums in `latchkit-pack.json`; review `sync --dry-run` before deliberately changing a selected version. Checksums confirm content integrity, not publisher identity.

If a process stops during sync or removal, run `latchkit recover --dry-run` and review the proposed recovery before applying it. See [installer recovery](docs/recovery.md) for conflict and manual-recovery guidance.

Project memory is opt-in: `latchkit memory` stores concise decisions, discoveries, constraints, and resolved defects in `.latchkit/memory/state-v1.json`. It never ingests transcripts automatically. Search, inspection, and export are local; delete scrubs managed search material but cannot revoke older exports, backups, or Git history. Likely credentials and common secret-file paths are rejected, but this is a practical safeguard rather than a claim of perfect secret detection. Recovery selects only records within an explicit context budget and only returns an on-demand context block when the provider contract supports compaction; every block is labeled historical, untrusted context, not instructions or authorization.

## Build with us

The direction is an open engineering workflow layer: requirements → plan → implement → verify → review → handoff. Native Windows and transparent provider capabilities are first-class requirements. The bundled workflows remain instruction-led: task state and quality gates contribute evidence only when their capabilities are available and explicitly invoked.

- [Roadmap](docs/roadmap.md)
- [Architecture and reliability boundaries](docs/architecture.md)
- [Compatibility and primary documentation](docs/compatibility.md)
- [Workflow scenarios](docs/workflows.md)
- [Local workflow workbench](docs/workflow-workbench.md)
- [Generated output inventory and cleanup](docs/generated-outputs.md)
- [Contributing](CONTRIBUTING.md)

```sh
npm run check
npm test
npm pack --dry-run
```

See [release and recovery procedures](docs/releases.md) for the Windows GitHub Release bundle, PowerShell installation script, dry-run evidence, upgrades, rollback, and recovery. End users will not need Node.js, npm, or BAML for a qualified standalone bundle; npm remains available for development.

For task-oriented operations, see [support and troubleshooting](docs/support.md)
and [upgrade, migration, rollback, and removal](docs/migration.md).

See [skill evaluations](docs/skill-evaluations.md) for the offline behavioral harness and explicitly authorized, bounded provider comparisons.

## License and provenance

[MIT](LICENSE). Latchkit is an independent project. All implementation and bundled skill text in this repository are original. Provider software and services retain their own terms.
