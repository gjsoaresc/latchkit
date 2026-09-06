import {
  defaultInstallationRoot,
  runInstallationManager,
  type InstallationCommand,
} from './manager.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = process.argv[2] as InstallationCommand | undefined;
if (!command || !['install', 'upgrade', 'rollback', 'uninstall', 'inspect'].includes(command)) {
  throw new Error(
    'Usage: installation-entry <install|upgrade|rollback|uninstall|inspect> [--root path] [--bundle path] [--version version] [--target target]',
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
