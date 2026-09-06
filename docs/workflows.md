# Workflow scenarios

Latchkit’s portable skills remain useful on their own. The typed delivery
workflow adds durable policy and execution around those skills while leaving
provider authentication, models, permissions, and sessions with the selected
provider CLI.

## Delivery sequence

The workflow follows:

```text
requirements → plan approval → implementation → verification
→ independent review → handoff
```

That is the retained sequence for workflows created before route selection.
New workflows persist a versioned, inspectable
route before execution. A local visual, documentation, or reproducible
low-impact fix can run implementation and its exact focused checks without a
separate requirements, planning, review, or handoff provider session. Features,
refactors, maintenance, and high-impact changes add stages proportionally; an
authorization, migration, credential, destructive, or other high-impact signal
overrides a lighter requested route. Unknown material impact stops after
bounded requirements investigation rather than inventing a full plan.

The route is distinct from `fast`/`standard` verification. Route selection
establishes the initial applicable check set before any evidence can be reused;
the verification mode then controls reuse and bounds only within that set.
Supply an exact accepted check document for a lightweight route, for example
with `--file checks.json`. `--route <id>` selects a supported route explicitly,
but cannot lower a high-impact route or waive applicable project policy.

The requirements and exact plan produce versioned acceptance checks. A user
must approve the exact requirements, plan, checks, and authorization scope
before implementation starts. The approval is digest-bound, so changed
requirements, plans, checks, policy, or prompts invalidate it — and so does a
change to the task's own accepted intent: approval also binds an `intentDigest`
over every currently accepted decision and confirmed assumption, recomputed
live on each policy evaluation, so reconciling one away (see
[reconciling changed intent](task-state.md#reconciling-changed-intent))
invalidates the approval immediately and routes an ordinary resume back to
plan approval instead of continuing on the stale contract. The selected
provider is the default reviewer when it exposes review capability; otherwise
an explicit review provider is required.

The initial implementation may have at most three repair attempts. Failed
verification or actionable independent-review findings consume that persisted
budget. Authentication failures, malformed provider responses, unavailable
capabilities, unresolved requirements, and interrupted actions pause the
workflow. Interrupted actions require observed task evidence, abandonment, or
an explicitly authorized retry; late results after cancellation are ignored.

Workflow state is additive to existing task state at
`.latchkit/workflows/state-v1.json`. It records revisions, operation IDs,
phase, approval digests, repair count, pending action IDs, outcomes, and
policy/prompt versions. Actions are journaled before effects and reconciled
afterward. On restart, the controller inspects the checkpoint and current task
evidence before continuing; it does not infer completion from a provider exit
status.

Every task carries an explicit `fast` or `standard` verification mode
(`standard` by default), persisted on the task itself so it survives every
resume unchanged until an explicit change. `latchkit workflow run` accepts
`--verification-mode`, applied only when it creates a new task; resuming an
existing task never changes its mode. When the verification phase runs, the
controller reads the task's own persisted mode and passes it to the acceptance
verifier, so a workflow started in fast mode stays bounded and change-focused
across every repair and resume. See [quality gates](quality-gates.md#fast-mode)
for the bounded plan, evidence-reuse rules, and budget/fallback behavior fast
mode applies; standard mode's behavior is unchanged from before this existed.

An upgrade that changes the policy, dispatcher, or review prompts cannot resume
an existing approved checkpoint under the new code. Inspection and cancellation
remain available. Roll back to the retained version that created the workflow
to continue it, or cancel it and start a newly approved workflow with the new
version. Automatic migration of approved pending work is not implemented.

## CLI

Start a workflow with a prompt and selected provider. `--host-local-authorized`
is required before a provider command may execute:

```sh
latchkit workflow run --project <path> --provider codex \
  --prompt "Implement the accepted feature" --host-local-authorized
```

Inspect one workflow or list all workflows:

```sh
latchkit workflow inspect --project <path> --task <task-id>
latchkit workflow inspect --project <path>
```

Preview the current, bounded resumable context brief (issue #112; see
[context briefs](task-state.md#context-briefs)) — current accepted intent,
what changed since the last dispatch, and the next action the existing
workflow allows. This is read-only: it never creates a controller, starts a
provider, or mutates workflow state, and requires an existing workflow
(`WORKFLOW_NOT_FOUND` otherwise):

```sh
latchkit workflow context --project <path> --task <task-id> \
  [--since-digest <sha256>] [--byte-budget 16384] [--format text|json]
```

Every `requirements`/`plan`/`implementation`/`handoff` dispatch this
controller actually makes binds a freshly built brief to that exact dispatch
first, recording which digest was delivered on the workflow's own record
(`lastDispatchedContext`) — always rebuilt from the current task/workflow
state immediately before dispatch, never reused, so a source drift or an
intent/criteria change is reflected automatically and a brief whose mandatory
content cannot fit its byte budget fails that dispatch
(`WORKFLOW_CONTEXT_BUDGET_EXCEEDED`) before any provider process starts.

Approve the exact plan shown by inspection. Supply all digests and the scope
and reference for the direct user approval:

```sh
latchkit workflow approve --project <path> --task <task-id> \
  --expected-revision <n> --requirements-digest <sha256> \
  --plan-digest <sha256> --checks-digest <sha256> \
  --authorization-scope "src/** and test/**" \
  --authorization-reference "maintainer approval"
```

Resume a paused workflow with current authorization. For an interrupted action,
include its `--action-id` and choose `--resolution observed|abandon|retry`; a
retry is an explicit authorization and still consumes the persisted repair
budget where applicable. Cancel with the current revision:

```sh
latchkit workflow resume --project <path> --task <task-id> \
  --expected-revision <n> --host-local-authorized
latchkit workflow cancel --project <path> --task <task-id> \
  --expected-revision <n>
```

Stale revisions are rejected. Re-read the workflow before retrying a rejected
mutation. Direct `task` commands remain available and share task ownership with
delivery workflows.

## Task worktree isolation is optional

Starting a direct task session decides, once, whether its implementation runs
in an isolated Git worktree or directly in the project checkout — see the
[configuration guide](configuration.md#task-workspace-preference) for the
persisted `workspace.executionPreference` project setting and its
`worktreeRoot` location. An explicit per-start choice always overrides that
default:

```sh
latchkit task start --project <path> --task <task-id> --provider codex \
  --host-local-authorized --workspace-choice worktree \
  --worktree-root .latchkit/worktrees
latchkit task start --project <path> --task <task-id> --provider codex \
  --host-local-authorized --workspace-choice direct
```

If the project preference is `ask` and a start omits `--workspace-choice`, the
start is refused with `WORKSPACE_CHOICE_REQUIRED` rather than silently picking
a side — the caller (an eventual UI prompt, or an explicit flag) must supply
the choice before anything starts. `--workspace-choice`/`--worktree-root`
apply only to a fresh start; `latchkit task resume` always reuses whatever
workspace (or lack of one) the task's session already recorded and never
re-decides, so changing the project default afterward cannot move an active
or resumed task or weaken provider permissions. If worktree isolation is
requested but Git or worktree creation is unavailable, the start fails with
`WORKSPACE_UNAVAILABLE` instead of silently falling back to direct execution.

This implementation-workspace choice is independent of the reviewer isolation
`latchkit review` always uses (see [review orchestration](review-orchestration.md));
changing one never affects the other. It currently applies to direct task
execution (`latchkit task start`/`resume`, `POST /api/tasks/start`) only — the
higher-level delivery `workflow run` implementation phase still always runs in
the project checkout, unchanged from prior releases; extending it to honor the
same preference is a follow-up.

## HTTP and console

The local console exposes the same workflow controller through the versioned
local API:

```text
GET  /api/workflows
GET  /api/workflows?task=<task-id>
POST /api/workflows/run
POST /api/workflows/approve
POST /api/workflows/resume
POST /api/workflows/cancel
```

Mutating requests use the current `expectedRevision`; execution requests return
promptly with `202` while provider work continues, and inspection/cancellation
remain available. The console lets a user start requirements, select a coding
provider and optional reviewer, authorize local tool execution, inspect the
requirements/plan/checks, approve the exact digests and scope, resolve paused
actions, refresh state, or cancel. The browser never receives provider
credentials.

## Portable skill scenarios

### Plan-only request and the end-of-spec decision

Ask for `latchkit-requirements` and then `latchkit-spec` with: “Clarify the
acceptance criteria and write a plan; do not edit files.” The expected result is
a requirements/specification note under `docs/plans/` (or the legacy
`.latchkit/notes/` when continuing an existing task there), no source edits,
and explicit unresolved decisions. Approval to implement is not invented by a
skill or workflow.

At that stopping point, `latchkit-spec` offers a concise end-of-spec decision:
approve and build, add revision notes, or keep the plan for later — preferring
the host agent's own native question/plan-approval control when one is
actually present in the running session (documented today only for Claude
Code; see [the Claude Code adapter](providers/claude.md#interactive-decision-surface))
and otherwise a concise text choice. The decision itself is recorded through
`latchkit spec decision-present/-approve/-notes/-pause/-build/-inspect` (see
[task-state persistence](task-state.md#cli-boundary)), a small state machine
additive to the typed delivery workflow: an approval is bound to the exact
plan digest shown, notes update the plan and clear a now-stale approval before
re-presenting the same choice, and pausing or leaving the prompt unanswered
persists the plan without starting implementation. Resuming reads that same
pending decision and its current revision back with `decision-inspect`, and a
repeated completion event never duplicates the prompt, the decision record, or
the build it authorizes.

### Authorized feature

Provide a named criterion and an explicit implementation request, then invoke
`latchkit-build`. The expected result is a bounded edit/test loop, a record of
commands and outcomes, and a final comparison with each criterion. If task
state or quality gates are unavailable, the Markdown note is the fallback and
remains labeled instruction-only evidence.

### Reproducible defect

Invoke `latchkit-fix` with the trigger, expected behavior, and actual behavior.
The expected result is a reproduction attempt before repair, a focused
regression check where practical, and a note distinguishing verified cause from
hypotheses. A non-reproducible defect remains unresolved.

### Execution completion and the end-of-execution result decision

Both `latchkit-build` and `latchkit-fix` close the same way: at the end of
execution, do not just stop silently. Present a reviewable result — what
changed, links to the relevant diff/artifacts, completed acceptance criteria,
actual verification results, and remaining gaps — and offer exactly three
choices: approve the result, add notes requesting changes, or review later.
This is the closing counterpart to the [plan-only end-of-spec
decision](#plan-only-request-and-the-end-of-spec-decision) above, for
execution instead of specification, and prefers the same native
question/plan-approval control when actually present in the running session
(documented today only for Claude Code; see [the Claude Code
adapter](providers/claude.md#interactive-decision-surface)) and otherwise the
same concise text choice.

The decision is recorded through `latchkit task result-present/-approve/-notes/-defer/-inspect`
(see [task-state persistence](task-state.md#cli-boundary)), a small state
machine additive to task state and to the `spec decision-*` machine: an
approval is bound to the exact reviewed snapshot — a SHA-256 digest over the
diff plus evidence summary just shown — so a later implementation change
invalidates it rather than silently carrying it forward. Approval never
rewrites the recorded verification results, completed criteria, or remaining
gaps; a failed or incomplete check stays visible on the record even after the
user accepts a known limitation. Approval accepts the task result only —
merging, publication, deployment, and destructive worktree cleanup keep their
own separate authorization boundaries and are never implied by it.

Notes add feedback and move the decision to `changes-requested`, clearing any
stale approval, without themselves changing the recorded result: the caller
routes the notes into the existing bounded `latchkit-build`/`latchkit-fix`
loop for the same task with that context, then calls `result-present` again
with the corrected snapshot's new digest, which re-presents it for a fresh
decision. Each note is classified `in-scope` (the default, reusing the task's
existing authorization) or `new-scope`, which requires its own explicit
authorization scope and reference rather than silently expanding the task or
resetting any repair budget the delivery workflow or the invoking skill's own
bounded loop already tracks — this state machine never touches those
counters itself. Reviewing later needs no call at all — dismissing the
prompt or an interrupted session already leaves the decision `pending` (or
`changes-requested`) and `result-inspect` restores the current result and any
outstanding notes on resume; a repeated completion event or resubmission with
the same `--mutation-id event_<uuid>` is a no-op replay rather than a
duplicate prompt, approval, or note.

### Review-only request

Invoke `latchkit-review` with a diff or commit and “review only; do not change
files.” The expected result is actionable findings with paths, triggers,
consequences, and evidence, or an explicit no-findings report. The skill does
not authorize fixes or publication.

### Interrupted handoff

Stop after recording partial evidence and invoke `latchkit-handoff`. The result
contains the actual revision, changed files, constraints, checks, uncertainty,
and next action. On resume, the next session rechecks the handoff against the
current working tree instead of treating it as proof of completion.

### Setup conflict and duplicate roots

Run `latchkit-setup` and preview `latchkit sync --dry-run` in a project with an
existing `AGENTS.md` or pre-existing skill file. The expected result is a
conflict with original bytes preserved. Selecting Claude alongside a shared-root
provider produces a distinct Claude export plus a warning that compatible tools
may discover the shared skill; provider selection is not a visibility boundary.
