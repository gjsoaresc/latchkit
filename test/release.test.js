import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { verifyEmbeddedArchive, verifyReleaseArtifacts } from '../scripts/release-artifacts.js';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function storedZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const checksum = crc32(bytes);
    const local = Buffer.concat([
      uint32(0x04034b50),
      uint16(20),
      uint16(0x0800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(bytes.length),
      uint32(bytes.length),
      uint16(filename.length),
      uint16(0),
      filename,
      bytes,
    ]);
    parts.push(local);
    central.push(
      Buffer.concat([
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0x0800),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(checksum),
        uint32(bytes.length),
        uint32(bytes.length),
        uint16(filename.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        filename,
      ]),
    );
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([
    ...parts,
    directory,
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(directory.length),
    uint32(offset),
    uint16(0),
  ]);
}

async function embeddedArchiveFixture(
  t,
  { target = 'win32-x64', version = '1.0.0', zip = false } = {},
) {
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
  const packages = [
    { name: 'latchkit', version, license: 'MIT', path: 'app' },
    { name: 'node', version: '24.20.0', license: 'NOASSERTION', path: 'runtime' },
  ];
  const packageItem = packages[0];
  await writeFile(path.join(bundle, 'app', 'package.json'), JSON.stringify(packageItem));
  const spdx = {
    packages: packages.map((item) => ({
      SPDXID: `SPDXRef-${createHash('sha256').update(item.path).digest('hex').slice(0, 24)}`,
      name: item.name,
      versionInfo: item.version,
      licenseConcluded: item.license,
    })),
  };
  await writeFile(path.join(bundle, 'sbom.spdx.json'), JSON.stringify(spdx));
  await writeFile(
    path.join(bundle, 'licenses.json'),
    JSON.stringify({ schemaVersion: 1, files: [] }),
  );
  const embedded = {
    schemaVersion: 1,
    package: 'latchkit',
    version,
    target,
    nodeVersion: '24.20.0',
    commit: 'a'.repeat(40),
    dirty: false,
    packages,
    files: await files(bundle),
  };
  await writeFile(path.join(bundle, 'bundle-manifest.json'), JSON.stringify(embedded));
  const archive = path.join(directory, zip ? 'bundle.zip' : 'bundle.tar.gz');
  if (zip) {
    const entries = await Promise.all(
      (await files(bundle)).map(async (file) => ({
        name: file.path,
        bytes: await readFile(path.join(bundle, ...file.path.split('/'))),
      })),
    );
    await writeFile(archive, storedZip(entries));
  } else await run('tar', ['-czf', archive, '-C', bundle, '.']);
  return { archive, embedded, spdx, bundle, directory };
}

async function releaseFixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'latchkit-release-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const archive = 'latchkit-1.0.0-win32-x64.zip';
  const bytes = Buffer.from('bounded release fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const packages = ['latchkit', 'node'].map((name) => ({ name, version: 'fixture' }));
  const manifest = {
    schemaVersion: 1,
    package: 'latchkit',
    version: '1.0.0',
    target: 'win32-x64',
    nodeVersion: '24.20.0',
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

const smokeChecks = [
  'compiled workflow policy async exit',
  'CLI',
  'UI/API',
  'hooks',
  'stable hook dispatch before/after rollback/uninstall',
  'spaces/Unicode',
  'installation',
  'failed-upgrade preservation',
  'rollback selection',
  'uninstall retention',
  'local archive bootstrap',
];

async function publicationFixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'latchkit-publication-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await mkdir(path.join(output, 'previous'), { recursive: true });
  await cp(path.join(root, 'install.ps1'), path.join(output, 'install.ps1'));
  const manifests = [];
  const evidence = [];
  for (const target of ['win32-x64']) {
    const current = await embeddedArchiveFixture(t, { target });
    const prior = await embeddedArchiveFixture(t, { target, version: '0.9.0' });
    const archive = `latchkit-1.0.0-${target}.tar.gz`;
    const priorArchive = `latchkit-0.9.0-${target}.tar.gz`;
    const currentBytes = await readFile(current.archive);
    const priorBytes = await readFile(prior.archive);
    const manifest = {
      ...current.embedded,
      archive,
      sha256: createHash('sha256').update(currentBytes).digest('hex'),
    };
    const priorManifest = {
      ...prior.embedded,
      archive: priorArchive,
      sha256: createHash('sha256').update(priorBytes).digest('hex'),
    };
    await writeFile(path.join(output, archive), currentBytes);
    await writeFile(path.join(output, `${archive}.sha256`), `${manifest.sha256}  ${archive}\n`);
    await writeFile(path.join(output, `${archive}.manifest.json`), JSON.stringify(manifest));
    await writeFile(path.join(output, `${archive}.spdx.json`), JSON.stringify(current.spdx));
    await writeFile(path.join(output, 'previous', priorArchive), priorBytes);
    await writeFile(
      path.join(output, 'previous', `${priorArchive}.sha256`),
      `${priorManifest.sha256}  ${priorArchive}\n`,
    );
    await writeFile(
      path.join(output, 'previous', `${priorArchive}.manifest.json`),
      JSON.stringify(priorManifest),
    );
    manifests.push(manifest);
    const base = {
      status: 'passed',
      archive,
      sha256: manifest.sha256,
      target,
      node: 'v24.20.0',
      upgradeKind: 'exact-prior-archive',
      prior: {
        archive: priorArchive,
        sha256: priorManifest.sha256,
        version: priorManifest.version,
      },
      systemToolchains: 'absent from PATH',
      checks: smokeChecks,
    };
    evidence.push({
      ...base,
      runtime: 'native',
      qualificationOS: 'Windows 11 Pro',
      qualificationVersion: '10.0.26100',
    });
  }
  const workflowManifest = manifests[0];
  evidence.push({
    schemaVersion: 1,
    kind: 'live-workflow-qualification',
    candidate: {
      archiveSha256: workflowManifest.sha256,
      commit: workflowManifest.commit,
      version: workflowManifest.version,
      target: workflowManifest.target,
      nodeVersion: workflowManifest.nodeVersion,
      privateNodeVersion: 'v24.20.0',
    },
    workflow: {
      workflowId: 'workflow-fixture',
      taskId: 'task-fixture',
      status: 'verified',
      phase: 'handoff',
      actions: ['requirements', 'plan', 'implementation', 'verification', 'review', 'handoff'].map(
        (phase) => ({ phase, status: 'passed' }),
      ),
    },
    proof: { taskState: 'verified', independentReview: 'passed', handoff: 'present' },
  });
  const saveEvidence = () =>
    Promise.all(
      evidence.map((item, index) =>
        writeFile(path.join(output, `qualification-${index}.evidence.json`), JSON.stringify(item)),
      ),
    );
  await saveEvidence();
  return { output, evidence, manifests, saveEvidence };
}

test('emitted CLI reports the candidate version', async () => {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(
    (await run(process.execPath, ['dist/src/cli.js', '--version'], { cwd: root })).stdout.trim(),
    metadata.version,
  );
});

test('release verification binds bytes, version, source commit, and production package inventory', async (t) => {
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
  fixture.manifest.packages = fixture.manifest.packages.filter((item) => item.name !== 'node');
  await fixture.save();
  await assert.rejects(verifyReleaseArtifacts(fixture.output), /SBOM/);
});

test('publication rejects non-Windows bundles and modified archives', async (t) => {
  const fixture = await releaseFixture(t);
  fixture.manifest.target = 'linux-x64';
  await fixture.save();
  await assert.rejects(
    verifyReleaseArtifacts(fixture.output, { requireClean: true }),
    /one qualified Windows/,
  );
  await writeFile(path.join(fixture.output, fixture.archive), 'tampered');
  await assert.rejects(verifyReleaseArtifacts(fixture.output), /checksum/);
});

test('publication requires exact prior-archive smoke and exact live workflow evidence', async (t) => {
  const fixture = await publicationFixture(t);
  assert.equal((await verifyReleaseArtifacts(fixture.output, { requireClean: true })).length, 1);
  fixture.evidence[0].upgradeKind = 'single-archive-fallback';
  await fixture.saveEvidence();
  await assert.rejects(
    verifyReleaseArtifacts(fixture.output, { requireClean: true }),
    /Exact prior-archive qualification/,
  );
  fixture.evidence[0].upgradeKind = 'exact-prior-archive';
  fixture.evidence.at(-1).proof.independentReview = 'missing';
  await fixture.saveEvidence();
  await assert.rejects(
    verifyReleaseArtifacts(fixture.output, { requireClean: true }),
    /live workflow qualification/,
  );
});

test('publication requires Windows 11 exact native evidence', async (t) => {
  const fixture = await publicationFixture(t);
  const windows = fixture.evidence.find(
    (item) => item.target === 'win32-x64' && item.runtime === 'native',
  );
  delete windows.qualificationOS;
  await fixture.saveEvidence();
  await assert.rejects(
    verifyReleaseArtifacts(fixture.output, { requireClean: true }),
    /Windows 11/,
  );
  windows.qualificationOS = 'Windows Server 2025';
  await fixture.saveEvidence();
  await assert.rejects(
    verifyReleaseArtifacts(fixture.output, { requireClean: true }),
    /Windows 11/,
  );
  windows.qualificationOS = 'Windows 11 Pro';
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

test('embedded ZIP verification uses a ZIP-capable archive reader', async (t) => {
  const fixture = await embeddedArchiveFixture(t, { zip: true });
  const sidecar = { ...fixture.embedded, archive: 'bundle.zip', sha256: '0'.repeat(64) };
  await verifyEmbeddedArchive(fixture.archive, sidecar, fixture.spdx);
});
