import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { verifyEmbeddedArchive, verifyReleaseArtifacts } from '../scripts/release-artifacts.js';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

async function embeddedArchiveFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'latchkit-embedded-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'bundle');
  const files = async (base, prefix = '') => {
    const output = [];
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(base, entry.name);
      if (entry.isDirectory()) output.push(...(await files(filename, relative)));
      else {
        const bytes = await readFile(filename);
        output.push({
          path: relative,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
    return output.sort((a, b) => a.path.localeCompare(b.path));
  };
  await mkdir(path.join(bundle, 'app'), { recursive: true });
  const packageItem = { name: 'latchkit', version: '1.0.0', license: 'MIT', path: 'app' };
  await writeFile(path.join(bundle, 'app', 'package.json'), JSON.stringify(packageItem));
  const spdx = {
    packages: [
      {
        SPDXID: `SPDXRef-${createHash('sha256').update('app').digest('hex').slice(0, 24)}`,
        name: 'latchkit',
        versionInfo: '1.0.0',
        licenseConcluded: 'MIT',
      },
    ],
  };
  await writeFile(path.join(bundle, 'sbom.spdx.json'), JSON.stringify(spdx));
  await writeFile(
    path.join(bundle, 'licenses.json'),
    JSON.stringify({ schemaVersion: 1, files: [] }),
  );
  const embedded = {
    schemaVersion: 1,
    package: 'latchkit',
    version: '1.0.0',
    target: 'win32-x64',
    nodeVersion: '24.20.0',
    bamlVersion: '0.17.0',
    commit: 'a'.repeat(40),
    dirty: false,
    packages: [packageItem],
    files: await files(bundle),
  };
  await writeFile(path.join(bundle, 'bundle-manifest.json'), JSON.stringify(embedded));
  const archive = path.join(directory, 'bundle.tar.gz');
  await run('tar', ['-czf', archive, '-C', bundle, '.']);
  return { archive, embedded, spdx, bundle, directory };
}

async function releaseFixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'latchkit-release-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const archive = 'latchkit-1.0.0-win32-x64.zip';
  const bytes = Buffer.from('bounded release fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const packages = [
    'latchkit',
    'node',
    '@boundaryml/baml-bridge',
    '@boundaryml/baml-bridge-win32-x64-msvc',
    'protobufjs',
  ].map((name) => ({ name, version: 'fixture' }));
  const manifest = {
    schemaVersion: 1,
    package: 'latchkit',
    version: '1.0.0',
    target: 'win32-x64',
    nodeVersion: '24.20.0',
    bamlVersion: '0.17.0',
    archive,
    sha256,
    commit: 'a'.repeat(40),
    dirty: false,
    packages,
  };
  const save = () =>
    writeFile(path.join(output, `${archive}.manifest.json`), JSON.stringify(manifest));
  await writeFile(path.join(output, archive), bytes);
  await writeFile(path.join(output, `${archive}.sha256`), `${sha256}  ${archive}\n`);
  await writeFile(path.join(output, `${archive}.spdx.json`), JSON.stringify({ packages }));
  await save();
  return { output, archive, manifest, save };
}

test('emitted CLI reports the candidate version', async () => {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(
    (await run(process.execPath, ['dist/src/cli.js', '--version'], { cwd: root })).stdout.trim(),
    metadata.version,
  );
});

test('release verification binds bytes, version, source commit, and native dependency inventory', async (t) => {
  const fixture = await releaseFixture(t);
  assert.equal(
    (await verifyReleaseArtifacts(fixture.output, { tag: 'v1.0.0', commit: 'a'.repeat(40) }))
      .length,
    1,
  );
  await assert.rejects(verifyReleaseArtifacts(fixture.output, { tag: 'v2.0.0' }), /version/);
  await assert.rejects(
    verifyReleaseArtifacts(fixture.output, { commit: 'b'.repeat(40) }),
    /approved tag commit/,
  );
  fixture.manifest.packages = fixture.manifest.packages.filter(
    (item) => item.name !== 'protobufjs',
  );
  await fixture.save();
  await assert.rejects(verifyReleaseArtifacts(fixture.output), /dependency closure/);
});

test('publication rejects missing targets and modified archives', async (t) => {
  const fixture = await releaseFixture(t);
  await assert.rejects(
    verifyReleaseArtifacts(fixture.output, { requireClean: true }),
    /four qualified/,
  );
  await writeFile(path.join(fixture.output, fixture.archive), 'tampered');
  await assert.rejects(verifyReleaseArtifacts(fixture.output), /checksum/);
});

test('release preparation refuses a mismatched tag before building', async () => {
  await assert.rejects(
    run(process.execPath, ['scripts/release-artifacts.js', '--tag', 'v99.0.0'], { cwd: root }),
    /does not match package version/,
  );
});

test('embedded archive verification rejects mismatched metadata and untracked delivered files', async (t) => {
  const fixture = await embeddedArchiveFixture(t);
  const sidecar = { ...fixture.embedded, archive: 'bundle.tar.gz', sha256: '0'.repeat(64) };
  await verifyEmbeddedArchive(fixture.archive, sidecar, fixture.spdx);
  await assert.rejects(
    verifyEmbeddedArchive(fixture.archive, sidecar, {
      packages: [{ ...fixture.spdx.packages[0], name: 'same-count-wrong-package' }],
    }),
    /SBOM differs/,
  );
  await writeFile(path.join(fixture.bundle, 'extra.exe'), 'unexpected');
  await run('tar', ['-czf', fixture.archive, '-C', fixture.bundle, '.']);
  await assert.rejects(
    verifyEmbeddedArchive(fixture.archive, sidecar, fixture.spdx),
    /inventory differs/,
  );
  await rm(path.join(fixture.bundle, 'app', 'package.json'));
  await run('tar', ['-czf', fixture.archive, '-C', fixture.bundle, '.']);
  await assert.rejects(
    verifyEmbeddedArchive(fixture.archive, sidecar, fixture.spdx),
    /inventory differs/,
  );
});
