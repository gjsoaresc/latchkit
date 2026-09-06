import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// See src/projects/store.js: without this override, a browser spec that calls startServer (every
// one of which now touches the multi-project registry on `ui-start`, see docs/projects.md) would
// write into the real user's machine-wide installation directory. Playwright worker processes
// inherit this process's environment, so setting it once here, before workers spawn, is enough.
if (!process.env.LATCHKIT_PROJECTS_ROOT) {
  process.env.LATCHKIT_PROJECTS_ROOT = path.join(
    os.tmpdir(),
    `latchkit-test-projects-registry-playwright-${process.pid}`,
  );
}
// Issue #139 slice 2: isolate the update-service default installation-data root the same way,
// see src/installation/manager.js's `defaultInstallationRoot` and test/env.js.
if (!process.env.LATCHKIT_INSTALL_DATA_ROOT) {
  process.env.LATCHKIT_INSTALL_DATA_ROOT = path.join(
    os.tmpdir(),
    `latchkit-test-install-root-playwright-${process.pid}`,
  );
}
delete process.env.LATCHKIT_INSTALL_ROOT;

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  // Acceptance specs launch a second, explicitly selected browser driver.
  // Keep files serial to avoid native browser oversubscription on small CI hosts.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    trace: 'off',
    screenshot: 'off',
    baseURL: 'http://127.0.0.1',
    // Deterministic, immediate style application: a theme toggle (issue #90's per-page dark-mode
    // accessibility scans) would otherwise land assertions and axe scans mid CSS transition,
    // observing a transient blended color rather than the final one.
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
