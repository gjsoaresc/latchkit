# Generated output inventory

This is the complete inventory of locations the repository's own build,
test, and release tooling creates. Nothing outside this list is a
Latchkit-owned generated location; an ignored filename or directory prefix
alone does not establish ownership, and cleanup tooling never guesses beyond
what is documented here.

| Location | Owner | Lifetime | Retention | Cleanup entrypoint |
| --- | --- | --- | --- | --- |
| `dist/` | `npm run build` (`scripts/build.ts`) | Until the next build or cleanup | None; fully regenerated from source | `npm run build` (reconciles in place) or `npm run clean --scope dist --apply` |
| `dist/web/licenses/<package>@<version>/` | `scripts/browser-licenses.ts`, invoked from `scripts/build.ts` | One build | None; a package that stops contributing bytes has its directory reclaimed automatically on the next build | Automatic (`npm run build`); not a separate `npm run clean` scope |
| `test-results/` (Playwright's output directory, including the `acceptance-<browser>-<uuid>` and `browser-crash-<browser>-<uuid>` fixtures created by `test/browser/acceptance-evidence.spec.js`) | `npm run test:browser` | One test run; each fixture is uniquely named and never referenced again | None; safe to remove at any time | `npm run clean` (default scope) or `npm run clean --scope test-results --apply` |
| `coverage/` | Reserved for a future coverage tool; not currently produced by any tracked command | N/A | None | `npm run clean` (default scope; a no-op today) |
| `.latchkit-typecheck.log` | Ad hoc: a developer manually redirecting `tsc`/`npm run typecheck` output | Until manually removed | None; not produced by any tracked command | `npm run clean` (default scope) |
| `*.tgz` at the repository root | `npm pack` | Until manually removed | None; a development inspection artifact, not the release artifact | `npm run clean` (default scope) |
| `release-artifacts/`, `release-artifacts-*/` | `npm run release:artifacts` (`scripts/release-artifacts.js`, `scripts/bundle.js`) | Staged archives, checksum/manifest/SBOM sidecars, retained `previous/` upgrade evidence, and qualification `.evidence.json` records persist until a maintainer prunes them | Mixed: regenerable staging alongside deliberately retained upgrade/qualification evidence (see [releases](releases.md)). Not pruned automatically | `npm run clean --scope release-artifacts --apply` removes the whole directory wholesale; excluded from the default scope because deciding which staged release is still referenced is release domain knowledge cleanup does not have. Fine-grained per-version pruning that preserves selected or referenced releases is a deferred follow-up (see Known limitations below) |
| OS temp scratch directories: `latchkit-bundle-*`, `latchkit-release-verify-*`, `latchkit-native-smoke-*`, `latchkit-artifact-*`, `latchkit-live-lifecycle-*`, `latchkit-provider-adapter-*`, `latchkit-live-provider-*`, `latchkit-live-workflow-*`, `latchkit-bench-*` under the OS temp root | `scripts/bundle.js`, `scripts/release-artifacts.js` (verification), `scripts/bundle-smoke.js`, `scripts/artifact-smoke.js`, `scripts/live-lifecycle-evidence.js`, `scripts/live-provider-adapter-evidence.js`, `scripts/live-workflow-evidence.js`, `scripts/benchmarks.js` | Normally removed in a `finally` block at the end of the run that created it | None once orphaned by an interrupted run | `npm run clean` (`tmp` scope, in the default set): only directories matching this repository's own exact `mkdtemp` prefixes -- never a generic wildcard, so a shared machine's unrelated `latchkit-`-prefixed directories from other processes are never touched -- and only once older than the retention window (24 hours by default; override with `--older-than-ms`), so a directory that may belong to a run still in progress is left alone |
| Mounted-project smoke fixtures (the path passed via `--mounted-project <path>` to `scripts/bundle-smoke.js` / `scripts/artifact-smoke.js`, typically a WSL-mounted drive used to prove cross-filesystem behavior) | The caller who supplies `--mounted-project` | Indefinite; nothing in this repository removes it automatically | Caller-owned | None. This path is explicitly outside every root `npm run clean` can safely discover (it is not repo-relative and not under the OS temp root), so it is never touched -- the caller is responsible for its own fixture's lifecycle |

## Reconciliation vs. cleanup

Two different mechanisms cooperate to keep generated output from
accumulating, and they are not interchangeable:

- **Build reconciliation** happens automatically inside `npm run build`
  every time it runs, without a separate `--clean` flag. `scripts/build.ts`
  now captures the exact set of files `tsc` reports emitting
  (`--listEmittedFiles`), copies the current `skills/` and `schemas/` source
  trees before comparing them against what is already in `dist/`, and asks
  `scripts/browser-licenses.ts` to reconcile its own destination against the
  packages that actually contributed bytes this run. Anything left over from
  a source file that was deleted or renamed since the previous build --
  a stale compiled module, an orphaned skill or schema file, or a browser
  dependency's old version-keyed license directory -- is removed as part of
  the same build, not left to silently coexist with the current output.
  This is implemented with the shared `listFiles`/`reconcileDirectory`
  helpers in `scripts/reconcile.ts` (covered by `test/reconcile.test.js`,
  `test/browser-licenses.test.js`).
- **`npm run clean`** is a standalone, cleanup-only command
  (`scripts/clean.js`) for the locations in the table above. It never
  rebuilds, installs dependencies, or launches a provider. Run bare, it is a
  dry run: it reports exactly what it would remove, with per-item retention
  reasons and a total reclaimable byte estimate, and makes no filesystem
  changes. Pass `--apply` (or run `npm run clean:apply`) to actually remove
  what the same, freshly recomputed plan finds -- applying always
  revalidates each item's existence, kind, and link status immediately
  before removing it, so a plan is never trusted as stale state. Use
  `--scope <name>[,<name>...]` to limit to one or more of `dist`,
  `test-results`, `coverage`, `typecheck-log`, `tgz`, `tmp`, or the
  explicitly opt-in `release-artifacts`; use `--json` for a machine-readable
  report. `npm run clean` never touches source files, `.latchkit/` project
  state, plans, configuration, memory, task/evidence state, dependencies,
  git history, worktrees, or branches -- it only ever considers the fixed
  locations documented above, and an ignored filename or directory prefix
  alone is never treated as ownership.

## Release archive publication

`scripts/bundle.js` stages the release archive next to its final name in
`release-artifacts/` (or the configured `--output` directory) before
touching that directory for real, then publishes the archive and its three
sidecars (`.sha256`, `.spdx.json`, `.manifest.json`) through
`scripts/atomic-publish.js`: each file is written to a same-directory
temporary name and renamed into place, and the manifest is committed last
because `verifyReleaseArtifacts`/`bundle-smoke.js` discover a published
artifact by the presence of its `*.manifest.json` file. If any step fails --
including a locked file, a full disk, or the sidecar write itself -- every
file this operation staged or already committed is removed before the error
propagates, so a previously published, distinct archive elsewhere in the
same directory is never touched, and a failed run never leaves a set that
reads as complete. An interruption that outlives the process (a kill signal
the process cannot handle) can still leave operation-owned temporary or
partially committed files behind; those are exactly the leftovers
`npm run clean`'s `tmp` scope and the explicit `release-artifacts` scope are
for. See [`test/atomic-publish.test.js`](../test/atomic-publish.test.js) for
the covered success, mid-publish-failure, and retry scenarios.

## Known limitations

- **Retained installation-version cleanup** (pruning old `versions/<version>`
  and hook-compatibility directories inside an *installed* standalone
  bundle, checked against the active runtime, running operations, rollback
  targets, and provider-hook references) is not implemented here. This is
  runtime/installer state, not a repository build artifact, and the current
  installer conservatively retains every version directory it has ever
  staged (see [releases](releases.md#install-upgrade-rollback-and-uninstall)).
  Implementing reference-aware pruning safely belongs with the installation
  manager's own transactional code and is coordinated with issue #98, not
  bundled into this change.
- **Per-version `release-artifacts` pruning** that preserves selected or
  referenced releases while reclaiming superseded ones is not implemented.
  `npm run clean --scope release-artifacts --apply` only removes the entire
  local staging directory wholesale; it does not selectively prune inside
  `previous/` or among multiple staged versions. Determining which staged
  release is still referenced is release domain knowledge this command does
  not have.
- **Worktree, branch, and staged/untracked/ignored user-change cleanup** is
  explicitly out of scope for `npm run clean`, which is reserved for issue
  #93's existing rules; this command never touches `.git`, worktrees, or
  branches.
- **`dist/web`'s per-file TypeScript compiles for modules never imported by
  `web/app.tsx`** (for example an unused `web/*.tsx` component) are
  reconciled the same way as any other renamed/deleted source, but the
  underlying build still asks `tsc` to emit a standalone compiled copy of
  every `web/*.ts(x)` file even though only the esbuild bundle at
  `dist/web/app.js` ships to the browser. Restructuring the build so `tsc`
  only type-checks `web/` without emitting redundant per-file output is a
  separate build-pipeline change, not a cleanup concern, and is not made
  here.
