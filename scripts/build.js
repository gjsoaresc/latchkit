import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

if (process.argv.includes('--clean'))
  await rm(dist, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
await mkdir(dist, { recursive: true });

const typeScript = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (typeScript.status !== 0) process.exit(typeScript.status ?? 1);

await cp(path.join(root, 'web', 'index.html'), path.join(dist, 'web', 'index.html'));
await cp(path.join(root, 'web', 'style.css'), path.join(dist, 'web', 'style.css'));
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [path.join(root, 'web', 'app.tsx')],
  bundle: true,
  format: 'esm',
  target: ['es2023'],
  outfile: path.join(dist, 'web', 'app.js'),
  sourcemap: false,
  minify: false,
});
await cp(path.join(root, 'skills'), path.join(dist, 'skills'), { recursive: true });
await cp(path.join(root, 'schemas'), path.join(dist, 'schemas'), { recursive: true });
