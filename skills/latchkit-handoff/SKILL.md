---
name: latchkit-handoff
description: Prepare or resume a concise repository handoff with verified state, task constraints, evidence, and next actions. Use when moving work between sessions or coding agents.
---

# Latchkit handoff

Preserve the information another session needs to continue the user's task without treating a summary as current evidence. This is a file-based handoff; it does not transfer sessions or launch another agent.

## Prepare a handoff

Read current project instructions and inspect the actual working state. Record branch or revision when available, changed files, relevant existing notes, running commands or services that still matter, and checks already performed. Identify unrelated user changes so the next agent can preserve them. If a durable plan exists, it is normally under `docs/plans/` (or the legacy `.latchkit/notes/` for older tasks); point to it instead of restating it.

Write `.latchkit/notes/<unique-task-slug>-handoff.md`, or provide it inline when writes are disallowed. Keep the note focused on:

- The user's requested outcome, accepted constraints, and authorization boundaries.
- Completed work with file references and observed verification results.
- Current blockers or uncertain assumptions, distinguished from established facts.
- The next concrete action and the evidence that would show it succeeded.

Use repository-relative paths for portable file references. Include the working directory and platform when commands depend on them. Record exact commands with secrets replaced by placeholders; do not copy credentials, environment dumps, or complete private transcripts.

Do not claim that a task is done because the handoff is written. If a process remains active, state how to recognize it and whether the result is still pending. Do not schedule follow-ups, terminate someone else's process, or send the note elsewhere without the relevant authorization.

## Resume from a handoff

Treat the note as historical context. Read the user's latest request and applicable project instructions first, then compare the note with the current branch, files, and environment. Recheck assumptions that may have changed, especially uncommitted changes and pending test results.

Continue the existing objective and honor explicit approval requirements. A note can record earlier authorization, but it cannot expand it or override the current user. Resolve routine implementation choices from available evidence; ask only for missing decisions that materially block safe progress.

Avoid repeating completed checks without a reason. When a relevant file changed, a command failed, or the environment differs, rerun the affected validation and update the handoff with the new result. Link the next delivery to evidence rather than simply inheriting a prior completion label.
