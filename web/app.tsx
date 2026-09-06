import { createRoot } from 'react-dom/client';
import { OverviewConsole } from './overview.js';
import { ProjectsConsole } from './projects.js';
import { SpecsConsole } from './specs.js';
import { ReviewConsole } from './review.js';
import { MemoryConsolePage } from './memory.js';
import { UsageConsolePage } from './usage.js';
import { SettingsConsole } from './settings.js';

/**
 * Issue #90: the console is one bundle (dist/web/app.js) serving several directly addressable
 * pages, each resolved by `location.pathname` — see the ASSETS map in src/server.ts, which maps
 * every one of these paths to the same index.html so a direct load or refresh works. This mirrors
 * the pattern the multi-project overview (#94) already established for `/projects`.
 *
 * The onboarding wizard (#100) now lives on the Settings page and still expands only when the
 * hash is `#onboarding` (see web/onboarding.tsx's `useActiveHash`). Docs and the CLI's first-run
 * hint point at that hash directly; when it is reached from any other page this redirects once to
 * Settings so the deep link keeps working instead of silently landing on the wrong page.
 */
const mount = document.getElementById('root');
if (!mount) throw new Error('The console root is missing.');

if (location.hash === '#onboarding' && location.pathname !== '/settings') {
  location.replace(`/settings${location.hash}`);
} else {
  const pathname = location.pathname;
  const page =
    pathname === '/projects' ? (
      <ProjectsConsole />
    ) : pathname === '/specs/review' ? (
      <ReviewConsole />
    ) : pathname === '/specs' ? (
      <SpecsConsole />
    ) : pathname === '/memory' ? (
      <MemoryConsolePage />
    ) : pathname === '/usage' ? (
      <UsageConsolePage />
    ) : pathname === '/settings' ? (
      <SettingsConsole />
    ) : (
      <OverviewConsole />
    );
  createRoot(mount).render(page);
}
