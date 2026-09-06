# Tooling TypeScript migration

Issue #99 migrates handwritten repository tooling incrementally so the first
strictly checked tools can bootstrap their own emitted execution path without
requiring a Node minor-version-specific TypeScript loader. The bootstrap slice
is compiled by `tsconfig.tools.json` before `dist/scripts/build.js` or
`dist/scripts/check.js` runs.

The following handwritten JavaScript files remain temporary migration debt;
they are still syntax-checked by `scripts/check.ts` and are not a permanent
exception to the TypeScript policy:

- `scripts/archive-tool.js`, `artifact-smoke.js`, `atomic-publish.js`,
  `bundle-smoke.js`, `bundle.js`, `clean.js`, `collect-release-evidence.js`,
  `live-lifecycle-evidence.js`, `live-provider-adapter-evidence.js`,
  `live-workflow-evidence.js`, `provider-e2e.js`, `release-artifacts.js`,
  `requirement-change-evaluations.js`, `skill-evaluations.js`,
  `workflow-evidence-options.js`, `workflow-evidence-proof.js`, and
  `workflow-plan-proof.js`.
- `scripts/test-helpers/crash-resource.js`, `crash-sync.js`,
  `crash-task-state.js`, and `cursor-ide-crash-hook-export.js`.

`test/**/*.js` remains deliberately outside this migration slice. Its
CommonJS fixtures and test harness contracts are preserved for a later,
separate conversion.
