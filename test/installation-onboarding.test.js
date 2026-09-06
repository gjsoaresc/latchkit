import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  detectInteractive,
  parseActivationKey,
  resolveOnboardingHandoff,
} from '../dist/src/installation/onboarding.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('detectInteractive honors explicit flags before environment and TTY state', () => {
  const base = { argv: [], env: {}, stdoutIsTTY: true, stdinIsTTY: true };
  assert.equal(detectInteractive(base), true);
  assert.equal(detectInteractive({ ...base, argv: ['--non-interactive'] }), false);
  assert.equal(
    detectInteractive({ ...base, stdoutIsTTY: false, stdinIsTTY: false, argv: ['--interactive'] }),
    true,
  );
  assert.equal(detectInteractive({ ...base, env: { CI: 'true' } }), false);
  assert.equal(detectInteractive({ ...base, env: { LATCHKIT_NON_INTERACTIVE: '1' } }), false);
  assert.equal(detectInteractive({ ...base, stdoutIsTTY: false }), false);
  assert.equal(detectInteractive({ ...base, stdinIsTTY: false }), false);
});

test('parseActivationKey tolerates hyphenated prerelease versions and rejects malformed keys', () => {
  assert.deepEqual(parseActivationKey('1.0.0-win32-x64'), {
    version: '1.0.0',
    target: 'win32-x64',
  });
  assert.deepEqual(parseActivationKey('1.0.0-rc.1-darwin-arm64'), {
    version: '1.0.0-rc.1',
    target: 'darwin-arm64',
  });
  assert.equal(parseActivationKey('not-a-key'), null);
  assert.equal(parseActivationKey('1.0.0-solaris-sparc'), null);
});

test('resolveOnboardingHandoff prints a hook-point next-step for interactive installs and a non-hanging status otherwise', () => {
  const interactive = resolveOnboardingHandoff({
    root: 'C:/Users/example/AppData/Local/Latchkit',
    version: '1.0.0',
    target: 'win32-x64',
    interactive: true,
  });
  assert.equal(interactive.interactive, true);
  assert.match(interactive.message, /Next: run/);
  assert.match(interactive.message, /#100/);
  assert.deepEqual(interactive.command.slice(1), ['ui', '--project', '<your-project-path>']);

  const nonInteractive = resolveOnboardingHandoff({
    root: '/home/example/.local/share/latchkit',
    version: '1.0.0',
    target: 'linux-x64',
    interactive: false,
  });
  assert.equal(nonInteractive.interactive, false);
  assert.match(nonInteractive.message, /onboarding skipped/);
  assert.doesNotMatch(nonInteractive.message, /Next: run/);
});

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(filename, relative)));
    else if (entry.isFile()) {
      const bytes = await readFile(filename);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}

async function fixtureBundle(scratch, version) {
  const bundle = path.join(scratch, `bundle-${version}`);
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(
    process.execPath,
    path.join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  const target = `${process.platform}-${process.arch}`;
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, package: 'latchkit', version, target, nodeVersion: process.version, files: await inventory(bundle) })}\n`,
  );
  return { bundle, target };
}

async function runEntry(args) {
  return run(process.execPath, [path.join(repository, 'dist/src/installation/entry.js'), ...args], {
    windowsHide: true,
    timeout: 30_000,
  });
}

test('a non-interactive entry install prints a clear, non-hanging status instead of an onboarding hand-off', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-noninteractive-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const { bundle, target } = await fixtureBundle(scratch, version);
  const root = path.join(scratch, 'root');
  const startedAt = Date.now();
  const { stdout, stderr } = await runEntry([
    'install',
    '--root',
    root,
    '--bundle',
    bundle,
    '--target',
    target,
    '--non-interactive',
  ]);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 30_000, `install must not hang waiting for input: ${elapsedMs}ms`);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.active, `${version}-${target}`);
  assert.match(stderr, /installed non-interactively/);
  assert.match(stderr, /onboarding skipped/);
  assert.doesNotMatch(stderr, /Next: run/);
});

test('entry install without a TTY defaults to non-interactive even without the explicit flag', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-default-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const { bundle, target } = await fixtureBundle(scratch, version);
  const root = path.join(scratch, 'root');
  // execFile pipes stdio (no TTY attached), matching how install.ps1/install.sh
  // invoke node when run from CI or another non-interactive automation context.
  const { stderr } = await runEntry([
    'install',
    '--root',
    root,
    '--bundle',
    bundle,
    '--target',
    target,
  ]);
  assert.match(stderr, /onboarding skipped/);
});

test('a forced-interactive entry install prints the onboarding hook-point next step', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-interactive-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const { bundle, target } = await fixtureBundle(scratch, version);
  const root = path.join(scratch, 'root');
  const { stderr } = await runEntry([
    'install',
    '--root',
    root,
    '--bundle',
    bundle,
    '--target',
    target,
    '--interactive',
  ]);
  assert.match(stderr, /Next: run/);
  assert.match(stderr, /ui --project/);
  assert.match(stderr, /#100/);
});

test('rollback and inspect never print an onboarding hand-off', async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-onboarding-scope-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const version = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;
  const { bundle, target } = await fixtureBundle(scratch, version);
  const root = path.join(scratch, 'root');
  await runEntry([
    'install',
    '--root',
    root,
    '--bundle',
    bundle,
    '--target',
    target,
    '--interactive',
  ]);
  const { stderr: inspectStderr } = await runEntry(['inspect', '--root', root]);
  assert.equal(inspectStderr, '');
  const { stderr: rollbackStderr } = await runEntry([
    'rollback',
    '--root',
    root,
    '--version',
    version,
    '--target',
    target,
    '--interactive',
  ]);
  assert.equal(rollbackStderr, '');
});
