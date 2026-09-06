# OpenSpec fixture provenance

All Markdown and YAML under this directory is original prose written for
Latchkit's test suite. It follows the section/heading/checklist shapes
documented by OpenSpec's pinned release (see `OPENSPEC_UPSTREAM` in
`src/spec-imports/contracts.ts` and the compatibility table in
`docs/spec-imports.md`), but no upstream template or example text is
reproduced here.

- `openspec/specs/auth/spec.md` — a complete, well-formed current spec.
- `openspec/specs/identity/user-auth/spec.md` — a complete current spec under
  a two-segment capability path, to exercise nested capability directories.
- `openspec/specs/billing/spec.md` — has a recognizable `## Requirements`
  heading but no `### Requirement:` entries yet, to exercise the `partial`
  current-spec status.
- `openspec/specs/Weird_Name/spec.md` — otherwise well-formed content under a
  directory name that violates the pinned kebab-case convention, to exercise
  the `ambiguous` status.
- `openspec/specs/scratch/spec.md` — unrelated freeform notes at the location
  a current spec would use, to prove a generic `spec.md` is never classified
  as an OpenSpec capability by filename/location alone (`unsupported-version`).
- `openspec/changes/add-mfa/` — a complete, well-formed active change (proposal,
  design, tasks, one explicit supporting link to `research-notes.md`, and a
  delta spec at `specs/auth/spec.md`).
- `openspec/changes/quick-fix/` — only `proposal.md`, to exercise the `partial`
  change status.
- `openspec/changes/legacy_change/` — all three core files present and
  well-formed, but the directory name uses an underscore instead of a hyphen,
  to exercise the `ambiguous` change status.
- `openspec/changes/archive/2025-01-24-add-2fa/` and
  `openspec/changes/archive/2025-06-01-add-2fa/` — two archived changes that
  intentionally share the base slug `add-2fa` (different date prefixes), to
  exercise archived-change duplicate-slug detection.
- `openspec/config.yaml` — declares a `store:` pointer, to exercise the
  store-pointer warning; this adapter never resolves or reads what it names.
