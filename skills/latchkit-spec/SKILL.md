---
name: latchkit-spec
description: Plan and deliver a feature against explicit acceptance criteria with a durable project note. Use for requested specification work or implementation that needs a reviewable plan, not a one-line edit.
---

# Latchkit spec

Turn the user's requested outcome into a small, testable delivery plan. This skill supplies instructions; it does not install hooks, enforce a state machine, or grant extra permissions.

When the caller requests lower usage or latency, apply the [optional efficiency policy](../references/efficiency.md).

## Establish the contract

Read the relevant project instructions, existing implementation, and the user's constraints. Distinguish a request to write a specification from a request to implement it. For a specification-only request, stop after the reviewable specification; do not change application code.

Use `.latchkit/notes/<unique-task-slug>-spec.md` for the working artifact. Reuse a clearly matching note only after checking its assumptions against current files. If writes are prohibited, keep the artifact in the response instead. Do not add credentials or private session transcripts.

Record the requested result, scope, acceptance criteria, relevant files, unresolved choices, and intended verification. Each criterion should describe something observable. Identify decisions that materially affect behavior before implementing them; infer routine details from the project.

For an explicitly enrolled enhanced workflow, use the compact [PRD](../references/prd-template.md) and [technical plan](../references/technical-plan-template.md) templates, then register their paths, hashes, structured criteria, and declared check mappings through the project's enhanced-spec service. Ordinary specification notes remain valid without enrollment; never infer enrollment or executable criteria from Markdown.

Preserve existing user authorization. A request to implement permits ordinary implementation work; this skill does not add a separate plan-approval gate. If the user requested approval before implementation, first prepare the concrete plan and wait for that approval.

## Offer the end-of-spec decision

When a spec-only request reaches a finished, reviewable plan, do not just stop silently. Show a concise one- or two-sentence summary and a link to the plan — the task's registered plan reference (for example, the value `latchkit spec decision-inspect` or `latchkit task inspect` reports), never a hardcoded note path, since plan storage is not fixed by this skill. Then offer exactly three choices: approve and build now, add notes to request changes, or keep the plan for later.

Register the decision point so it is durable and machine-checkable: `latchkit spec decision-present --task <task-id> --plan-ref <link-or-path> --plan-digest <sha256-of-the-plan-just-shown> --summary "<one-line summary>"`. Reuse the CLI's `--mutation-id event_<uuid>` idempotency pattern for a retried or repeated completion event; the command is safe to call again for the same task — an unchanged plan is a no-op, and an already-approved decision for the current plan is returned unchanged rather than re-asked or rebuilt.

### Prefer the host agent's own native control

Check this session's own currently available tools before choosing how to present the three choices:

- If a structured multi-choice/question tool or an editable plan-approval control (including free-form notes) is actually available in the running session, use it. Claude Code documents such a control (its `AskUserQuestion` tool and plan-mode approval flow — see [the Claude Code adapter notes](../../docs/providers/claude.md)); use it there when available.
- Otherwise — including Codex, Antigravity CLI, Cursor IDE/CLI, or any session where no such tool is actually present — offer the three choices as concise text and read the reply as ordinary conversation, with free-form notes accepted as plain text.

Only Claude Code has a documented native control for this today. Never claim or invoke a native question/choice/plan-approval tool that is not actually present in the current session's toolset, and never report using a native control when the text fallback was what the user actually saw; do not fabricate capability for a provider merely because another provider has it.

### Handle the answer

- **Approve and build**: `latchkit spec decision-approve --task <task-id> --expected-revision <n> --plan-digest <sha256> --scope "<paths or description>" --reference "<who/what approved it>"`. This binds the approval to the exact plan digest just shown — the same digest-bound approval approach `src/workflows/contracts.ts` uses for the full delivery workflow — so a plan that changes after this point makes the approval stale rather than authorizing the new content. On success, continue into `latchkit-build` (or the existing authorized implementation workflow, for example `latchkit workflow run`) for the same task, preserving its context, named criteria, and the provider's own permission boundaries. Immediately before starting that implementation, call `latchkit spec decision-build --task <task-id> --expected-revision <n>` once so a repeated completion event can never start a second build for the same approval.
- **Add notes**: revise the plan to address the feedback, then `latchkit spec decision-notes --task <task-id> --expected-revision <n> --text "<the notes>" --plan-digest <new-sha256> [--plan-ref <new-link>]`. This attaches the notes to the same task/plan, updates it to the revised content, and clears any prior approval — a stale approval can never authorize a changed plan. Re-present the revised plan and the same three choices again.
- **Keep for later**: `latchkit spec decision-pause --task <task-id> --expected-revision <n>` — or simply stop; leaving the prompt unanswered or dismissing it has the same effect. The plan is preserved and nothing is implemented. On resume, `latchkit spec decision-inspect --task <task-id>` restores the pending decision and its current revision before re-presenting it.

Preserve any implementation authorization or plan approval that already exists and is still valid for the current plan; do not introduce a duplicate confirmation when no new user decision is needed.

## Implement and verify

When implementation is authorized, work in coherent increments and update the note when evidence changes the plan. For behavioral code, use the smallest meaningful failing test when the repository has a suitable test harness. Confirm it fails for the intended behavior, make the change, then run it again. For prose, styling, or trivial configuration, use inspection or focused validation instead of manufacturing tests.

Run the project's checks appropriate to the changed behavior. Exercise the affected user flow, CLI command, or API when feasible. Record the command, environment, observed result, and any limitation; a successful build does not establish that every acceptance criterion passed.

Compare the finished work with each criterion and inspect the final diff. If a capable independent reviewer is available and useful, give them the requirements and changes; otherwise perform a separate review pass and identify it as self-review. Do not claim a reviewer or tool ran when it did not.

## Deliver

Update the note with completed work, verification evidence, remaining gaps, and the next action if incomplete. Report the outcome and material limitations to the user. Publish, deploy, merge, or send messages only within the user's authorization; creating this note does not authorize those actions.
