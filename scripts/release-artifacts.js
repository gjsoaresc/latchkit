#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const command = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = process.argv.slice(2);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

function packageEntries(lock) {
  return Object.entries(lock.packages)
    .filter(([name]) => name && !name.startsWith('node_modules/'))
    .map(([name, value]) => ({
      SPDXID: `SPDXRef-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`,
      name: value.name ?? name.slice('node_modules/'.length),
      versionInfo: value.version ?? 'unknown',
      licenseConcluded: value.license ?? 'NOASSERTION',
      licenseDeclared: value.license ?? 'NOASSERTION',
      downloadLocation: value.resolved ?? 'NOASSERTION',
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.versionInfo.localeCompare(right.versionInfo),
    );
}

async function artifactFromPack(destination) {
  const result = await command(npm, ['pack', '--json', '--pack-destination', destination], {
    cwd: repository,
    encoding: 'utf8',
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });
  return path.join(destination, JSON.parse(result.stdout)[0].filename);
}

async function main() {
  const output = path.resolve(valueAfter('--output') ?? path.join(repository, 'release-artifacts'));
  const dryRun = args.includes('--dry-run');
  const requestedArtifact = valueAfter('--artifact');
  const packageJson = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  const tag = valueAfter('--tag');
  if (tag && tag !== `v${packageJson.version}`)
    throw new Error(`Release tag ${tag} does not match package version v${packageJson.version}.`);
  await mkdir(output, { recursive: true });
  const artifact = requestedArtifact
    ? path.resolve(requestedArtifact)
    : await artifactFromPack(output);
  if (!(await stat(artifact)).isFile()) throw new Error(`Archive does not exist: ${artifact}`);
  const archiveName = path.basename(artifact);
  const digest = await sha256(artifact);
  const lock = JSON.parse(await readFile(path.join(repository, 'package-lock.json'), 'utf8'));
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${packageJson.name}-${packageJson.version}`,
    documentNamespace: `https://github.com/gjsoaresc/latchkit/releases/tag/v${packageJson.version}`,
    creationInfo: {
      creators: ['Tool: latchkit release-artifacts'],
      created: '1970-01-01T00:00:00Z',
    },
    packages: [
      {
        SPDXID: 'SPDXRef-Package',
        name: packageJson.name,
        versionInfo: packageJson.version,
        licenseConcluded: packageJson.license,
        licenseDeclared: packageJson.license,
        downloadLocation: 'NOASSERTION',
        checksums: [{ algorithm: 'SHA256', checksumValue: digest }],
      },
      ...packageEntries(lock),
    ],
  };
  const manifest = {
    schemaVersion: 1,
    package: packageJson.name,
    version: packageJson.version,
    archive: archiveName,
    sha256: digest,
    releaseTag: tag ?? null,
    publication: dryRun
      ? 'dry-run; no registry mutation'
      : 'prepared; publication requires CI environment approval',
  };
  await writeFile(path.join(output, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`);
  await writeFile(path.join(output, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
  await writeFile(
    path.join(output, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const files = (await readdir(output)).sort();
  console.log(JSON.stringify({ status: 'prepared', output, files, ...manifest }, null, 2));
}

main().catch((error) => {
  console.error(`Release artifact preparation failed: ${error.message}`);
  process.exitCode = 1;
});
