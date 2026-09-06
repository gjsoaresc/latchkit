# Homebrew packaging — status

**Scaffold, not published.** `latchkit.rb` is not tapped anywhere and cannot
be installed with `brew install` today. This document is explicit about what
is real and what is a placeholder.

## What is real

- The install mechanism `latchkit.rb` drives is the actual, shipped
  `src/installation/manager.ts` — the same code `install.sh` calls into
  (via `app/dist/src/installation/entry.js`). It is not a reimplementation.
- The formula's `install` step stages the bundle, verifies every file
  against the embedded `bundle-manifest.json` checksum, runs the manager's
  smoke check, and only then creates the launcher — identical guarantees to
  a direct `install.sh` run, on top of Homebrew's own top-level archive
  `sha256` verification.
- The `caveats` block's description of upgrade/uninstall ownership
  (Homebrew manages its own Cellar root; it never touches a separate direct
  install or any project's `.latchkit/` state) matches how the manager
  actually behaves — `--root` scopes every operation to exactly the
  directory passed to it.

## What is placeholder / not yet done

- `version`, every `url`, and every `sha256` in `latchkit.rb` are
  placeholders (`0.0.0` / all-zero digests). They must be filled in from an
  actual tagged, qualified GitHub Release before this formula is usable.
- **The archives it references do not exist yet.** `docs/releases.md`
  qualifies only `win32-x64` for 1.0; `darwin-arm64`, `darwin-x64`, and
  `linux-x64` are deferred experimental targets with no published, qualified
  archive. This formula cannot be exercised end-to-end until that changes.
- The formula has never been run through `brew install --build-from-source`,
  `brew audit`, or any CI. Treat it as a design sketch of the mechanism, not
  as validated packaging.
- No tap repository exists. Submitting to `homebrew-core` is out of scope
  here and is a separate, later decision — this issue only prepares the
  formula, it does not publish or submit it anywhere (per the project's
  change-boundary rules: no publishing, no deployment).

## Before this can be tapped for real

1. Qualify and publish at least one macOS/Linux target archive (extends the
   Windows-only release pipeline in emitted `dist/scripts/release-artifacts.js` and
   `.github/workflows/release.yml` — out of scope for this change).
2. Replace the placeholders in `latchkit.rb` with the exact version, URLs,
   and `sha256` values from that release.
3. Run `brew install --build-from-source packaging/homebrew/latchkit.rb` (or
   `brew audit --strict`) on real macOS/Linux hosts and fix whatever that
   surfaces — none of that has been attempted yet.
4. Decide on and create a tap (a `homebrew-latchkit` repository, or a
   `homebrew-core` submission if it qualifies) as a separate, explicit
   maintainer action.
