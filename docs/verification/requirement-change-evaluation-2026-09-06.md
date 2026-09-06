# Requirement-change evaluation — first offline run, 2026-09-06

This is the sanitized transcript the [demo guide](../requirement-change-demo.md) and [requirement-change-evaluations.md](../requirement-change-evaluations.md) link to. It records one actual execution of the issue [#116](https://github.com/willahealm/latchkit/issues/116) offline harness on this branch, on native Windows 11 x64, with development Node `v26.8.1` and npm `11.19.0`. `npm ci` reported zero vulnerabilities.

Commands run, in order:

```sh
npm run build
node scripts/requirement-change-evaluations.js --output .latchkit/requirement-change-evaluation.json
node scripts/requirement-change-evaluations.js --format markdown
```

Both exited `0`.

## Result summary

From the retained `.latchkit/requirement-change-evaluation.json` (not committed; `.latchkit/` is git-ignored local state) and the markdown rendering:

- `schemaVersion`: `2`.
- Scenario denominator: **16** correctness-gate checks across **2** scenarios (8 each: 5 mandatory acceptance assertions + 1 preserve-artifact check + the unauthorized-intent-promotion check + the stale-completion check).
- Baseline arms completed: **2**; unavailable: **0**.
- Both scenarios' scripted-controller correctness gate: **passed**, zero failures, zero regressions.
- `export-visibility` gate `uncertain`: `"order-access (src/orderAccess.js): impact intentionally seeded as unknown; flagged for review."` — the seeded unknown-impact dependency was flagged, and the harness still reports it as unresolved rather than coercing it into a pass.
- `notification-opt-out` gate `uncertain`: `"digest-sender (src/digestSender.js): impact intentionally seeded as unknown; flagged for review."`
- Reconciliation arm for both scenarios: `status: "completed"` using the merged #110/#111 task-record and reconciliation APIs. Each records accepted-intent supersession, stale-preview rejection, explicit unknown impact, and preserved artifacts; only `resumeContext` is `unavailable` pending #112.
- `arms.baseline.acceptance`: `{ "total": 5, "passed": 5, "failedIds": [] }` for both scenarios.
- `arms.baseline.metrics` for both scenarios: `finalBehavioralSuccess: true`, `falseCompletion: false`, `staleResultAcceptance: false`, `omittedRequiredConstraints: 0`, `detectedSeededDependencies: 1`, `missedSeededDependencies: 0`, `unnecessaryInvalidation: 0`, `retainedWork: 1`, `discardedWork: 0`, `reworkAfterChange: 0`; `coordinatorUsage`/`workerUsage` both `unavailable` (owned by [#32](https://github.com/willahealm/latchkit/issues/32)/[#92](https://github.com/willahealm/latchkit/issues/92), not computed here).

## Automated regression coverage

`test/requirement-change-evaluations.test.js` (14 tests, run via `npm test`) additionally proves the correctness gate actually rejects each of its four zero-tolerance rules — dropped mandatory constraint, stale completion, unauthorized intent promotion, and silently lost work — by injecting a deliberately broken scripted controller for each one, and proves a declared (non-silent) preserve-artifact change and a missed unknown-impact dependency affect only metrics, never the gate.

## Limitations

This run exercises deterministic scripted controllers, including the separate #110/#111 reconciliation integration; it is not a model or human session. It validates the harness, fixtures, correctness gate, and task-state API boundary end to end offline; it is not a claim about live-agent or human behavior on ordinary current Latchkit, and `totalElapsedTimeMs` is harness/filesystem overhead, not a productivity or cost figure. #112 resume context remains unmeasured. No participant or provider session was used to produce this evidence.
