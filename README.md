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

**This is an early working foundation, not full Pilot Shell feature parity.** Skill installation and configuration work today. The skills provide instructions; lifecycle hooks, enforced quality gates, persistent memory services, and session orchestration are planned.

## Try it

Install [Node.js 22 or newer](https://nodejs.org/) and Git, then run these commands from PowerShell, Terminal, or a Linux shell:

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

For a command available from any directory, run `npm link` in the clone, then use `latchkit init`, `latchkit sync`, and `latchkit ui` in your project. This alpha is distributed from GitHub; it has not been published to npm.

No Bash installer, Homebrew, Python, symlinks, or WSL is required by Latchkit. Run Node inside WSL when you want a WSL environment. Install and authenticate your chosen coding tool separately.

## What works today

| Capability | Alpha behavior |
| --- | --- |
| Portable workflows | Four original skills: spec/build, fix, review, handoff |
| Project configuration | Provider and skill selection in `.latchkit/config.json` |
| Local console | Real configuration, executable discovery, install preview and sync |
| Managed installation | Hash-based ownership checks; conflicts block changes |
| Safe removal | Removes unmodified managed skill files; keeps notes and config |
| Host diagnostics | Detects native vs WSL and executables on PATH |
| Cross-platform checks | Node 22/24 CI on Windows, Linux, and macOS |

`doctor` checks executable availability, not authentication or end-to-end agent behavior. CI validates Latchkit's runtime and filesystem behavior; real provider sessions and a dedicated WSL test matrix remain on the [roadmap](docs/roadmap.md).

## Use the skills

After syncing, restart your coding agent or reload its skills. Ask it to use:

- `latchkit-spec` to plan and implement a feature with verification evidence.
- `latchkit-fix` to reproduce and repair a defect.
- `latchkit-review` to inspect changes for actionable issues.
- `latchkit-handoff` to write a durable session handoff.

Claude Code and Cursor expose slash invocation; Codex supports `$latchkit-spec` and the other skill names. Gemini discovers skills by description and manages activation through its skill system. See the current [provider notes](docs/compatibility.md).

Claude receives `.claude/skills/latchkit-*/SKILL.md`. Codex, Gemini and Cursor share `.agents/skills/latchkit-*/SKILL.md`. Provider selection chooses install destinations; it does not prevent another compatible tool from discovering those files.

```sh
latchkit doctor
latchkit config
latchkit migrate --dry-run
latchkit sync --dry-run
latchkit remove
```

If a managed file has local edits, sync stops and reports its path. Preserve or move your changes before trying again. There is no force-overwrite flag. Configuration saves and skill synchronization are separate actions.

## Build with us

The direction is an open engineering workflow layer: requirements → plan → implement → verify → review → handoff. Native Windows and transparent provider capabilities are first-class requirements.

- [Roadmap and Pilot Shell capability baseline](docs/roadmap.md)
- [Architecture and reliability boundaries](docs/architecture.md)
- [Compatibility and primary documentation](docs/compatibility.md)
- [Contributing](CONTRIBUTING.md)

```sh
npm run check
npm test
npm pack --dry-run
```

## License and provenance

[MIT](LICENSE). All implementation and bundled skill text in this repository are original. Latchkit is an independent project inspired by the general idea of structured coding-agent workflows. It is not a fork of or affiliated with Pilot Shell or any provider. Provider software and services retain their own terms.
