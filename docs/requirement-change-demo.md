# Requirement-change demo: "all orders" narrows to "only orders visible to this user"

This is the runnable local demo for issue [#116](https://github.com/willahealm/latchkit/issues/116), built on the exact scenario the [#109 epic](https://github.com/willahealm/latchkit/issues/109) describes: an order-export feature ships against "export all orders," then the requirement changes to "export only orders visible to the current user." **This increment ships the baseline half of that demo, honestly.** The second half — the intent/reconciliation flow from [#110](https://github.com/willahealm/latchkit/issues/110)–[#112](https://github.com/willahealm/latchkit/issues/112) — is not merged yet, and this guide does not pretend otherwise.

## Run it

One command, Windows-compatible, offline:

```sh
npm run evaluate:requirement-change -- --output .latchkit/requirement-change-evaluation.json
npm run evaluate:requirement-change -- --format markdown
```

This runs both fixtures under `test/fixtures/skill-evaluations/requirement-change/`, including `export-visibility` (this demo's scenario). See [requirement-change-evaluations.md](requirement-change-evaluations.md) for the full contract, metric definitions, and correctness gate. A sanitized transcript of an actual run is retained at [verification/requirement-change-evaluation-2026-09-06.md](verification/requirement-change-evaluation-2026-09-06.md); every claim below links to a field in that run's output, not to a hand-written example.

## What #109's demo asks for, and what is runnable today

| Demo element | Status in this increment | Where it shows up |
| --- | --- | --- |
| **Decision delta** | Runnable today | The workspace's `requirement.md` changes from "Export every order in the system to CSV." to the scenario's `changedRequirement`, and `memory.json`'s `decision-export-scope` record gains a `supersededBy` note pointing at the change. The scenario result's `arms.baseline.metrics` entry `staleResultAcceptance` confirms the change log's applied-requirement text matches the declared new requirement; `misleading-decision-superseded` in `arms.baseline.acceptance` confirms the old decision was marked superseded rather than left standing. |
| **Flagged query/criteria** | Runnable today | The shared `src/orderAccess.js` helper is seeded as a dependency with unknown impact (it is also used, outside this fixture, by an admin report the change should not silently affect). The scripted controller flags it rather than resolving it; `arms.baseline.flaggedDependencies` and `arms.baseline.correctnessGate.uncertain` both report it, worded as still unresolved and unreviewed — never coerced into "affected" or "safe." |
| **Retained CSV formatting work** | Runnable today | `src/csvFormat.js` is the scenario's `preserveArtifacts` entry. `arms.baseline.metrics` entry `retainedWork` reports it byte-identical after the change; the gate's `silently-lost-work` rule (see [the gate definition](requirement-change-evaluations.md#the-deterministic-correctness-gate)) would fail the run if it had changed without being declared. |
| **Delivered resume context** | **Not available in this increment** | A bounded, current-intent resume brief is [#112](https://github.com/willahealm/latchkit/issues/112)'s deliverable. Nothing in this harness fabricates one; there is no field for it in today's result. |
| **Final executable behavior check** | Runnable today | `acceptance.mjs` calls the workspace's actual `exportOrdersToCsv` with sample orders and asserts only orders visible to the current user appear, independently of what the "before" implementation happened to do. `arms.baseline.acceptance` reports `total`/`passed`/`failedIds`; `arms.baseline.correctnessGate.passed` is the zero-tolerance summary. |

## The second arm

Every scenario result also carries `arms.reconciliation`, and it is always `{ "status": "unavailable", "reason": "..." }` naming #110, #111, and #112 explicitly — never a stubbed or fabricated result. That is what lets this demo, and the harness underneath it, run end to end today: the reconciliation arm's shape is already reserved in the schema (`schemas/skill-evaluation-result-v2.schema.json`), and filling it in is a follow-up increment's job once that flow merges, not a schema change.

## What this demo is not

It is not a live coding-agent session, and the scripted controller that plays the "engineer applying the change" role is a fixed, deterministic patch bundled with the fixture — not a model call. It is not a measured comparison against Pilot Shell, OpenSpec, Spec Kit, or TinySpec (see [the comparison matrix](spec-workflow-comparison.md) for why, and what would change that). It is not a claim about human review effort (see [the human-review study protocol](human-review-study-protocol.md), which currently has zero participants and zero runs by design). And its `totalElapsedTimeMs` metric is harness/filesystem overhead, not a productivity or cost figure.
