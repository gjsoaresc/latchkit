// Exercises install.ps1 and install.sh themselves (not just the TypeScript
// installation manager they call into). install.ps1 runs against a fully
// real fixture bundle (the compiled dist/ tree plus the current Node binary
// standing in for the private runtime) because this suite's host is Windows,
// so win32-x64 is the host's actual target and the real manager accepts it.
//
// install.sh cannot reach a genuine success path on this Windows host: it
// only ever resolves to a linux-*/darwin-* target, and the installation
// manager cross-checks the requested target against the *real* running
// platform (`process.platform`/`process.arch`), which is win32-x64 here
// regardless of what install.sh's `uname` shim reports. So the "supported
// path" install.sh tests substitute a tiny stub `entry.js` for the real
// manager, to test what install.sh itself is responsible for — local-file
// artifact/checksum resolution, checksum verification and abort-on-mismatch,
// argument pass-through, and idempotent re-invocation — independent of the
// real manager (which already has its own direct tests in
// test/installation.test.js). The unsupported-OS/architecture tests do use
// the genuine, unmodified install.sh gate and require no stub.
//
// install.sh needs a POSIX `sh` plus coreutils (mktemp, sha256sum, tar, awk,
// cp, mkdir, rm, uname). On non-Windows hosts these are assumed to be the
// system's own. On Windows this suite looks for Git for Windows' bundled
// MSYS `sh.exe`/coreutils and skips the install.sh tests with an explicit
// reason if it is not present.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const GIT_USR_BIN = 'C:\\Program Files\\Git\\usr\\bin';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findPosixShell() {
  if (process.platform !== 'win32') return '/bin/sh';
  const candidate = path.join(GIT_USR_BIN, 'sh.exe');
  return (await exists(candidate)) ? candidate : null;
}

const posixShell = await findPosixShell();
const skipPosix = posixShell
  ? false
  : 'requires a POSIX sh (Git for Windows was not found at the conventional path)';

function posixPath() {
  return process.platform === 'win32'
    ? `${GIT_USR_BIN}${path.delimiter}${process.env.PATH ?? ''}`
    : (process.env.PATH ?? '');
}

async function writeFakeUname(directory, { s, m }) {
  await mkdir(directory, { recursive: true });
  const script = path.join(directory, 'uname');
  await writeFile(
    script,
    `#!/bin/sh\ncase "$1" in\n  -s) echo '${s}' ;;\n  -m) echo '${m}' ;;\nesac\n`,
  );
  await chmod(script, 0o755);
  return directory;
}

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

/**
 * A fully real bundle: compiled dist/ plus the current Node binary as the
 * private runtime. `cli.js --version` reads `app/dist/package.json`, which
 * the installation manager's smoke check cross-verifies against the bundle
 * manifest's declared version — so exercising a distinct fixture version
 * requires rewriting that embedded package.json, not just the manifest.
 */
async function realWindowsBundle(scratch, version) {
  const bundle = path.join(scratch, `bundle-${version}-${Date.now()}`);
  await cp(path.join(repository, 'dist'), path.join(bundle, 'app', 'dist'), { recursive: true });
  await cp(process.execPath, path.join(bundle, 'runtime', 'node.exe'));
  const packageFile = path.join(bundle, 'app', 'dist', 'package.json');
  const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
  packageJson.version = version;
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  const target = 'win32-x64';
  await writeFile(
    path.join(bundle, 'bundle-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, package: 'latchkit', version, target, nodeVersion: process.version, files: await inventory(bundle) })}\n`,
  );
  return { bundle, target };
}

async function zipBundle(bundleDirectory, archive) {
  const script = path.join(path.dirname(archive), `zip-${path.basename(archive)}.ps1`);
  await writeFile(
    script,
    'param($Source,$Destination)\n$ErrorActionPreference="Stop"\nCompress-Archive -Path (Join-Path $Source "*") -DestinationPath $Destination -Force\n',
  );
  await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', script, bundleDirectory, archive],
    {
      windowsHide: true,
      timeout: 60_000,
    },
  );
}

async function writeChecksumSidecar(archive, { correct = true } = {}) {
  const bytes = await readFile(archive);
  const digest = correct ? hash(bytes) : '0'.repeat(64);
  await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  return digest;
}

/** A lightweight stand-in bundle: a real Node binary plus a stub entry.js that only records what it was asked to do. Used only to test install.sh's own shell-level responsibilities, decoupled from the real cross-platform manager (see file header). */
async function stubPosixBundle(scratch, version, target) {
  const bundle = path.join(scratch, `stub-bundle-${version}-${Date.now()}`);
  await mkdir(path.join(bundle, 'app', 'dist', 'src', 'installation'), { recursive: true });
  await mkdir(path.join(bundle, 'runtime'), { recursive: true });
  await cp(process.execPath, path.join(bundle, 'runtime', 'node'));
  await chmod(path.join(bundle, 'runtime', 'node'), 0o755);
  const stub = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    'function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }',
    'const command = args[0];',
    "const root = arg('--root');",
    `const version = arg('--version') || ${JSON.stringify(version)};`,
    `const target = arg('--target') || ${JSON.stringify(target)};`,
    "if (!root) { console.error('stub entry: --root is required'); process.exit(2); }",
    'fs.mkdirSync(root, { recursive: true });',
    "if (command === 'install') {",
    "  fs.writeFileSync(path.join(root, 'current'), version + '-' + target + '\\n');",
    "  fs.mkdirSync(path.join(root, 'versions', version + '-' + target), { recursive: true });",
    '}',
    "process.stdout.write(JSON.stringify({ command, root, version, target }) + '\\n');",
  ].join('\n');
  await writeFile(path.join(bundle, 'app', 'dist', 'src', 'installation', 'entry.js'), stub);
  return bundle;
}

async function tarGzBundle(bundleDirectory, archive) {
  // On Windows, tar misparses a `C:\...` archive path as a legacy remote
  // `host:file` spec ("Cannot connect to C:"); `--force-local` is tar's own
  // documented escape hatch for a colon-bearing path that is actually local.
  const tool = process.platform === 'win32' ? path.join(GIT_USR_BIN, 'tar.exe') : 'tar';
  const forceLocal = process.platform === 'win32' ? ['--force-local'] : [];
  await run(tool, [...forceLocal, '-czf', archive, '-C', bundleDirectory, '.'], {
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// install.ps1 — runs on the genuine, unmodified manager against a real target
// ---------------------------------------------------------------------------

test(
  'install.ps1 rejects an unsupported architecture before any network call or filesystem change',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-ps1-arch-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const targetRoot = path.join(scratch, 'root');
    const startedAt = Date.now();
    await assert.rejects(
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(repository, 'install.ps1'),
          '-Root',
          targetRoot,
        ],
        {
          windowsHide: true,
          timeout: 30_000,
          env: { ...process.env, PROCESSOR_ARCHITECTURE: 'ARM64' },
        },
      ),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /Unsupported Windows target/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 10_000, 'the check must fail fast, before any network call');
    assert.equal(await exists(targetRoot), false, 'no root directory may be created');
  },
);

test(
  'install.ps1 installs an exact version to a custom destination and is idempotent on repeat',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-ps1-version-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const version = '9.9.9-fixture';
    const { bundle, target } = await realWindowsBundle(scratch, version);
    const archive = path.join(scratch, 'latchkit-9.9.9-fixture-win32-x64.zip');
    await zipBundle(bundle, archive);
    await writeChecksumSidecar(archive);
    const root = path.join(scratch, 'custom root é');

    const install = () =>
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(repository, 'install.ps1'),
          '-Version',
          version,
          '-Root',
          root,
          '-Artifact',
          archive,
          '-Checksum',
          `${archive}.sha256`,
        ],
        { windowsHide: true, timeout: 120_000 },
      );

    await install();
    const current = (await readFile(path.join(root, 'current'), 'utf8')).trim();
    assert.equal(current, `${version}-${target}`);

    // Repeat with identical inputs must succeed without changing the active version.
    await install();
    assert.equal((await readFile(path.join(root, 'current'), 'utf8')).trim(), current);

    // A mismatched requested version must fail and must not disturb the active version.
    await assert.rejects(
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(repository, 'install.ps1'),
          '-Version',
          '1.2.3',
          '-Root',
          root,
          '-Artifact',
          archive,
          '-Checksum',
          `${archive}.sha256`,
        ],
        { windowsHide: true, timeout: 60_000 },
      ),
    );
    assert.equal((await readFile(path.join(root, 'current'), 'utf8')).trim(), current);
  },
);

test(
  'install.ps1 aborts on a checksum mismatch and preserves the previously active version',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-ps1-checksum-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const firstVersion = '9.9.8-fixture';
    const first = await realWindowsBundle(scratch, firstVersion);
    const firstArchive = path.join(scratch, 'first.zip');
    await zipBundle(first.bundle, firstArchive);
    await writeChecksumSidecar(firstArchive);
    const root = path.join(scratch, 'root');

    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(repository, 'install.ps1'),
        '-Version',
        firstVersion,
        '-Root',
        root,
        '-Artifact',
        firstArchive,
        '-Checksum',
        `${firstArchive}.sha256`,
      ],
      { windowsHide: true, timeout: 120_000 },
    );
    const activeBefore = (await readFile(path.join(root, 'current'), 'utf8')).trim();
    assert.equal(activeBefore, `${firstVersion}-win32-x64`);

    const secondVersion = '9.9.9-fixture';
    const second = await realWindowsBundle(scratch, secondVersion);
    const secondArchive = path.join(scratch, 'second.zip');
    await zipBundle(second.bundle, secondArchive);
    await writeChecksumSidecar(secondArchive, { correct: false });

    await assert.rejects(
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(repository, 'install.ps1'),
          '-Version',
          secondVersion,
          '-Root',
          root,
          '-Artifact',
          secondArchive,
          '-Checksum',
          `${secondArchive}.sha256`,
        ],
        { windowsHide: true, timeout: 60_000 },
      ),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /SHA-256 verification failed/);
        return true;
      },
    );
    assert.equal((await readFile(path.join(root, 'current'), 'utf8')).trim(), activeBefore);
    const versions = await readdir(path.join(root, 'versions'));
    assert.ok(
      !versions.includes(`${secondVersion}-win32-x64`),
      'a checksum-mismatched version must never be staged',
    );
  },
);

// ---------------------------------------------------------------------------
// install.sh — unsupported-combination detection uses the genuine script;
// the "supported path" tests use the stub entry.js described in the file
// header comment.
// ---------------------------------------------------------------------------

test(
  'install.sh rejects an unsupported operating system before any change',
  { skip: skipPosix },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-sh-os-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const fakebin = await writeFakeUname(path.join(scratch, 'fakebin'), { s: 'SunOS', m: 'sparc' });
    const targetRoot = path.join(scratch, 'root');
    await assert.rejects(
      run(posixShell, [path.join(repository, 'install.sh'), '--root', targetRoot], {
        timeout: 30_000,
        env: { ...process.env, PATH: `${fakebin}${path.delimiter}${posixPath()}` },
      }),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /Unsupported operating system/);
        return true;
      },
    );
    assert.equal(await exists(targetRoot), false);
  },
);

test(
  'install.sh rejects an unsupported architecture before any change',
  { skip: skipPosix },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-sh-arch-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const fakebin = await writeFakeUname(path.join(scratch, 'fakebin'), { s: 'Linux', m: 'mips' });
    const targetRoot = path.join(scratch, 'root');
    await assert.rejects(
      run(posixShell, [path.join(repository, 'install.sh'), '--root', targetRoot], {
        timeout: 30_000,
        env: { ...process.env, PATH: `${fakebin}${path.delimiter}${posixPath()}` },
      }),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /Unsupported architecture/);
        return true;
      },
    );
    assert.equal(await exists(targetRoot), false);
  },
);

test(
  'install.sh rejects a recognized-but-deferred OS/architecture combination (linux-arm64) before any change',
  { skip: skipPosix },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-sh-combo-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const fakebin = await writeFakeUname(path.join(scratch, 'fakebin'), {
      s: 'Linux',
      m: 'aarch64',
    });
    const targetRoot = path.join(scratch, 'root');
    await assert.rejects(
      run(posixShell, [path.join(repository, 'install.sh'), '--root', targetRoot], {
        timeout: 30_000,
        env: { ...process.env, PATH: `${fakebin}${path.delimiter}${posixPath()}` },
      }),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /Unsupported target: linux-arm64/);
        return true;
      },
    );
    assert.equal(await exists(targetRoot), false);
  },
);

test(
  'install.sh installs an exact version to a custom destination and is idempotent on repeat',
  { skip: skipPosix },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-sh-version-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const fakebin = await writeFakeUname(path.join(scratch, 'fakebin'), {
      s: 'Darwin',
      m: 'x86_64',
    });
    const env = { ...process.env, PATH: `${fakebin}${path.delimiter}${posixPath()}` };
    const version = '9.9.9-fixture';
    const target = 'darwin-x64';
    const bundle = await stubPosixBundle(scratch, version, target);
    const archive = path.join(scratch, 'latchkit-9.9.9-fixture-darwin-x64.tar.gz');
    await tarGzBundle(bundle, archive);
    await writeChecksumSidecar(archive);
    const root = path.join(scratch, 'custom root é');

    const install = () =>
      run(
        posixShell,
        [
          path.join(repository, 'install.sh'),
          '--version',
          version,
          '--root',
          root,
          '--artifact',
          archive,
          '--checksum',
          `${archive}.sha256`,
        ],
        { timeout: 60_000, env },
      );

    const first = await install();
    assert.match(first.stdout, /Use .*bin\/latchkit or add its bin directory to PATH/);
    const current = (await readFile(path.join(root, 'current'), 'utf8')).trim();
    assert.equal(current, `${version}-${target}`);

    await install();
    assert.equal((await readFile(path.join(root, 'current'), 'utf8')).trim(), current);
  },
);

test(
  'install.sh aborts on a checksum mismatch and preserves the previously active version',
  { skip: skipPosix },
  async (t) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-install-sh-checksum-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const fakebin = await writeFakeUname(path.join(scratch, 'fakebin'), {
      s: 'Darwin',
      m: 'x86_64',
    });
    const env = { ...process.env, PATH: `${fakebin}${path.delimiter}${posixPath()}` };
    const target = 'darwin-x64';
    const root = path.join(scratch, 'root');

    const firstVersion = '9.9.8-fixture';
    const firstBundle = await stubPosixBundle(scratch, firstVersion, target);
    const firstArchive = path.join(scratch, 'first.tar.gz');
    await tarGzBundle(firstBundle, firstArchive);
    await writeChecksumSidecar(firstArchive);
    await run(
      posixShell,
      [
        path.join(repository, 'install.sh'),
        '--version',
        firstVersion,
        '--root',
        root,
        '--artifact',
        firstArchive,
        '--checksum',
        `${firstArchive}.sha256`,
      ],
      { timeout: 60_000, env },
    );
    const activeBefore = (await readFile(path.join(root, 'current'), 'utf8')).trim();
    assert.equal(activeBefore, `${firstVersion}-${target}`);

    const secondVersion = '9.9.9-fixture';
    const secondBundle = await stubPosixBundle(scratch, secondVersion, target);
    const secondArchive = path.join(scratch, 'second.tar.gz');
    await tarGzBundle(secondBundle, secondArchive);
    await writeChecksumSidecar(secondArchive, { correct: false });

    await assert.rejects(
      run(
        posixShell,
        [
          path.join(repository, 'install.sh'),
          '--version',
          secondVersion,
          '--root',
          root,
          '--artifact',
          secondArchive,
          '--checksum',
          `${secondArchive}.sha256`,
        ],
        { timeout: 60_000, env },
      ),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /SHA-256 verification failed/);
        return true;
      },
    );
    assert.equal((await readFile(path.join(root, 'current'), 'utf8')).trim(), activeBefore);
    const versions = await readdir(path.join(root, 'versions'));
    assert.ok(
      !versions.includes(`${secondVersion}-${target}`),
      'a checksum-mismatched version must never be staged',
    );
  },
);

test(
  'install.sh usage error for an unknown flag names the correct exit path',
  { skip: skipPosix },
  async () => {
    await assert.rejects(
      run(posixShell, [path.join(repository, 'install.sh'), '--bogus-flag'], {
        timeout: 15_000,
        env: { ...process.env, PATH: posixPath() },
      }),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /Usage: install\.sh/);
        return true;
      },
    );
  },
);
