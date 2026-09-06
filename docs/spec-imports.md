# Foreign spec-artifact discovery and preview (issue #114)

This is the first reviewable increment of issue #114: read-only discovery
and preview of an external specification framework's local files, pinned to
one dialect at a time. It does not import, register, or write anything.
OpenSpec, TinySpec, registration into task state, reinspection/detach, and
any browser UI are separate, later increments — see the issue and its parent
epic, [#109](https://github.com/willahealm/latchkit/issues/109).

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
| `spec-kit` | [GitHub Spec Kit](https://github.com/github/spec-kit)   | `v1.0.4` (commit `cb610277fdea781fcfa83d20522c2db37c94068d`, published 2026-09-02) | `<root>/specs/<NNN-slug>/{spec.md,plan.md,tasks.md}` plus explicit local links from those three files | Implemented (this increment) |
| `openspec` | [OpenSpec](https://github.com/Fission-AI/OpenSpec)       | Not pinned yet                                  | Not implemented                                                 | Planned (later increment)  |
| `tinyspec` | [tinyspec](https://github.com/nmcdaines/tinyspec)        | Not pinned yet                                  | Not implemented                                                 | Planned (later increment)  |

The pinned commit and release date were read directly from
`gh api repos/github/spec-kit/tags` and `.../releases` on 2026-09-06; see
`SPEC_KIT_UPSTREAM` in `src/spec-imports/contracts.ts`. A future upstream
template change requires bumping the pinned commit and adapter version, not
a silent parsing change — a directory that no longer matches the pinned
template's recognizable markers is reported as `unsupported-version`, not
silently accepted.

Calling `discover`/`preview` with `adapter: "openspec"` or `"tinyspec"`
returns a `SPEC_IMPORT_ADAPTER_NOT_YET_SUPPORTED` error rather than an opaque
unknown-adapter failure, since those adapters are named in the parent issue.

## What the adapter recognizes

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

## Limits

| Limit                     | Default   | What it bounds                                              |
| -------------------------- | --------- | ------------------------------------------------------------ |
| `maxFeatureDirectories`    | 200       | `specs/*` entries scanned                                    |
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
latchkit spec-import discover --root <path> [--adapter spec-kit]
latchkit spec-import preview --root <path> [--adapter spec-kit]
```

`--root` is the local directory that directly contains `specs/`; it does not
need to be the current Latchkit project (`--project`/`--root` are unrelated
here — this command reads no `.latchkit/` state and writes nothing).
`discover` returns a lightweight per-feature status summary; `preview`
returns the complete manifest, its `manifestDigest`, and a `wouldCreate`
array describing exactly what a later, separate registration action would
create for each registrable (`complete` or `partial`) entry.

## HTTP API

```
GET /api/spec-imports/discover?root=<path>&adapter=spec-kit
GET /api/spec-imports/preview?root=<path>&adapter=spec-kit
```

Both require the same per-launch bearer token as every other route (see
[architecture](architecture.md)). `root` is a plain local filesystem path,
not necessarily the console's own project root — this mirrors how e.g. the
managed-FCC tool routes already accept an explicit `root` distinct from the
project. Both routes are read-only `GET`s and do not wait on the project's
own pending-mutation queue.

## Known limitations

- Parsing is line-based regular expressions tuned to the pinned template's
  documented shapes, not a full Markdown/CommonMark AST. Reordering the
  documented `[ID] [P?] [Story] Description` task fields, or splitting a
  Markdown link across lines, is not recognized.
- `unsupported-version` classification is a heuristic marker check (a few
  characteristic lines per file), not a structural diff against the pinned
  template.
- Manifest byte/file limits bound what is *read into* the manifest; the
  directory walk itself is only bounded by `maxFeatureDirectories` and the
  per-entry file list (three core files plus explicit links), so a
  pathological root with thousands of `specs/*` directories still costs one
  bounded `readdir` per candidate before the feature-directory limit stops
  further processing.
- No adapter in this increment writes an import manifest to disk; a caller
  that wants to keep one must save the `preview` response itself. A durable,
  Latchkit-owned manifest store is part of the deferred registration
  increment.
