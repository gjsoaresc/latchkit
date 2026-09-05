# Architecture

Latchkit is an original open-source toolkit that adds shared engineering skills and project configuration to existing coding agents. The initial implementation is a CLI and local configuration interface. The provider still owns authentication, model execution, tool permissions, and the conversation.

## Current components

| Component             | Responsibility                                                                        |
| --------------------- | ------------------------------------------------------------------------------------- |
| Node.js CLI           | Project initialization, provider discovery, configuration, and skill synchronization. |
| Project configuration | `.latchkit/config.json` records the selected providers and selected skill IDs.        |
| Canonical skills      | `skills/latchkit-*/SKILL.md` contains original portable instructions.                 |
| Provider destinations | Project-local copies in supported discovery roots.                                    |
| Provider contracts    | Versioned capability evidence and non-executing adapter plans.                        |
| Project rules         | Bounded manifest discovery, canonical instruction data, and provider-native exports.  |
| Local UI              | A browser interface for viewing providers and editing project configuration.          |
| Workflow notes        | Agents following the skills write task evidence under `.latchkit/notes/`.             |
| Project memory        | Explicit local records and bounded, capability-aware context recovery.                 |

The core targets Node.js 22 or newer and has no runtime package dependencies. Node's filesystem, path, HTTP, and process facilities provide a common implementation for Windows, Linux, and macOS. WSL runs the Linux path; it is optional for native Windows use.

The frontend is served locally. It is a configuration surface, not an embedded terminal, hosted account service, or provider session viewer. Authentication and model selection remain in each provider's own tools.

Project configuration and the ownership manifest are independently versioned contracts. Configuration reads never migrate files implicitly; supported schemas, provider extension boundaries, validation behavior, and explicit backup-backed migration are documented in [configuration contracts](configuration.md). Source-pack metadata and workflow state use separate future contracts rather than adding unrelated state to project configuration.

## Skill synchronization

The configuration uses the stable skill IDs `requirements`, `spec`, `build`, `fix`, `review`, `handoff`, and `setup`. They map to folders with the corresponding `latchkit-` prefix. The original four IDs remain valid in every supported configuration version; adding the three workflow IDs requires no migration.

| Selected provider | Destination relative to the target project |
| ----------------- | ------------------------------------------ |
| Claude Code       | `.claude/skills/`                          |
| Codex             | `.agents/skills/`                          |
| Gemini CLI        | `.agents/skills/`                          |
| Cursor IDE        | `.agents/skills/`                          |
| Cursor CLI        | `.agents/skills/`                          |

Shared destinations are deduplicated during synchronization. Generated copies are distribution artifacts; edit the canonical bundled skill to develop a new version.

Selecting a provider controls where Latchkit installs files. It does not isolate other agents from those files. Gemini and Cursor recognize shared roots, and Cursor can also discover other providers' skill directories. Selecting Claude alongside a shared-root provider can expose matching skills through multiple roots in Cursor. A single managed destination avoids unnecessary copies, but provider discovery rules still govern what appears. See [compatibility](compatibility.md).

## Provider contracts and lifecycle bridge

`src/providers/registry.js` owns the provider registry; `src/providers/contracts.js` validates versioned, serializable provider metadata, with published JSON schemas in `schemas/`. The legacy `PROVIDERS` exports remain available through `src/catalog.js` and `src/core.js` for existing CLI and UI consumers. A contract records capabilities and verification independently: installed, authenticated, configured, and end-to-end verified are separate facts. Capabilities include portable skills, invocation, individual hooks, blocking/advisory decisions, compaction, resume, cancellation, and usage. Every entry carries state, reason, version range, and evidence URL, so consumers need no vendor-specific field names.

An adapter, when one is implemented, must supply operations for inspection, installation planning, skill/rule export planning, invocation and resume planning, lifecycle input/output translation, and optional usage planning. Command plans contain an executable and argument array only; constructing or validating a plan never executes it. Provider contracts do not change approval policy, grant trust, read credentials, or manage account login.

`src/runtime/process-runner.js` is the bounded execution primitive for a future adapter. It accepts only a validated command plan and a provider contract with invocation evidence, and requires the caller to name the `host-local-authorized` execution profile. That profile is explicit evidence of local authorization; it does not inherit or emulate a provider's sandbox, terminal, approval policy, or credentials. Unavailable profiles and unknown invocation capability refuse before spawning. Native commands use Node argument vectors; Windows `.cmd`/`.bat` shims are launched only through a fixed `cmd.exe /d /v:off /s /c` strategy with each token escaped. The runner bounds decoded UTF-8 stdout/stderr, closes stdin, reports spawn/exit/timeout/cancellation outcomes, and terminates only its owned process tree.

Lifecycle adapters translate to a normalized envelope with a schema version; provider version and runtime; project, task, and session correlation; event ID; timestamp; event kind; bounded object payload; and declared decision modes. `turn-completed`, `session-terminated`, `interrupted`, and `verified-task-completed` are distinct events. The last is emitted only after a task owner has independently verified completion; it is not inferred from a turn ending.

The current bridge is an in-process, injectable dispatcher rather than a running hook service. Its future adapter entrypoint is: provider input → validated envelope → task lookup and authorization → handler → provider response translation. The future quality-gates component owns a concrete handler and any hook command/service transport; provider end-to-end work owns proving the joined path. With no adapter or service, hooks do not run when the console is closed (or open). The dispatcher deduplicates event IDs, reports a timestamp older than an accepted event in the same provider/project/task/session stream as out-of-order, returns explicit missing-task and unauthorized results, and makes handler failure and timeout advisory. Malformed envelopes are rejected before lookup; no one of these outcomes silently passes a gate.

## Runtime boundary

Managed files have SHA-256 ownership entries in `.latchkit/manifest.json`. Ownership manifest v2 added the selected pack identity, version, source selection, pin state, and provenance; v3 adds narrow managed-section ownership for shared instruction files. Sync preflights every planned destination and stops before changes if any file is unowned, edited, or reached through a symlink/junction. The installer publishes `.latchkit/transaction.json` with exact before/after bytes before its first resource mutation and commits the complete manifest last. A crash before that commit rolls back; a crash after it finalizes. Files that match neither recorded state are preserved as conflicts.

## Task worktree isolation

`src/workspaces/git.js` creates one deterministic worktree per durable task ID. Its record is stored under Git's common directory (`latchkit/workspaces-v1.json`), never in the user's checkout, so starting an isolated task does not add an untracked project file. A record binds the task ID to canonical common-directory and source paths, a private sibling worktree root, worktree path, branch, and immutable base commit. The default branch is `latchkit/task/<task UUID>`; an explicitly supplied branch must be new, and Latchkit never overwrites or deletes user branches.

The default root is a deterministic hidden sibling of the source checkout, keyed by the common Git directory. This supports linked worktrees without placing a worktree in another checkout. Creation uses Git argument vectors and never stashes, resets, cleans, or modifies the source checkout. A repeated request reconciles only matching ownership. If Git created the deterministic worktree but the registry write was interrupted, recovery records it only when branch, HEAD, and clean status exactly match the requested setup; every other occupied target requires manual review.

Cancellation retains the worktree and reports a recovery command, including staged, untracked, and ignored content. Cleanup requires explicit direct-user authorization, rechecks containment below the owned root, rejects links/junctions, missing records, repository or branch mismatches, and any status output including ignored files, then uses non-forced `git worktree remove`. The branch remains. Direct-workspace mode is explicit, returns the selected checkout without creating isolation, and is never selected implicitly. Non-Git, bare, and unavailable-Git environments return capability results rather than falling back to destructive filesystem behavior.

## Skill packs

Configuration v3 selects explicit packs. The bundled `latchkit-core@1.0.0` pack remains the default and includes seven original workflow skills. A local pack is a directory containing `latchkit-pack.json` and declared regular files under `skills/<portable-name>/SKILL.md`. Its manifest declares an ID, semantic version, provenance, supported configuration schema versions and provider IDs, plus SHA-256 checksums. Checksums establish copied-byte integrity; they do not establish publisher trust. Local paths are an explicit user trust decision and are never fetched or executed.

Pins are declarative: Latchkit never searches for or automatically changes a version. To upgrade or roll back, change the selected pack version and source manifest deliberately, review `sync --dry-run`, then sync. The transaction contains both versions' bytes, so an interrupted change recovers through the same journal. An edited managed destination blocks either direction and is preserved for manual resolution. Pack IDs may coexist, but two packs may not claim the same provider destination. Traversal, absolute paths, linked files, case-ambiguous names, Unicode non-NFC paths, and Windows reserved names are refused.

The project lock contains a unique identity and an ephemeral Ed25519 proof endpoint on loopback. Contenders verify the live process rather than trusting a reusable PID. `latchkit recover --dry-run` is read-only; `latchkit recover` only reclaims a cryptographically well-formed lock whose owner no longer answers. Malformed or ambiguous metadata requires manual review. Writes fsync temporary files before rename and sync parent directories where the platform supports it. Storage devices, network filesystems, or operating systems that do not honor these primitives remain outside the durability guarantee. The installer does not defend against a malicious process with equivalent local privileges.

The transaction core accepts registered resource IDs rather than caller-supplied target paths. It journals whole files; provider serializers remain responsible for preserving unrelated JSON, TOML, comments, line endings, and marked sections before submitting their rendered bytes. Ownership manifest v3 keeps full-file hashes separate from narrow project-instruction section hashes. A changed or missing owned section blocks the entire operation; removal strips only the unchanged section and transaction recovery retains exact before/after bytes.

## Project instruction generation

`src/rules/` discovers only bounded, explicit project manifests and toolchain files. It does not invoke package managers, evaluate repository modules, inspect credentials, or copy package-script bodies. Commands are stored as executable-plus-argument arrays and remain marked declared and unverified. The canonical model records generator provenance, selected directory scopes, source paths, original Latchkit guidance, and validated user overrides.

Exporters preserve provider semantics. Codex receives scoped `AGENTS.md` sections. Claude and Gemini import that shared hierarchy when Codex is selected; otherwise Claude uses scoped `.claude/rules` files and Gemini imports a separately owned canonical rule. Cursor receives `.mdc` frontmatter unless its selected Codex export is already discoverable, in which case preview reports the shared visibility and omits the duplicate. Provider selection is not represented as a visibility boundary. Details and limitations are in [project instructions](project-instructions.md).

The HTTP server binds only to `127.0.0.1`, requires a per-launch bearer token for API calls, validates the host and mutation origin, and limits request bodies. The URL fragment carries the token so it is not sent as a normal HTTP URL or referrer. The console serves one fixed project and has no command-execution endpoint.

Operational diagnostics are a separate local contract. Structured failures carry schema version, operation ID, timestamp, stable code, stage, and retry guidance while retaining human-readable messages. Error records are redacted before persistence, capped at 500 events/256 KiB in `.latchkit/diagnostics/events.ndjson`, and never include prompts, provider streams, credentials, authorization headers, full environment, or source contents by default. `latchkit diagnostics` previews an allowlisted bundle containing runtime/configuration metadata, summaries, and recovery evidence; `--export` writes it locally for manual review and never uploads it. Diagnostics can be deleted independently of configuration, installed skills, and task state.
Its private JSON API is versioned with `apiVersion: 1`. Successful state/configuration responses carry an opaque quoted `"sha256:<digest>"` configuration revision (also as `ETag`); a configuration `PUT` must send that exact value in `If-Match`. The persistence lock performs the comparison and write together, returning `428` for a missing precondition and `409 CONFIG_REVISION_CONFLICT` with the current revision for a stale one. A sync preview returns a `planId` digest over the configuration, pack selection, project identity, ownership manifest, and current managed destinations. `POST /api/sync` must return that reviewed ID; it recomputes the digest under the installer lock and returns `409 SYNC_PLAN_STALE` before mutation on drift. A successful sync returns a fresh plan, so retrying an old preview is deliberately rejected rather than applying an unreviewed state. Error payloads always include `apiVersion`, a stable `code`, opaque operation ID, retry guidance, and only safe conflict/revision metadata; they do not include session tokens or stack traces.

Operational diagnostics are a separate local contract. Structured failures carry schema version, operation ID, timestamp, stable code, stage, and retry guidance while retaining human-readable messages. Error records are redacted before persistence, capped at 500 events/256 KiB in `.latchkit/diagnostics/events.ndjson`, and never include prompts, provider streams, credentials, authorization headers, full environment, or source contents by default. `latchkit diagnostics` previews an allowlisted bundle containing runtime/configuration metadata, summaries, and recovery evidence; `--export` writes it locally for manual review and never uploads it. Diagnostics can be deleted independently of configuration, installed skills, and task state.

The skills request plans, meaningful regression tests, reviews, and evidence. The local task-state service can persist that lifecycle and reject stale evidence. The quality-gate evaluator accepts only explicit declared command plans from a normalized, deliberately triggered lifecycle event; it uses the bounded runner under explicit host-local authorization and records the actual boundary and distinct results. It neither installs hooks nor changes provider permissions. Blocking is returned only when both the provider contract and normalized event support it; otherwise failures remain visibly advisory. See [quality gates](quality-gates.md). Notes remain ordinary user-owned Markdown and can be explicitly imported with provenance.

Project memory is a separate, inspectable snapshot at `.latchkit/memory/state-v1.json`; see [ADR 0002](adr/0002-local-project-memory.md). It stores only explicit concise records and has no automatic transcript capture, database, embedding service, MCP server, background scheduler, or provider-memory modification. Local search has no cache separate from the snapshot. Recovery is on-demand and bounded by a caller-selected character budget; it labels returned text untrusted historical context, rechecks source existence/hash, and returns manual mode when provider compaction capability is unavailable. Deleted records are scrubbed from managed searchable fields and excluded from exports, but prior exports, backups, and Git history are outside local deletion scope.

Future enforcement belongs in separate provider adapters with executable integration tests. One provider's hook names, payloads, and approval behavior cannot be assumed valid in another. The [roadmap](roadmap.md) tracks those components separately from portable skill distribution.

The Cursor IDE adapter is the first editor-specific boundary. Its opt-in project hooks use native
Cursor event names and a packaged, bounded Node handler; they do not create an editor session or a
quality-gate service. Translation allowlists non-sensitive fields, records Agent/Tab/workspace
source, and maps only shared lifecycle kinds that have an exact meaning. See the
[Cursor IDE adapter](providers/cursor-ide.md).

## Portability principles

- Keep path handling in Node and avoid required Bash, symlinks, administrator rights, or global configuration writes.
- Keep managed assets project-scoped and preserve user-authored files.
- Treat native Windows and WSL as distinct environments with their own Node installation and executable discovery.
- Verify behavior on all three native operating systems before claiming a release is tested everywhere; a CI matrix definition alone is not evidence of a passing run.
- Leave provider sandboxes and approval policies under the user's control.
