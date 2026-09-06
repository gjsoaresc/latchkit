# Windows dogfood candidate — 2026-09-06

Candidate `1.0.0-dogfood.20260906.1` was built from clean commit
`42889f7b54db2009483d9c54d63a16b77f5b8f5c` and installed on Windows 11 Pro x64,
build `10.0.26200`, with private Node `24.20.0`. The ZIP SHA-256 is
`76639da0cc748eefdba4db7e7ce03121fcc8427559258ddc9efac486fa1177a9`.
This is a development candidate, not a published or fully qualified release.

The user-local launcher is `%USERPROFILE%/.local/share/latchkit/bin/latchkit.ps1`.
The earlier `1.0.0` installation remains available for explicit rollback. The
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
- Opt-in local usage inspection/import/export/retention/deletion and UI controls.
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

## Executed qualification

Source dependencies were installed with `npm ci` (npm `11.19.0`, development Node
`26.8.1`); npm reported zero vulnerabilities. `npm run check` passed. The candidate
was built with `node scripts/build.js --clean` under private Node `24.20.0`.

The full compiled suite at the candidate commit ran with Node `24.20.0` and
`22.23.2`: **289 passed, zero failed, seven explicit skips** on each runtime.
Three skips require unavailable file-symlink capability; four require explicit
FCC fixtures. Separately enabling the pinned archive, installed root and live
FCC fixtures ran those four tests: **four passed**, including a real bounded
child process receiving the intended environment. That test performs no inference.

```powershell
npm ci
npm run check
node --test test/*.test.js test/providers/*.test.js test/providers/e2e/*.test.js
node scripts/release-artifacts.js --version 1.0.0-dogfood.20260906.1 --target win32-x64 --output release-artifacts-dogfood
# Place the matching install.ps1 beside both archives before smoke testing.
node scripts/bundle-smoke.js --directory release-artifacts-dogfood --previous-directory <prior-1.0.0-directory>
```

Native bundle smoke passed with system Node/npm absent from PATH: CLI, UI/API,
hooks, stable hook dispatch, paths containing spaces/Unicode, installation,
failed-upgrade preservation, exact prior-archive upgrade/rollback, and uninstall
retention. The prior ZIP SHA-256 was
`4246492eb9b52c9900a9d9efd67a32f27dc163550784676d0c9b9c4ab55de955`.
The installed console also passed a Chromium check using its actual local usage
records, FCC status and dark theme, with no browser page errors.

The first Luna/medium workflow qualification reached requirements and planning,
then stopped before implementation at the plan comparison. Offline reproduction
found that an optional `fixture: undefined` property disappears during JSON
persistence. The harness now compares the exact persisted JSON contract while
retaining all serialized values, array order and scope checks. Failure evidence
is retained separately from subsequent attempts. Time/output limits are not
monetary spending caps.

## Installed performance

The same synthetic workloads were repeated against the installed candidate and
its private Node after verifying its manifest and executable/application receipts.
There was no deliberate disk contention; the local consoles and FCC were idle.
This is one machine with small sample counts, not a hardware guarantee.

| Operation | Runs | Median | P95 |
| --- | ---: | ---: | ---: |
| Fresh CLI startup | 7 | 34.74 ms | 35.51 ms |
| Initial 1,000-file pack sync | 3 | 2,688.56 ms | 2,757.30 ms |
| Search 10,000 memory records | 3 | 32.56 ms | 34.86 ms |
| Diff of 300 changed files | 3 | 535.58 ms | 560.23 ms |

Earlier same-host synchronization measurements improved from 5,209.85 ms to
2,622.58 ms after batching, approximately 49.7%. The installed result is consistent
with that improvement. The observed bottleneck is durable filesystem work;
these measurements do not justify moving the application to Go or Rust.
Representative repositories, deliberate disk contention, CPU traces and memory
budgets should precede any native-worker decision.

## Evidence and remaining scope

Sanitized records are in
[`windows-dogfood`](../../.github/release-evidence/windows-dogfood/): installed
benchmarks, bundle smoke, browser verification, Claude observation and separate
Codex workflow attempts. FCC's exact upstream contract and lifecycle evidence is
in [its verification record](fcc-lifecycle-2026-09-06.md).

Windows CI must independently execute the required file-symlink checks. A full
successful real-provider workflow and NIM inference still require their own
observed evidence; fixtures cannot establish them. NIM needs the user's existing
key entered into FCC's private profile. No other API key has been requested.

Open feature scope remains explicit: MCP serializers for other providers,
enforced MCP tool allowlists and installed-provider version qualification;
scheduler notification UI and unattended provider qualification; Antigravity
hooks; FCC attachment/upgrades; enhanced specification/TDD enrollment, Ollama,
RTK and budgeted background reviewers from issue #86. Other operating systems
remain deferred. These remaining items are not represented as completed by this
Windows milestone.
