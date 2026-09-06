---
name: latchkit-build
description: Implement an authorized feature against named acceptance criteria with bounded iterations, explicit verification evidence, and honest unresolved gaps. Use after requirements or a specification is ready.
---

# Latchkit build

Deliver the authorized change in small, reviewable increments. Read applicable project guidance, the requirements or specification, and the current working state before editing. Preserve unrelated user work.

When the caller requests lower usage or latency, apply the [optional efficiency policy](../references/efficiency.md).

## Confirm the work boundary

Use the existing authorization and scope. Distinguish plan-only requests from delivery requests; do not add approval checkpoints to already authorized work. Confirm the named criteria, allowed directories, and limits for iteration, time, and provider usage. Never merge, deploy, send messages, schedule work, or start costly orchestration merely because this skill is present.

If a durable plan exists, it is normally under `docs/plans/` (or the legacy `.latchkit/notes/` for older tasks); read it for the accepted scope and criteria instead of re-deriving them.

## Iterate with evidence

For each criterion, make the smallest coherent change, run a focused check, and record the command, result, environment, and artifact. Prefer a failing regression test before a behavioral fix. Use the repository's declared quality gates only when a caller supplies an explicit execution authorization and the provider capability supports the requested mode.

Bound the loop: stop after the agreed iteration or time/usage limit, or sooner when the evidence shows a blocker. Record unresolved failures, unsupported gates, and untested environments as gaps. `advisory`, `unsupported`, `skipped`, and `failed` are not `passed`; an instruction-only fallback cannot claim runtime enforcement.

When the task's verification mode is `fast`, focused iteration checks and the host's bounded, change-focused plan are expected; still run the required final checks once the change is stable, and fall back to `standard` mode when fast mode reports a gap it could not resolve within its bound.

Use task-state checkpoints and acceptance evidence when available. If they are unavailable, write `.latchkit/notes/<unique-task-slug>-build.md` using [workflow evidence](../references/workflow-evidence.md). A checkpoint or note is durable context, not independent proof.

## Deliver

Run the focused checks plus the project's relevant validation. Compare every result with the named criteria, inspect the final diff, and report changed files, evidence, remaining gaps, and the next action. Do not claim provider or OS verification that was not actually executed.

## Offer the closing decision

Do not just stop after delivering. Present a reviewable result: what changed, a link to the diff or relevant artifacts, which named criteria are complete, the actual verification results just reported, and remaining gaps — verification status stays separate from acceptance, so state a failed or incomplete check plainly rather than soften it. Then offer exactly three choices: approve the result, add notes requesting changes, or review later. Prefer this session's own native structured choice/plan-approval control when actually present (documented today only for Claude Code — see [the Claude Code adapter](../../docs/providers/claude.md#interactive-decision-surface) — and the same capability gating `latchkit-spec` uses); otherwise use a concise text choice. Never claim a native control that was not actually available.

Register the decision so it is durable and machine-checkable: `latchkit task result-present --task <task-id> --result-ref <link-or-path> --result-digest <sha256-of-the-diff-plus-evidence-summary-just-shown> --summary "<one-line summary>" --verification-results "<actual results>" [--remaining-gaps "<known gaps>"]`. Reuse `--mutation-id event_<uuid>` for a retried or repeated completion event; an unchanged result is a no-op, and an already-approved decision for the current result is returned unchanged rather than re-asked.

- **Approve**: `latchkit task result-approve --task <task-id> --expected-revision <n> --result-digest <sha256> [--text "<optional note>"]`. This binds acceptance to the exact result digest just shown, the same digest-bound approach the delivery workflow and `latchkit-spec` use, so a later implementation change makes the approval stale rather than authorizing new content it never saw. Approval accepts the task result only — it never merges, publishes, deploys, or authorizes destructive worktree cleanup, and it never rewrites the recorded verification results as passing.
- **Add notes**: `latchkit task result-notes --task <task-id> --expected-revision <n> --text "<the feedback>" --result-digest <sha256>`. This attaches the feedback to the same task and moves it to `changes-requested`, clearing any prior approval. Judge whether the request fits the existing authorization: an in-scope correction needs nothing further and routes straight back into this skill's own bounded edit/test loop with that feedback as context, preserving whatever iteration budget already applies; a materially new request — different from what was authorized — needs its own `--change-scope new-scope --authorization-scope "<paths or description>" --authorization-reference "<who/what approved it>"` rather than silently expanding the task. After the correction, present the updated result again (a new `--result-digest`) for a fresh decision.
- **Review later**: `latchkit task result-defer --task <task-id> --expected-revision <n>` — or simply stop; leaving the prompt unanswered or dismissing it has the same effect, and review stays pending. On resume, `latchkit task result-inspect --task <task-id>` restores the current result and any outstanding notes before re-presenting it.

Preserve any acceptance that already exists and is still valid for the current result; do not introduce a duplicate confirmation when no new user decision is needed.
