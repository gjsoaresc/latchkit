# Multi-project overview

`src/server.ts` serves exactly one fixed project per running `latchkit ui` process — see
[the local workflow workbench](workflow-workbench.md). The multi-project overview is an additive
layer on top of that: a small, user-local registry of every project Latchkit has touched, plus a
`/projects` console page and `/api/projects/*` API that read each registered project's own specs,
task/workflow state, memory, and usage directly, without moving the single-project server's fixed
project. Registering, listing, or removing a project never runs a machine-wide filesystem scan —
every registry entry is either explicit (an operator points at a path) or captured at one of the
few places Latchkit already knows a project's path (`latchkit init`, `latchkit ui` starting, or a
task/workflow run).

## The registry

`src/projects/` owns a durable JSON registry, independent of any project checkout, stored under
`.latchkit/`-style versioning conventions but rooted outside every project:

- Default location: `<user-local installation root>/projects/registry-v1.json`, where the
  installation root is `src/installation/manager.ts`'s `defaultInstallationRoot()` (for example
  `%LOCALAPPDATA%\Latchkit` on Windows, `$XDG_DATA_HOME/latchkit` or `~/.local/share/latchkit`
  elsewhere). This keeps the registry alongside other user-local Latchkit state without colliding
  with installed-bundle files (`versions/`, `bin/`, `current`).
- `LATCHKIT_PROJECTS_ROOT` explicitly overrides the registry's root directory. This repository's
  own test suite always sets it (`test/env.js`, preloaded via `node --import` in the `test` npm
  script; `playwright.config.js` for browser specs) so `npm test` and `npm run test:browser` never
  write into a real machine's actual installation directory. An operator can set the same variable
  to relocate the registry.
- The store (`src/projects/store.ts`) uses the same atomic, lock-protected read/write pattern as
  other additive stores (`src/workflows/spec-decision-store.ts`, `src/usage/baseline-store.ts`):
  writes go through `writeAtomic`, and every read/mutation is taken under the same
  `withTaskStateLock` primitive `src/task-state/lock.ts` already provides — the registry's root
  directory does not need to be a project or a Git repository for that lock to work.

Each registry entry (`ProjectRecord`, `src/projects/contracts.ts`) is intentionally small: a
stable `project_<uuid>` ID, the absolute resolved (`realpath`) root at registration time, a
display name, and provenance (`addedAt`/`addedVia`, `lastSeenAt`/`lastSeenVia`). `addedVia` records
how the project was first captured and is never overwritten by a later touch; `lastSeenVia` always
reflects the most recent one. Nothing about a project's live status (Git identity, activity, usage)
is cached on the record itself — every read below resolves it fresh, so a moved or deleted project
is detected rather than trusted from a stale snapshot.

## The stable API

`src/projects/service.ts` exposes the integration surface other code (including the parallel
installation-onboarding work in `src/installation/`, issue #100) is expected to call:

```ts
registerProject(registryRoot, { root, displayName?, source? }): Promise<ProjectRecord>
listProjects(registryRoot): Promise<{ schemaVersion, revision, projects: ProjectOverviewEntry[] }>
removeProject(registryRoot, id): Promise<{ removed: true; id: string }>
resolveProjectIdentity(root): Promise<ProjectIdentity> // re-exported from ./identity.js
inspectProject(registryRoot, id, options?): Promise<ProjectDetail>
```

`registerProject` is the same call used for an explicit "add an existing project" action and for a
capture hook: registering an already-registered root (matched by resolved path, case-insensitively
on Windows) never creates a duplicate — it reconciles `lastSeenAt`/`lastSeenVia` and only changes
`displayName` when one is explicitly supplied, so an implicit touch can never silently rename a
project the user already renamed. `source` must be one of `init`, `ui-start`, `task-run`, or
`manual` (`PROJECT_SOURCES` in `src/projects/contracts.ts`); every other value is rejected rather
than silently accepted. `removeProject` only deletes the registry entry — it never touches the
project's own files, `.latchkit/` state, or Git history, and removing an unregistered ID reports
`PROJECT_NOT_FOUND` (HTTP 404 through the API) rather than succeeding silently.

### Where a project is captured today

- `latchkit init` (`src/cli.ts`) registers the initialized project with `source: 'init'` after
  `initProject` succeeds. A registry write failure never fails `init` itself.
- `latchkit ui` (`src/server.ts`'s `startServer`) registers its fixed project with
  `source: 'ui-start'` once, at server start, non-blocking and error-tolerant.
- `POST /api/tasks/start`, `POST /api/workflows/run`, `latchkit task start`, and
  `latchkit workflow run` (the `run` action) each register the current project with
  `source: 'task-run'` after the operation succeeds.
- `latchkit projects add` / `POST /api/projects` explicitly register a project with
  `source: 'manual'`.

This is the full set of capture points wired in this change; a task or workflow **resumed** rather
than freshly started does not itself re-touch the registry (its project is already registered from
the run that created it), and CLI subcommands other than `init`/`task start`/`workflow run` do not
touch the registry. Every capture call is wrapped so a registry failure (for example a read-only
`LATCHKIT_PROJECTS_ROOT`) never blocks or fails the action that triggered it.

## Identity and grouping

`src/projects/identity.ts` resolves a registered root's identity live, every time — never from a
cached field — using Git directly (`git rev-parse --show-toplevel`, `--git-common-dir`,
`--is-bare-repository`, and `git worktree list --porcelain`, mirroring the approach
`src/workspaces/git.ts` already uses for task-owned worktrees):

- `kind: 'git'` — inside a Git working tree. Carries the repository's `commonDir` (Git's own
  common directory, shared by a main checkout and every one of its linked worktrees), the
  `mainRoot` (the first entry in `git worktree list`, resolved independent of which checkout the
  query started from), and `isMainCheckout`.
- `kind: 'plain'` — a real directory that is not inside a Git working tree.
- `kind: 'unavailable'` — the registered root no longer resolves (`reason: 'missing'`) or resolves
  to something that is not a directory (`reason: 'not-directory'`).

The **group key** for grouping is `commonDir` for a Git identity and the resolved path itself for a
plain one; an unavailable identity is never merged into another project's group. `listProjects`
groups every registered record by this key: within a group, the entry whose identity is
`isMainCheckout: true` is `isRepresentative` (falling back to the earliest-registered member if no
main checkout is registered); every other member of the group is not. An overview grid built from
`projects.filter(p => p.isRepresentative)` therefore shows exactly one card per repository — a main
checkout and a separately registered linked worktree never appear, or count toward totals, as two
projects — while `groupMemberIds` and `inspectProject`'s `group` field keep every member
individually addressable and inspectable (its own tasks, its own workflows, its own usage), because
each worktree normally has its own `.latchkit/` state.

`inspectProject`'s `worktrees` field is a separate, complementary list: every worktree Git currently
knows about for the project's repository (read directly, not only Latchkit-created ones), each
flagged `isRegistered`/`registeredProjectId` when it matches an existing registry entry, so the
detail page can link straight to it or invite the user to add it.

## Status: active, idle, unavailable, stale

`listProjects` never infers an active provider session from installed tooling. A project's status
is evidence-based, from its own persisted task/workflow state:

- **unavailable** — the resolved identity is `unavailable` (moved, deleted, or unreadable root).
  `inspectProject` returns this project's registry identity but explicit `null`/`unavailable`
  values for tasks, workflows, memory, and usage — never a `0`, which would misrepresent "unknown"
  as "empty."
- **active** — at least one task is in a non-terminal state (`running`, `awaiting-decision`, or
  `blocked`; not `planned`, `cancelled`, `completed`, or `verified`) or one workflow is in a
  non-terminal status (`running`, `awaiting-input`, `awaiting-approval`, or `blocked`).
- **idle** — the project resolves fine but has no non-terminal task or workflow (including a brand
  new project with no tasks at all).

An active project also carries `activityStale: true` when its most recent non-terminal
task/workflow timestamp is older than 30 minutes (`ACTIVITY_STALE_MS` in
`src/projects/service.ts`). This does not downgrade the status to idle — the work is not known to
be finished — it only flags that the activity evidence itself may be stale (a crashed process, an
abandoned session) so the UI does not present it with the same confidence as activity from moments
ago.

## HTTP API

Additive routes in `src/server.ts`, alongside the existing single-project routes (which keep
serving exactly the server's own fixed project, unchanged):

```
GET    /api/projects              -> { schemaVersion, revision, projects: ProjectOverviewEntry[] }
POST   /api/projects              body: { root, displayName? }  (source: 'manual')
GET    /api/projects/:id          -> ProjectDetail
DELETE /api/projects/:id          -> { removed: true, id }
```

All four require the same launch-token bearer authentication, same-origin mutation check, and
loopback/CSP protections as every other route on this server. `GET /api/projects/:id` accepts the
same `from`/`to` ISO range query parameters as `/api/usage/overview` and forwards them into the
project's own usage aggregation.

Every read and mutation targets the project resolved from the registry entry for the `:id` in the
URL — never a client-supplied path, and never the server's own fixed `root`. An unknown or
malformed ID is refused (`PROJECT_NOT_FOUND` / `PROJECT_ID_INVALID`, HTTP 404/400) rather than
falling back to any other project's data, so navigating between projects (or an interrupted
navigation racing a pending action) cannot mix one project's reads or actions into another's.

## CLI

```sh
latchkit projects list
latchkit projects add --project "path/to/project" [--title "Display name"]
latchkit projects remove --id project_<uuid>
```

`latchkit projects add` reuses the existing `--project` option (defaulting to the current
directory, like every other command) as the path to register, and `--title` as an optional display
name override. `latchkit projects list`/`remove` operate purely on the registry and need no
`--project`.

## Console page

`web/projects.tsx` is a second top-level page in the same single-page bundle as the existing
console (`web/app.tsx`), reached at `/projects` — the only new nav entry added to the existing
sidebar, and the only new entry in `src/server.ts`'s static-asset map (so a direct load or a
refresh at `/projects` resolves the same bundle). The selected project is addressed by a
`project` query parameter (`/projects?project=<id>`); switching projects is a real navigation (a
plain link, not client-side routing), so every load of a project's detail view re-fetches exactly
that project's data from scratch under its own URL — there is no shared in-memory state that a
faster or slower navigation could race or mix between two different projects.

The grid view lists every `isRepresentative` project with its status badge, root path, open
task/workflow counts, and last-activity time, plus an inline form to add an existing project and a
remove action per card (with a confirmation, since removal is irreversible from the registry even
though it never deletes the project's own files). An empty registry shows an explicit empty state
rather than a blank page. The detail view shows the project's own group (sibling worktrees sharing
its identity, each linking to its own registered entry), Git worktrees, durable specs/plans under
`docs/plans/` and legacy `.latchkit/notes/`, task and workflow summaries, a project-memory count,
and a usage summary that shows "unavailable" text (with its reason) instead of a `0` when usage
could not be read for that project.

## Known limitations

- Capture points are the ones listed above; a project reached only through other CLI subcommands
  (for example `latchkit memory add` in a project that was never `init`ed, `ui`ed, or run through
  `task start`/`workflow run`) is not automatically registered. `latchkit projects add` (or the
  console's "Add existing project" form) covers that case explicitly.
- `activityStale`'s 30-minute window is a fixed constant, not yet configurable.
- The `#100` onboarding hook point (recording a chosen project root during first-run setup calling
  `registerProject` with `source: 'init'` or a new source) is left for that work to wire once both
  branches merge; this change only guarantees the function signature and behavior described above.
- A browser acceptance spec (`test/browser/projects-console.spec.js`) covers the grid, add/remove,
  identity grouping display, and the detail view end to end; see the build report for which browser
  projects it was actually run against on this host.
