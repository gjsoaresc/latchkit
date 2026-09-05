# v1 release qualification: no-go

> Current authoritative candidate: `main` at `5d64b803e464558604a73c42bfbacfe7d26b67bc`, packaged as `latchkit-0.1.0-alpha.1.tgz` with SHA-256 `c4d96cba6ad8c213b53139d5f176e2bf09f5d42e776394936ca37a0d12482a75`. The earlier candidate and digest retained below are historical evidence only.

## Candidate and decision

- Candidate commit: `5d64b803e464558604a73c42bfbacfe7d26b67bc` (current `main`)
- Package: `latchkit@0.1.0-alpha.1`
- Exact archive SHA-256: `c4d96cba6ad8c213b53139d5f176e2bf09f5d42e776394936ca37a0d12482a75`
- Qualification date: 2026-09-06 UTC
- Decision: **NO-GO** for v1.0 publication

The package/runtime, recovery, security, browser, evaluation, and exact-archive platform evidence is green. The candidate is not eligible for a production-ready claim because the required live provider evidence is incomplete and the package is still an alpha rather than an approved v1 release candidate. Issue #36 must remain open.

The previous qualification record (`d7dfcf8` / `85722166…`) and the September 5/6 follow-up artifacts are retained as historical evidence. They do not supersede the exact `main` candidate and digest listed above.

## Reproducible evidence

| Scope              | Evidence                                                                                                  | Result                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact-commit CI    | [Main push run 33998158086](https://github.com/gjsoaresc/latchkit/actions/runs/33998158086) on `5d64b803` | Node 22/24 on Windows, Ubuntu, and macOS; Chromium, Firefox, WebKit; WSL mounted-drive smoke all passed                                                           |
| Controlled release | [Main dry-run 33998184838](https://github.com/gjsoaresc/latchkit/actions/runs/33998184838) on `5d64b803`  | Archive, checksum, SPDX SBOM, manifest, and installed-artifact smoke passed; publication job deliberately skipped                                                 |
| One exact archive  | Same controlled-release dry-run                                                                           | The archive above passed Node 22/24 on native Windows, Ubuntu, and macOS, plus Node 22 in real WSL and a mounted Windows drive                                    |
| Local suite        | Native Windows 10.0.26200, Node 26.8.1, npm 11.19.0                                                       | `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run smoke:artifact`, `npm run release:dry-run`, and `npm audit --omit=dev --audit-level=high` passed |
| Skill evaluation   | Offline fixture harness, 2026-09-05T22:17:32Z                                                             | 8 passed, 0 failed, 0 skipped; this is harness evidence, not provider-quality evidence                                                                            |
| Security           | [Security audit](../../../docs/security-audit.md) and GitGuardian/check matrix                            | No unresolved critical/high exploitable finding recorded; practical same-user, filesystem, and redaction limitations remain documented                            |

The local suite had one explained Windows file-symlink skip because that host denied file-symlink creation with `EPERM`. The release workflow exercised link protections on its Windows and WSL runners, so the skip is not used as substitute evidence. GitHub emitted non-failing action-runtime deprecation and transient cache-service warnings; no test retry was converted into a pass.

## Provider evidence

| Provider                         | Native Windows          | WSL     | Linux   | macOS   | Disposition                                                                                                                                         |
| -------------------------------- | ----------------------- | ------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.258              | blocked                 | unknown | unknown | unknown | Bounded live smoke reached the provider but required login, approval, or permission; see `provider-claude-windows.json`                             |
| Codex CLI 0.153.2                | pass                    | unknown | unknown | unknown | Bounded one-turn live smoke exited 0; see `provider-codex-windows.json`                                                                             |
| Gemini CLI (individual accounts) | unsupported upstream    | unknown | unknown | unknown | A real personal-account sign-in reports that Gemini CLI is no longer supported for individuals; Google directs those users to Antigravity CLI       |
| Cursor IDE 3.19.7                | manual evidence missing | unknown | unknown | unknown | Editor was installed, but the required manual skill/hook workflow was not performed                                                                 |
| Cursor CLI                       | unsupported upstream    | unknown | unknown | unknown | Current upstream installation docs support Windows through WSL, not natively; the documented `cursor-agent` executable was unavailable on this host |

`unknown`, `blocked`, and `unavailable` are not support claims. The evidence records contain no transcript, command arguments, credentials, or usage estimate.

### Follow-up diagnostics

The September 6 follow-up at commit `508ffaf41629af043b5e2a7c6c503be738f02681` corrected provider-contract drift and exercised an installed local archive with SHA-256 `29a11dd2f24430cb4aab09bedb9632d77daf66fc0e9c547fe59eb73341a7a2e4`. See `provider-diagnostics-windows.json` and `lifecycle-codex-windows.json`.

- Claude's official `auth status` command returned exit 1 with `loggedIn: false`. Authentication blocks live validation before repository permissions can be evaluated.
- Gemini CLI 0.58.0 was provisioned, and a real personal-account sign-in returned that Gemini CLI is no longer supported for individuals and directs migration to Antigravity CLI. Google's upstream announcement records the June 18, 2026 retirement for Google AI Pro, Google AI Ultra, and free-tier individual accounts; enterprise Gemini Code Assist licenses and supported API-key/Google Cloud access are separate scopes: https://github.com/google-gemini/gemini-cli/discussions/28017. This is unsupported-upstream evidence, not a pass. Antigravity was not installed or tested.
- Current Cursor documentation names `cursor-agent` and supports Windows through WSL, not a native Windows installer. The adapter and compatibility statement were corrected; the WSL executable remains absent.
- The installed-archive Codex harness recorded the required initial failure, rejected failed evidence, terminated an owned provider process, recorded the run as interrupted, and recovered the task to a new provider run. The nested Codex process then exited 0 without changing source or writing the spec, so the test remained failed and no completion evidence was produced.
- A separate text-only probe proved the corrected `codex exec resume --json` vector: both turns exited 0 with `thread.started`, `turn.started`, `item.completed`, and `turn.completed`. Only a hash of the thread ID was emitted; no transcript was retained.

The full live implementation/review/handoff criterion therefore remains blocked. Run the documented `verify:lifecycle` command from a normal terminal outside an active Codex desktop task with the existing authenticated account and reviewed workspace-write/approval policy. Do not use bypass flags.

The same follow-up found no remote tags, no GitHub releases, and no configured `npm-production` environment (the repository-scoped GitHub API returned 404). `release-authority.json` records this result. Selecting the exact v1 version/tag, configuring protected trusted publication, and later approving a qualified stable release are maintainer decisions; this evidence does not invent them.

## Lifecycle, recovery, and resource evidence

The maintained suite passed the end-to-end mechanics for failed-then-passed acceptance, stale evidence, denied authorization, unsupported gates, cancellation, interrupted installer recovery, rollback, user-edit preservation, worktree cleanup refusal, token isolation, memory export/deletion, and support-bundle redaction. These are reproducible automated scenarios, not a substitute for the required live multi-provider requirements-to-handoff workflow.

Budgets were declared before the local measurement: server startup maximum 1,000 ms, CLI version average 500 ms over 20 runs, diff regression suite 10,000 ms, and no growth in active handles after 20 start/stop cycles. Observed on native Windows/Node 26.8.1: server startup maximum 1.59 ms and average 0.41 ms; CLI version total 3,656.27 ms (182.81 ms average); diff regression suite 5,441.16 ms; active handles changed from 2 to 1 after shutdown. These measurements are local responsiveness evidence, not formal performance guarantees.

## Blocking actions

Before changing this decision to go:

1. Select and commit an explicit v1 release-candidate version/tag; do not publish `0.1.0-alpha.1` as the qualified stable release.
2. Run the bounded provider verification matrix with authorized accounts on the supported environments. At minimum resolve the Claude Windows block, verify Cursor CLI, perform the documented Cursor IDE manual workflow, and record every required OS cell as pass, unsupported, or blocked with evidence. Gemini individual-account use is unsupported upstream; enterprise/API-key testing is only required if maintainers explicitly choose that paid or organizational release scope.
3. Run one live requirements → implementation → failed-then-passed verification → independent review → handoff workflow on that exact candidate, including one interruption/recovery, and retain sanitized task evidence.
4. Rerun the controlled release workflow for that exact candidate and archive digest. Stable publication still requires the separately protected `npm-production` environment approval.

The accountable owner for these actions is the release maintainer with access to the required provider accounts, native environments, and release-version decision. No post-v1 feature is required to clear this gate.
