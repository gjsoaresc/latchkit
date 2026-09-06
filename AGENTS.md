# Latchkit agent and contributor contract

## Project shape

Latchkit is an MIT-licensed, original strict TypeScript application with a Node.js 22+ ESM CLI and local browser UI. Runtime code is in `src/`, the UI is in `web/`, canonical portable skills are in `skills/`, JSON contracts are in `schemas/`, and tests are in `test/`. TypeScript is compiled to emitted ESM under `dist/`; standalone CommonJS hook handlers remain `.cts` sources. BAML selects delivery actions and phase prompts; TypeScript executes authorized sessions through existing coding tools, which retain authentication and their configured models.

## Commands

Run these from the repository root after installing Node.js 22 or newer and Git:

```powershell
npm ci
npm run check
npm test
```

The same commands work in a POSIX shell. `npm run check` performs deterministic formatting validation, TypeScript typechecking/build validation, ESLint, recursive skill metadata/reference validation, and schema validation. Use `npm run format` to apply the repository formatter, then rerun `npm run check`. Use `npm start` to launch the local UI. BAML workflow sources use the pinned 0.17.0 toolchain and generated TypeScript SDK; use the repository BAML scripts when editing them.

## Change boundaries

Preserve observable CLI/HTTP behavior, the Node 22 support floor, user-authored files, permissions, and provider approval policies. Keep changes bounded to the issue and do not merge, publish, deploy, spend on provider sessions, change credentials, or claim real-provider verification without evidence. Use Node filesystem APIs and portable paths; do not require Bash, WSL, symlinks, administrator rights, or global configuration writes. Managed filesystem changes go through the registered-resource transaction layer. The planned release route is GitHub Releases with user-local standalone bundles; npm remains development tooling and is not a required end-user installation path.

## Tests and evidence

Add focused regression tests for behavioral changes and failure paths. Run `npm ci`, `npm run check`, `npm test`, and any affected command. Report exact commands, Node version, platform, results, and limitations; distinguish configured CI cells from actually executed provider or OS tests. Keep canonical skill edits under `skills/`; generated provider copies are distribution artifacts.

## Provenance

Implementation and bundled skill text must be original or MIT-compatible with attribution. Do not copy proprietary provider or Pilot Shell source, instructions, documentation, or visual assets. Read `README.md`, `docs/architecture.md`, `docs/compatibility.md`, and `CONTRIBUTING.md` before broad changes.
