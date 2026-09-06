# v1 release qualification: ready for maintainer release review

> Current package candidate: source commit `783567be209d09202dd26570cb03cba644c153ae`, packaged locally without publication as `latchkit-1.0.0-rc.1.tgz` with SHA-256 `16ed09a0b6d5d4b59975ae68616b6f51bf30dece61e188cdc3b83be5d8b47fb4`.

## Candidate and decision

- Package: `latchkit@1.0.0-rc.1`
- Package source commit: `783567be209d09202dd26570cb03cba644c153ae`
- Exact archive SHA-256: `16ed09a0b6d5d4b59975ae68616b6f51bf30dece61e188cdc3b83be5d8b47fb4`
- Qualification date: 2026-09-06 UTC
- Decision: **GO** for v1.0 release-candidate qualification; publication remains separately authorized

The maintainer selected an explicit release-candidate version. The exact candidate passes the complete live Codex requirements-to-handoff scenario, including interruption recovery, implementation, verification, resumable handoff, and independent review. The final Cursor IDE manual gate also passes: the bounded editor workflow used the installed skill and the opt-in hook evidence recorded every event required for that workflow. Qualification is complete and ready for maintainer review. No tag, GitHub release, registry publication, or stable-version claim has been made; those actions still require explicit release authorization.

The package source commit differs from the later evidence-only commit that contains this report. `.github/release-evidence` is excluded from the package inventory, so recording these results does not change the exact archive above.

## Exact-candidate checks

| Scope | Environment | Result |
| --- | --- | --- |
| Local project checks | Native Windows 10.0.26200, Node 24.20.0 | `npm run check` and `npm test` passed: 174 passed, 0 failed, 1 explained local file-symlink skip caused by Windows `EPERM` |
| Package inventory | Native Windows | `npm pack --dry-run` passed; the candidate contains 113 files |
| Installed archive | Disposable native Windows and WSL fixtures | Both fixtures installed `latchkit@1.0.0-rc.1`; `init` and `sync` completed and installed the selected skill |
| [Merged main CI](https://github.com/willahealm/latchkit/actions/runs/34005427213) | Node 22/24 on Windows, Ubuntu, and macOS; Chromium, Firefox, WebKit; real WSL | All jobs passed on the merged package source commit |
| [Controlled release dry run](https://github.com/gjsoaresc/latchkit/actions/runs/34001185127) | One uploaded archive on Node 22/24 across Windows, Ubuntu, and macOS, plus WSL mounted drive | Rebuild, checksum, SPDX SBOM, manifest, and every exact-archive smoke passed; publication job skipped |

The earlier controlled release dry run applies to the pre-fix RC archive with SHA-256 `c28d743c6b7c4b9bdfdf186ec0448e69c9ea44ae6b5b7522bf1bc2eef0670cb5`; its manifest records `releaseTag: null` and `publication: dry-run; no registry mutation`. The current archive was rebuilt locally from merged `main` solely for qualification and has not been published. One first-attempt Windows/Node 22 test process exited nonzero in the concurrent Cursor evidence test without emitting child diagnostics. The same job passed on rerun, the PR run had already passed that cell, 20 additional local Windows/Node 22 repetitions passed, and the real editor run persisted all nine records. The evidence-only follow-up improves that assertion so a future child failure reports its event, exit code, and sanitized stderr.

The evidence-only full-suite run also exposed a deterministic test-harness race: its cancellation timer could fire before the verifier launched the child, producing no result to assert. The follow-up replaces elapsed-time scheduling with the process runner's durable `process-start` boundary; the full suite then passed. Neither follow-up changes packaged runtime bytes. These observations are retained and reviewed here rather than omitted or accepted on a passing retry alone.

## Live provider evidence

All provider prompts were bounded, requested no tools or file changes, and used existing authenticated sessions with explicit user authorization. Retained evidence contains only versions, state classifications, byte counts, and SHA-256 digests; no prompt transcript, response transcript, credential, token, account identifier, or provider session identifier is retained.

| Provider | Environment | Result | Disposition |
| --- | --- | --- | --- |
| Claude Code 2.1.258 | Native Windows | The exact controlled archive completed a bounded JSON task-controller invocation; exit 0, 2,118 output bytes, digest `9ca4016fa05ec4b91c1c3e6edcfe586e11dc46b52249fd010ab9eb3e8d704436`, valid result and provider session identity, task state returned to `blocked` | pass |
| Antigravity CLI 1.1.27 | Native Windows | The exact controlled archive launched `agy --print --output-format json`; exit 0, 304 output bytes, digest `4dc5b85089ba090fbb981889047629468c5054b970016efb6cbaae26f014c976`, valid JSON response, and task state returned to `blocked` after provider exit | pass for invocation; resume/hooks remain unclaimed under #76 |
| Cursor CLI 2026.09.02-c22c1a3 | WSL Ubuntu, Node 22.23.2 | Official status command exited 0 and reported authenticated. The exact installed RC completed bounded JSON invocation and chat-ID resume with exit 0; both sessions finished and task state returned to `blocked` | pass |
| Cursor IDE 3.19.13 | Native Windows, Node 24.20.0 | The exact current archive passed skill discovery and the bounded one-file editor workflow. Nine privacy-safe hook records observed session start/end, three pre-tool events, two successful post-tool events, one failed post-tool event, and stop; pre-compact was correctly absent | pass |
| Codex CLI 0.153.2 | Native Windows, Node 24.20.0 | The exact current archive passed the complete authorized lifecycle with zero retries and no retained transcript or command arguments | pass |

### Codex lifecycle details

The exact current archive was installed outside the checkout. Initial missing evidence failed as required with `TASK_NOT_VERIFIABLE`; a deliberately interrupted owned process was terminated and recorded; implementation produced the requested source change and spec note; its independent test passed; the recorded provider session identity resumed for handoff; and an independent review completed with no findings. The final task state was `verified`. An unauthorized resume was refused with `TASK_AUTHORIZATION_REQUIRED`, cleanup left zero live owned processes, and the disposable lifecycle fixture was removed.

The earlier exact-RC lifecycle failure was caused by an invocation plan that did not explicitly grant the bounded workspace-write sandbox needed for an authorized implementation. The adapter now defaults to read-only/on-request, permits only reviewed read-only or workspace-write plans, and uses explicit no-prompt approval only inside the already authorized lifecycle harness. It never enables `danger-full-access` or a trust-bypass flag.

### Cursor IDE details

The final manual run used the exact current archive in a disposable trusted Cursor workspace. Cursor followed the installed `latchkit-spec` skill, kept the specification inline, created only the authorized marker, and stopped. The opt-in evidence file contains nine records with only schema version, contiguous sequence, event name, and classification. It stores no prompt, transcript, tool arguments or results, account or provider-session identifiers, credentials, or absolute paths.

The first attempt produced no records because Cursor's native Windows PowerShell hook transport prepended a UTF-8 byte-order marker before the JSON payload. PR #82 made the packaged handler accept exactly that leading encoding marker while preserving all other bounds and validation. The rerun observed `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, and `stop`; `preCompact` was not expected for this short session. The failed post-tool record is an honest failure classification from the bounded run and did not prevent the authorized write from succeeding.

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

## Remaining release-authority actions

Qualification does not authorize publication. Before tagging or publishing:

1. Review the completed matrix, security findings, package inventory, documentation, retained CI observation, and limitations.
2. Explicitly authorize a fresh controlled release dry run and review its exact-archive manifest.
3. Separately authorize any tag, GitHub Release, registry publication, or stable-version claim through the protected release workflow.

The accountable owner for those actions is the release maintainer with protected publication authority. Post-v1 enhancement issues remain out of scope and are not release blockers.
