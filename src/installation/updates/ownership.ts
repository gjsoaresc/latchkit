/**
 * Installation ownership detection (issue #139 slice 1, acceptance
 * criterion 5).
 *
 * Distinguishes the installation kinds a console/CLI updater must treat
 * differently: a self-managed direct install (owns its own launchers and
 * may update itself), a package-manager-owned install (Homebrew/WinGet:
 * updates must go through that manager, never a direct self-install — see
 * docs/installation.md#package-manager-upgradeuninstall-ownership), an
 * unowned directory (exists but was never actually installed/adopted by the
 * manager), a source/development checkout (no standalone bundle exists to
 * update at all), and an unsupported platform/architecture pair (no
 * installer script even accepts it).
 *
 * Contract: `root` and `runningFromInstallRoot` must only ever be supplied
 * by a trusted caller — the CLI (which resolves `defaultInstallationRoot()`
 * or an explicit `--install-root` the operator typed themselves) or a test
 * fixture. A future authenticated local API MUST resolve these only from
 * the current server process's own verified installation identity (for
 * example the `LATCHKIT_INSTALL_ROOT` environment variable a stable launcher
 * sets — see `src/installation/manager.ts`'s `createStableLaunchers`) and
 * must never accept a root, path, or override from request/browser input;
 * doing so would let a caller nominate an arbitrary managed root for update
 * operations to act on.
 */
import path from 'node:path';
import { defaultInstallationRoot, inspectInstallation } from '../manager.js';

export type InstallationOwnershipKind =
  'self-managed' | 'package-manager' | 'unowned' | 'source-development' | 'unsupported-platform';

export type InstallationUpdateRoute =
  'console-or-cli' | 'package-manager' | 'manual-bootstrap' | 'not-applicable';

export interface InstallationOwnershipResult {
  kind: InstallationOwnershipKind;
  root: string | null;
  target: string;
  reason: string;
  updateRoute: InstallationUpdateRoute;
}

/** Targets any installer script even accepts (qualified or experimental).
 * Anything else — `win32-arm64`, `linux-arm64`, or an unrecognized platform
 * — is rejected by both installers before making any change (see
 * docs/installation.md#supported-vs-deferred-targets). */
const SCRIPTED_TARGETS = new Set(['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64']);

const HOMEBREW_MARKERS = ['cellar', 'homebrew'];
const WINGET_MARKER = path.join('microsoft', 'winget', 'packages');

function packageManagerMarker(root: string): 'homebrew' | 'winget' | null {
  const normalized = root.toLowerCase().split(path.sep).join('/');
  if (normalized.includes(WINGET_MARKER.split(path.sep).join('/'))) return 'winget';
  if (HOMEBREW_MARKERS.some((marker) => normalized.split('/').includes(marker))) return 'homebrew';
  return null;
}

export interface DetectInstallationOwnershipOptions {
  /** Explicit installation root to inspect. Defaults to
   * `defaultInstallationRoot()`. See the module contract above: never wire
   * this to unauthenticated request input. */
  root?: string;
  target?: string;
  /** The `LATCHKIT_INSTALL_ROOT` a stable launcher sets, or `null`/absent
   * when running directly from a source checkout (no launcher involved).
   * Injectable so tests do not depend on the real process environment. */
  runningFromInstallRoot?: string | null;
}

export async function detectInstallationOwnership(
  options: DetectInstallationOwnershipOptions = {},
): Promise<InstallationOwnershipResult> {
  const target = options.target ?? `${process.platform}-${process.arch}`;
  if (!SCRIPTED_TARGETS.has(target)) {
    return {
      kind: 'unsupported-platform',
      root: null,
      target,
      reason: `${target} is not an installer-supported target; see docs/installation.md#supported-vs-deferred-targets.`,
      updateRoute: 'not-applicable',
    };
  }
  const runningFromInstallRoot =
    options.runningFromInstallRoot === undefined
      ? (process.env.LATCHKIT_INSTALL_ROOT ?? null)
      : options.runningFromInstallRoot;
  if (!runningFromInstallRoot) {
    return {
      kind: 'source-development',
      root: null,
      target,
      reason:
        'Running from a source checkout, not a standalone installed bundle; there is no installation to update. Use git/npm to update the checkout instead.',
      updateRoute: 'not-applicable',
    };
  }
  const root = options.root ?? defaultInstallationRoot();
  const marker = packageManagerMarker(root);
  if (marker) {
    return {
      kind: 'package-manager',
      root,
      target,
      reason: `This installation is owned by ${marker === 'winget' ? 'WinGet' : 'Homebrew'}; use its own upgrade/uninstall commands rather than a direct self-install (see docs/installation.md#package-manager-upgradeuninstall-ownership).`,
      updateRoute: 'package-manager',
    };
  }
  try {
    const inspection = await inspectInstallation(root);
    if (inspection.active && inspection.launchers.length > 0) {
      return {
        kind: 'self-managed',
        root,
        target,
        reason: 'This installation owns its managed launchers and can be updated directly.',
        updateRoute: 'console-or-cli',
      };
    }
    return {
      kind: 'unowned',
      root,
      target,
      reason:
        'No recognized Latchkit launcher ownership was found at this root; run the installer to adopt it before updating.',
      updateRoute: 'manual-bootstrap',
    };
  } catch {
    return {
      kind: 'unowned',
      root,
      target,
      reason:
        'This installation root could not be inspected; run the installer to adopt it before updating.',
      updateRoute: 'manual-bootstrap',
    };
  }
}
