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

## Implement and verify

When implementation is authorized, work in coherent increments and update the note when evidence changes the plan. For behavioral code, use the smallest meaningful failing test when the repository has a suitable test harness. Confirm it fails for the intended behavior, make the change, then run it again. For prose, styling, or trivial configuration, use inspection or focused validation instead of manufacturing tests.

Run the project's checks appropriate to the changed behavior. Exercise the affected user flow, CLI command, or API when feasible. Record the command, environment, observed result, and any limitation; a successful build does not establish that every acceptance criterion passed.

Compare the finished work with each criterion and inspect the final diff. If a capable independent reviewer is available and useful, give them the requirements and changes; otherwise perform a separate review pass and identify it as self-review. Do not claim a reviewer or tool ran when it did not.

## Deliver

Update the note with completed work, verification evidence, remaining gaps, and the next action if incomplete. Report the outcome and material limitations to the user. Publish, deploy, merge, or send messages only within the user's authorization; creating this note does not authorize those actions.
