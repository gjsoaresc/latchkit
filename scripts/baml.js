import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = readFileSync(path.join(root, '.baml-version'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid BAML toolchain pin.');
const runtime = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (runtime.dependencies?.['@boundaryml/baml-bridge'] !== version)
  throw new Error('BAML compiler and runtime must have the same exact version.');
const local = path.join(
  os.homedir(),
  '.baml',
  'bin',
  process.platform === 'win32' ? 'baml.exe' : 'baml',
);
const executable = process.env.LATCHKIT_BAML_BIN || (existsSync(local) ? local : 'baml');
const env = { ...process.env, BAML_VERSION: version };
function run(args, capture = false, cwd = root) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    windowsHide: true,
    timeout: 120_000,
    shell: false,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw new Error(`BAML ${version} is required: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? '';
}
const actual = run(['--version'], true);
if (
  !actual
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trim().match(/^baml toolchain (\d+\.\d+\.\d+)(?: \([^\r\n]*\))?\.?$/)?.[1] === version,
    )
)
  throw new Error(`Expected BAML ${version}; received ${actual.trim()}.`);

function generatedDigest() {
  const directory = path.join(root, 'src', 'baml_sdk');
  if (!existsSync(directory)) return null;
  const hash = createHash('sha256');
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort();
  for (const file of files) {
    hash.update(path.relative(directory, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
const args = process.argv.slice(2);
if (args[0] === 'test') {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'latchkit-baml-tests-'));
  try {
    cpSync(path.join(root, 'baml.toml'), path.join(stage, 'baml.toml'));
    cpSync(path.join(root, 'baml_src'), path.join(stage, 'baml_src'), { recursive: true });
    cpSync(path.join(root, 'baml_tests'), path.join(stage, 'baml_src', 'tests'), {
      recursive: true,
    });
    run(['test', '--directory', stage, ...args.slice(1)]);
  } finally {
    rmSync(stage, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
  }
} else if (args.length === 1 && args[0] === 'check-generated') {
  const before = generatedDigest();
  run(['generate']);
  if (before === null || before !== generatedDigest()) {
    console.error('BAML SDK was stale. Commit the regenerated src/baml_sdk files.');
    process.exitCode = 1;
  }
} else {
  run(args.length ? args : ['check']);
}
