# Project instructions

Latchkit builds a deterministic, provider-neutral instruction model from explicit project metadata and serializes that model to the selected providers' documented discovery surfaces. `latchkit sync --dry-run` is the review boundary: it returns every proposed file action, the exact generated instruction body, model provenance, scopes, declared command argument arrays, and discovery warnings without writing files.

## Discovery boundary

Discovery reads regular files no larger than 256 KiB. It recognizes `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `.nvmrc`, `.node-version`, and `rust-toolchain.toml`, plus package roots explicitly named by npm workspace patterns. A workspace `*` expands only one directory level and linked directories are ignored. By default all discovered scopes are selected; callers can choose an exact subset with validated project-relative paths.

Latchkit does not run package scripts, load repository modules, invoke a package manager, scan source code, read `.env` or credential files, or contact a provider. A declared build, test, or lint entry becomes an executable and argument array such as `npm` plus `["run", "test"]`; the script body is not copied. Every discovered fact and command names its source and remains unverified until a user actually runs and observes it.

## Provider serialization

- Codex uses managed sections in `AGENTS.md` at each discovered scope. Root-to-working-directory precedence still applies. A same-directory `AGENTS.override.md` can shadow the export, so preview reports it.
- Claude uses separately owned `.claude/rules/latchkit-*.md` files. When Codex is also selected, a narrow `@AGENTS.md` section in the corresponding `CLAUDE.md` avoids duplicating the instruction body.
- Gemini uses a narrow import in the corresponding `GEMINI.md`. It imports `AGENTS.md` when Codex is selected or a separately owned `.latchkit/rules/*.md` file otherwise. A user's customized Gemini context filename can prevent the default file from loading; Latchkit does not rewrite Gemini settings.
- Cursor uses separately owned `.cursor/rules/latchkit-*.mdc` files with `description`, `globs`, and `alwaysApply: false`. When Codex is selected, Cursor can already discover the `AGENTS.md` hierarchy, so Latchkit reports that shared visibility and omits the duplicate `.mdc` export.

Provider selection controls what Latchkit writes, not what another compatible tool can see. Scoped discovery also differs among providers; preview warnings describe known sharing or shadowing instead of claiming isolation.

## Ownership and reversal

Separately owned files use full-file SHA-256 ownership. Shared instruction files use narrow start/end markers and store the exact managed-section hash in ownership manifest v3. Sync preserves unrelated bytes and the existing newline style. An unowned marker, a missing managed section, a locally edited managed section, or an unowned separate destination blocks the complete transaction with an actionable conflict.

Removal deletes only unchanged separately owned files and unchanged marked sections. Human-authored text, comments, local hierarchy, and provider settings remain. The registered-resource transaction journal records exact before/after bytes before mutation, so an interruption can roll back or finalize using `latchkit recover`; ambiguous external edits are preserved as recovery conflicts.

Generated guidance never grants permission, weakens provider approval policy, suppresses review, or claims a command passed. User overrides are explicit model inputs, retain user provenance, and are rejected when they attempt those policy changes.
