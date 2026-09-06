# Local usage observations

Usage is opt-in for each project. Enable it before starting the sessions you want to observe:

```powershell
latchkit usage enable
latchkit usage inspect
latchkit usage export
latchkit usage disable
```

The console's Usage view reads the same `.latchkit/usage/state-v1.json` ledger. Direct task sessions, scheduled tasks, workflow inference phases, and independent reviewers feed that ledger for supported Claude and Codex result formats. Existing sessions and transcripts are not scanned automatically. Turning observation off prevents subsequent writes; retained records remain until explicit deletion or retention cleanup.

Workflow and review observation runs a bounded `--version` command only after local execution authorization and only while usage is enabled. The probe uses the invocation's executable, working directory, environment mode, and cancellation signal. It has a maximum five-second timeout and 4 KiB output cap. Probes never count as inference, and no prompt is sent with them. The workflow reviewer wrapper recognizes only an exact bounded version command; inference retains its read-only permission checks. Unknown or failed version evidence yields unavailable counts rather than an invented provider version. Disabled observation adds neither a version probe nor a usage-file write.

Each workflow phase uses its persisted action ID, and each reviewer uses its persisted assignment ID, as the observation identity. Reviewer counts are written to the source project's ledger and attributed to the parent task, even when the reviewer executes in a separate worktree. Workflow-level review delegation does not record the same reviewer twice. When the provider supplies a documented session/thread identity, it is retained separately. Replaying an observation with the same identity replaces the prior record rather than adding its counts again, including unavailable observations from older versions of this ledger.

Observation happens as soon as the inference process returns, before workflow or review output validation. A failed exit, cancelled run, or malformed business result can therefore still contribute reported usage. A cancellation during the version probe launches no inference and creates no inference record. Usage parsing/storage failures remain advisory; they cannot approve a workflow, suppress provider failure, or change provider permissions. The usage ledger stores normalized counts and provenance, not prompts, transcripts or environment values. FCC calls retain the explicit replacement environment selected for their existing runner.

Measured tokens are not proof of billing. Missing fields remain unknown, and a mixed or incomplete total is not displayed as zero. Actual subscription charges remain unknown. Monetary estimates require explicit public API pricing provenance; automatically observed token counts do not manufacture a rate or treat a provider's reported list price as the user's bill. This is local diagnostic evidence, not invoice reconciliation or full account-wide usage tracking.

The workflow and reviewer changes alter the workflow policy artifact digest. Complete or stop an existing workflow under its original installed runtime; a workflow recorded with an older policy cannot silently resume under the new one.

Validation uses injected, credential-free provider result fixtures. It covers workflow phases, separate reviewer workspaces, failures, disabled observation, version uncertainty, cancellation, replay, and FCC environment propagation. Those fixtures do not establish real-provider or other-platform qualification.

## Usage overview: totals, trends, and coverage

The console's Usage view also renders an "Understand each session." overview built from the same ledger. `src/usage/aggregate.ts` is a pure function (`aggregateUsage`) that groups already-collected `UsageRecord`s by date (UTC day), project, provider, and model, and returns, for every group: record counts by status (measured/partial/unavailable), the strict `tokens` total (a field stays `null` if any contributing record has an unknown count for it, matching `inspectUsage`'s existing convention), the `knownTokens` sum that ignores unknowns, an `estimatedUsd` total that is only populated when every record in the group carries a priced estimate, a separate `knownEstimatedUsd` for partial visibility, and `recordIds` for drill-down back to the underlying sessions. Nothing is ever presented as zero usage; a group with unknown data reports `null`/`priceMissingCount`, not `0`.

`src/usage/overview-service.ts` (`inspectUsageOverview`) composes this with the existing `readUsageState` and applies the same per-project retention cutoff `service.ts` uses, then filters by an optional `from`/`to` ISO range. It accepts a list of project roots rather than one fixed root: only the current project is wired into `GET /api/usage/overview` today (via `src/server.ts`), but the aggregation itself is ready for the multi-project registry that issue #94 adds — a future caller can pass every registered project's root and the totals, trends, `byProject` breakdown, and drill-down all work unchanged.

Coordinator/worker/planning/verification/tool-model overhead is surfaced as a `byRole` breakdown, but the current usage record format does not yet capture which role or phase produced an invocation (a workflow's coordinator phases and its independent reviewers are both attributed to the same task ID today). Rather than omitting that breakdown, `byRole` reports every in-scope record under an explicit `unknown` role with a note explaining that role attribution is not yet measured. This is deliberately visible-but-empty rather than silently absent, and is the extension point for the parallel workflow/reviewer usage-observation work to populate once it records a role or phase on each invocation.

Actual provider billing remains `{ status: 'unknown' }` in the overview response, exactly as in `inspectUsage`; no aggregation here infers or fabricates account-wide billing or provider limits.

## Savings baselines and comparison

A savings baseline is a separate, explicit, user-entered record — not something Latchkit infers. `src/usage/baseline-contracts.ts` defines its shape and `src/usage/baseline-service.ts` provides CRUD, stored at `.latchkit/usage/baselines-v1.json` (its own file and schema, independent of and additive to the usage ledger). Every baseline records:

- `kind`: `paired` (a controlled comparison against a specific manual/alternate run, scoped by explicit task IDs) or `historical` (a broader estimate, typically scoped by a comparison period).
- `source`: free text describing where the baseline number came from.
- `scope`: a comparison period (`from`/`to`), a list of task IDs, or both, plus a required human-readable description. A baseline must declare at least a period or a task scope — an unscoped baseline is rejected.
- `providerSettings`: the provider/model the baseline assumes, so the comparison's settings are visible even when they differ from what actually ran.
- `units`: `usd` or `tokens` (with a `tokenField` selecting which token dimension — `input`, `output`, `cacheRead`, `cacheCreation`, `thinking`, or `total`).
- `assumptions`: required free text describing the methodology.
- `pricing`: optional structured provenance (source URL, version/date) for baselines derived from published pricing; a baseline that is itself a recorded ground-truth number (an invoice, a timed manual run) does not require it, but `source` and `assumptions` are always required either way.

`src/usage/savings.ts` (`computeSavings`) compares a baseline against the matching in-scope usage records and never invents a number. It returns one of:

- `missing-baseline` — no baseline was selected, or the requested ID does not exist.
- `incomplete-comparison` — no usage matched the baseline's scope, or every matched record is `unavailable` (missing usage is never reported as zero), or (for a token-unit baseline) the chosen token field is unknown on some matched records.
- `missing-prices` — a monetary baseline matched records that are not fully priced; the response still exposes `knownActualAmount` for transparency but does not present it as the complete answer.
- `zero-denominator` — the baseline amount is `0`, so a percentage difference is undefined; the actual usage is still reported, with an explanation instead of an invented or infinite percentage.
- `ok` — `absoluteDifference` (baseline minus actual; positive means savings) and `percentDifference`, plus a `direction` of `savings`, `loss`, or `unchanged`, and the originating baseline's `kind` so paired controlled comparisons stay visually separated from historical estimates.

`GET /api/usage/baselines`, `POST /api/usage/baselines`, `PUT /api/usage/baselines/:id`, `DELETE /api/usage/baselines/:id`, `GET /api/usage/baselines/export`, and `GET /api/usage/savings?baselineId=…` expose this additively alongside the existing `/api/usage*` routes; none of the existing usage endpoints changed shape. `usage/baselines/export` mirrors `usage/export`'s normalized-input contract so a savings comparison can be reproduced offline from the two exports together.

Unit tests in `test/usage-aggregate.test.js` and `test/usage-savings.test.js` cover multi-project aggregation, date-range filtering, mixed measured/partial/unavailable coverage, out-of-order corrections, zero denominators, missing baselines, missing/partial prices, an unavailable-only match, and positive/negative/zero/paired/historical outcomes with deterministic fixtures. `test/browser/usage-console.spec.js` exercises the same flow — recording usage, creating a baseline through the console, and computing savings — end to end in a real browser.
