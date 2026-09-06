import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectBrowserLicenses } from './browser-licenses.js';
import { listFiles, reconcileDirectory } from './reconcile.js';

const adjacentRoot = path.resolve(import.meta.dirname, '..');
// The tool runs from source only during development and from dist/scripts in
// the supported bootstrap. Resolve the actual repository in both layouts.
const root = existsSync(path.join(adjacentRoot, 'tsconfig.json'))
  ? adjacentRoot
  : path.resolve(adjacentRoot, '..');
const dist = path.join(root, 'dist');
const clean = process.argv.includes('--clean');

if (clean) await rm(dist, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
await mkdir(dist, { recursive: true });

// A clean build has just removed the emitted bootstrap tool that is currently
// running. Recreate the strict tooling slice before rebuilding the application
// so dist remains self-contained after the command exits.
if (clean) {
  const tooling = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      'tsconfig.tools.json',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (tooling.status !== 0) process.exit(tooling.status ?? 1);
}

// --listEmittedFiles reports the exact set of files this compilation wrote,
// so a source that was deleted or renamed since the previous build can be
// told apart from output that is still current. Diagnostics still reach the
// terminal (stderr stays inherited; captured stdout is echoed back with the
// bookkeeping lines filtered out) and the exit status is unchanged.
const typeScript = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    'tsconfig.json',
    '--listEmittedFiles',
  ],
  { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' },
);
const emittedByTypeScript = new Set<string>();
for (const line of (typeScript.stdout ?? '').split(/\r?\n/)) {
  const match = /^TSFILE:\s*(.+)$/.exec(line);
  if (!match) {
    if (line.trim()) process.stdout.write(`${line}\n`);
    continue;
  }
  const emittedPath = match[1]?.trim();
  if (!emittedPath) continue;
  const relative = path.relative(dist, path.resolve(emittedPath)).split(path.sep).join('/');
  if (relative && !relative.startsWith('..')) emittedByTypeScript.add(relative);
}
if (typeScript.status !== 0) process.exit(typeScript.status ?? 1);

// dist/src is owned exclusively by this compilation step, so any file left
// over from a source that no longer exists can be reclaimed immediately.
// reconcileDirectory reports paths relative to the directory it is given,
// so the "src/" prefix from the dist-relative TSFILE paths is stripped here.
const emittedUnder = (prefix: string): string[] =>
  [...emittedByTypeScript]
    .filter((relative) => relative.startsWith(`${prefix}/`))
    .map((relative) => relative.slice(prefix.length + 1));
await reconcileDirectory(path.join(dist, 'src'), emittedUnder('src'));

await cp(path.join(root, 'web', 'index.html'), path.join(dist, 'web', 'index.html'));
const postcss = (await import('postcss')).default;
const tailwind = (await import('@tailwindcss/postcss')).default;
const sourceCss = path.join(root, 'web', 'design-system.css');
const utilities = await postcss([tailwind({ base: root })]).process(
  await readFile(sourceCss, 'utf8'),
  { from: sourceCss, to: path.join(dist, 'web', 'style.css') },
);
await writeFile(
  path.join(dist, 'web', 'style.css'),
  `${utilities.css}\n${await readFile(path.join(root, 'web', 'style.css'), 'utf8')}`,
);
const esbuild = await import('esbuild');
const browserBuild = await esbuild.build({
  entryPoints: [path.join(root, 'web', 'app.tsx')],
  bundle: true,
  format: 'esm',
  target: ['es2023'],
  outfile: path.join(dist, 'web', 'app.js'),
  sourcemap: false,
  minify: true,
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
// collectBrowserLicenses reconciles its own destination against the
// packages it actually wrote this run before returning.
if (!browserBuild.metafile)
  throw new Error('esbuild did not return required browser license metadata.');
await collectBrowserLicenses(root, path.join(dist, 'web', 'licenses'), browserBuild.metafile);

const skillFiles = await listFiles(path.join(root, 'skills'));
await cp(path.join(root, 'skills'), path.join(dist, 'skills'), { recursive: true });
await reconcileDirectory(path.join(dist, 'skills'), skillFiles);

const schemaFiles = await listFiles(path.join(root, 'schemas'));
await cp(path.join(root, 'schemas'), path.join(dist, 'schemas'), { recursive: true });
await reconcileDirectory(path.join(dist, 'schemas'), schemaFiles);

// dist/web mixes several owners: per-file TypeScript compiles, the static
// index.html/style.css assets copied above, the esbuild bundle written to
// the same "app.js" path TypeScript also emits, and the independently
// reconciled licenses/ subtree. Keep everything each owner just wrote and
// leave licenses/ untouched (it manages its own reconciliation above); what
// remains is exactly the set of orphaned per-file compiles from a deleted or
// renamed web/*.ts(x) source.
await reconcileDirectory(
  path.join(dist, 'web'),
  new Set([...emittedUnder('web'), 'index.html', 'style.css']),
  { ignore: ['licenses'] },
);
