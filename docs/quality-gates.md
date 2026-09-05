# Quality gates

Quality gates evaluate only explicitly declared command plans associated with durable task criteria. They are invoked through a normalized lifecycle event whose payload sets `qualityGateTrigger: true`; ordinary discussion, maintenance, stop, and compaction events are advisory and do not start commands. Provider adapters translate their raw events to that normalized form and serialize the returned decision.

Each check has an explicit executable, argument array, working directory, timeout, output bound, criterion ID, and optional `watchPaths`. A change reruns only checks whose watched path contains the changed path; a check without path scoping conservatively reruns. Results record `passed`, `failed`, `timed-out`, `cancelled`, `skipped`, or `unsupported` evidence against the current criterion and source snapshot. Only `passed` required evidence can verify a task.

The evaluator requires an injected, already-applicable authorization decision for every command. A project file cannot authorize its own execution, and the evaluator never adds approval prompts or changes provider permissions. Commands run only under Latchkit's explicit `host-local-authorized` boundary, which is recorded in the evidence and is not provider-sandboxed. If that boundary is unavailable, no command starts and the evidence is `unsupported`.

A blocking response is returned only when the normalized event offers blocking and the provider contract explicitly supports `decision:blocking`; otherwise a failed gate is advisory with a visible limitation. Unsupported enforcement is never passed. The in-process handler is designed for a provider adapter/dispatcher; Latchkit does not install hooks or start a daemon.

Product-level CLI, HTTP, and browser assertions extend this same criterion evidence path through the [acceptance verifier](acceptance-verification.md). They do not replace quality-gate selection or task verification, and they do not create a second completion record.

## Manual provider smoke

With a user-authorized provider adapter that supplies a documented blocking lifecycle event, create and resume a task with a required criterion, configure a failing explicit check, and send one correlated normalized event with `qualityGateTrigger: true` and `decisionMode: "blocking"`. Confirm the adapter returns its documented blocking response, the task records failed evidence with the host-local boundary, and task verification refuses it. Repeat with a provider that lacks a blocking event and confirm an advisory limitation instead. This repository's automated tests use fixtures only: no credentialed provider session, provider hook installation, or cross-provider end-to-end smoke is claimed.
