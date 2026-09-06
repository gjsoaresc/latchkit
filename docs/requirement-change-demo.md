# Requirement-change demo: "all orders" narrows to "only orders visible to this user"

This is the runnable local demo for issue [#116](https://github.com/willahealm/latchkit/issues/116), built on the exact scenario the [#109 epic](https://github.com/willahealm/latchkit/issues/109) describes: an order-export feature ships against "export all orders," then the requirement changes to "export only orders visible to the current user." It exercises merged #110–#112 intent, reconciliation, and context-brief APIs offline.

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
| **Delivered resume context** | Runnable today, offline | The reconciliation arm builds #112's real bounded context brief from the persisted reconciled task and passes it to its next scripted-controller call. `arms.reconciliation.reconciliationEvidence.resumeContext` records its digest, schema version, byte count, next action, and `scripted-controller-handoff` delivery mode. This proves the local handoff only: no provider is launched, and it does not claim provider receipt or consumption. |
| **Final executable behavior check** | Runnable today | `acceptance.mjs` calls the workspace's actual `exportOrdersToCsv` with sample orders and asserts only orders visible to the current user appear, independently of what the "before" implementation happened to do. `arms.baseline.acceptance` reports `total`/`passed`/`failedIds`; `arms.baseline.correctnessGate.passed` is the zero-tolerance summary. |

## The reconciliation arm

`arms.reconciliation` runs in a separate copied workspace and uses the merged task-record, reconciliation, and context-brief APIs. It proves the stale preview digest is rejected before applying the reviewed patch, preserves the CSV formatter byte-for-byte, retains unknown impact as explicit, and hands the resulting bounded brief to the next scripted-controller call. The code patch is still deterministic, so this is API integration evidence, not a model or human comparison.

## What this demo is not

It is not a live coding-agent session, and the scripted controller that plays the "engineer applying the change" role is a fixed, deterministic patch bundled with the fixture — not a model call. It is not a measured comparison against Pilot Shell, OpenSpec, Spec Kit, or TinySpec (see [the comparison matrix](spec-workflow-comparison.md) for why, and what would change that). It is not a claim about human review effort (see [the human-review study protocol](human-review-study-protocol.md), which currently has zero participants and zero runs by design). And its `totalElapsedTimeMs` metric is harness/filesystem overhead, not a productivity or cost figure.
