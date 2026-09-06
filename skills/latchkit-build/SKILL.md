---
name: latchkit-build
description: Implement an authorized feature against named acceptance criteria with bounded iterations, explicit verification evidence, and honest unresolved gaps. Use after requirements or a specification is ready.
---

# Latchkit build

Deliver the authorized change in small, reviewable increments. Read applicable project guidance, the requirements or specification, and the current working state before editing. Preserve unrelated user work.

When the caller requests lower usage or latency, apply the [optional efficiency policy](../references/efficiency.md).

## Confirm the work boundary

Use the existing authorization and scope. Distinguish plan-only requests from delivery requests; do not add approval checkpoints to already authorized work. Confirm the named criteria, allowed directories, and limits for iteration, time, and provider usage. Never merge, deploy, send messages, schedule work, or start costly orchestration merely because this skill is present.

## Iterate with evidence

For each criterion, make the smallest coherent change, run a focused check, and record the command, result, environment, and artifact. Prefer a failing regression test before a behavioral fix. Use the repository's declared quality gates only when a caller supplies an explicit execution authorization and the provider capability supports the requested mode.

Bound the loop: stop after the agreed iteration or time/usage limit, or sooner when the evidence shows a blocker. Record unresolved failures, unsupported gates, and untested environments as gaps. `advisory`, `unsupported`, `skipped`, and `failed` are not `passed`; an instruction-only fallback cannot claim runtime enforcement.

Use task-state checkpoints and acceptance evidence when available. If they are unavailable, write `.latchkit/notes/<unique-task-slug>-build.md` using [workflow evidence](../references/workflow-evidence.md). A checkpoint or note is durable context, not independent proof.

## Deliver

Run the focused checks plus the project's relevant validation. Compare every result with the named criteria, inspect the final diff, and report changed files, evidence, remaining gaps, and the next action. Do not claim provider or OS verification that was not actually executed.
