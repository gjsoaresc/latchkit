# v1 release qualification: no-go

> Current package candidate: source commit `f9f6e4863eb65bf4d667d17d9e99751bb38e1588`, packaged as `latchkit-1.0.0-rc.1.tgz` with SHA-256 `d9611007bf1ed358908a7500c82301d0d44a6e078268f58b087755e9084e3553`.

## Candidate and decision

- Package: `latchkit@1.0.0-rc.1`
- Package source commit: `f9f6e4863eb65bf4d667d17d9e99751bb38e1588`
- Exact archive SHA-256: `d9611007bf1ed358908a7500c82301d0d44a6e078268f58b087755e9084e3553`
- Qualification date: 2026-09-06 UTC
- Decision: **NO-GO** for v1.0 publication

The maintainer selected an explicit release-candidate version, and the live Claude Code, Antigravity CLI, and Cursor CLI checks described below pass. The candidate is not yet eligible for a production-ready claim because the required Cursor IDE manual workflow and the complete live requirements-to-handoff scenario are still missing. Issue #36 must remain open. No tag, GitHub release, registry publication, or stable-version claim has been made.

The package source commit differs from the later evidence-only commit that contains this report. `.github/release-evidence` is excluded from the package inventory, so recording these results does not change the exact archive above.

## Exact-candidate checks

| Scope | Environment | Result |
| --- | --- | --- |
| Local project checks | Native Windows 10.0.26200, Node 26.8.1, npm 11.19.0 | `npm run check` and `npm test` passed: 168 passed, 0 failed, 1 explained local file-symlink skip caused by Windows `EPERM` |
| Package inventory | Native Windows | `npm pack --dry-run` passed; the candidate contains 112 files |
| Installed archive | Disposable native Windows and WSL fixtures | Both fixtures installed `latchkit@1.0.0-rc.1`; `init` and `sync` completed and installed the selected skill |

The candidate still requires reviewed CI on Node 22 and 24 across Windows, Linux, and macOS. Historical exact-archive and controlled-release results remain useful regression evidence, but do not substitute for CI on this RC.

## Live provider evidence

All provider prompts were bounded, requested no tools or file changes, and used existing authenticated sessions with explicit user authorization. Retained evidence contains only versions, state classifications, byte counts, and SHA-256 digests; no prompt transcript, response transcript, credential, token, account identifier, or provider session identifier is retained.

| Provider | Environment | Result | Disposition |
| --- | --- | --- | --- |
| Claude Code 2.1.258 | Native Windows | Official authentication status reported an active first-party session; a bounded one-turn smoke exited 0 | pass |
| Antigravity CLI 1.1.27 | Native Windows | The exact installed RC launched `agy --print --output-format json`; exit 0, 319 output bytes, digest `f2254d0f7ba9986596996a8d6ed68af580d1517ceeaec966909cfa36806b445c`, valid JSON response, and task state returned to `blocked` after provider exit | pass for invocation; resume/hooks remain unclaimed under #76 |
| Cursor CLI 2026.09.02-c22c1a3 | WSL Ubuntu, Node 22.23.2 | Official status command exited 0 and reported authenticated. The exact installed RC completed bounded JSON invocation and chat-ID resume with exit 0; both sessions finished and task state returned to `blocked` | pass |
| Cursor IDE | Native Windows | Required manual skill discovery, editor workflow, and evidence capture not performed | **blocked** |
| Codex CLI 0.153.2 | Native Windows | Historical bounded invocation and resume evidence passed on the pre-RC candidate | pending exact-RC lifecycle run |

### Cursor CLI details

The upstream-supported Windows route was tested in WSL rather than claimed as a native Windows CLI. Cursor Agent reported version `2026.09.02-c22c1a3`; its status output was 36 bytes with digest `8db5835047ecfdb604c32d2c9a975cabdf3081caf1013ad54eb30c699bae9730` and was classified as authenticated.

WSL lacked Node, so the official Node.js `v22.23.2` Linux x64 archive was downloaded directly from `nodejs.org`, verified against the separately downloaded official `SHASUMS256.txt`, and installed without elevation at `/home/willahelm/.local/node-v22.23.2`. Its bin directory was added once to the user's Zsh path. No pipe-to-shell installer was used.

Workspace trust was granted once and only for the disposable fixture `/home/willahelm/.cache/latchkit-cursor-qual-final-20260906`. The repository and parent directories were not trusted, and no `--force`, `--yolo`, or permission-bypass option was used. The trust handshake exited 0 with valid JSON and digest `c47341ac893e2dfad208cd33adb7a816ee48c0ebb9db446ac6892cd0225e8968`.

After that handshake, Latchkit's normal task-controller path ran without a trust override:

- Initial invocation: exit 0, 336 output bytes, digest `a2919d33caee31f824a4d7b6a46a2c097f0653e27f92dedd520c8e017c8282a4`, valid JSON result and resumable provider session identity observed.
- Resume by recorded provider session identity: exit 0, 356 output bytes, digest `3d36f62c56ea12fe97d0349564d9663a8b2f659f9953f7c5c8eb806903c705b9`, valid JSON result and session identity preserved.
- A start without direct execution authorization was refused with `EXECUTION_AUTHORIZATION_REQUIRED`.
- Provider exit never became task acceptance; both turns left the task `blocked` for independent evidence and decision handling.

This run exposed and fixed a real adapter defect: task-controller prompts previously planned Cursor's interactive mode, and resume ignored the controller's `sessionId`. Default task prompts now use bounded print/JSON mode and resume maps the recorded provider session identity. Regression tests cover both behaviors.

### Antigravity details

Antigravity was installed at the provider-owned Windows location and reported version `1.1.27`. The exact installed RC successfully exercised the documented print/JSON invocation. Although current CLI help exposes conversation and continuation flags, Latchkit does not infer a stable automation contract from help output alone. Non-interactive resume, session identity, hooks, and lifecycle semantics remain explicitly unclaimed and are tracked by #76.

## Existing regression evidence

The maintained suite covers failed-then-passed acceptance, stale evidence, denied authorization, unsupported gates, cancellation, interrupted installer recovery, rollback, user-edit preservation, worktree cleanup refusal, token isolation, memory export/deletion, support-bundle redaction, and bounded process ownership. These automated scenarios are not substitutes for the remaining live multi-provider workflow.

Earlier qualification reports and artifacts remain in repository history. In particular, main CI and controlled release dry-run evidence for `5d64b803e464558604a73c42bfbacfe7d26b67bc` passed Node 22/24 on Windows, Ubuntu, and macOS, browser coverage, real WSL mounted-drive smoke, artifact checksum/SBOM/manifest generation, and installed-artifact smoke. That archive was `0.1.0-alpha.1`, so it is historical evidence rather than the current RC.

## Blocking actions

Before changing this decision to go:

1. Obtain reviewed CI and exact-archive evidence for this RC on Node 22/24 across Windows, Linux, and macOS; do not convert retries or unexplained skips into passes.
2. Perform the documented Cursor IDE manual workflow on the exact RC and retain sanitized skill-discovery, editor-lifecycle, and permission behavior evidence.
3. Run the complete live requirements → implementation → failed-then-passed verification → independent review → handoff workflow on the exact RC, including one interruption/recovery. Repeat the exact-RC Codex lifecycle probe as part of that workflow.
4. Review the completed matrix, security findings, package inventory, documentation, and limitations. Only then may the maintainer authorize the RC tag and controlled publication workflow.

The accountable owner for the remaining manual and release actions is the release maintainer with access to Cursor IDE, the required provider accounts, native environments, and protected publication authority. Post-v1 enhancement issues remain out of scope and are not release blockers.
