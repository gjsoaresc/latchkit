import {
  defaultInstallationRoot,
  runInstallationManager,
  type InstallationCommand,
} from './manager.js';
import { detectInteractive, parseActivationKey, resolveOnboardingHandoff } from './onboarding.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = process.argv[2] as InstallationCommand | undefined;
if (!command || !['install', 'upgrade', 'rollback', 'uninstall', 'inspect'].includes(command)) {
  throw new Error(
    'Usage: installation-entry <install|upgrade|rollback|uninstall|inspect> [--root path] [--bundle path] [--version version] [--target target] [--interactive|--non-interactive]',
  );
}
const result = await runInstallationManager({
  command,
  root: argument('--root') ?? defaultInstallationRoot(),
  bundle: argument('--bundle'),
  version: argument('--version'),
  target: argument('--target'),
  force: process.argv.includes('--force'),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// Onboarding hook point (see ./onboarding.ts). Scoped to the literal `install`
// command because install.ps1/install.sh always invoke `install` (the
// manager itself distinguishes a fresh install from an upgrade internally).
if (command === 'install' && result.active) {
  const parsed = parseActivationKey(result.active);
  if (parsed) {
    const interactive = detectInteractive({
      argv: process.argv.slice(2),
      env: process.env,
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      stdinIsTTY: Boolean(process.stdin.isTTY),
    });
    const handoff = resolveOnboardingHandoff({
      root: result.root,
      version: parsed.version,
      target: parsed.target,
      interactive,
    });
    console.error(handoff.message);
  }
}
