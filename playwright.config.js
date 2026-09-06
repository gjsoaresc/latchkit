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
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
