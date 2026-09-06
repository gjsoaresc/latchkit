/**
 * Onboarding hand-off hook point for the standalone installer.
 *
 * Issue #100 owns the dedicated first-launch onboarding flow. Latchkit has no
 * such flow yet: `latchkit ui` (the local configuration console) is the
 * closest existing entrypoint. Until #100 lands, a successful interactive
 * `latchkit self install` (invoked through install.ps1/install.sh) prints a
 * suggested next command instead of launching anything automatically —
 * launching a long-running server/browser from an installer without explicit
 * user action would be surprising and could hang unattended runs. A
 * non-interactive install prints an equivalent status line and never blocks.
 *
 * When #100 ships a real onboarding entrypoint, replace the interactive
 * branch below to invoke it directly (or exec it) instead of only printing a
 * suggested command. Keep the non-interactive branch's "never hang, never
 * launch anything" behavior — that is a requirement, not an artifact of the
 * current placeholder.
 */
import path from 'node:path';

export interface OnboardingHandoff {
  /** True when the install ran attached to an interactive terminal and was not explicitly suppressed. */
  interactive: boolean;
  /** Single-line, human-readable status. install.ps1/install.sh do not parse this; it is for humans. */
  message: string;
  /** The exact next command a user (or a future onboarding launcher) can run. */
  command: string[];
}

export interface InteractivityContext {
  /** Process argv tail (installer-specific flags), e.g. ['install', '--root', ...]. */
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
}

/**
 * Decide interactivity for the current installer run. Explicit flags always
 * win; `CI`/`LATCHKIT_NON_INTERACTIVE` force non-interactive for scripted
 * environments that still happen to attach a TTY; otherwise both stdout and
 * stdin must be a TTY.
 */
export function detectInteractive(context: InteractivityContext): boolean {
  if (context.argv.includes('--non-interactive')) return false;
  if (context.argv.includes('--interactive')) return true;
  if (context.env.LATCHKIT_NON_INTERACTIVE === '1') return false;
  if (context.env.CI) return false;
  return context.stdoutIsTTY && context.stdinIsTTY;
}

export function resolveOnboardingHandoff(options: {
  root: string;
  version: string;
  target: string;
  interactive: boolean;
}): OnboardingHandoff {
  const launcherName = options.target.startsWith('win32-') ? 'latchkit.ps1' : 'latchkit';
  const launcher = path.join(options.root, 'bin', launcherName);
  const command = [launcher, 'ui', '--project', '<your-project-path>'];
  const rendered = command.map((token) => (token.includes(' ') ? `"${token}"` : token)).join(' ');
  if (options.interactive)
    return {
      interactive: true,
      message: `Latchkit ${options.version} installed. Next: run ${rendered} to open the local console and finish setup. (Onboarding hook point for #100; see docs/installation.md#onboarding-hook-point.)`,
      command,
    };
  return {
    interactive: false,
    message: `Latchkit ${options.version} installed non-interactively. Setup status: ready, onboarding skipped. Run ${rendered} when you want to open the local console.`,
    command,
  };
}

/** Parse a `${version}-${platform}-${arch}` activation key, tolerating hyphenated prerelease versions. */
export function parseActivationKey(active: string): { version: string; target: string } | null {
  const match = /^(.+)-(win32|linux|darwin)-(x64|arm64)$/.exec(active);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined)
    return null;
  return { version: match[1], target: `${match[2]}-${match[3]}` };
}
