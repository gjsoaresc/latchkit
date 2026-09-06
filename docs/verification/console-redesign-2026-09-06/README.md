# Console redesign visual evidence (issue #90)

Representative before/after screenshots for "Modernize the console design and separate pages
by concern." Captured with Playwright (chromium, headless) against a real `startServer()`
instance backed by a freshly initialized temporary project — no fabricated views. Total size is
kept well under the ~2 MB budget (JPEG, quality 60).

## What was reviewed

- **Before** (`before/`): the single combined console page at the base commit
  (`add1cee`, the commit this branch started from, before any redesign changes), captured by
  checking that commit out in this worktree, building it, and screenshotting `/` — light desktop,
  dark desktop, and a 390×844 narrow viewport. This is the "everything on one long page" layout
  the issue describes as hard to read and navigate.
- **After** (`after/`): the redesigned console at the tip of this branch, screenshotting each of
  the six directly addressable pages the issue asks for: Overview (`/`, light desktop + dark
  desktop + narrow), Settings (`/settings`, light desktop + narrow), Specs & Tasks (`/specs`),
  Memory (`/memory`), Usage (`/usage`), and Projects (`/projects`, unchanged from #94, now sharing
  the same sidebar/topbar shell as every other page).

Each capture: establishes a session at the printed root URL (so the launch token lands in
`sessionStorage`, matching how a real user reaches the console), navigates to the target path,
waits briefly for the page to settle, optionally switches to dark via the real theme toggle, and
takes a full-viewport screenshot. No visual state was hand-edited or fabricated.

## What changed, visually

- The old console stacked configuration, onboarding, skills, workspace preference, sync,
  tasks/workbench, delivery workflows, acceptance evidence, memory, and usage into one very long
  scroll under a single "Workspace" nav item. The new console gives each of those concerns its
  own page (Overview / Projects / Specs & Tasks / Memory / Usage / Settings), each reachable by a
  distinct sidebar link and a distinct URL that survives a refresh or a direct load.
- A shared sidebar/topbar shell (`web/shell.tsx`) is now used by every page — including the
  Projects page, which previously duplicated its own copy of the sidebar markup — so navigation,
  spacing, and the "Loopback session" / theme-toggle controls look and behave the same everywhere.
- The narrow (390px) captures show the sidebar collapsing into a horizontal icon-only row that
  wraps instead of overflowing, now that it carries six page links plus Documentation instead of
  the original four.
- Dark mode was audited page-by-page with axe-core (see `test/browser/*.spec.js` and the new
  `test/browser/navigation.spec.js`); two real contrast gaps this surfaced are visible if you
  compare closely: the destructive (Remove/Delete) button's hover state and the sync/onboarding
  plan panel's file-change labels, both of which previously had no (or an unpredictable) dark
  color and now use explicit, contrast-verified colors in both themes.

## Limitations

- Screenshots are a single representative viewport per scenario, not an exhaustive gallery of
  every state (loading/empty/error/success) each page can show; those states are instead covered
  by the browser specs' own assertions (e.g. `config-console.spec.js`'s session-missing/expired
  tests, `usage-console.spec.js`'s unknown-totals coverage).
- The "Registered projects" list in `09-projects-light-desktop.jpg` includes leftover entries
  from ad hoc manual testing on the machine that produced these screenshots (this console's
  multi-project registry is user-machine-global by design, see `docs/projects.md`); it is not
  representative of a fresh install and is unrelated to this issue's scope.

## Follow-up: skill card title/description separation (2026-09-06)

`04-settings-light-desktop.jpg` and `05-settings-light-narrow.jpg` above show a defect
introduced by the #90 page split: the Settings page's skill-selection cards (`.skill-card` in
`web/settings.tsx`) rendered their title (`<strong>`) and description (`.skill-description`) as
plain inline text with no class linking the title to the design system's `.skill-name` rule, so
the two ran together on one line (e.g. "Write a specificationTurn accepted requirements into a
scoped, reviewable delivery plan."). The provider cards directly above them were unaffected
because `.provider-name` was already `display: block` with its own top margin.

Fix: `web/settings.tsx`'s `SkillGrid` now puts the existing (previously unused) `skill-name`
class on the `<strong>` title, and `web/style.css`'s `.skill-description` rule gained an explicit
`display: block` so its `margin-top` reliably takes effect. The onboarding wizard
(`web/onboarding.tsx`) uses the same `.skill-card` class but combines it with `.onboarding-row`,
whose flexbox layout already blockifies the `<strong>`/description children — it rendered
correctly before and after this fix and needed no changes.

- `10-settings-skills-fix-light-desktop.jpg` / `11-settings-skills-fix-light-narrow.jpg`: the
  Settings page's `.skills-section` after the fix, at desktop width and 390×844, captured the
  same way as the screenshots above (real `startServer()` instance, freshly initialized temporary
  project, JPEG quality 60). Titles now sit on their own bold line above the description, matching
  the provider cards. Dark mode was checked the same way (not saved here — the axe-core scan in
  `test/browser/config-console.spec.js` ("has no automated accessibility violations on the
  Settings page in dark mode") already covers dark-mode color-contrast for this page and passed).
