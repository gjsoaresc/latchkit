# v1 release qualification: no-go

## Candidate and decision

- Candidate commit: `d7dfcf8a0804196e3f3737dafd3191acc1113546`
- Package: `latchkit@0.1.0-alpha.1`
- Exact archive SHA-256: `85722166cfb1985e0b6cbdaa57eec51bba5c31a34b5ef45f8b632249ab817bf2`
- Qualification date: 2026-09-05 UTC
- Decision: **NO-GO** for v1.0 publication

The package/runtime, recovery, security, browser, evaluation, and exact-archive platform evidence is green. The candidate is not eligible for a production-ready claim because the required live provider evidence is incomplete and the package is still an alpha rather than an approved v1 release candidate. Issue #36 must remain open.

## Reproducible evidence

| Scope              | Evidence                                                                                                                                                                               | Result                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact-commit CI    | [Cross-platform run 33995374873](https://github.com/gjsoaresc/latchkit/actions/runs/33995374873) on `62d8de5`; no product/package files changed between that commit and this candidate | Node 22/24 on Windows, Ubuntu, and macOS; Chromium, Firefox, WebKit; WSL mounted-drive smoke all passed                                                           |
| Controlled release | [Run 33995875765](https://github.com/gjsoaresc/latchkit/actions/runs/33995875765) on this candidate                                                                                    | Archive, checksum, SPDX SBOM, manifest, and installed-artifact smoke passed; publication job deliberately skipped                                                 |
| One exact archive  | Same controlled-release run                                                                                                                                                            | The archive above passed Node 22/24 on native Windows, Ubuntu, and macOS, plus Node 22 in real WSL and a mounted Windows drive                                    |
| Local suite        | Native Windows 10.0.26200, Node 26.8.1, npm 11.19.0                                                                                                                                    | `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run smoke:artifact`, `npm run release:dry-run`, and `npm audit --omit=dev --audit-level=high` passed |
| Skill evaluation   | Offline fixture harness, 2026-09-05T22:17:32Z                                                                                                                                          | 8 passed, 0 failed, 0 skipped; this is harness evidence, not provider-quality evidence                                                                            |
| Security           | [Security audit](../../../docs/security-audit.md) and GitGuardian/check matrix                                                                                                         | No unresolved critical/high exploitable finding recorded; practical same-user, filesystem, and redaction limitations remain documented                            |

The local suite had one explained Windows file-symlink skip because that host denied file-symlink creation with `EPERM`. The release workflow exercised link protections on its Windows and WSL runners, so the skip is not used as substitute evidence. GitHub emitted non-failing action-runtime deprecation and transient cache-service warnings; no test retry was converted into a pass.

## Provider evidence

| Provider            | Native Windows          | WSL     | Linux   | macOS   | Disposition                                                                                                             |
| ------------------- | ----------------------- | ------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.258 | blocked                 | unknown | unknown | unknown | Bounded live smoke reached the provider but required login, approval, or permission; see `provider-claude-windows.json` |
| Codex CLI 0.153.2   | pass                    | unknown | unknown | unknown | Bounded one-turn live smoke exited 0; see `provider-codex-windows.json`                                                 |
| Gemini CLI          | unavailable             | unknown | unknown | unknown | Executable was not installed on the qualification host                                                                  |
| Cursor IDE 3.19.7   | manual evidence missing | unknown | unknown | unknown | Editor was installed, but the required manual skill/hook workflow was not performed                                     |
| Cursor CLI          | unavailable             | unknown | unknown | unknown | The documented `agent` executable was not installed                                                                     |

`unknown`, `blocked`, and `unavailable` are not support claims. The evidence records contain no transcript, command arguments, credentials, or usage estimate.

## Lifecycle, recovery, and resource evidence

The maintained suite passed the end-to-end mechanics for failed-then-passed acceptance, stale evidence, denied authorization, unsupported gates, cancellation, interrupted installer recovery, rollback, user-edit preservation, worktree cleanup refusal, token isolation, memory export/deletion, and support-bundle redaction. These are reproducible automated scenarios, not a substitute for the required live multi-provider requirements-to-handoff workflow.

Budgets were declared before the local measurement: server startup maximum 1,000 ms, CLI version average 500 ms over 20 runs, diff regression suite 10,000 ms, and no growth in active handles after 20 start/stop cycles. Observed on native Windows/Node 26.8.1: server startup maximum 1.59 ms and average 0.41 ms; CLI version total 3,656.27 ms (182.81 ms average); diff regression suite 5,441.16 ms; active handles changed from 2 to 1 after shutdown. These measurements are local responsiveness evidence, not formal performance guarantees.

## Blocking actions

Before changing this decision to go:

1. Select and commit an explicit v1 release-candidate version/tag; do not publish `0.1.0-alpha.1` as the qualified stable release.
2. Run the bounded provider verification matrix with authorized accounts on the supported environments. At minimum resolve the Claude Windows block, install and verify Gemini CLI and Cursor CLI, perform the documented Cursor IDE manual workflow, and record every required OS cell as pass, unsupported, or blocked with evidence.
3. Run one live requirements → implementation → failed-then-passed verification → independent review → handoff workflow on that exact candidate, including one interruption/recovery, and retain sanitized task evidence.
4. Rerun the controlled release workflow for that exact candidate and archive digest. Stable publication still requires the separately protected `npm-production` environment approval.

The accountable owner for these actions is the release maintainer with access to the required provider accounts, native environments, and release-version decision. No post-v1 feature is required to clear this gate.
