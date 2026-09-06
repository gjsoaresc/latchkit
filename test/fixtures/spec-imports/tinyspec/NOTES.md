# TinySpec fixture provenance

All Markdown under this directory is original prose written for Latchkit's
test suite. It follows the front-matter/section/checklist shapes documented
by TinySpec's pinned release (see `TINYSPEC_UPSTREAM` in
`src/spec-imports/contracts.ts` and the compatibility table in
`docs/spec-imports.md`), but no upstream template or example text is
reproduced here.

- `.specs/2026-02-01-10-00-add-login.md` — a complete, well-formed spec
  (front matter, all four sections, grouped tasks with an explicit link to
  `docs/add-login-notes.md` and a plain-text inferred reference).
- `docs/add-login-notes.md` — a plain supporting document linked from the
  spec above, kept outside `.specs/` so it is never itself discovered as an
  entry.
- `.specs/v1/2026-02-02-11-00-billing.md` — only a `# Background` section,
  to exercise the `partial` status.
- `.specs/v1/2026-02-03-12-00-Weird.md` — otherwise well-formed content
  whose filename's name portion uses an uppercase letter, to exercise the
  `ambiguous` status.
- `.specs/v1/2026-02-06-14-00-add-login.md` — reuses the name `add-login`
  from the ungrouped spec above, to exercise duplicate-name detection
  (TinySpec requires names to be globally unique across groups).
- `.specs/2026-02-04-09-00-legacy-notes.md` — a correctly-named, correctly
  located file with no `tinySpec:` front matter at all, to prove a generic
  Markdown file is never classified as a TinySpec spec by filename/location
  alone (`malformed`).
- `.specs/2026-02-05-13-00-future-format.md` — declares `tinySpec: v1`, to
  exercise the `unsupported-version` status (this adapter is pinned to `v0`).
- `.specs/2026-02-07-15-00-multi-repo.md` — declares `applications:`, to
  exercise the application-pointer warning; those names are resolved only
  through the user's local `~/.tinyspec/config.yaml`, which this adapter
  never reads.
- `.specs/templates/default.md` — proves the `templates/` directory is
  excluded from discovery regardless of its content.
- `.specs/v1/nested/2026-02-08-16-00-too-deep.md` — a second level of
  grouping, to prove only one level is recognized.
