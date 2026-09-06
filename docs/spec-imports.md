# Foreign spec-artifact discovery and preview (issue #114)

This covers the first two reviewable increments of issue #114: read-only
discovery and preview of an external specification framework's local files,
one adapter at a time (Spec Kit, then OpenSpec; TinySpec is the next
increment). It does not import, register, or write anything. TinySpec,
registration into task state, reinspection/detach, and any browser UI are
separate, later increments — see the issue and its parent epic,
[#109](https://github.com/willahealm/latchkit/issues/109).

## What this does and does not do

`src/spec-imports/` enumerates a user-selected local root for one documented
adapter's artifact layout, hashes and parses what it finds, and returns a
bounded, versioned manifest. It never:

- installs, downloads, or invokes the upstream tool, its CLI, scripts,
  templates, or package hooks;
- follows a reference outside the selected root, or a symlink/junction
  anywhere along a scanned path;
- treats a source checkbox or status line as verification evidence — those
  are recorded as an imported claim only;
- writes to disk, including `.latchkit/`; every call is explicitly invoked
  and returns a fresh manifest computed from the current files on disk;
- creates a Latchkit task, record, or association. `preview` describes
  exactly what a later, separate registration action would create and
  returns a `manifestDigest` that action would need to bind to.

## Adapter compatibility table

| Adapter ID | Upstream project                                       | Pinned version/commit                          | Recognized layout                                             | Status                    |
| ---------- | ------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| `spec-kit` | [GitHub Spec Kit](https://github.com/github/spec-kit)   | `v1.0.4` (commit `cb610277fdea781fcfa83d20522c2db37c94068d`, published 2026-09-02) | `<root>/specs/<NNN-slug>/{spec.md,plan.md,tasks.md}` plus explicit local links from those three files | Implemented |
| `openspec` | [OpenSpec](https://github.com/Fission-AI/OpenSpec)       | `v1.12.0` (commit `e062b9572be933564ba3899d059377dfa1393e32`, published 2026-09-03) | `<root>/openspec/specs/**/spec.md` (current capabilities), `<root>/openspec/changes/<name>/{proposal.md,design.md,tasks.md,specs/**/spec.md}` (active), `<root>/openspec/changes/archive/<YYYY-MM-DD-name>/...` (archived), plus explicit local links from the three core files | Implemented |
| `tinyspec` | [tinyspec](https://github.com/nmcdaines/tinyspec)        | Not pinned yet                                  | Not implemented                                                 | Planned (next increment)  |

The pinned commit and release date for each implemented adapter were read
directly from `gh api repos/<owner>/<repo>/tags` and `.../releases` (Spec
Kit on 2026-09-06; OpenSpec on 2026-09-06); see `SPEC_KIT_UPSTREAM` and
`OPENSPEC_UPSTREAM` in `src/spec-imports/contracts.ts`. A future upstream
template change requires bumping the pinned commit and adapter version, not
a silent parsing change — a directory or file that no longer matches the
pinned template's recognizable markers is reported as `unsupported-version`,
not silently accepted.

Calling `discover`/`preview` with `adapter: "tinyspec"` returns a
`SPEC_IMPORT_ADAPTER_NOT_YET_SUPPORTED` error rather than an opaque
unknown-adapter failure, since that adapter is named in the parent issue.

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

## Limits

The same `SpecImportLimits` shape and defaults are shared and enforced by
every adapter (Spec Kit and OpenSpec so far); only the vocabulary differs
slightly per adapter, noted below.

| Limit                     | Default   | What it bounds                                              |
| -------------------------- | --------- | ------------------------------------------------------------ |
| `maxFeatureDirectories`    | 200       | Top-level entries scanned (`specs/*` for Spec Kit; current specs + active changes + archived changes, combined and current-first, for OpenSpec) |
| `maxTotalFiles`            | 2000      | Files (core + supporting) read across the whole discovery    |
| `maxFilesPerEntry`         | 32        | Files read for one feature directory                         |
| `maxFileBytes`             | 512 KiB   | A single file above this is reported and never read          |
| `maxTotalBytes`            | 8 MiB     | Bytes read across the whole discovery                        |
| `maxDepth`                 | 6         | Path segments a resolved supporting link may add beyond root |
| `maxLinksPerArtifact`      | 100       | Markdown links inspected per core file                       |
| `maxTasksPerEntry`         | 500       | Checklist tasks parsed per `tasks.md`                        |
| `maxUserStoriesPerEntry`   | 50        | User-story headings parsed per `spec.md`                     |

Reaching a limit never fails the call; it sets `truncated: true` on the
manifest and records a `discovery-limit-exceeded` (or a more specific)
warning naming what was skipped. A caller may override individual limits
(bounded to 20x the default) through the CLI and API; this exists for
covering unusually large real trees, not for disabling bounding.

## CLI

```powershell
latchkit spec-import discover --root <path> [--adapter spec-kit|openspec]
latchkit spec-import preview --root <path> [--adapter spec-kit|openspec]
```

`--root` is the local directory that directly contains `specs/` (Spec Kit)
or `openspec/` (OpenSpec); it does not need to be the current Latchkit
project (`--project`/`--root` are unrelated here — this command reads no
`.latchkit/` state and writes nothing). `--adapter` defaults to `spec-kit`.
`discover` returns a lightweight per-feature status summary; `preview`
returns the complete manifest, its `manifestDigest`, and a `wouldCreate`
array describing exactly what a later, separate registration action would
create for each registrable (`complete` or `partial`) entry.

## HTTP API

```
GET /api/spec-imports/discover?root=<path>&adapter=spec-kit|openspec
GET /api/spec-imports/preview?root=<path>&adapter=spec-kit|openspec
```

Both require the same per-launch bearer token as every other route (see
[architecture](architecture.md)). `root` is a plain local filesystem path,
not necessarily the console's own project root — this mirrors how e.g. the
managed-FCC tool routes already accept an explicit `root` distinct from the
project. Both routes are read-only `GET`s and do not wait on the project's
own pending-mutation queue.

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
- No adapter in this increment writes an import manifest to disk; a caller
  that wants to keep one must save the `preview` response itself. A durable,
  Latchkit-owned manifest store is part of the deferred registration
  increment.
