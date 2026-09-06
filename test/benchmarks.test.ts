import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  benchmarkRepositoryRoot,
  parseBenchmarkOptions,
  validateStandaloneApp,
} from '../scripts/benchmarks.js';

const digest = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

test('benchmark options preserve the development default and reject ambiguous input', () => {
  const root = path.join(os.tmpdir(), 'latchkit-benchmark-options');
  assert.deepEqual(parseBenchmarkOptions([], root), {
    app: undefined,
    output: path.join(root, '.github', 'release-evidence', 'rc2', 'benchmarks-windows.json'),
    profileSync: false,
  });
  assert.deepEqual(
    parseBenchmarkOptions(['--app', 'candidate/app', '--output', 'evidence.json'], root),
    {
      app: path.resolve('candidate/app'),
      output: path.resolve('evidence.json'),
      profileSync: false,
    },
  );
  assert.throws(() => parseBenchmarkOptions(['--app']), /--app needs a value/);
  assert.throws(() => parseBenchmarkOptions(['--output', 'one', '--output', 'two']), /only once/);
  assert.throws(() => parseBenchmarkOptions(['--unknown']), /Unknown benchmark option/);
});

test('benchmark root resolution remains checkout-relative after TypeScript emission', () => {
  const checkout = path.join(os.tmpdir(), 'latchkit-checkout');
  assert.equal(benchmarkRepositoryRoot(path.join(checkout, 'scripts')), checkout);
  assert.equal(benchmarkRepositoryRoot(path.join(checkout, 'dist', 'scripts')), checkout);
});

test('standalone benchmark input binds app receipts and the private runtime without an archive claim', async (t) => {
  const bundle = await mkdtemp(path.join(os.tmpdir(), 'latchkit-benchmark-app-'));
  t.after(() => rm(bundle, { recursive: true, force: true }));
  const app = path.join(bundle, 'app');
  const runtime = path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  await mkdir(path.join(app, 'dist', 'src'), { recursive: true });
  await mkdir(path.dirname(runtime), { recursive: true });
  await cp(process.execPath, runtime);
  const metadata = { name: 'latchkit', version: '1.0.0' };
  await writeFile(path.join(app, 'package.json'), `${JSON.stringify(metadata)}\n`);
  await writeFile(path.join(app, 'dist', 'package.json'), `${JSON.stringify(metadata)}\n`);
  const cli = path.join(app, 'dist', 'src', 'cli.js');
  await writeFile(cli, 'export {}\n');
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const receiptFiles: Array<[string, string]> = [
    ['app/package.json', path.join(app, 'package.json')],
    ['app/dist/package.json', path.join(app, 'dist', 'package.json')],
    ['app/dist/src/cli.js', cli],
    [`runtime/${executable}`, runtime],
  ];
  const files = await Promise.all(
    receiptFiles.map(async ([relative, file]) => ({
      path: relative,
      bytes: 0,
      sha256: await digest(file),
    })),
  );
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      package: 'latchkit',
      version: '1.0.0',
      target: `${process.platform}-${process.arch}`,
      nodeVersion: process.version.slice(1),
      commit: 'a'.repeat(40),
      dirty: false,
      packages: [
        { name: 'latchkit', version: '1.0.0', path: 'app' },
        { name: 'node', version: process.version.slice(1), path: 'runtime' },
      ],
      files,
    })}\n`,
  );
  const inspected = await validateStandaloneApp(app, { callerNode: runtime });
  assert.equal(inspected.app, app);
  assert.equal(inspected.manifest.commit, 'a'.repeat(40));
  await writeFile(cli, 'edited\n');
  await assert.rejects(validateStandaloneApp(app, { callerNode: runtime }), /does not match/);
});
