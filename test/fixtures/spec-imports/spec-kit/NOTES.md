# Spec Kit fixture provenance

All Markdown under this directory is original prose written for Latchkit's
test suite. It follows the section/heading/checklist shapes documented by
GitHub Spec Kit's pinned release (see `SPEC_KIT_UPSTREAM` in
`src/spec-imports/contracts.ts` and the compatibility table in
`docs/spec-imports.md`), but no upstream template text is reproduced here.

- `specs/001-example-feature/` — a complete, well-formed feature (spec, plan,
  tasks, and one explicit supporting link to `research.md`).
- `specs/002-partial-feature/` — only `spec.md`, to exercise the `partial`
  status.
- `specs/legacy-notes/` — a feature-like directory that does not follow the
  pinned `NNN-slug` naming convention, to exercise the `ambiguous` status.
- `specs/003-custom-tasks/` — `spec.md`/`plan.md` match the pinned template
  markers but `tasks.md` is a customized, non-checklist format, to exercise
  the `unsupported-version` status.
- `specs/004-missing-link/` — `plan.md` links to a `data-model.md` that was
  never added, to exercise the `missing-referenced-file` warning.
- `spec.md` (fixture root, outside `specs/`) — proves a generic `spec.md` is
  never classified as a Spec Kit feature by filename alone.
