# FCC/NIM code-edit workflow qualification — 2026-09-06

Issue #105 requested one bounded installed Windows workflow through the managed
FCC/NVIDIA NIM bridge: a code edit, test, independent review and handoff. This
attempt did **not** qualify that path.

The tested installed artifact was Latchkit `1.0.0-dogfood.20260906.3`, commit
`d6ee85d8aff58c3159aaaca2b5aa7c83f8dcc509`, with its recorded FCC `5.22.8`
pin `c9b75088b09cbd3251d1e828b710cfdcd1ff3c5a`. The child-only bridge checked
its owned authenticated endpoint and observed the configured route
`nvidia_nim/nvidia/nemotron-3-super-120b-a12b`. No credential, token, private
profile path or provider transcript is retained here.

Before the live attempt, the installed process runner and task controller passed
a deterministic disposable-fixture prerequisite under Node `22.23.2`: a
100 ms owned-child timeout, an abort-driven cancellation, and controller
cancellation during partial work. The final task and session were both
`cancelled`; cancellation did not become success or verification.

The one live fixture used an immutable independently specified failing
`multiply` test and permitted only `src/calculator.js` to change. Limits were
120 seconds per provider phase, eight minutes total, 1 MiB output per phase,
eight Claude turns, concurrency one, zero client retries and no model fallback.
The requested Claude alias was `haiku`; FCC's inspected route above remained
the only configured route. Normal provider permissions were retained. The
fixture's independent failing test ran before dispatch.

The live workflow reached the owned authenticated bridge, but it did not reach
the exact-plan approval checkpoint: the controller reported `PLAN_NOT_READY`.
The run was not retried, no alternative model or provider was selected, and the
implementation, acceptance test after an edit, independent review and handoff
therefore did not run. This report does not claim that the synthetic defect was
fixed or that any provider exit/prose establishes acceptance.

The first harness revision retained only that sanitized checkpoint status, so
the completed phase was not preserved. Consequently the historical attempt
cannot distinguish a provider permission refusal, malformed workflow JSON,
`needs-input`, a failed plan, or plan-check validation; no raw transcript was
retained to reconstruct it. This is a harness-observability gap, not evidence
of a product parsing defect. The committed harness now records only the phase,
action statuses, and digests before it makes the checkpoint decision, allowing
a future separately authorized attempt to classify the same failure without
recording provider output.

## Second bounded attempt

After replacing the harnesses with strict TypeScript and adding a credential-free
classification regression, one additional attempt used the identical installed
artifact, model route, limits, and provider settings. It was blocked in the
read-only **requirements** phase. The sanitized result records one error action
and classifies the provider result as `provider-permission-or-auth-refusal`.
The private fixture and a sanitized status record were retained for review; raw
provider output was not published.

This is evidence that the bridge's owned controller endpoint was reachable, not
proof of upstream authentication. It does not establish a product parsing bug:
the normal provider permission/auth boundary stopped the workflow before an
implementation phase. No third attempt, alternate model, fallback, global
configuration change, code edit, post-edit test, review, or handoff occurred.

The local evidence records `billing: unknown`. FCC may make upstream retries,
so the zero client-retry setting and per-phase limits are not aggregate upstream
or monetary spending limits. The qualification does not establish broader
autonomous-worker support, a portable-skill workflow (issue #103 remains a
separate prerequisite), other models, or another platform.

## Reproduction

Use a disposable checkout and set the two environment variables to the exact
installed app directory and a protected local output path. Then run, under a
Node 22+ runtime:

```powershell
$env:LATCHKIT_QUALIFICATION_APP = '<installed-artifact>/app'
npm run build
node dist/scripts/qualify-fcc-nim-deterministic.js
$env:LATCHKIT_QUALIFICATION_OUTPUT = '<protected-output>.json'
node dist/scripts/qualify-fcc-nim-live.js
```

Run `npm run build` first, then invoke the emitted `.js` scripts. The live
qualification deliberately requires the operator to supply the
installed app and output paths. It does not configure FCC, restart it, read
credentials, or use global provider settings. Its output is a protected local
diagnostic artifact, not public release evidence.
