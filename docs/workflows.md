# Workflow scenarios

The bundled skills are portable instructions. They can use task state, provider adapters, project-rule exports, and quality gates when those capabilities are available, but none of these scenarios claims a live provider session unless one was actually run.

## Plan-only request

Ask for `latchkit-requirements` and then `latchkit-spec` with: “Clarify the acceptance criteria and write a plan; do not edit files.” The expected result is a requirements/specification note under `.latchkit/notes/`, no source edits, and explicit unresolved decisions. Approval to implement is not invented by the skills.

## Authorized feature

Provide a named criterion and an explicit implementation request, then invoke `latchkit-build`. The expected result is a bounded edit/test loop, a record of commands and outcomes, and a final comparison with each criterion. If task state or quality gates are unavailable, the Markdown note is the fallback and remains labeled as instruction-only evidence.

## Reproducible defect

Invoke `latchkit-fix` with the trigger, expected behavior, and actual behavior. The expected result is a reproduction attempt before the repair, a focused regression check where practical, and a note distinguishing verified cause from hypotheses. A non-reproducible defect remains an unresolved finding rather than a claimed fix.

## Review-only request

Invoke `latchkit-review` with a diff or commit and “review only; do not change files.” The expected result is actionable findings with paths, triggers, consequences, and evidence, or an explicit no-findings report. The skill does not authorize fixes, publication, or contact with the author.

## Interrupted handoff

Stop after recording partial evidence and invoke `latchkit-handoff`. The expected result is a concise note containing the actual revision, changed files, constraints, checks, uncertainty, and next action. On resume, the next session rechecks the note against the current working tree instead of treating the handoff as proof that work completed.

## Setup conflict and duplicate roots

Run `latchkit-setup` and preview `latchkit sync --dry-run` in a project with existing `AGENTS.md` or a pre-existing skill file. The expected result is a conflict with original bytes preserved. Selecting Claude alongside a shared-root provider produces a distinct Claude export plus a warning that compatible tools may discover the shared skill; it does not pretend provider selection is a visibility boundary.
