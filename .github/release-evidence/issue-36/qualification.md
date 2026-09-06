# v1 release qualification: no-go

> Current package candidate: source commit `eeced31ad47b99fd73b529512857a80377e9a160`, packaged by the controlled release workflow as `latchkit-1.0.0-rc.1.tgz` with SHA-256 `c28d743c6b7c4b9bdfdf186ec0448e69c9ea44ae6b5b7522bf1bc2eef0670cb5`.

## Candidate and decision

- Package: `latchkit@1.0.0-rc.1`
- Package source commit: `eeced31ad47b99fd73b529512857a80377e9a160`
- Exact archive SHA-256: `c28d743c6b7c4b9bdfdf186ec0448e69c9ea44ae6b5b7522bf1bc2eef0670cb5`
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
| [Merged main CI](https://github.com/gjsoaresc/latchkit/actions/runs/34001090855) | Node 22/24 on Windows, Ubuntu, and macOS; Chromium, Firefox, WebKit; real WSL | All jobs passed on the merged package source commit |
| [Controlled release dry run](https://github.com/gjsoaresc/latchkit/actions/runs/34001185127) | One uploaded archive on Node 22/24 across Windows, Ubuntu, and macOS, plus WSL mounted drive | Rebuild, checksum, SPDX SBOM, manifest, and every exact-archive smoke passed; publication job skipped |

The controlled manifest records the digest above, `releaseTag: null`, and `publication: dry-run; no registry mutation`. GitHub emitted non-failing action-runtime deprecation and transient cache-service warnings; no test retry was converted into a pass.

## Live provider evidence

All provider prompts were bounded, requested no tools or file changes, and used existing authenticated sessions with explicit user authorization. Retained evidence contains only versions, state classifications, byte counts, and SHA-256 digests; no prompt transcript, response transcript, credential, token, account identifier, or provider session identifier is retained.

| Provider | Environment | Result | Disposition |
| --- | --- | --- | --- |
| Claude Code 2.1.258 | Native Windows | The exact controlled archive completed a bounded JSON task-controller invocation; exit 0, 2,118 output bytes, digest `9ca4016fa05ec4b91c1c3e6edcfe586e11dc46b52249fd010ab9eb3e8d704436`, valid result and provider session identity, task state returned to `blocked` | pass |
| Antigravity CLI 1.1.27 | Native Windows | The exact controlled archive launched `agy --print --output-format json`; exit 0, 304 output bytes, digest `4dc5b85089ba090fbb981889047629468c5054b970016efb6cbaae26f014c976`, valid JSON response, and task state returned to `blocked` after provider exit | pass for invocation; resume/hooks remain unclaimed under #76 |
| Cursor CLI 2026.09.02-c22c1a3 | WSL Ubuntu, Node 22.23.2 | Official status command exited 0 and reported authenticated. The exact installed RC completed bounded JSON invocation and chat-ID resume with exit 0; both sessions finished and task state returned to `blocked` | pass |
| Cursor IDE | Native Windows | Required manual skill discovery, editor workflow, and evidence capture not performed | **blocked** |
| Codex CLI 0.153.2 | Native Windows | Historical bounded invocation and resume evidence passed on the pre-RC candidate | pending exact-RC lifecycle run |

### Cursor CLI details

The upstream-supported Windows route was tested in WSL rather than claimed as a native Windows CLI. Cursor Agent reported version `2026.09.02-c22c1a3`; its status output was 36 bytes with digest `8db5835047ecfdb604c32d2c9a975cabdf3081caf1013ad54eb30c699bae9730` and was classified as authenticated.

WSL lacked Node, so the official Node.js `v22.23.2` Linux x64 archive was downloaded directly from `nodejs.org`, verified against the separately downloaded official `SHASUMS256.txt`, and installed without elevation at `/home/willahelm/.local/node-v22.23.2`. Its bin directory was added once to the user's Zsh path. No pipe-to-shell installer was used.

Workspace trust was granted once and only for the disposable fixture `/home/willahelm/.cache/latchkit-cursor-qual-final-20260906`. The repository and parent directories were not trusted, and no `--force`, `--yolo`, or permission-bypass option was used. The trust handshake exited 0 with valid JSON and digest `c47341ac893e2dfad208cd33adb7a816ee48c0ebb9db446ac6892cd0225e8968`.

After that handshake, the exact controlled archive was installed into the same fixture and Latchkit's normal task-controller path ran without a trust override:

- Initial invocation: exit 0, 361 output bytes, digest `8feb66f3aeb8120f9f249d2fda3e0e7852840ccc4ed94812ae959de82b36d158`, valid JSON result and resumable provider session identity observed.
- Resume by recorded provider session identity: exit 0, 345 output bytes, digest `fa141f67ce44322b890ba217621e0bf74369f53e3e346483ea4823488059b6d3`, valid JSON result and session identity preserved.
- A start without direct execution authorization was refused with `EXECUTION_AUTHORIZATION_REQUIRED`.
- Provider exit never became task acceptance; both turns left the task `blocked` for independent evidence and decision handling.

This run exposed and fixed a real adapter defect: task-controller prompts previously planned Cursor's interactive mode, and resume ignored the controller's `sessionId`. Default task prompts now use bounded print/JSON mode and resume maps the recorded provider session identity. Regression tests cover both behaviors.

### Antigravity details

Antigravity was installed at the provider-owned Windows location and reported version `1.1.27`. The exact installed RC successfully exercised the documented print/JSON invocation. Although current CLI help exposes conversation and continuation flags, Latchkit does not infer a stable automation contract from help output alone. Non-interactive resume, session identity, hooks, and lifecycle semantics remain explicitly unclaimed and are tracked by #76.

## Existing regression evidence

The maintained suite covers failed-then-passed acceptance, stale evidence, denied authorization, unsupported gates, cancellation, interrupted installer recovery, rollback, user-edit preservation, worktree cleanup refusal, token isolation, memory export/deletion, support-bundle redaction, and bounded process ownership. These automated scenarios are not substitutes for the remaining live multi-provider workflow.

Earlier qualification reports and alpha artifacts remain in repository history as regression evidence. They do not supersede the merged source commit, controlled workflow, and exact RC digest recorded above.

## Blocking actions

Before changing this decision to go:

1. Perform the documented Cursor IDE manual workflow on the exact RC and retain sanitized skill-discovery, editor-lifecycle, and permission behavior evidence.
2. Run the complete live requirements → implementation → failed-then-passed verification → independent review → handoff workflow on the exact RC, including one interruption/recovery. Repeat the exact-RC Codex lifecycle probe as part of that workflow.
3. Review the completed matrix, security findings, package inventory, documentation, and limitations. Only then may the maintainer authorize the RC tag and controlled publication workflow.

The accountable owner for the remaining manual and release actions is the release maintainer with access to Cursor IDE, the required provider accounts, native environments, and protected publication authority. Post-v1 enhancement issues remain out of scope and are not release blockers.
