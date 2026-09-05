#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  doctor,
  initProject,
  inspectRecovery,
  migrateConfig,
  planConfigMigration,
  planSync,
  readConfig,
  recoverProject,
  removeProjectSkills,
  syncProject,
} from './core.js';
import { exportSupportBundle, previewSupportBundle } from './diagnostics/bundle.js';
import { appendEvent } from './diagnostics/logger.js';
import { operationalError } from './diagnostics/errors.js';

let cliValues = {};
const usage = `Latchkit — Your agents. One workflow.

Usage: latchkit <command> [options]

  init       Create project configuration without replacing existing settings
  doctor     Detect host runtime and provider executables on PATH
  config     Print saved project configuration
  migrate    Upgrade configuration; use --dry-run to preview
  recover    Inspect or recover an interrupted mutation
  sync       Install selected skills and scoped project instructions; use --dry-run to preview
  remove     Remove unchanged Latchkit-managed content; keep user-authored text
  diagnostics Preview/export or clear local redacted diagnostics
  ui         Start the local configuration console (Ctrl+C to stop)

Options:
  --project <path>    Project directory (default: current directory)
  --providers <csv>   init: claude,codex,gemini,cursor,cursor-cli
  --skills <csv>      init: spec,fix,review,handoff
  --port <number>     ui: local port (default: automatically selected)
  --to <version>      migrate: target schema version (default: current)
  --dry-run           migrate/recover/sync: preview exact managed changes and collisions without writing
  --export            diagnostics: export a reviewable local support bundle
  --clear             diagnostics: delete local diagnostic records
  --help             Show this help
  --version          Show version

Providers handle their own login, subscription, and permissions.
Skills guide agent behavior; this alpha does not enforce workflow hooks.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      providers: { type: 'string' },
      skills: { type: 'string' },
      port: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
  });
  cliValues = values;
  if (values.version) console.log('0.1.0-alpha.1');
  else if (values.help || positionals.length === 0) console.log(usage);
  else {
    const [command, ...extra] = positionals;
    if (extra.length) throw new Error('Only one command is supported at a time.');
    const allowed = {
      init: ['project', 'providers', 'skills'],
      doctor: ['project'],
      config: ['project'],
      migrate: ['project', 'to', 'dry-run'],
      recover: ['project', 'dry-run'],
      sync: ['project', 'dry-run'],
      remove: ['project'],
      diagnostics: ['project', 'export', 'clear'],
      ui: ['project', 'port'],
    }[command];
    if (!allowed) throw new Error(`Unknown command: ${command}. Run latchkit --help.`);
    for (const option of Object.keys(values))
      if (!allowed.includes(option)) throw new Error(`--${option} is not valid for ${command}.`);
    const root = path.resolve(values.project ?? process.cwd());
    const print = (value) => console.log(JSON.stringify(value, null, 2));
    if (command === 'init')
      print(
        await initProject(root, {
          ...(values.providers !== undefined
            ? { providers: values.providers.split(',').filter(Boolean) }
            : {}),
          ...(values.skills !== undefined
            ? { skills: values.skills.split(',').filter(Boolean) }
            : {}),
        }),
      );
    else if (command === 'doctor') print(await doctor(root));
    else if (command === 'config') print(await readConfig(root));
    else if (command === 'migrate') {
      const options = values.to === undefined ? {} : { toVersion: values.to };
      print(
        await (values['dry-run']
          ? planConfigMigration(root, options)
          : migrateConfig(root, options)),
      );
    } else if (command === 'recover')
      print(await (values['dry-run'] ? inspectRecovery(root) : recoverProject(root)));
    else if (command === 'sync') {
      const result = await (values['dry-run'] ? planSync(root) : syncProject(root));
      print(result);
      if (result.conflicts.length) process.exitCode = 1;
    } else if (command === 'remove') print(await removeProjectSkills(root));
    else if (command === 'diagnostics') {
      if (values.clear) {
        const { clearDiagnostics } = await import('./diagnostics/logger.js');
        print(await clearDiagnostics(root));
      } else if (values.export) print(await exportSupportBundle(root));
      else print(await previewSupportBundle(root));
    } else if (command === 'ui') {
      const port = values.port === undefined ? 0 : Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Port must be an integer between 0 and 65535.');
      await initProject(root);
      const { startServer } = await import('./server.js');
      const { server, url } = await startServer(root, { port });
      console.log(
        `Latchkit console for ${root}\n${url}\nOpen this link in your browser. Keep its session token private. Ctrl+C to stop.`,
      );
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, () => {
          server.close();
          server.closeAllConnections();
        });
    }
  }
} catch (error) {
  const diagnostic = operationalError(error, { operation: 'cli', stage: 'dispatch' });
  console.error(`Latchkit [${diagnostic.code}]: ${diagnostic.message}`);
  const project = typeof cliValues.project === 'string' ? path.resolve(cliValues.project) : null;
  if (project) await appendEvent(project, diagnostic).catch(() => {});
  process.exitCode = 1;
}
