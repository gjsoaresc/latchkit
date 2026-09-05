import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('CLI version, release manifest, checksum, and SPDX inventory use the package version', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'latchkit-release-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = (
    await run(process.execPath, ['src/cli.js', '--version'], { cwd: root })
  ).stdout.trim();
  assert.equal(version, packageJson.version);
  await run(process.execPath, ['scripts/release-artifacts.js', '--dry-run', '--output', output], {
    cwd: root,
  });
  const manifest = JSON.parse(await readFile(path.join(output, 'release-manifest.json'), 'utf8'));
  const sbom = JSON.parse(await readFile(path.join(output, 'sbom.spdx.json'), 'utf8'));
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.publication, 'dry-run; no registry mutation');
  assert.match(
    await readFile(path.join(output, `${manifest.archive}.sha256`), 'utf8'),
    /^[a-f0-9]{64} {2}/,
  );
  assert.equal(sbom.packages[0].versionInfo, packageJson.version);
});

test('release preparation refuses a tag that does not match package version', async () => {
  await assert.rejects(
    run(process.execPath, ['scripts/release-artifacts.js', '--tag', 'v99.0.0'], { cwd: root }),
    /does not match package version/,
  );
});
