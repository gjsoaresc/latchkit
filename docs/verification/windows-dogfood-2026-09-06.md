# Windows dogfood candidate — 2026-09-06

Candidate `1.0.0-dogfood.20260906.3` was built from clean commit
`d6ee85d8aff58c3159aaaca2b5aa7c83f8dcc509` and installed on Windows 11 Pro x64,
build `10.0.26200`, with private Node `24.20.0`. The ZIP SHA-256 is
`12a057584630b30b8188c70280b3727d28a8bc96635c4d4f77a1a43dd83794c8`.
This is a development candidate, not a published or fully qualified release.

The user-local launcher is `%USERPROFILE%/.local/share/latchkit/bin/latchkit.ps1`.
The earlier `1.0.0` and `1.0.0-dogfood.20260906.1` installations remain available for explicit rollback. The
installed candidate ran `doctor`, synced the repository's Claude/Codex skills,
and served the React console with actual local task and usage state. A bounded
Claude Haiku session through the earlier installed task controller supplied a
proposed installer repair; provider edit permissions refused mutation. The
orchestrator implemented and tested that repair. This observation does not
establish a completed autonomous delivery workflow.

## Delivered behavior

- React console, local shadcn components, original layout tokens, and
  light/dark/system themes. The production JavaScript is 359,592 bytes.
  Full notices for 43 bundled dependencies and their SBOM entries ship with it.
- Durable synchronization batches independent filesystem work while draining
  failed writes before rollback. Windows activation retries only known transient
  rename failures and retains the prior active version on failure.
- Shared durable state writes retry bounded Windows sharing failures, preserve
  original files, and reject substituted junctions. Server close callbacks drain
  admitted requests and owned workflows. Schedule edits preserve canonical targets.
- Opt-in local usage inspection/import/export/retention/deletion and UI controls.
  Direct tasks, workflow phases and independent reviewers record observations;
  disabled collection adds no workflow probes or usage writes.
  Missing counters and actual billing stay unknown. Recorded public list-price
  observations do not establish subscription cost or savings.
- Immutable Git pack materialization, explicit foreground schedules with durable
  tasks and cancellation, and a bounded initial Claude project MCP integration.
- Exact-version Antigravity invocation/resume handling; live verification and
  lifecycle-hook implementation remain separate work.
- FCC 5.22.8 installed in a private home-local Python environment. Its owned
  controller, authenticated inference endpoint and six Admin assets were checked.
  The console exposes start/stop/refresh and the separate Admin interface.
  Child connection settings replace inherited Anthropic credentials and preserve
  provider permissions. No NIM inference has been performed.
- Local Windows release preparation stages the matching `install.ps1` automatically
  and refuses conflicting existing bootstrap files before building.

## Executed qualification

Source dependencies were installed with `npm ci` (npm `11.19.0`, development Node
`26.8.1`); npm reported zero vulnerabilities. `npm run check` passed. The candidate
was built with `node scripts/build.js --clean` under private Node `24.20.0`.

The final full compiled suite on local Node `22.23.2` had **332 passed, zero
failed, eight explicit skips**: four file-symlink capability skips and four opt-in
FCC tests. The four pinned/live FCC tests separately passed on Node `24.20.0`,
including a real bounded child receiving the intended environment. They perform no inference.

Both GitHub Windows CI runs for the exact candidate commit passed:
[push](https://github.com/willahealm/latchkit/actions/runs/34042670320) and
[pull request](https://github.com/willahealm/latchkit/actions/runs/34042672068).
Their Node `24.20.0` suite had **336 passed, zero failed, four opt-in FCC skips**.
The required file-link artifact smoke was actually exercised. All **14 Chromium
tests** passed locally and in CI. These are executed Windows checks, not claims
about other operating systems.

```powershell
npm ci
npm run check
node --test --test-timeout=120000 test/*.test.js test/providers/*.test.js test/providers/e2e/*.test.js
npm run smoke:artifact
node scripts/release-artifacts.js --version 1.0.0-dogfood.20260906.3 --target win32-x64 --output release-artifacts-dogfood3
node scripts/bundle-smoke.js --directory release-artifacts-dogfood3 --previous-directory release-artifacts-dogfood
```

Native bundle smoke passed with system Node/npm absent from PATH: CLI, UI/API,
hooks, stable hook dispatch, paths containing spaces/Unicode, installation,
failed-upgrade preservation, exact prior-archive upgrade/rollback, and uninstall
retention. The prior ZIP SHA-256 was
`76639da0cc748eefdba4db7e7ce03121fcc8427559258ddc9efac486fa1177a9`.
The installed console also passed a Chromium check using its actual local usage
records, FCC status and dark theme, with no browser page errors.

The first Luna/medium workflow qualification reached requirements and planning,
then stopped before implementation at the plan comparison. Offline reproduction
found that an optional `fixture: undefined` property disappears during JSON
persistence. The harness now compares the exact persisted JSON contract while
retaining all serialized values, array order and scope checks. Failure evidence
is retained separately from subsequent attempts. Time/output limits are not
monetary spending caps.

Early Windows CI exposed sharing errors, a scheduler path spelling mismatch,
and asynchronous handlers surviving transport closure. Regression tests and the
final CI runs cover the repairs. A duplicate CI run was cancelled after a scheduler
test hung: its held fake runner ignored cancellation if startup assertions failed.
The fake runners now drain on cancellation, cleanup covers startup failures, and
test/job deadlines bound future failures.

## Real workflow and self-hosting

The final archive passed a real six-phase workflow in **113.19 seconds**, using
Codex CLI `0.153.2` with explicit `gpt-5.6-luna` and medium reasoning. Requirements,
plan, implementation, verification, independent review and handoff all passed.
Approval bound the exact persisted plan/check digests; the original Git commit,
requirements and tests stayed unchanged, with only the approved implementation
file modified. The policy digest matched the packaged implementation.

Opted-in accounting recorded all **five inference sessions** separately from
**five version probes** and **one acceptance command**. Known counters were
265,717 input tokens, including 212,224 cached input, 3,100 output and 1,016
thinking tokens. Cache creation was unavailable; price and actual billing remain
unknown. These counts do not establish monetary cost or savings.

```powershell
node scripts/live-workflow-evidence.js --authorized --provider codex --model gpt-5.6-luna --reasoning-effort medium --collect-usage --artifact <candidate-3.zip> --artifact-sha256 12a057584630b30b8188c70280b3727d28a8bc96635c4d4f77a1a43dd83794c8 --output <evidence.json>
```

The installed earlier candidate ran one bounded Luna/low session against Latchkit's
own repository to repair bootstrap staging: **73.96 seconds**, 255,816 input
tokens including 226,304 cached, and 2,313 output tokens. The provider edited the
release script and its tests. Review caught missing-directory/default-target
defects and corrected them locally; no second inference was run. The reviewed
change is included in this candidate and was exercised by its actual archive build.
The direct task controller left that session's task blocked pending verification;
its evidence does not label that task verified. Earlier candidate workflow attempts
are retained separately.

## Installed performance

The same synthetic workloads were repeated against the installed candidate and
its private Node after verifying its manifest and executable/application receipts.
There was no deliberate disk contention; the local consoles and FCC were idle.
This is one machine with small sample counts, not a hardware guarantee.

| Operation                    | Runs |      Median |         P95 |
| ---------------------------- | ---: | ----------: | ----------: |
| Fresh CLI startup            |    7 |    35.30 ms |    35.59 ms |
| Initial 1,000-file pack sync |    3 | 2,631.85 ms | 2,652.83 ms |
| Search 10,000 memory records |    3 |    31.06 ms |    34.62 ms |
| Diff of 300 changed files    |    3 |   503.62 ms |   523.14 ms |

Earlier same-host synchronization measurements improved from 5,209.85 ms to
2,622.58 ms after batching, approximately 49.7%. The installed result is consistent
with that improvement. The observed bottleneck is durable filesystem work;
these measurements do not justify moving the application to Go or Rust.
Representative repositories, deliberate disk contention, broader CPU traces and memory
budgets should precede any native-worker decision. The cumulative peak RSS was
about 239 MiB including fixture construction, not a steady-state memory budget.
Provider execution is a separate, much longer part of the observed workflow.

A separate V8 main-thread profile covered the complete diagnostic benchmark,
including setup and cleanup. Of sampled elapsed time, **77.588% was idle**,
9.291% was attributed to filesystem frames, 3.294% to process launch and 2.003%
to Latchkit application frames. These are not whole-system CPU percentages.
The capture excludes child Git/CLI CPU, kernel work and libuv worker threads,
and has no phase markers. It supports investigating file metadata and process
overhead, without establishing which work accounts for each idle sample. The
sanitized [profile interpretation](../../.github/release-evidence/windows-dogfood/cpu-profile-candidate-3.json)
retains these limits and the raw diagnostic's digest; private paths are omitted.

## Evidence and remaining scope

Sanitized records are in
[`windows-dogfood`](../../.github/release-evidence/windows-dogfood/): installed
benchmarks, bundle smoke, browser verification, Claude observation and separate
Codex workflow attempts. FCC's exact upstream contract and lifecycle evidence is
in [its verification record](fcc-lifecycle-2026-09-06.md).

NIM inference remains unverified. The unsaved Notepad key was visible behind a
Windows security prompt, but local OCR did not recover the exact key format.
No credential was sent, no Admin configuration changed and no NIM inference ran.
The existing key must be saved accurately in the private local key file or entered
into FCC's private profile. No replacement API key is required by the integration.

Open feature scope remains explicit: MCP serializers for other providers,
enforced MCP tool allowlists and installed-provider version qualification;
scheduler notification UI and unattended provider qualification; Antigravity
hooks; FCC attachment/upgrades; enhanced specification/TDD enrollment, Ollama,
RTK and budgeted background reviewers from issue #86. Other operating systems
remain deferred. These remaining items are not represented as completed by this
Windows milestone.
