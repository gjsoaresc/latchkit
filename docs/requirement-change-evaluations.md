# Requirement-change evaluations

This is the first foundation slice of [issue #116](https://github.com/willahealm/latchkit/issues/116), the evaluation half of the [#109 requirement-change epic](https://github.com/willahealm/latchkit/issues/109). It extends the [skill-evaluation harness](skill-evaluations.md) with a second, versioned scenario/result shape (`schemaVersion: 2`, published as [`schemas/skill-evaluation-v2.schema.json`](../schemas/skill-evaluation-v2.schema.json) and [`schemas/skill-evaluation-result-v2.schema.json`](../schemas/skill-evaluation-result-v2.schema.json)) for scenarios where a requirement changes after work has already started. The version-1 behavioral scenarios are unchanged.

Run it with:

```sh
npm run evaluate:requirement-change
npm run evaluate:requirement-change -- --format markdown
npm run evaluate:requirement-change -- --output .latchkit/requirement-change-evaluation.json
```

The command is offline by default, deterministic, and Windows-compatible: it copies each fixture into isolated temporary workspaces, runs the fixture's own bundled scripted controller, and separately seeds and reconciles task intent through the merged #110–#112 APIs. The reconciliation arm builds #112's current bounded brief from that persisted task and hands it to the next scripted-controller call. It hashes every workspace file before and after, grades the result against the correctness gate below, and removes the workspaces. It never starts a provider process or spends on a session; the handoff is not evidence that a provider received or consumed the brief. It exits non-zero if any scenario's correctness gate fails.

## What each scenario seeds

A requirement-change scenario (see `src/evaluations/contracts.ts`, `RequirementChangeScenario`) seeds, in one small original fixture:

- **A late visibility requirement change** in an export-style feature — the demo scenario from #109, `export-visibility`: "export all orders" narrows to "export only orders visible to the current user" after the naive implementation already shipped.
- **A dependency with unknown impact** (`unknownImpactDependencies`) — a shared helper also used by something outside the fixture, whose impact from the change is genuinely undecidable from the fixture alone.
- **A misleading old decision in memory** (`memoryRecords`, `misleadingAfterChange: true`) — a recorded decision that was correct under the old requirement and becomes wrong once the requirement changes.
- **An unaffected implementation component worth preserving** (`preserveArtifacts`) — code that has nothing to do with the changed requirement and must not be touched.

Two original fixtures currently exist under `test/fixtures/skill-evaluations/requirement-change/`: `export-visibility` (the #109 demo scenario) and `notification-opt-out` (a smaller, independent scenario proving the harness generalizes beyond one domain). Each fixture bundles its own `apply-change.mjs` (the deterministic scripted controller — a fixed, known-good patch, never a model call) and `acceptance.mjs` (the executable acceptance assertions). Both are authored from the scenario's requirement text, not by inspecting what the "before" implementation happens to do, so grading is not circular. The scenario index is `test/fixtures/skill-evaluations/requirement-change-scenarios.json`.

## Metric definitions and their limitations

Metrics are fixed in `REQUIREMENT_CHANGE_METRICS` (`src/evaluations/contracts.ts`) before any comparative run, per #116's acceptance criteria. Every metric result carries an explicit `availability` (`measured` or `unavailable`) — no metric is silently omitted.

| Metric | What it measures | Limitation |
| --- | --- | --- |
| `finalBehavioralSuccess` | Every mandatory acceptance assertion passed after the change. | Reflects only this fixture's seeded assertions, not general correctness. |
| `falseCompletion` | The arm claimed completion while a mandatory assertion still failed. | Only visible through the recorded change log and this run's acceptance results. |
| `staleResultAcceptance` | The change log's applied-requirement text does not match the scenario's declared new requirement. | One pre-change/post-change run only; cannot see staleness across additional intermediate runs. |
| `omittedRequiredConstraints` | Count of mandatory constraints whose assertion failed. | Bounded by the fixture author's constraint list. |
| `detectedSeededDependencies` / `missedSeededDependencies` | Seeded unknown-impact dependencies flagged vs. left unflagged. | Self-reported; a blanket flag of every file would still count as "detected". Impact itself is never resolved to affected/unaffected — it stays unknown either way. |
| `unnecessaryInvalidation` | Preserve-artifact files changed *and declared* in the change log. | A justified-but-unseeded change would still be counted. |
| `retainedWork` / `discardedWork` | Preserve-artifact files byte-identical vs. changed after the run. | Byte identity cannot distinguish a semantic rewrite from a coincidental round-trip. |
| `reworkAfterChange` | Files changed outside the seeded change targets and preserve set. | An unseeded but legitimate change is indistinguishable from unnecessary rework. |
| `totalElapsedTimeMs` | Wall-clock time for the complete arm. | Includes fixture copy, task-state work, hashing, and acceptance checks; it is not workflow latency, productivity, or cost. |
| `controllerElapsedTimeMs` | Wall-clock time for the injected controller call only. | Excludes fixture copy, reconciliation, context projection, hashing, and acceptance checks; it is not productivity or cost. |
| `coordinatorUsage` / `workerUsage` | Coordinator/worker token or session usage. | Always `unavailable`. Usage provenance and comparable baselines belong to [#32](https://github.com/willahealm/latchkit/issues/32)/[#92](https://github.com/willahealm/latchkit/issues/92); this harness supplies scenario outputs to those contracts rather than inventing a second savings ledger. |

## The deterministic correctness gate

`evaluateRequirementChangeGate` (`src/evaluations/runner.ts`) is zero-tolerance for the scripted-controller arm only, per #116 acceptance criterion 3:

1. **Dropped mandatory constraint** — a mandatory acceptance assertion failed.
2. **Silently lost work** — a `preserveArtifacts` file's hash changed and the change log does not list it in `touchedFiles`. A *declared* change to a preserve artifact is not a gate failure; it is reported through the `unnecessaryInvalidation`/`discardedWork` metrics instead, because a controller that says what it did is a different failure mode than one that hides it.
3. **Unauthorized intent promotion** — the change log does not bind an authorized (`authorized: true`) record to the scenario's exact declared new requirement text.
4. **Stale completion** — the change log claims completion (`claimsComplete: true`) while a mandatory constraint is still failing.

The gate result reports the full scenario denominator (every mandatory assertion plus every preserve artifact plus the two log-level checks, summed across scenarios), the failures, an `uncertain` list (the seeded unknown-impact dependencies, reported with whether they were flagged — never coerced into a pass/fail verdict), and `regressions` (assertions tagged `preexisting`, unrelated to the new requirement, that broke as a side effect of the change). `test/requirement-change-evaluations.test.js` proves the gate actually catches each of the four rules by injecting a deliberately broken controller for each one, in addition to proving the bundled fixtures pass cleanly.

## The two arms

Every scenario result carries two arms (`RequirementChangeScenarioResult.arms`):

- **`baseline`** — always present, `controller: "scripted"` by default in this command. It is the deterministic fixed patch described above, used to validate the harness and the correctness gate end to end offline. The same `runRequirementChangeScenario`/`runRequirementChangeSuite` functions accept an injected `applyChange`/`runAcceptance` pair, so a future increment can drive this arm with a model instead (`controller: "model"`, `provider: "<id>"`); this command does not do that, and no such run is authorized or executed here. Deterministic scripted-controller results and model-driven outcomes are never merged into the same field — the `controller` field always says which one produced a result, and only the scripted arm ever carries a `correctnessGate`.
- **`reconciliation`** — `status: "completed"` for deterministic #110–#112 integration. `reconciliationEvidence` separately records superseded authority, stale-preview rejection, explicit unknown impact, preserved work, and the digest/schema/byte count of the #112 brief handed to the next scripted-controller call. No provider result is fabricated or inferred from that local handoff.

## Honest scope of this increment

This command validates the harness mechanics — the fixtures, the gate, and the metric computation — deterministically and offline. It is **not** a claim about how a live coding agent or a human engineer actually behaves on ordinary current Latchkit today; that would require a live, authorized, opt-in run comparable to [the existing skill-evaluation `--real` flow](skill-evaluations.md), which is out of scope for this increment (see [the demo guide](requirement-change-demo.md) for exactly what is and is not runnable today). Deterministic context-byte reductions reported anywhere in this harness must never be read as token, productivity, or cost savings.
