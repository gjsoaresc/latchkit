# Task-state persistence

Latchkit stores workflow state separately from configuration and installer recovery in `.latchkit/tasks/state-v1.json`. The stable filename may contain any of the published [v1](../schemas/task-state-v1.schema.json), [v2](../schemas/task-state-v2.schema.json), [v3](../schemas/task-state-v3.schema.json), [v4](../schemas/task-state-v4.schema.json), or [v5](../schemas/task-state-v5.schema.json) schemas; reads validate whichever version is present and never migrate implicitly. New stores use the current version. The atomic-file and concurrency rationale is recorded in [ADR 0001](adr/0001-local-task-state.md).

Version 2 adds nullable, versioned [enhanced-workflow metadata](../schemas/enhanced-workflow-v1.schema.json) to every task. A null value preserves ordinary task behavior. Explicit registration records PRD and technical-plan hashes plus declared criterion/check mappings in the same locked task revision. It never interprets Markdown as an executable contract.

Version 3 adds a persisted `verificationMode` (`fast` or `standard`) to every task; `latchkit task mode` and `setVerificationMode` change it explicitly, and resume never silently changes an existing task's mode. Version 4 adds the `records` array described in [Task records](#task-records) below. Version 5 adds the `reconciliations` array described in [Reconciling changed intent](#reconciling-changed-intent).

Durable specifications and technical plans default to a collision-safe, readable filename under `docs/plans/`. Registration and import continue to accept the legacy `.latchkit/notes/` location so existing artifacts remain valid; nothing migrates implicitly. `docs/plans/` is an ordinary tracked project path, unlike `.latchkit/notes/`, which the source fingerprint used for evidence currency explicitly excludes: editing a plan under `docs/plans/` therefore changes the working-tree source snapshot and can invalidate evidence bound to the prior snapshot under the existing revision/source-matching policy, while a `.latchkit/notes/` edit alone does not. Re-registering an enhanced workflow after either kind of edit still increments `enhancedWorkflow.revision` and recomputes the artifact hash.

## Records and verification

Stable prefixed UUIDs identify projects, tasks, runs, criteria, checkpoints, evidence, authorizations, owners, and mutation events. Task and store revisions provide optimistic concurrency. Callers should persist the returned task revision and supply it to the next mutation; a stale revision produces `TASK_REVISION_CONFLICT`.

Every mutating service call accepts an optional `mutationId` such as `event_123e4567-e89b-12d3-a456-426614174000`. Persist and reuse it when retrying an uncertain call. An identical retry is idempotent; different input with the same ID produces `TASK_IDEMPOTENCY_CONFLICT`.

Evidence is current only when its criterion revision and source snapshot match the current criterion and worktree. Required evidence must be `passed`; failed, timed-out, cancelled, skipped, unsupported, or explicitly missing checks prevent verification. An approval criterion needs `approval` evidence and new direct-user authorization provenance. A saved approval requirement remains part of the criterion after restart even when no approval has been recorded.

An enrolled enhanced task must have at least one required criterion, and every required criterion must map to at least one declared check. Final verification requires current passing `enhanced-check:<check-id>` evidence for every mapping; one passing check cannot conceal a missing or failed sibling. Ordinary tasks, including tasks with no required criteria, retain the v1 verification behavior.

`src/task-state/service.js` is the service boundary. In addition to the ordinary task operations, it exports `registerEnhancedWorkflow` and `migrateTaskState`. Mutations require an expected task revision except initial creation/import and explicit store migration. `resumeTask` reconciles the source tree and the recorded process; a missing process becomes interrupted and never completed. Integrations may inject a stronger platform process probe, but may not translate missing or unknown into success.

## Task records

Task-state schema version 4 adds a bounded `records` array to every task: discriminated `decision`, `assumption`, `observation`, and `question` records with a stable `record_<uuid>` ID, a per-record revision, kind-appropriate `status`, bounded `text` (4 KiB), declared `provenance`, up to 32 declared `links`, and a bounded `history` (40 entries) of every prior revision, status, text, reason, and (when applicable) the authorization that made the change. This is additive: an existing task with no records behaves exactly as before, and `records` defaults to `[]` on creation and on the explicit v3→v4 migration step of `migrateTaskState`. `src/task-state/records.ts` holds the pure shape (kinds, statuses, transition table, dependency-cycle detection, link reconciliation); `src/task-state/contracts.ts` validates every record on every read and write; `src/task-state/service.ts` implements the five operations below on top of the same `mutate()`/lock/idempotency machinery as every other task mutation — there is no second store or second lock.

**Provenance** distinguishes `direct-user` (typed or dictated by the person), `agent-inferred` (an agent's inference from code or conversation), `imported` (text copied from another source), and `execution-observed` (something a command or check actually produced). Provenance is descriptive only: it never implies acceptance. Every new record — regardless of its provenance, including `direct-user` — starts in its kind's initial, non-authoritative status: `decision` starts `proposed`, `assumption` starts `tentative`, `observation` starts `unverified`, `question` starts `open`. Reaching an accepted state is always a separate, explicit transition.

**Status transitions** are a fixed table per kind, not arbitrary strings:

| Kind          | Statuses                                                                                                                                                      | Terminal                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `decision`    | `proposed → accepted → {retracted, superseded}`; `proposed → {retracted, superseded}`                                                                         | `retracted`, `superseded` |
| `assumption`  | `tentative → {confirmed, contradicted, retracted, superseded}`; `confirmed → {contradicted, retracted, superseded}`; `contradicted → {retracted, superseded}` | `retracted`, `superseded` |
| `observation` | `unverified ⇄ {verified, stale}`; any → `{retracted, superseded}`                                                                                             | `retracted`, `superseded` |
| `question`    | `open → {answered, withdrawn, superseded}`; `answered → {withdrawn, superseded}`                                                                              | `withdrawn`, `superseded` |

`decision.accepted`, `assumption.confirmed`, and `question.answered` are each kind's single **authoritative** status. Moving into or out of that status (acceptance, or reversing a prior acceptance) is an authority-bearing action: the caller must reference the task's existing direct-user authorization by ID (`authorizationId`) or grant a new one in the same call (`authorization`, following the same `source: 'user'` shape used everywhere else in this contract) — never both silently assumed. No parser, model response, memory import, source match, or new observation can reach that path; only an explicit `transitionTaskRecord` call (or a `recordTaskRecord` call that supersedes an already-accepted record) can. This is why acceptance is never implied by kind or provenance alone, and why a universal approval gate is unnecessary: a transition that stays within non-authoritative statuses (marking an assumption `contradicted`, a question `withdrawn`, an observation `stale`) needs no authorization at all. `observation` has no authoritative status; moving one to `verified` instead requires a linked `evidenceId` naming current, `passed` task evidence (`TASK_RECORD_EVIDENCE_REQUIRED` otherwise) — a label, exit code, or narrative is never sufficient.

**Links** are a bounded, typed set (`record`, `criterion`, `evidence`, `memory`, or `source`), each carrying enough to detect staleness later: a `record` link pins a `recordId`/`recordRevision`, a `criterion` link pins `criterionId`/`criterionRevision`, an `evidence` link pins the immutable `evidenceId`, a `memory` link pins a project-memory `memoryId`/`memoryRevision` (see [project memory](../src/project-memory/service.ts); inspecting it never changes that memory's own authority or lifecycle), and a `source` link records a repository-relative path with either the SHA-256 digest observed at declaration time or an explicit `null` (declared unavailable, via `digestUnavailable: true`) — never a fabricated digest for a file that does not exist. Every link target must already exist and be at or before its current revision at declaration time (`TASK_RECORD_LINK_INVALID` otherwise); `record`-type links (and `supersedes`) form a dependency graph that is checked for cycles before every mutation (`TASK_RECORD_CYCLE`). Because every ID lookup is scoped to the current task's own `criteria`/`evidence`/`records` arrays, a link copied from a different task or project simply does not resolve.

**Supersession** replaces a record without rewriting history: `recordTaskRecord` with `supersedes: <recordId>` creates a new same-kind record and, in the same mutation, marks the prior record `superseded` with `supersededBy` set to the new record's ID. Superseding a record that is currently in its kind's authoritative status requires the same authorization as any other authority-bearing transition (replacing an accepted decision is itself a new user choice); superseding a non-authoritative record does not. A record already `retracted` or `superseded` cannot be revised, transitioned, or superseded again. An authoritatively accepted record cannot be revised in place (`reviseTaskRecord` rejects it with `TASK_RECORD_TRANSITION_INVALID`) — acceptance can only be changed by an explicit reversal or supersession, never a silent text edit.

**Restart and recovery** return the same IDs, statuses, and provenance: `records` is ordinary task state, so `resumeTask`/`inspectTask` reconcile it exactly like criteria and evidence. `inspectTaskRecord` additionally recomputes every declared link's freshness on read — `current`, `stale` (revision/digest moved on), `missing` (target no longer exists), or `unknown` (an explicitly declared-unavailable source digest) — without ever rewriting the stored record; a changed or deleted source is exposed, not silently repaired or treated as semantic proof of anything. Text that arrives as an `imported` or `agent-inferred` record is inert data: recording or listing it never executes it, and nothing in its content (an embedded "APPROVED", a fake authorization ID, or instructions to run a command) can move a record's status or grant authority — only an explicit, separately authorized `transitionTaskRecord`/`recordTaskRecord` call can.

Operations, all through `src/task-state/service.ts` and reusing the existing expected-task-revision and `mutationId` idempotency semantics:

- `recordTaskRecord(root, { taskId, expectedRevision, kind, text, provenance, links?, supersedes?, authorizationId?, authorization? })` — create.
- `reviseTaskRecord(root, { taskId, expectedRevision, recordId, recordRevision, text?, links?, reason? })` — revise text and/or links of a non-terminal, non-authoritative record.
- `transitionTaskRecord(root, { taskId, expectedRevision, recordId, recordRevision, status, reason, authorizationId?, authorization?, evidenceId? })` — resolve, adopt, contradict, or otherwise move a record along its kind's transition table.
- `listTaskRecords(root, { taskId, kind?, status?, limit?, cursor? })` — read-only, paginated (`limit` 1–200, default 50; `cursor` is the last-seen record ID).
- `inspectTaskRecord(root, { taskId, recordId })` — read-only, includes link reconciliation.

The CLI exposes the same five operations under `latchkit task record-*` (see [CLI boundary](#cli-boundary)). `text`, `provenance.reference`, and transition `reason` are each bounded (4 KiB / 1 KiB / 2 KiB); `links` is bounded to 32 entries per record, `history` to 40 entries per record, and a task to 500 records total — each limit produces an explicit `TASK_RECORD_LIMIT_EXCEEDED`/`TASK_RECORD_TEXT_TOO_LARGE` rather than silent truncation, and `listTaskRecords` paginates rather than returning an unbounded array.

## Reconciling changed intent

Task-state schema version 5 adds a bounded `reconciliations` array to every task (issue #111, building directly on [task records](#task-records) from issue #110): a deterministic, reviewable impact report for a proposed change to accepted intent (a superseded/transitioned decision or assumption) and/or criteria, and an explicit apply operation bound to that exact report by digest. This does not add a second graph or state store — it computes impact from the same declared `record`/`criterion`/`evidence`/`memory`/`source` links `inspectTaskRecord` already reconciles, and it applies through the same `mutate()`/lock/`mutationId` machinery every other task mutation uses.

**Preview** (`previewTaskReconciliation`) is read-only: it takes a task ID and an explicit **patch** — a bounded list of record operations (`transition`, `supersede`, or `revise`, in the same shape as `record-transition`/`record-add --supersedes`/`record-revise`) and/or a full criteria replacement (the same shape `spec register` already accepts) — and returns a report without touching persisted state, user files, or launching any command or provider. Identical input against identical state reproduces an identical report, `digest` included; the only field that legitimately varies between otherwise-identical calls is `generatedAt`.

**Impact classification** is computed by simulating the patch and then running a bounded breadth-first traversal over the _undirected_ graph of declared record↔record and record↔criterion links, starting from every record/criterion the patch names directly:

- **directly-affected** — named by the patch itself (a transitioned/superseded/revised record, an added/changed/removed criterion).
- **declared-dependent** — reachable from a directly-affected item through one or more declared links; each entry carries the exact chain (`path`) that explains why it was reached, and an `enhanced-workflow` check or task evidence bound to a reached criterion is included too (`needs-re-verification`).
- **potentially-affected** — a required criterion that no declared record link, task-wide, ever points at, surfaced only when the patch changes adopted (accepted/confirmed) intent. Latchkit has no semantic dependency inference (that remains CodeGraph's territory, issue #96): it cannot tell whether such a criterion actually depends on the changed intent, so it is flagged as an explicit uncertainty rather than silently folded into "unchanged" — **absence of a declared link never proves independence**, and an unlinked check is never described as reusable or safe on that basis.
- everything else is unchanged-by-this-patch, reported only as a bounded count (`impactSummary.unchanged`) to keep the report itself bounded.

Each impact entry also carries a declared `outcome`: `needs-user-decision` (a newly proposed/tentative item still needs explicit resolution), `needs-replanning` (a downstream accepted decision, confirmed assumption, or removed criterion should be re-examined), `needs-re-verification` (a criterion, check, or evidence entry whose criterion revision moved), or `none` (historical/terminal, informational only). A `reasonCode` and `path` on every entry make the classification auditable rather than opaque. Traversal and the returned impact list are both bounded (`MAX_RECONCILE_TRAVERSAL_NODES`, `MAX_RECONCILE_IMPACT_ENTRIES`); exceeding either sets `impactTruncated: true` rather than silently dropping entries. A `uncertainties` array separately flags declared links that are `stale`, `missing`, or explicitly `unknown` (a declared-unavailable source digest) among the reached items, plus each uncovered-dependency criterion.

The report's `digest` binds the exact patch to the current task revision, the associated workflow's revision (if one exists), the working-tree source snapshot, and the resolved current hash of every source file any reached record declares a link to (its "referenced artifact hashes"). **Apply** (`applyTaskReconciliation`) recomputes this identical report against the live, locked task and refuses with `TASK_RECONCILE_PREVIEW_STALE` before mutating anything if the digest no longer matches — a concurrent unrelated task mutation, a workflow event, or a plain edit to a file a record links to (with no task mutation at all) are all caught this way, not only a stale task revision. A terminal task (`verified`/`cancelled`) is refused with `TASK_RECONCILE_TASK_TERMINAL` (reconcile a new follow-up task instead), and a task with an owned, live workflow effect (a pending action whose owner process is still running) is refused with `TASK_RECONCILE_ACTIVE_EFFECT` — settle or cancel it through the existing workflow pause/cancel path first; apply never silently cancels, restarts, forks, or takes ownership of it. `applyTaskReconciliation` reuses the same expected-revision/`mutationId` idempotency semantics as every other mutation: a retried call with identical input after a restart returns the already-committed result, and reusing a `mutationId` with different input is rejected.

Applying a patch commits every named record operation and the criteria replacement as **one** task revision and event (`task.reconciled`), never one per operation, and appends a bounded `TaskReconciliation` summary (`id`, the committing `mutationId`, `patchDigest`/`previewDigest`, a per-operation `ops` summary, the bounded `impact`/`impactSummary`/`uncertainties`, the authorization IDs used, and `workflowAcknowledged`) to `task.reconciliations` (capped at `MAX_RECONCILIATIONS_PER_TASK`). Removing a criterion that a required enhanced check still maps to still fails the existing whole-state validation (`registerEnhancedWorkflow`'s check-coverage rule is not bypassed); a rejected patch never partially commits.

**Approval freshness** extends to adopted intent: `src/workflows/service.ts`'s `WorkflowApproval` now also records `intentDigest` (`computeIntentDigest` over every accepted decision/confirmed assumption at approval time, from `src/task-state/records.ts`) alongside the existing `criteriaDigest`. `approvalValid` compares both against the task's _current_ values on every policy evaluation, exactly like `criteriaDigest` already does — so reconciling away an accepted decision (even one that never touched a criterion's text) makes a workflow's plan approval invalid immediately, without any change to the workflow record itself, the next time the workflow evaluates its next action. Because that check is live and independent of any secondary bookkeeping, an _ordinary_ `workflow resume` on a task whose accepted intent moved reroutes back to `awaiting-approval` through the plan-approval transition the delivery workflow already has — it never re-invokes the old contract. A task with no adopted records (including every task that predates task records) produces the same fixed `intentDigest`, so this never invalidates an approval on a task that never adopted any decisions. A context-only observation is never authoritative and therefore never appears in `intentDigest`; it cannot silently rewrite approved scope.

**Atomicity across the two stores**: task-state and workflow-state share one lock file (`src/task-state/lock.ts`), so `applyTaskReconciliation` performs the durable task-state commit and a secondary, best-effort, idempotent workflow acknowledgment (reusing the workflow's existing `mutations` ledger — see `src/workflows/reconcile.ts`) under that single lock, in that order. The task commit is the sole authoritative boundary: `approvalValid` is recomputed live from committed task state, never from the acknowledgment, so a crash or injected failure between the task write and the acknowledgment still leaves a mismatched approval unusable — it can never dispatch implementation or verification against mixed revisions. The acknowledgment's outcome is reflected in the value `applyTaskReconciliation` returns; because it necessarily happens after the one task-state write, a _later_ read of the persisted `TaskReconciliation.workflowAcknowledged` field always shows `false`, even when the acknowledgment actually succeeded moments later — a deliberate consequence of never writing task-state twice for one reconciliation.

Operations, both read/write through `src/task-state/service.ts`:

- `previewTaskReconciliation(root, { taskId, patch })` — read-only.
- `applyTaskReconciliation(root, { taskId, expectedRevision, patch, previewDigest, mutationId? })`.

The CLI exposes both as `latchkit task reconcile-preview`/`reconcile-apply` (see [CLI boundary](#cli-boundary)); published request/response shapes are in [reconciliation-patch-v1](../schemas/reconciliation-patch-v1.schema.json) and [reconciliation-report-v1](../schemas/reconciliation-report-v1.schema.json) (the latter also defines the persisted `TaskReconciliation` shape referenced from [task-state-v5](../schemas/task-state-v5.schema.json)).

Explicitly out of scope, matching the parent epic: semantic/structural dependency inference (CodeGraph, issue #96), incremental evidence-cache reuse, automatic task decomposition, and autonomous repairs. Historical evidence keeps its original source/criterion/check bindings unconditionally — the report may say where new verification is needed but never relabels old evidence, synthesizes a pass, or reuses source-stale evidence based on the dependency graph; the existing whole-source freshness rule (source snapshot equality) stays in force regardless of the declared impact set's size.

## Context briefs

Issue #112 (building on [task records](#task-records) from #110 and [reconciling changed intent](#reconciling-changed-intent) from #111) adds a versioned, deterministic context projection over the same task and workflow records: a bounded brief a resumed agent session can receive instead of stale memory or a replayed transcript. `src/context-brief/service.ts#buildContextBrief` is read-only — it performs no task migration, file rewrite, tool installation, inference, or provider execution — and reproduces an identical `digest` for identical underlying state (the only field that legitimately varies between otherwise-identical calls is `generatedAt`), the same determinism contract `previewTaskReconciliation` already has. The published shape is [context-brief-v1](../schemas/context-brief-v1.schema.json).

A brief keeps four kinds of content visibly distinct, never mixed: **user intent** (`acceptedDecisions`/`confirmedAssumptions`, each carrying its `provenance`), **inferred advice or still-open material** (`pendingDecisions`/`openAssumptions`/`openQuestions`, labeled by `provenance.kind`), **historical observations** (`historicalObservations`, kept out of the intent sections entirely), and **execution authorization** (`authorizations`, the task's own granted authorizations — never folded into decisions). It also reports `criteria` (current task criteria), `reconciliationOutcomes` (bounded, most-recent-first summaries of `task.reconciliations`), `planReferences` (durable plan/enhanced-artifact/workflow-requirements/plan digests with inspectable source references), and `nextAction` — a projection of the existing workflow's *current* status/phase/approval-freshness (`approvalValid`, the exact live check `src/workflows/service.ts` uses), never a re-invocation of the delivery workflow's own TypeScript policy and never provider execution. A task with no delivery workflow gets `nextAction.kind: 'ordinary-task'` rather than a fabricated workflow decision.

**Change since last run** (`changeSinceLastRun`) is bound to the *last dispatched* context digest only — never a full transcript or history archive. Callers can pass an explicit `sinceDigest`; omitting it defaults to the workflow's own recorded `lastDispatchedContext.digest` (see below). When that digest is unknown or doesn't match, the section is honestly `available: false` with `reason: 'no-prior-dispatch'` or `'digest-mismatch'` rather than a fabricated diff. When it matches, the section reports: `reconciliationsSince` (reconciliations committed after the bound task revision), `unreconciledChange` (a flag for the rarer case where criteria or adopted intent changed by some path *other* than reconciliation — a direct edit — so nothing is silently attributed to a reconciliation that didn't happen), `workNeedingAttention` (criteria/checks/evidence reached by those reconciliations' own impact graphs, deduplicated), `completedWorkRemaining` (required criteria *not* flagged that also have current, passing evidence right now — evidence currency is always proven fresh, never assumed from the mere absence of a reconciliation: "unchanged work never implies reusable evidence"), and `missingDependencyLinks` (declared links on currently adopted decisions/assumptions whose live status is `missing` or `unknown`, reported regardless of whether a prior dispatch digest is even available).

**Byte budget** (AC #3): every brief carries an explicit `budget` (`requestedBytes`/`effectiveBytes` from `--byte-budget`, default 16384, bounded to at most 262144; `mandatoryBytes`; `usedBytes`; a heuristic `estimatedTokens` with an `estimateDisclaimer` that is never presented as provider-measured usage). Mandatory content — identity/digests, `authorizations`, `acceptedDecisions`, `confirmedAssumptions`, `pendingDecisions`, `openAssumptions`, `openQuestions`, `criteria`, `nextAction`, and `changeSinceLastRun`'s own flags — is never trimmed: if it alone exceeds the budget, `buildContextBrief` throws `CONTEXT_BRIEF_BUDGET_EXCEEDED` with the exact mandatory byte count and an actionable next step (raise `--byte-budget`, or resolve/supersede records to shrink it) instead of dispatching an incomplete brief. Optional material (`historicalObservations`, `reconciliationOutcomes`, `planReferences`, and the four bounded lists inside `changeSinceLastRun`) is filled in a fixed, documented priority order — safety-relevant material (`missingDependencyLinks`, `workNeedingAttention`) first, decorative history (`historicalObservations`) last — and every item that doesn't fit is listed in `omitted` with its section and an inspectable `sourceRef` (for example `task.records[id=record_…]` or `task.reconciliations[id=reconciliation_…]`), never silently dropped.

**Binding at dispatch** (AC #5): `src/workflows/service.ts#invoke` binds a freshly built brief to every provider dispatch (`requirements`/`plan`/`implementation`/`handoff`) *before* journaling it, using its own already-loaded `task`/`record` and `tasks.source(root)` rather than an independent storage read (so an injected test double, or a concurrent mutation, can never disagree with what the rest of the dispatch is using). The binding — digest, brief schema version, task/workflow revision, criteria/intent digest, source snapshot, and referenced plan-artifact hashes — is recorded on the existing dispatch journal itself as `WorkflowRecord.lastDispatchedContext` (optional, so a workflow persisted before this field existed reads as `null`/`no-prior-dispatch` rather than a fabricated comparison; see [workflow-v1](../schemas/workflow-v1.schema.json)). Because the brief is always rebuilt fresh immediately before dispatch, a source drift or an intent/criteria change is reflected automatically; a brief that cannot fit its byte budget fails that dispatch with `WORKFLOW_CONTEXT_BUDGET_EXCEEDED`, the same way a stale approval already blocks it, before any provider process starts. The direct task-controller path (`latchkit task start`/`resume`) records the same digest on its own session record (`TaskSession.contextBriefDigest`) best-effort — a brief-building failure there never blocks starting or resuming a session. Latchkit cannot rewrite an already-running provider's context: a brief only ever applies at the start of a *new* dispatch, and unsupported in-session delivery falls back to the existing checkpoint/next-session path (every brief carries this as `deliveryNote`/`resumeGuidance`).

**CLI and API**: `latchkit task context-preview --project <path> --task <task-id> [--since-digest <sha256>] [--byte-budget <n>] [--format text|json]` previews the brief for any task, enrolled or not. `latchkit workflow context` takes the same options but requires an existing delivery workflow (`WORKFLOW_NOT_FOUND` otherwise), matching `workflow inspect`. Both are read-only previews through the existing services: repeated calls with unchanged state and options reproduce the same digest, and neither ever creates a controller, starts a provider, or mutates task/workflow state. `--format text` (the default) renders a concise human-readable summary with source links; `--format json` prints the full brief. Project-memory excerpts reachable through a record's `memory` link remain historical, untrusted context exactly as documented under [task records](#task-records) — inspecting or previewing a brief never lets embedded instructions in record, memory, or imported text acquire task authority.

Ordinary tasks keep working unchanged: a task with no records, no reconciliations, and no delivery workflow still previews cleanly (`nextAction.kind: 'ordinary-task'`, `changeSinceLastRun.reason: 'no-prior-dispatch'`). Opting in is exactly the existing task-records/reconciliation flow — `task record-add`/`record-transition` to record and accept one decision with criterion links, `task record-inspect`/`context-preview` to inspect it, `task reconcile-preview`/`reconcile-apply` to amend it at a safe checkpoint — and resuming afterward uses the same ordinary `task resume`/`workflow resume` operations. A context preview or a decision amendment never grants new execution scope; existing authorization remains effective within its own already-declared scope.

## Provider session controller

`src/runtime/task-controller.js` coordinates an explicitly authorized provider launch with a durable task run. Its session correlation and redacted process result are stored separately in `.latchkit/tasks/sessions-v1.json`; task-state v2 adds only nullable enhanced-spec metadata and does not absorb provider session records. The controller accepts only an adapter with evidenced invocation or resume capability and the `host-local-authorized` boundary. That boundary is local execution, not a provider sandbox or an approval-policy override.

An exited provider process or provider `session-terminated` event records a checkpoint/diagnostic state but never completes or verifies the task. Required evidence and independent `completeTask`/`verifyTask` remain necessary. Cancellation first commits the terminal task state, then signals only a child launched by the same in-memory controller. A restarted controller refuses to adopt a recorded PID; it can use a provider-native resume plan only when the provider exposed a session identity. This prevents an unrelated reused PID or a late completion event from being mistaken for the task's process.

The local console exposes the same controller at authenticated `/api/tasks`, `/api/tasks/start`, `/api/tasks/resume`, `/api/tasks/cancel`, and `/api/tasks/events` routes. These are local, bearer-token-protected service operations, not a remote provider API.

## CLI boundary

The deliberately narrow CLI exposes operator lifecycle actions:

```sh
latchkit task inspect --project "path/to/project"
latchkit task inspect --project "path/to/project" --task task_<uuid>
latchkit task resume --project "path/to/project" --task task_<uuid> --expected-revision 3
latchkit task cancel --project "path/to/project" --task task_<uuid> --expected-revision 4 --reason "user cancelled"
latchkit task start --project "path/to/project" --task task_<uuid> --provider codex --host-local-authorized
latchkit task result-present --project "path/to/project" --task task_<uuid> \
  --result-ref <link-or-path> --result-digest <sha256> --summary "<one-line summary>" \
  --verification-results "<actual verification results>" [--remaining-gaps "<known gaps>"] \
  [--file result-links.json]
latchkit task result-approve --project "path/to/project" --task task_<uuid> --expected-revision 1 \
  --result-digest <sha256> [--text "<optional acceptance note>"]
latchkit task result-notes --project "path/to/project" --task task_<uuid> --expected-revision 2 \
  --text "<requested changes>" --result-digest <sha256> [--change-scope in-scope|new-scope] \
  [--authorization-scope "src/** and test/**" --authorization-reference "maintainer approval"]
latchkit task result-defer --project "path/to/project" --task task_<uuid> --expected-revision 2
latchkit task result-inspect --project "path/to/project" --task task_<uuid>
latchkit task record-add --project "path/to/project" --task task_<uuid> --expected-revision 3 \
  --kind decision --text "Use SQLite for local state" \
  --provenance direct-user --reference "user message 2026-09-06" \
  [--file links.json] [--supersedes record_<uuid>] [--mutation-id event_<uuid>]
latchkit task record-revise --project "path/to/project" --task task_<uuid> --expected-revision 4 \
  --record record_<uuid> --record-revision 1 [--text "<revised text>"] [--file links.json] \
  [--reason "clarify wording"]
latchkit task record-transition --project "path/to/project" --task task_<uuid> --expected-revision 5 \
  --record record_<uuid> --record-revision 1 --status accepted --reason "user confirmed in chat" \
  [--authorization-id authorization_<uuid> | --authorization-scope "src/**" --authorization-reference "maintainer approval"] \
  [--evidence-id evidence_<uuid>]
latchkit task record-list --project "path/to/project" --task task_<uuid> \
  [--kind decision|assumption|observation|question] [--status <status>] [--limit 50] [--cursor record_<uuid>]
latchkit task record-inspect --project "path/to/project" --task task_<uuid> --record record_<uuid>
latchkit task reconcile-preview --project "path/to/project" --task task_<uuid> --file patch.json
latchkit task reconcile-apply --project "path/to/project" --task task_<uuid> --expected-revision 5 \
  --file patch.json --preview-digest <sha256-from-reconcile-preview> [--mutation-id event_<uuid>]
latchkit task context-preview --project "path/to/project" --task task_<uuid> \
  [--since-digest <sha256>] [--byte-budget 16384] [--format text|json]
latchkit workflow context --project "path/to/project" --task task_<uuid> \
  [--since-digest <sha256>] [--byte-budget 16384] [--format text|json]
latchkit spec migrate --project "path/to/project" --dry-run
latchkit spec migrate --project "path/to/project"
latchkit spec register --project "path/to/project" --task task_<uuid> --expected-revision 3 --file enhanced.json
latchkit spec inspect --project "path/to/project" --task task_<uuid>
latchkit spec verify --project "path/to/project" --task task_<uuid> --expected-revision 8
latchkit spec decision-present --project "path/to/project" --task task_<uuid> \
  --plan-ref <link-or-path> --plan-digest <sha256> --summary "<one-line summary>"
latchkit spec decision-approve --project "path/to/project" --task task_<uuid> --expected-revision 1 \
  --plan-digest <sha256> --scope "src/** and test/**" --reference "maintainer approval"
latchkit spec decision-notes --project "path/to/project" --task task_<uuid> --expected-revision 2 \
  --text "<revision notes>" --plan-digest <new-sha256>
latchkit spec decision-pause --project "path/to/project" --task task_<uuid> --expected-revision 2
latchkit spec decision-build --project "path/to/project" --task task_<uuid> --expected-revision 3
latchkit spec decision-inspect --project "path/to/project" --task task_<uuid>
latchkit spec plan-path --project "path/to/project" --title "Enhanced spec enrollment"
latchkit spec migrate-plan --project "path/to/project" --from ".latchkit/notes/example-spec.md" --dry-run
latchkit spec migrate-plan --project "path/to/project" --from ".latchkit/notes/example-spec.md"
```

The `spec decision-*` commands are the durable decision state machine behind the `latchkit-spec`
skill's end-of-spec offer (approve and build, add notes, or keep the plan for later); see
[workflow scenarios](workflows.md#plan-only-request-and-the-end-of-spec-decision). One decision
record exists per task, keyed to a caller-supplied plan reference and a SHA-256 digest of the
exact plan content, in `.latchkit/workflows/spec-decisions-v1.json`. `decision-approve` binds an
approval to that exact digest the same way the delivery workflow's approval binds to a plan
digest (see [delivery workflow policy](architecture.md#delivery-workflow-policy)); a plan that
changes afterward — for example through `decision-notes` — makes the approval stale
(`SPEC_DECISION_PLAN_STALE`) rather than silently carrying it forward. `decision-present` and
`decision-build` are idempotent for a repeated completion event: an unchanged plan or an
already-started build is returned unchanged rather than re-prompted or re-launched, and reusing a
`--mutation-id` with different input is rejected (`SPEC_DECISION_IDEMPOTENCY_CONFLICT`) rather than
silently applied.

`spec plan-path` previews a collision-safe filename under `docs/plans/` for a new durable plan without
creating anything; it never reuses or overwrites a name already on disk. `spec migrate-plan` explicitly
copies one existing `.latchkit/notes/` plan to `docs/plans/`: it preserves the original file exactly,
computes the destination itself unless `--to` names one, and refuses to run when a different file
already occupies the destination. It is never invoked implicitly.

The `task result-*` commands are the closing counterpart: a durable decision state machine behind
the same-shaped end-of-execution offer from `latchkit-build` and `latchkit-fix` (approve the
result, add notes requesting changes, or review later); see [workflow
scenarios](workflows.md#execution-completion-and-the-end-of-execution-result-decision). One
decision record exists per task, keyed to a caller-supplied result reference and a SHA-256 digest
of the exact reviewed snapshot (diff plus evidence summary), in
`.latchkit/workflows/result-decisions-v1.json`. `result-approve` binds acceptance to that exact
digest the same way `spec decision-approve` binds to a plan digest; a result that changes
afterward — a correction landing, or a later run producing a different snapshot — makes the
approval stale (`RESULT_DECISION_SNAPSHOT_STALE`) rather than silently carrying it forward, and
approval never rewrites the recorded `verificationResults`, `completedCriteria`, or
`remainingGaps` fields, so a failed or incomplete check stays visible even after acceptance.
`result-notes` moves the record to `changes-requested` and clears any stale approval without
itself changing the reviewed content; each note is `in-scope` (default, reusing the task's
existing authorization) or an explicit `new-scope` with its own `--authorization-scope`/
`--authorization-reference`, so a correction can never silently expand the task or reset a repair
budget owned elsewhere. `result-present` is idempotent for a repeated completion event: an
unchanged result is returned unchanged rather than re-prompted, and reusing a `--mutation-id` with
different input is rejected (`RESULT_DECISION_IDEMPOTENCY_CONFLICT`) rather than silently applied.

`task context-preview` and `workflow context` (see [context briefs](#context-briefs)) are the read-only preview surface for the versioned context projection: `text` (default) renders a concise summary and `json` prints the full brief, `--since-digest` diffs against a specific prior dispatch instead of the workflow's own recorded one, and `--byte-budget` overrides the default explicit budget. Neither ever creates a controller, starts a provider, or mutates task/workflow state; `workflow context` additionally requires an existing delivery workflow (`WORKFLOW_NOT_FOUND` otherwise, matching `workflow inspect`), while `task context-preview` works on any task, enrolled or not.

Use `--mutation-id event_<uuid>` to retry resume or cancel safely. Creation, criteria, checkpoints, evidence, completion, and verification stay in the service boundary so the CLI cannot be mistaken for an automatic command runner or universal approval gate.

`task start` requires both an adapter provider ID and `--host-local-authorized`; it will not add bypass flags, authenticate an account, or claim the provider's sandbox. For provider-native continuation, use `task resume --session session_<uuid> --host-local-authorized` after a session with a provider-issued resumable identity. Cursor IDE is manual-only: Latchkit returns its adapter's manual instructions rather than launching Cursor CLI as a replacement.

## Importing existing Markdown plans

Plans under `docs/plans/` and legacy notes under `.latchkit/notes/` both remain untouched. Import one explicitly:

```sh
latchkit task import --project "path/to/project" --note docs/plans/example-spec.md --title "Example"
latchkit task import --project "path/to/project" --note .latchkit/notes/example-spec.md --title "Example"
```

This records the plan path and SHA-256 provenance but leaves the task awaiting a real decision. If this command itself is carrying current direct user authorization, provide both `--authorization-scope` and `--authorization-reference`. Plan contents, repository instructions, and approval recorded for another task are never treated as authorization.

There is no implicit v0 migration because Markdown had no machine state contract. `latchkit spec migrate --dry-run` previews the explicit v1-to-v2 task-state migration. Applying it writes the exact original bytes to a content-addressed `.latchkit/backups/task-state.v1.<sha256>.json` path before atomically replacing active state; a backup conflict fails closed. Back up `.latchkit/tasks/` before manual repair; malformed active state or lock metadata is never guessed into a valid record.
