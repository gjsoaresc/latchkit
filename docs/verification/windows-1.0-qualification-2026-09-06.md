# Windows 1.0 release qualification — 2026-09-06

This is the qualification pass for issue #104 ("Qualify and publish the final
Windows 1.0 release archive"). It prepares and qualifies the exact Windows
11 x64 archive a maintainer would publish; it does **not** publish anything.
Publication and the live Codex delivery-workflow session are reserved for the
repository owner and were intentionally not run (see
[What was skipped and why](#what-was-skipped-and-why)).

## Candidate identity

| Field | Value |
| --- | --- |
| Source commit | `08dd962e25e34343e657b3ca9a36fc0efdd30e07` (tip of `origin/main` at the start of this qualification) |
| Version | `1.0.0` |
| Target | `win32-x64` |
| Archive | `latchkit-1.0.0-win32-x64.zip` |
| Archive SHA-256 | `a15711c188593b5b4df2e742a76debcb472f34c38e5c29ea8f3ae26f1b24f17b` |
| Bundled Node runtime | `v24.20.0` (private, embedded; not the development host's Node) |
| Source tree state at build | clean, `dirty: false` in the embedded manifest |
| Development host | Windows 11 Pro `10.0.26200`, Node `v26.8.1`, npm `11.19.0` |

The archive itself lives outside git under the worktree's ignored
`release-artifacts/` directory (already covered by `.gitignore`); it is not
committed. Only its checksum, manifest, SPDX SBOM, and sanitized qualification
records are tracked, under `.github/release-evidence/1.0.0/`.

### Prior-version archive for upgrade/rollback qualification

The exact bytes of the immediately preceding Windows candidate,
`1.0.0-dogfood.20260906.3` (built from commit
`d6ee85d8aff58c3159aaaca2b5aa7c83f8dcc509`, documented in
[windows-dogfood-2026-09-06.md](windows-dogfood-2026-09-06.md)), were located
on this machine at
`C:/Users/gjsoa/Code/latchkit-windows-candidate/release-artifacts-dogfood3/latchkit-1.0.0-dogfood.20260906.3-win32-x64.zip`
together with its `.sha256`, `.manifest.json`, and `.spdx.json` sidecars. Its
SHA-256 was independently recomputed and matches the issue-stated and
sidecar-recorded digest exactly:
`12a057584630b30b8188c70280b3727d28a8bc96635c4d4f77a1a43dd83794c8`. These
exact bytes (not a rebuild) were used for every upgrade/rollback check below
and copied into `release-artifacts/previous/` for the publication verifier.

## Executed qualification

All commands below were run from the repository root on the host described
above, from clean, committed source at the candidate commit.

```powershell
npm ci --ignore-scripts
```
179 packages installed, 0 vulnerabilities.

```powershell
npm run check
```
Passed: `format:check`, `lint`, `typecheck`, and skill/schema validation
(`scripts/check.js`) all passed with no findings.

```powershell
npm test
```
582 tests, **573 passed, 0 failed, 9 skipped** (explicit symlink-capability
skips), 68.58s. Includes the shared-reference dependency-graph tests added by
PR #131 (`every bundled skill only depends on shared resources actually
present in the pack`, `a fresh sync resolves every exported reference from a
project path with spaces and a non-ASCII character`, etc.) and the
interruption/recovery fault-injection suite (`atomic termination recovery
keeps the last checkpoint and retry never duplicates a committed event`,
`interrupted persistence never partially commits a record, and retrying the
same mutation ID recovers`, `cancellation records a recovery location and
preserves staged, untracked, and ignored task work`).

```powershell
npx playwright test --project=chromium
```
**25 passed** (19.6s), 0 failed. Covers the configuration console, onboarding,
navigation, usage, projects, workbench, and accessibility scans.

```powershell
npm run release:artifacts
```
Built the archive above. `install.ps1` was staged into `release-artifacts/`
automatically by `stageWindowsBootstrap` (no separate copy step needed —
see the corrected instructions in [releases.md](../releases.md)).

```powershell
node scripts/bundle-smoke.js --directory release-artifacts --previous-directory <prior archive directory>
```
**Passed.** This is the existing automated Windows smoke harness; it
extracted the archive to an isolated temp directory containing a space and
`é` (`extracted bundle é`), removed `node`, `npm`, and `baml` from `PATH` for
the child process, and exercised, against the exact candidate and exact prior
archives:

- compiled workflow policy async exit
- CLI
- UI/API
- hooks (`codex-handler.js`, `claude-hook.js`, `cursor-ide-hook.cjs`)
- stable hook dispatch before/after rollback/uninstall
- spaces/Unicode paths (`installed versions é`)
- installation
- failed-upgrade preservation (a corrupted bundle is rejected without
  disturbing the active version)
- rollback selection
- uninstall retention
- local archive bootstrap
- **exact prior archive upgrade and rollback** (using the real
  `1.0.0-dogfood.20260906.3` bytes above, not a reconstructed predecessor)

The resulting evidence record is
`.github/release-evidence/1.0.0/bundle-smoke-win32-x64.evidence.json`
(`qualificationOS: "Windows 11 Pro"`, `qualificationVersion: "10.0.26200"`,
`runtime: "native"`).

### Manual native qualification (isolated install root, spaces + Unicode)

Beyond the automated harness above, the exact archive was separately
installed by hand into an install root and a project root this qualification
created under the local temp directory, both containing a space and a
non-ASCII character (`install root café ½`, `project café ½`), with `node`,
`npm`, and `PSModulePath` removed from the shell's `PATH` before every
command — never touching `%LOCALAPPDATA%\Latchkit` or any pre-existing
install. This gave an independently inspectable trail for the #103
standalone-installation check PR #131 left outstanding, plus a hook and UI
check and a genuine interruption/recovery exercise:

- **Clean install**: `install.ps1 -Version 1.0.0 -Root <isolated root>
  -Artifact <candidate zip> -Checksum <candidate .sha256>` — succeeded,
  printed the onboarding hand-off, activated `1.0.0-win32-x64`.
- **CLI startup**: the installed `bin/latchkit.ps1 --version` printed `1.0.0`;
  `self inspect --install-root <root>` reported the correct active version
  and launcher set.
- **Skill/resource export (issue #103 check)**: `init --providers
  claude,codex --skills requirements,spec,build,review` then `sync` created,
  under **both** `.agents/skills/` and `.claude/skills/`, the four shared
  reference files the exported `SKILL.md` files link to —
  `references/efficiency.md`, `references/workflow-evidence.md`,
  `references/prd-template.md`, `references/technical-plan-template.md` —
  and the relative links in the installed `latchkit-build/SKILL.md`
  (`../references/efficiency.md`, `../references/workflow-evidence.md`)
  resolved to files that actually exist on disk. This is the same defect
  PR #131 fixed at the source level, now confirmed against the packaged
  standalone bundle rather than the dev tree.
- **Hook use**: the installed `bin/latchkit-hook.ps1 --version
  <active> --handler claude --event Stop` returned a well-formed
  `turn-completed` event JSON for a piped `Stop` payload.
- **UI startup**: `bin/latchkit.ps1 ui --project <project> --port 0` printed
  a local URL and session token; `GET /` returned 200 with `Latchkit` in the
  body, and an authenticated `GET /api/state` (bearer token from the printed
  URL) returned 200.
- **Interruption/recovery**: killing a `sync` of 7 skills across 2 providers
  1–15 ms after launch did not catch it mid-operation on this host (it
  completed first); a fresh `install.ps1` run into a new isolated root,
  killed with `taskkill /T /F` 1.5 s into an observed ~4.8 s full install,
  **did** catch it mid-staging — the target root was left with no `current`
  pointer, an empty `versions/` list, and only an abandoned
  `*.staging` directory; `self inspect` reported `active: null` (a clean,
  non-broken pre-install state, not a partial one). Re-running the same
  install command against the same root then completed normally and
  activated `1.0.0-win32-x64`.

Sanitized records: `.github/release-evidence/1.0.0/standalone-cli-ui-hook-check.json`,
`.github/release-evidence/1.0.0/standalone-shared-resource-export.json`, and
`.github/release-evidence/1.0.0/interruption-recovery-check.json` (the last
one also notes that project-level sync/remove interruption is covered
deterministically, not by timing, in the `npm test` fault-injection suite
above).

## Sanitized qualification records

All under `.github/release-evidence/1.0.0/`:

| File | What it proves |
| --- | --- |
| `bundle-smoke-win32-x64.evidence.json` | Automated native Windows 11 smoke: install/upgrade/rollback/uninstall/hooks/CLI/UI against the exact candidate and exact prior archive. |
| `standalone-shared-resource-export.json` | Manual #103 standalone-installation check against the packaged archive. |
| `standalone-cli-ui-hook-check.json` | Manual CLI/self-inspect/hook/UI check against the isolated install. |
| `interruption-recovery-check.json` | Manual install-time interruption and recovery against the isolated install. |

`node scripts/collect-release-evidence.js --artifacts release-artifacts
--evidence .github/release-evidence` was run and collected the one record
matching the verifier's schema (`bundle-smoke-win32-x64.evidence.json`); the
other three are supplementary narrative records in the same style as the
existing `windows-dogfood` evidence directory and are not consumed by the
schema-checked verifier gates.

## Publication verifier result: NO-GO

`scripts/release-artifacts.js` exports the exact function the controlled
`release.yml` publish job calls (`verifyReleaseArtifacts` with
`requireClean: true`). Its CLI entry point (`--verify-only --tag vX.Y.Z`)
resolves the tag's commit via `git rev-parse refs/tags/<tag>^{commit}` —
but **creating that tag is a maintainer "final approval" action this
qualification is explicitly not authorized to take**, and was not taken (no
tag exists in this repository as a result of this work). Instead, the same
exported function was invoked directly with the already-verified tag/commit
pair it would have resolved to (`v1.0.0` / `08dd962e25e34343e657b3ca9a36fc0efdd30e07`,
independently confirmed via `git rev-parse HEAD` earlier in this
qualification) and `requireClean: true` — identical logic, no gate relaxed,
only the tag-creation side effect avoided:

```json
{
  "status": "no-go",
  "tag": "v1.0.0",
  "commit": "08dd962e25e34343e657b3ca9a36fc0efdd30e07",
  "reason": "Exact current-artifact live workflow qualification evidence is missing."
}
```

Every other gate passed first: archive checksum and checksum-sidecar
agreement, embedded `bundle-manifest.json`/SBOM/file-inventory/license
cross-verification (full archive extraction and byte-for-byte comparison),
exact prior-archive validity (`release-artifacts/previous/`), and Windows 11
(not Server) native smoke evidence for `win32-x64`. The verifier stopped only
at the one gate this qualification cannot satisfy without violating its own
hard limits: `exactWorkflowEvidence`, which requires a
`live-workflow-qualification` record from an authenticated Codex session
against this exact archive (requirements → plan → implementation →
verification → review → handoff, all `passed`, with `proof.taskState:
"verified"`). No such record was fabricated. **This NO-GO is the correct,
expected outcome, not a defect** — it accurately reflects that a maintainer
still needs to run one authenticated delivery-workflow session before this
candidate can publish.

## What was skipped and why

- **Live Codex delivery-workflow qualification** (`npm run verify:workflow --
  --authorized --provider codex ...`) — requires spending an authenticated
  provider session; this task's hard limits explicitly forbid running any
  provider (Codex, Claude, Gemini, FCC/NIM) session.
- **`gh release create` / any push, tag, or workflow dispatch** — explicitly
  forbidden; publication is reserved for the repository owner.
- **Creating the `v1.0.0` git tag** — reserved for maintainer "final
  approval" per `docs/releases.md`; the verifier was instead exercised
  directly against the same tag/commit pair (see above).
- Non-Windows targets, Homebrew/WinGet, and FCC/NIM inference were not
  built or exercised — out of scope per the issue (#98, #86 territory) and
  the hard limit against running any provider session.

## Remaining steps for the release manager

To publish these exact, already-qualified bytes without rebuilding:

1. Run the live Codex delivery-workflow harness against this exact archive
   and record its evidence:
   ```powershell
   npm run verify:workflow -- --authorized --provider codex --model gpt-5.6-luna --reasoning-effort medium `
     --artifact release-artifacts/latchkit-1.0.0-win32-x64.zip `
     --artifact-sha256 a15711c188593b5b4df2e742a76debcb472f34c38e5c29ea8f3ae26f1b24f17b `
     --output .github/release-evidence/1.0.0/workflow-codex-windows.evidence.json
   ```
   Commit the resulting sanitized evidence file.
2. Re-run `node scripts/release-artifacts.js --verify-only --tag v1.0.0
   --output release-artifacts` (or dispatch a fresh `prepare` workflow run
   and let `publish` do this) to confirm a GO before proceeding.
3. Create the exact `v1.0.0` tag at commit
   `08dd962e25e34343e657b3ca9a36fc0efdd30e07`.
4. Dispatch `.github/workflows/release.yml` with `publish: true`,
   `tag: v1.0.0`, `artifact_run_id` set to a qualified `prepare` run for this
   exact commit (a fresh CI `prepare` dispatch rebuilds identical bytes from
   the same clean commit; it does not need to reuse this local build), and
   `evidence_ref` pointing at the commit/branch containing this qualification's
   evidence under `.github/release-evidence/1.0.0/`.
5. Approve the protected `github-release-production` environment gate
   (required reviewer `willahealm`).
6. After publication, verify the public release assets and checksums, run a
   fresh `install.ps1` against the published (not local) archive, and link
   the release and this qualification's evidence in the issue's closing
   comment.

## Limitations

- This qualification ran on one development machine; it is not a
  multi-machine or multi-account reproduction.
- The interruption/recovery exercise's sync-level attempt completed before
  an external kill could interrupt it on this host; only the slower
  install-staging path was actually caught mid-operation. Deterministic
  (non-timing) interruption coverage for project mutations comes from the
  regression suite, not from this manual pass.
- No dollar cost, token usage, or provider billing claims are made anywhere
  in this record; none were collected.
- This record does not establish macOS, Linux, WSL, Cursor, Antigravity, or
  FCC/NIM live-session qualification for this candidate; those remain
  separately tracked (see the scope matrix in
  [releases.md](../releases.md#release-scope-and-supported-capability-matrix)).
