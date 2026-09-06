// Preloaded (via `node --import`) before the test runner discovers or spawns any test file.
// `LATCHKIT_PROJECTS_ROOT` (see src/projects/store.js) overrides the multi-project registry's
// otherwise machine-wide default location. Without this, `npm test` would write real files
// into the running user's actual installation directory the first time any test exercises
// `latchkit init`, `latchkit ui`, `latchkit task start`, or `latchkit workflow run` — every one
// of which now touches the registry (see docs/projects.md). Node child processes inherit
// `process.env` by default, so setting this once here reaches every per-file test process this
// run spawns, and every `latchkit` CLI subprocess those tests spawn in turn. This directory is
// never created eagerly; the registry store creates it lazily (like every other Latchkit store)
// only on its first write, and nothing here is responsible for removing it afterward. Individual
// tests that want their own isolated registry still pass an explicit `registryRoot` directly to
// `src/projects/service.js` functions rather than relying on this shared default.
import os from 'node:os';
import path from 'node:path';

if (!process.env.LATCHKIT_PROJECTS_ROOT) {
  process.env.LATCHKIT_PROJECTS_ROOT = path.join(
    os.tmpdir(),
    `latchkit-test-projects-registry-${process.pid}-${Date.now()}`,
  );
}

// Issue #139 slice 2: `defaultInstallationRoot()` (src/installation/manager.js) backs the
// update-service settings/staged-record/lease/handoff stores. Without this override, any test
// that starts a server (every one now exposes the console updater's read-only status route) or
// calls an update-service default-rooted function would touch the real per-user installation
// directory the first time it ran. Individual update tests still pass an explicit, isolated
// `installRoot` directly rather than relying on this shared default.
if (!process.env.LATCHKIT_INSTALL_DATA_ROOT) {
  process.env.LATCHKIT_INSTALL_DATA_ROOT = path.join(
    os.tmpdir(),
    `latchkit-test-install-root-${process.pid}-${Date.now()}`,
  );
}
// Never let a real installed-bundle launcher's environment leak into a test process; ownership
// detection must default to `source-development` unless a test explicitly overrides it.
delete process.env.LATCHKIT_INSTALL_ROOT;
