# Quality gates

Quality gates evaluate only explicitly declared command plans associated with durable task criteria. They are invoked through a normalized lifecycle event whose payload sets `qualityGateTrigger: true`; ordinary discussion, maintenance, stop, and compaction events are advisory and do not start commands. Provider adapters translate their raw events to that normalized form and serialize the returned decision.

Each check has an explicit executable, argument array, working directory, timeout, output bound, criterion ID, and optional `watchPaths`. A change reruns only checks whose watched path contains the changed path; a check without path scoping conservatively reruns. Results record `passed`, `failed`, `timed-out`, `cancelled`, `skipped`, or `unsupported` evidence against the current criterion and source snapshot. Only `passed` required evidence can verify a task.

The evaluator requires an injected, already-applicable authorization decision for every command. A project file cannot authorize its own execution, and the evaluator never adds approval prompts or changes provider permissions. Commands run only under Latchkit's explicit `host-local-authorized` boundary, which is recorded in the evidence and is not provider-sandboxed. If that boundary is unavailable, no command starts and the evidence is `unsupported`.

A blocking response is returned only when the normalized event offers blocking and the provider contract explicitly supports `decision:blocking`; otherwise a failed gate is advisory with a visible limitation. Unsupported enforcement is never passed. The in-process handler is designed for a provider adapter/dispatcher; Latchkit does not install hooks or start a daemon.

Product-level CLI, HTTP, and browser assertions extend this same criterion evidence path through the [acceptance verifier](acceptance-verification.md). They do not replace quality-gate selection or task verification, and they do not create a second completion record.

## Fast mode

Every task and workflow run carries an explicit `verificationMode` of `fast` or
`standard`. `standard` is the default and preserves the original behavior
exactly: every selected check always runs and no evidence is reused. `fast`
applies a bounded, change-focused plan on top of the same selection and
evidence path.

A project-level default lives in `.latchkit/verification/settings-v1.json`,
inspected and changed with `latchkit verification` (`--verification-mode
fast|standard`). It only affects newly created tasks; an existing task keeps
its own persisted mode across every resume until an explicit
`latchkit task mode --task <id> --expected-revision <n> --verification-mode
<fast|standard>` changes it, or a workflow run supplies `verificationMode`
when it creates a new task. `latchkit task import` and `latchkit workflow run`
both accept `--verification-mode`.

In fast mode, `executeQualityGates` and the acceptance verifier
(`createAcceptanceVerifier().verify`) build a plan over the already
change-selected checks: a check is reused — not rerun — only when its last
recorded evidence passed for the exact current criterion revision and either
the whole project source is byte-identical to that evidence's snapshot, or the
caller supplied `changedPaths` and none of them fall under the check's
declared `watchPaths` (a check with no declared `watchPaths` has no scope to
prove safe, so it always reruns unless nothing at all changed). A new failure,
a changed dependency, or no prior evidence always forces a rerun; an unchanged
passing check is the only thing ever reused. Standard mode never reuses
anything, so mandatory and required checks are always retained there.

Fast mode also applies an explicit bounded budget — `timeBudgetMs` (default
5 minutes) and `maxExecutions` (default 50) — to the checks it actually
executes; reused checks do not count against it. When the budget is reached
before every selected check has run, the remaining checks are recorded with
outcome `skipped` (kind `fast-mode-budget-exceeded`), the result carries
`stats.fallback: 'standard'` with a reason and the exact `stats.nextChecks`
still unresolved, and the run is reported `failed` — fast mode never silently
loops past its bound or reports an unresolved gap as verified. Every result
also reports `stats` (selected, reused, executed, skippedForBudget, elapsedMs)
and a `plan` naming each check's selection/reuse reason, so a caller can see
exactly why a check ran, was reused, or was skipped. Skipped, failed,
cancelled, timed-out, and unsupported checks remain their own distinct
outcomes in both modes; only `passed` counts toward a passing result.

## Manual provider smoke

With a user-authorized provider adapter that supplies a documented blocking lifecycle event, create and resume a task with a required criterion, configure a failing explicit check, and send one correlated normalized event with `qualityGateTrigger: true` and `decisionMode: "blocking"`. Confirm the adapter returns its documented blocking response, the task records failed evidence with the host-local boundary, and task verification refuses it. Repeat with a provider that lacks a blocking event and confirm an advisory limitation instead. This repository's automated tests use fixtures only: no credentialed provider session, provider hook installation, or cross-provider end-to-end smoke is claimed.
