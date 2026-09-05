# Roadmap

Latchkit aims to provide a shared engineering workflow over Claude Code, Gemini CLI, Codex, Cursor IDE, and Cursor CLI on native Windows, optional WSL, Linux, and macOS, with an accessible configuration frontend. This is a staged implementation, not a claim of full Pilot Shell parity.

## Initial foundation

The starter contains a Node.js 22+ CLI, project configuration, a local configuration UI, provider skill destinations, and seven original skills for requirements, specifications, builds, repairs, reviews, handoffs, and setup. The skills can produce durable Markdown notes; task-state and quality-gate services add evidence only when explicitly available and invoked; the core does not silently enforce skill instructions.

Repository tests and platform CI validate the implementation as those checks run. End-to-end provider sessions and WSL verification remain separate acceptance work. Refer to [compatibility](compatibility.md) for the distinction between supported skill formats and verified integrations.

## Milestones

| Milestone             | Deliverables                                                                                                                            | Completion evidence                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Reliable installation | Native Windows, Linux and macOS packages; optional WSL instructions; upgrades, conflict handling and removal.                           | Fresh-install, update, resync and removal tests on each platform, including paths with spaces and existing user files.             |
| Provider integrations | Versioned adapters for all five targets, original rule generation, capability discovery and explicit integration status.                | A recorded real-agent session discovers and uses a skill on every supported target.                                                |
| Workflow execution    | Requirements discovery, specification delivery, acceptance-driven build loops, diagnosis, review and handoff with durable state.        | Interrupted work resumes accurately; completion reflects observed acceptance results; explicit user approval requirements persist. |
| Quality enforcement   | Optional hooks, targeted TDD guidance, lint/type/test/build checks and completion guards.                                               | Contract tests per provider event; failed checks remain visible; unavailable hooks are reported as unavailable.                    |
| Context and memory    | Local durable decisions, project search, compaction recovery, session history and exportable team knowledge.                            | Relevant context survives restart and compaction; users can inspect, remove and export stored data.                                |
| Parallel engineering  | Worktree isolation, independent reviews, coordinated agent execution and cancellation.                                                  | Concurrent tasks cannot corrupt each other's work or claim one another's evidence.                                                 |
| Evidence and tools    | Real CLI/API/browser/device verification, optional MCP integrations, semantic code search, structural search and language tooling.      | Each claimed verification links to an actual result and supported runtime environment.                                             |
| Expanded frontend     | Session status, requirements/plans, diffs, annotations, evidence, memory, notifications, usage, extension management and configuration. | Changes in the interface persist and reach the intended task; stale or missing data is identified.                                 |
| Ecosystem             | Versioned skill packs, provider plugin packaging, evaluations, team sync, optional scheduled automation and remote workflows.           | Reproducible installs, documented permissions, tested upgrades and controllable background work.                                   |

## Reference baseline: Pilot Shell v10.12.3

The baseline was checked on September 5, 2026. Pilot Shell's latest release was **v10.12.3**, published September 4, 2026. The release adjusts nonessential hooks to remain private and nonblocking. [Release](https://github.com/maxritter/pilot-shell/releases/tag/v10.12.3)

Pilot advertises macOS, Linux and Windows through WSL2, with Claude Code and Codex support. Its capabilities include structured specification/build/fix/requirements workflows, persistent context, quality checks, reviews, professional tooling and runtime verification. Native Windows and Gemini/Cursor integration are additional Latchkit goals. [Official README](https://github.com/maxritter/pilot-shell)

Its lifecycle integrations cover session context, compaction recovery, memory capture and workflow completion rules. Its local Console provides sessions, memory, workflow artifacts, diff annotations, usage and settings. Those capabilities require runtime components beyond a skill pack. [Hooks](https://pilot-shell.com/docs/features/hooks), [Console](https://pilot-shell.com/docs/features/console)

Pilot itself documents feature differences between Claude Code and Codex. Latchkit will likewise expose capability differences rather than imply every agent has identical hooks or tools. [Provider comparison](https://pilot-shell.com/docs/getting-started/codex-cli)

## Original implementation

Pilot Shell's current LICENSE is proprietary and restricts redistribution and derivative distribution. Latchkit develops its own code, skill text, architecture, and interface. The reference above describes public capabilities; no Pilot code, prompts, branding, or assets are required. Contributions must preserve that independent implementation. [Pilot LICENSE](https://github.com/maxritter/pilot-shell/blob/main/LICENSE)
