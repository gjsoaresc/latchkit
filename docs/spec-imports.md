# Foreign spec-artifact discovery, preview, and registration (issue #114)

This covers all three adapter increments of issue #114 (read-only discovery
and preview of an external specification framework's local files — Spec
Kit, then OpenSpec, then TinySpec) plus the registration increment
(`src/spec-imports/registration-service.ts`): an explicit operation that
binds a selected, previewed entry into existing Latchkit task state.
Browser UI for selection/preview, semantic mapping generation, and
automatic migration remain out of scope — see the issue and its parent
epic, [#109](https://github.com/willahealm/latchkit/issues/109).

## What this does and does not do

`src/spec-imports/service.ts` (`discoverSpecImport`, `previewSpecImport`)
enumerates a user-selected local root for one documented adapter's artifact
layout, hashes and parses what it finds, and returns a bounded, versioned
manifest. Discovery and preview never:

- install, download, or invoke the upstream tool, its CLI, scripts,
  templates, or package hooks;
- follow a reference outside the selected root, or a symlink/junction
  anywhere along a scanned path;
- treat a source checkbox or status line as verification evidence — those
  are recorded as an imported claim only;
- write to disk, including `.latchkit/`; every call is explicitly invoked
  and returns a fresh manifest computed from the current files on disk;
- create a Latchkit task, record, or association on their own. `preview`
  describes exactly what a later, separate `register` call would create and
  returns the `manifestDigest` that call binds to.

`src/spec-imports/registration-service.ts` (`registerSpecImport`,
`reinspectSpecImportRegistrations`, `detachSpecImportRegistration`) adds the
explicit registration operation; see "Registration" below for its contract
and limitations.

## Adapter compatibility table

| Adapter ID | Upstream project                                       | Pinned version/commit                          | Recognized layout                                             | Status                    |
| ---------- | ------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| `spec-kit` | [GitHub Spec Kit](https://github.com/github/spec-kit)   | `v1.0.4` (commit `cb610277fdea781fcfa83d20522c2db37c94068d`, published 2026-09-02) | `<root>/specs/<NNN-slug>/{spec.md,plan.md,tasks.md}` plus explicit local links from those three files | Implemented |
| `openspec` | [OpenSpec](https://github.com/Fission-AI/OpenSpec)       | `v1.12.0` (commit `e062b9572be933564ba3899d059377dfa1393e32`, published 2026-09-03) | `<root>/openspec/specs/**/spec.md` (current capabilities), `<root>/openspec/changes/<name>/{proposal.md,design.md,tasks.md,specs/**/spec.md}` (active), `<root>/openspec/changes/archive/<YYYY-MM-DD-name>/...` (archived), plus explicit local links from the three core files | Implemented |
| `tinyspec` | [tinyspec](https://github.com/nmcdaines/tinyspec)        | `v0.0.9` (commit `d1c122f10f4bddf07299aea0df6f781e403ed340`, published 2026-02-19) | `<root>/.specs/*.md` and `<root>/.specs/<group>/*.md` (one level of grouping; `templates/` excluded) with `tinySpec: v0` front matter, plus explicit local links from the file body | Implemented |

The pinned commit and release date for each adapter were read directly from
`gh api repos/<owner>/<repo>/tags` and `.../releases` (Spec Kit and OpenSpec
on 2026-09-06; tinyspec on 2026-09-06); see `SPEC_KIT_UPSTREAM`,
`OPENSPEC_UPSTREAM`, and `TINYSPEC_UPSTREAM` in
`src/spec-imports/contracts.ts`. A future upstream template change requires
bumping the pinned commit and adapter version, not a silent parsing
change — a directory or file that no longer matches the pinned template's
recognizable markers is reported as `unsupported-version`, not silently
accepted.

## What the Spec Kit adapter recognizes

Under the selected root, only `specs/<feature>/{spec.md,plan.md,tasks.md}` is
scanned — never a loose root-level `spec.md`, and never anything outside
`specs/`. A feature directory is classified as one of:

- `complete` — the directory name matches the pinned `NNN-slug` convention,
  all three core files are present, and `tasks.md` (when present) contains
  at least one recognizable `- [ ] Txxx ...` checklist line while `spec.md`
  and `plan.md` (when present) contain at least one of their pinned
  template's marker lines.
- `partial` — matches the naming convention but is missing one or more core
  files.
- `ambiguous` — has recognizable content but the directory name does not
  follow the pinned `NNN-slug` convention.
- `unsupported-version` — matches the naming convention and has all three
  core files, but at least one no longer matches the pinned template's
  recognizable markers (a customized or different-version format).
- `malformed` — none of the three core files could be read at all.
- `inaccessible` — the feature directory itself could not be read
  (permission denied).

Explicit local links (standard Markdown `[text](path)` syntax, anchors and
external URLs excluded) found in any of the three core files are resolved
relative to that file, checked for existence, and recorded as
`declaredLinks` with `provenance: "explicit-link"`; the referenced file, if
it exists and is within limits, becomes a `supporting` artifact with its own
hash. A link that would resolve outside the selected root, or that targets a
symlink/junction, is refused and reported as a warning — never followed.

Plain-text, path-looking tokens inside a parsed task's description (for
example `src/models/entity1.py` written as prose, not as a Markdown link)
are recorded separately as `inferredReferences` with `provenance: "inferred"`
and `established: false`. They are never resolved against the filesystem,
hashed, or treated as a real dependency — structural co-location or wording
cannot establish one.

Every checkbox and `**Status**:` line is recorded under
`sourceDeclaredStatus` / `parsedIdentifiers.tasks[].checked` tagged
`provenance: "source-declared-claim"`. It is the source author's claim as
written, not something this adapter has verified.

## What the OpenSpec adapter recognizes

Under the selected root, `openspec/specs/**/spec.md` (current, deployed
capability specs — the path between `specs/` and `spec.md` may be nested,
e.g. `identity/user-auth/`, matching OpenSpec's own capability-path
convention), `openspec/changes/<name>/` (active changes), and
`openspec/changes/archive/<YYYY-MM-DD-name>/` (archived changes) are
scanned. Every entry carries a `lifecycle` of `"current"`, `"active"`, or
`"archived"` so a caller can distinguish a deployed spec from an in-flight
or completed change without guessing from its path.

A **current spec** entry is classified as one of:

- `complete` — the capability path is kebab-case per segment, `spec.md` has
  a `## Requirements` heading, and at least one `### Requirement:` entry.
- `partial` — has a `## Requirements` heading but no `### Requirement:`
  entries yet.
- `ambiguous` — recognizable content, but a capability-path segment does not
  follow the pinned kebab-case convention.
- `unsupported-version` — `spec.md` exists but has neither a `## Requirements`
  heading nor a `### Requirement:` entry — not an OpenSpec capability spec
  in the pinned shape, never assumed to be one solely by its filename/location.
- `malformed` — `spec.md` could not be read at all.

An **active** or **archived change** entry uses the same `{proposal.md,
design.md, tasks.md}` three-core-file completeness model as Spec Kit
(`proposal.md` as role `spec`, `design.md` as role `plan`, `tasks.md` as
role `tasks`), classified `complete`/`partial`/`ambiguous`/
`unsupported-version`/`malformed` the same way, plus `inaccessible` when the
change directory itself cannot be read. An active change's directory name
must be kebab-case; an archived change's must be `YYYY-MM-DD-kebab-slug`
(its `slug` has the date prefix stripped). Delta spec files under
`<change>/specs/**/spec.md` are discovered structurally (the same way Spec
Kit discovers its own three core files, not through a Markdown link) and
recorded as `supporting` artifacts; a delta spec missing every
`## ADDED/MODIFIED/REMOVED Requirements` / `## Purpose` marker is reported
with an `unrecognized-delta-spec-format` warning without changing the
change entry's own status. OpenSpec task lines (`- [ ] 1.1 Description`,
no colon, unlike Spec Kit's `Txxx`) are parsed into `parsedIdentifiers.tasks`;
OpenSpec has no user-story convention, so `parsedIdentifiers.userStories` is
always empty and `sourceDeclaredStatus.value` is always `null` — this pinned
version of OpenSpec has no explicit status line to record as a claim.

Explicit local links and plain-text inferred references are handled exactly
as in the Spec Kit adapter (see above), reusing the same shared, generic
helpers (`src/spec-imports/discovery-helpers.ts`).

**Store pointers are never followed.** A `store:` key in
`openspec/config.yaml` — OpenSpec's pointer to a separately registered
[store](https://openspec.dev/docs/stores) repository — is detected and
reported as an `openspec-store-pointer-detected` warning naming what it
points to; this adapter never resolves the pointer, reads a registered
store's location, or looks at a `.openspec-store/` identity file anywhere
but the selected root. Per the stores documentation, a store is an ordinary
git repository the user controls with `git`/`openspec store`; a local
reference to one may be stale until the user pulls, which is exactly why a
detected pointer is reported rather than followed.

## What the TinySpec adapter recognizes

Under the selected root, `.specs/*.md` (ungrouped) and `.specs/<group>/*.md`
(one level of grouping, matching TinySpec's own "only one level deep" rule)
are scanned; `.specs/templates/` is always excluded, and a second level of
grouping is reported with a `nonstandard-tinyspec-nesting` warning and never
scanned. Every entry uses a single `spec` artifact for the whole file (its
`directory` field is the file's own path, since TinySpec's unit is a file,
not a directory) and has `lifecycle: null` — TinySpec documents no
current/active/archived distinction.

A file is classified as one of:

- `complete` — the filename matches the pinned `YYYY-MM-DD-HH-MM-kebab-name.md`
  convention, front matter declares `tinySpec: v0`, and the body has all
  three mandatory `# Background`, `# Proposal`, and `# Implementation Plan`
  sections (exact heading text, matching the pinned CLI's own section
  boundary check — `# Test Plan` is optional, per its own documentation).
- `partial` — `tinySpec: v0` is declared but one or more of the three
  mandatory sections is missing.
- `ambiguous` — recognizable `tinySpec: v0` content, but the filename or
  group-directory name does not follow the pinned naming convention.
- `unsupported-version` — front matter declares a `tinySpec` value other
  than `v0` (a future or different format version).
- `malformed` — no `---`-delimited front matter block is found at all, or
  the block has no `tinySpec` key — a generic Markdown file is never
  classified as a TinySpec file by its filename or `.specs/` location alone.
- `inaccessible` — the file itself could not be read (permission denied).

Front matter is parsed with a minimal YAML subset covering the pinned
`tinySpec`, `title`, and `applications` scalar/list keys (inline `[a, b]` or
block `- a` form) — see "Known limitations" below. Task lines are parsed
only from the `# Implementation Plan` section, stopping at the next
top-level heading, mirroring the pinned CLI's own `parse_tasks` exactly:
`- [ ]`/`- [x] ` followed by an arbitrary `ID:` and description (`A`,
`A.1`, or a customized label — never assumed to be Spec Kit's `Txxx` or
OpenSpec's `N.N`). `# Test Plan` checklist items are not parsed as tasks,
since the pinned CLI's own status computation does not count them either.
TinySpec has no user-story convention, so `parsedIdentifiers.userStories`
is always empty, and no explicit status field, so
`sourceDeclaredStatus.value` is always `null`.

Explicit local links and plain-text inferred references are handled
exactly as in the Spec Kit adapter (see above), reusing the same shared,
generic helpers.

**Application pointers are never followed.** An `applications:` front-matter
list names other repositories that the pinned CLI resolves only through the
user's local `~/.tinyspec/config.yaml` (a machine-local mapping, not part of
the selected root). A non-empty `applications` list is reported as a
`tinyspec-application-pointer-detected` warning naming what it declares;
this adapter never reads `~/.tinyspec/config.yaml` or resolves an
application name to a path.

## Limits

The same `SpecImportLimits` shape and defaults are shared and enforced by
every adapter (Spec Kit, OpenSpec, and TinySpec); only the vocabulary
differs slightly per adapter, noted below.

| Limit                     | Default   | What it bounds                                              |
| -------------------------- | --------- | ------------------------------------------------------------ |
| `maxFeatureDirectories`    | 200       | Top-level entries scanned (`specs/*` for Spec Kit; current specs + active changes + archived changes, combined and current-first, for OpenSpec; `.specs/**/*.md` files for TinySpec) |
| `maxTotalFiles`            | 2000      | Files (core + supporting) read across the whole discovery    |
| `maxFilesPerEntry`         | 32        | Files read for one feature directory (or, for TinySpec, one file's own explicit links) |
| `maxFileBytes`             | 512 KiB   | A single file above this is reported and never read          |
| `maxTotalBytes`            | 8 MiB     | Bytes read across the whole discovery                        |
| `maxDepth`                 | 6         | Path segments a resolved supporting link may add beyond root |
| `maxLinksPerArtifact`      | 100       | Markdown links inspected per core file                       |
| `maxTasksPerEntry`         | 500       | Checklist tasks parsed per entry                              |
| `maxUserStoriesPerEntry`   | 50        | User-story headings parsed per `spec.md` (unused by OpenSpec/TinySpec, which have no user-story convention) |

Reaching a limit never fails the call; it sets `truncated: true` on the
manifest and records a `discovery-limit-exceeded` (or a more specific)
warning naming what was skipped. A caller may override individual limits
(bounded to 20x the default) through the CLI and API; this exists for
covering unusually large real trees, not for disabling bounding.

## CLI

```powershell
latchkit spec-import discover --root <path> [--adapter spec-kit|openspec|tinyspec]
latchkit spec-import preview --root <path> [--adapter spec-kit|openspec|tinyspec]
```

`--root` is the local directory that directly contains `specs/` (Spec Kit),
`openspec/` (OpenSpec), or `.specs/` (TinySpec); it does not need to be the
current Latchkit project (`--project`/`--root` are unrelated here — this
command reads no `.latchkit/` state and writes nothing). `--adapter`
defaults to `spec-kit`. `discover` returns a lightweight per-feature status
summary; `preview` returns the complete manifest, its `manifestDigest`, and
a `wouldCreate` array describing exactly what a later, separate
registration action would create for each registrable (`complete` or
`partial`) entry.

## HTTP API

```
GET /api/spec-imports/discover?root=<path>&adapter=spec-kit|openspec|tinyspec
GET /api/spec-imports/preview?root=<path>&adapter=spec-kit|openspec|tinyspec
```

Both require the same per-launch bearer token as every other route (see
[architecture](architecture.md)). `root` is a plain local filesystem path,
not necessarily the console's own project root — this mirrors how e.g. the
managed-FCC tool routes already accept an explicit `root` distinct from the
project. Both routes are read-only `GET`s and do not wait on the project's
own pending-mutation queue.

## Registration

`src/spec-imports/registration-service.ts` explicitly registers one
selected, previously previewed entry into existing Latchkit task state.
Registration is a distinct increment from discovery/preview above and has a
narrower requirement: unlike `--root` for `discover`/`preview`, the
selected source root for `register` **must be the Latchkit project itself
or a subdirectory of it** (`SPEC_IMPORT_REGISTRATION_ROOT_OUTSIDE_PROJECT`
otherwise), because registration records a project-relative task-record
source link (see below), and that link can only ever name a path inside
the project it belongs to.

### What registration creates

Registering a `complete` or `partial` entry creates one ordinary Latchkit
task (`awaiting-decision`, exactly like `task import`'s existing Markdown
import — no authorization is granted) plus one `observation` task record on
it (issue #110's record contract; `provenance.kind: 'imported'`) whose text
summarizes the source entry (adapter, directory, source-declared status,
source-declared task counts) and whose single `source`-type link names the
project-relative path and SHA-256 of the entry's primary artifact (the
`plan.md`/`design.md` when present, else `spec.md`/`proposal.md`, else
`tasks.md` — the same file `preview`'s `wouldCreate[].wouldCreate.importSource`
already names). `observation` is the only record kind with **no**
authoritative status: moving one to `verified` requires a linked, current,
`passed` task-evidence entry, never import text alone (see
[task records](task-state.md#task-records)). Registration therefore creates
no execution authorization, approved plan, verified task, passing evidence,
or enhanced-workflow enrollment; source checkboxes and status lines remain
imported claims only. Required criteria and runnable checks still require
the existing, separate `spec register`/`registerEnhancedWorkflow` contract
— nothing here calls it. A user who later wants this imported record to
participate in adopted intent explicitly transitions/supersedes it through
the ordinary `task record-transition`/`record-add --supersedes` operations;
issue #111's freshness rules (`intentDigest`, approval invalidation) apply
from that point on exactly as they do for any other record.

Latchkit's own association metadata — which discovered entry maps to which
task/record, and at what source hash — is tracked separately from the task
record, in a small store at `.latchkit/spec-imports/registrations-v1.json`
(schema: [spec-import-registration-v1](../schemas/spec-import-registration-v1.schema.json)).
This is the "reviewable revision of the same source association" criterion
(4) asks for: it is what `reinspect` and `detach` operate on. It never
holds a copy of the source file, only its path and hash.

### Freshness binding and idempotency

`register` takes the exact `manifestDigest` from a `preview` the caller
reviewed, plus the exact `wouldCreate[].wouldCreate.importSource.sha256`
for the selected entry from that same preview. Before any write, it rebuilds
the manifest fresh from the current files on disk and rechecks both: a
mismatch on either (a source file changed anywhere in the discovery, or
specifically the selected entry's primary artifact) fails closed with
`SPEC_IMPORT_STALE_PREVIEW` before any mutation — never a partial or
best-guess import.

Repeating an identical `register` call (same adapter/source root/entry,
content unchanged since the last registration) is idempotent: it makes no
new task-state mutation and returns `action: 'unchanged'` with the existing
association. When the artifact's content changed since the last
registration, `register` supersedes the prior task record with a new one
(`recordTaskRecord` with `supersedes`) on the **same** task and association
— `action: 'revised'` — rather than creating a duplicate task; this call
requires `expectedTaskRevision` (the task revision the caller last
observed, e.g. from `reinspect`), checked with the same
`TASK_REVISION_CONFLICT` semantics as every other Latchkit task mutation,
so an intervening, unrelated mutation to that same task is never silently
overwritten.

When a selected entry does not match any currently active registration,
but a **different**, now-missing registration (same adapter/source root)
has byte-identical primary-artifact content, this is reported as an
`ambiguities` entry (`matchesRegistrationId`, `matchesPreviousDirectory`)
rather than silently treated as the same source moved or renamed. The new
entry is still registered as its own, independent association; detach the
prior one explicitly if it is in fact the same artifact.

### Reinspection

`reinspect` (no `--id`: every registration in the project; with `--id`: one)
recomputes each registration's primary artifact's current state against its
registered snapshot, without rewriting anything: `current` (unchanged),
`changed` (hash differs), `missing` (`ENOENT`), or `unreadable` (any other
read failure, e.g. the path now resolves to a directory). The historical
hash is always preserved in the registration's `history`. It also reports
the associated task's current revision when the task can still be read, so
a caller has the value `register`'s `expectedTaskRevision` needs for a
subsequent revision update.

### Detach

`detach` (`--id`, `--expected-revision`) marks a registration `detached` in
the association store only: it never touches the source file or the task
record it points at. Detaching an already-detached registration is a
no-op. A stale `--expected-revision` fails with
`SPEC_IMPORT_REGISTRATION_REVISION_CONFLICT` rather than silently
overwriting a concurrent change to the same registration.

### CLI

```powershell
latchkit spec-import register --project <path> --root <path> [--adapter spec-kit|openspec|tinyspec] \
  --entry <entryId> --manifest-digest <sha256> --source-sha256 <sha256> \
  [--expected-task-revision <n>]
latchkit spec-import reinspect --project <path> [--id <registrationId>]
latchkit spec-import detach --project <path> --id <registrationId> --expected-revision <n>
```

### HTTP API

```
POST /api/spec-imports/register   { sourceRoot, adapter?, entryId, manifestDigest, sourceSha256, expectedTaskRevision? }
GET  /api/spec-imports/reinspect?id=<registrationId>
POST /api/spec-imports/detach     { id, expectedRevision }
```

All three require the same per-launch bearer token as every other route and
operate on the console's own project (unlike `discover`/`preview`, which
accept an unrelated `root`). `register` and `detach` are serialized through
the same pending-mutation queue as every other task-state-touching route.

### Persistence and locking

The association store is written with the same atomic-rename primitive
(`writeAtomic`) every other Latchkit-owned store uses, and every
registration/detach operation holds the project-wide lock
(`withProjectLock`, `src/installer/lock.ts` — the same lock
`src/managed-tools/fcc.ts` and `src/integrations/mcp/managed.ts` use for
their own managed state) across the whole operation. The task-state half
(the task and its imported record) commits first, through the existing,
separate task-state lock/expected-revision/idempotency boundary
(`src/task-state/lock.ts`, `mutate()`); the association-store write is a
secondary, idempotent index kept consistent with it, mirroring how
`applyTaskReconciliation` treats its workflow acknowledgment as secondary to
the task-state commit (see
[reconciling changed intent](task-state.md#reconciling-changed-intent)). If
the process is interrupted between the two commits, no file is left
partially written (`writeAtomic` never leaves a partial file), and a
retried `register` call for the same entry detects the already-committed
task record by its deterministic (non-secret) provenance reference and
completes only the missing association, rather than creating a duplicate
task.

This module deliberately does not route the association store through
`src/installer/transactions.ts`'s `applyRegisteredTransaction`, even though
that is the registered-resource/transaction facility other managed state
(FCC, managed MCP config, provider install) uses: that facility's
before/after journal is anchored to one project-wide `.latchkit/manifest.json`
file, which is installer-owned state describing generated provider files —
coupling an unrelated feature's writes to it would either require depending
on a prior `latchkit install` for no real reason, or silently overwriting
that shared file's content. `writeAtomic` plus `withProjectLock` gives the
same interruption- and collision-safety (atomic replace; no concurrent
writer) without that coupling.

## Known limitations

- Parsing is line-based regular expressions tuned to each pinned template's
  documented shapes, not a full Markdown/CommonMark AST or YAML parser.
  Reordering the documented Spec Kit `[ID] [P?] [Story] Description` task
  fields, or splitting a Markdown link across lines, is not recognized.
- `unsupported-version` classification is a heuristic marker check (a few
  characteristic lines per file), not a structural diff against the pinned
  template.
- Manifest byte/file limits bound what is *read into* the manifest; the
  directory walk itself is only bounded by `maxFeatureDirectories` (Spec
  Kit) or `maxDepth` plus the per-entry file list (OpenSpec's recursive
  capability-path/delta-spec walk), so a pathological tree still costs one
  bounded `readdir` per candidate before a limit stops further processing.
- The OpenSpec adapter does not parse `.openspec.yaml` change metadata
  (`schema`, `created`, `skip_specs`, `retire_capabilities`); a change using
  a custom schema (not the built-in `spec-driven` artifact set) is reported
  as `partial`/`unsupported-version` based on the built-in three-file model,
  not recognized as its own schema.
- The OpenSpec adapter detects an `openspec/config.yaml` store pointer at
  the selected root only; it does not read a store's own
  `.openspec-store/store.yaml` identity file (which would itself require
  following the pointer, something this adapter never does).
- The TinySpec adapter's front-matter parser is a minimal YAML subset
  (scalar keys plus a single-level `applications` list, inline or block
  form); nested maps, multi-line scalars, anchors, or other YAML features
  are not supported and may cause a customized front matter to be reported
  as `malformed` rather than parsed. Its filename-timestamp check
  (`YYYY-MM-DD-HH-MM-`) is a naming-convention check this adapter adds for
  honest reporting — the pinned upstream CLI itself does not validate the
  prefix's characters when reading an existing file, only when creating one.
- `discover`/`preview` still write nothing to disk; a caller that wants to
  keep a manifest must save the response itself. Only the explicit
  `register`/`detach` operations write the durable, Latchkit-owned
  association store described above.
- Registration tracks only the entry's single primary artifact (the same
  one `wouldCreate[].wouldCreate.importSource` names); it does not create a
  separate task record per supporting artifact or declared link. A future
  increment could extend this without changing the association shape.
- Registration requires the selected source root to be the Latchkit
  project or a subdirectory of it (see "Registration" above); it cannot
  register an entry discovered from an unrelated local root the way
  `discover`/`preview` can.
- Browser UI for reviewing and selecting entries to register, semantic
  mapping generation/confirmation, and automatic migration remain out of
  scope for this increment, matching the parent issue.
