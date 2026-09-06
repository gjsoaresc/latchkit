---
name: latchkit-requirements
description: Discover and record the problem, audience, scope, decisions, and observable acceptance criteria before implementation. Use when a request is unclear or needs a shared requirements record.
---

# Latchkit requirements

Turn a request into a reviewable statement of intent without quietly turning discovery into implementation. Read the project guidance and inspect only the bounded repository context needed to understand the request.

When the caller requests lower usage or latency, apply the [optional efficiency policy](../references/efficiency.md).

## Discover the need

Record the audience, problem, desired outcome, constraints, non-goals, and decisions that materially affect the work. Separate what the requester said from assumptions and unresolved questions. Do not invent provider capabilities, credentials, approvals, or evidence.

Write `.latchkit/notes/<unique-task-slug>-requirements.md` unless the user asked for an inline result or writes are unavailable. Use the template in [workflow evidence](../references/workflow-evidence.md). Keep secrets, full private transcripts, and unrelated repository contents out of the note.

## Make intent observable

Express each acceptance criterion as an observable result with a clear scope. Include relevant failure and preservation cases, such as existing user guidance, unavailable enforcement, interrupted work, and duplicate discovery roots. Mark criteria that require user approval or a provider capability; do not treat a missing capability as a pass.

Stop at requirements when the request is discovery or planning only. If implementation is requested, hand the accepted criteria to `latchkit-spec` or `latchkit-build`; loading this skill never authorizes edits, execution, publication, or additional approval gates.

## Close the record

Summarize open decisions and the next workflow. If a task-state service is available, associate the note with the task and preserve its revision; otherwise the Markdown note is the instruction-only fallback. A note records intent, not proof that the work is complete.
