#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveTar } from './archive-tool.js';
import { buildBundle } from './bundle.js';

const command = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..', '..');
type JsonRecord = Record<string, unknown>;
type ArchiveFile = { path: string; bytes: number; sha256: string };
type PackageEntry = { name: string; version: string; license: string; path: string };
export type ReleaseManifest = JsonRecord & {
  schemaVersion: number;
  package: string;
  version: string;
  target: string;
  nodeVersion: string;
  commit: string;
  dirty: boolean;
  archive: string;
  sha256: string;
  files: ArchiveFile[];
  packages: PackageEntry[];
};
type ReleaseVerificationOptions = { tag?: string; requireClean?: boolean; commit?: string };
type BuildOptions = { output: string; version?: string; target?: string };
type ArchiveTool = { tool: string; prefixArgs: string[] };
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const requiredSmokeChecks = Object.freeze([
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
]);
const requiredWorkflowPhases = Object.freeze([
  'requirements',
  'plan',
  'implementation',
  'verification',
  'review',
  'handoff',
]);

function safeArchivePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value) &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

const canonical = (value: unknown) => JSON.stringify(value);

export async function stageWindowsBootstrap(directory: string, target: string): Promise<void> {
  if (target !== 'win32-x64') return;
  const source = path.join(repository, 'install.ps1');
  const destination = path.join(directory, 'install.ps1');
  const bytes = await readFile(source);
  try {
    if (!(await lstat(destination)).isFile())
      throw new Error('Existing publication bootstrap must be a regular file, not a link.');
    const existing = await readFile(destination);
    if (!existing.equals(bytes))
      throw new Error('Existing publication bootstrap differs from the reviewed install.ps1.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }
}

export async function prepareReleaseArtifacts(
  { output, version, target = `${process.platform}-${process.arch}` }: BuildOptions,
  build = buildBundle,
) {
  // Refuse bootstrap conflicts before the builder can replace any archive or sidecar.
  await stageWindowsBootstrap(output, target);
  return build({ output, version, target });
}

async function archiveTool(archive: string): Promise<ArchiveTool> {
  if (process.platform === 'win32') return resolveTar();
  return {
    tool:
      path.extname(archive).toLowerCase() === '.zip' && process.platform === 'linux'
        ? 'bsdtar'
        : 'tar',
    prefixArgs: [],
  };
}

async function archiveCommand(
  archive: string,
  args: string[],
  options: Parameters<typeof command>[2],
) {
  try {
    const { tool, prefixArgs } = await archiveTool(archive);
    return await command(tool, [...prefixArgs, ...args], options);
  } catch (error) {
    if (
      path.extname(archive).toLowerCase() === '.zip' &&
      process.platform === 'linux' &&
      error &&
      typeof error === 'object' &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw new Error('ZIP verification requires bsdtar (libarchive-tools) on this platform.', {
        cause: error,
      });
    throw error;
  }
}

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function validPriorArtifact(
  directory: string,
  prior: unknown,
  manifest: ReleaseManifest,
): Promise<boolean> {
  const invalidShape =
    !record(prior) ||
    !safeArchivePath(prior?.archive) ||
    typeof prior?.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(prior.sha256) ||
    typeof prior?.version !== 'string' ||
    prior.version === manifest.version;
  if (invalidShape) return false;
  const validatedPrior = prior as { archive: string; sha256: string; version: string };
  const location = path.join(directory, 'previous', validatedPrior.archive);
  const manifestLocation = `${location}.manifest.json`;
  const checksumLocation = `${location}.sha256`;
  try {
    if (sha256(await readFile(location)) !== validatedPrior.sha256) return false;
    if (
      (await readFile(checksumLocation, 'utf8')).trim() !==
      `${validatedPrior.sha256}  ${validatedPrior.archive}`
    )
      return false;
    const priorManifest = JSON.parse(await readFile(manifestLocation, 'utf8'));
    const valid =
      record(priorManifest) &&
      priorManifest.archive === validatedPrior.archive &&
      priorManifest.sha256 === validatedPrior.sha256 &&
      priorManifest.version === validatedPrior.version &&
      priorManifest.version !== manifest.version &&
      priorManifest.target === manifest.target;
    return valid;
  } catch {
    return false;
  }
}

function smokeArtifactEvidence(item: unknown, manifest: ReleaseManifest): item is JsonRecord {
  return (
    record(item) &&
    item.status === 'passed' &&
    item.archive === manifest.archive &&
    item.sha256 === manifest.sha256 &&
    item.target === manifest.target &&
    item.node === 'v24.20.0' &&
    item.systemToolchains === 'absent from PATH' &&
    Array.isArray(item.checks) &&
    requiredSmokeChecks.every((check) => (item.checks as unknown[]).includes(check))
  );
}

async function exactSmokeEvidence(
  directory: string,
  item: unknown,
  manifest: ReleaseManifest,
): Promise<boolean> {
  if (
    !smokeArtifactEvidence(item, manifest) ||
    item.upgradeKind !== 'exact-prior-archive' ||
    !record(item.prior)
  )
    return false;
  return validPriorArtifact(directory, item.prior, manifest);
}

function windows11Qualification(item: unknown): boolean {
  if (!record(item)) return false;
  if (typeof item.qualificationOS !== 'string') return false;
  const osName = item.qualificationOS.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    osName.includes('windows11') &&
    !osName.includes('server') &&
    typeof item.qualificationVersion === 'string' &&
    /^10\.0\.\d+(?:\.\d+)?$/.test(item.qualificationVersion)
  );
}

function exactWorkflowEvidence(item: unknown, manifests: ReleaseManifest[]): boolean {
  if (!record(item) || item.kind !== 'live-workflow-qualification' || !record(item.candidate))
    return false;
  const candidateRecord = item.candidate as JsonRecord;
  const manifest = manifests.find(
    (manifestCandidate) =>
      manifestCandidate.sha256 === candidateRecord.archiveSha256 &&
      manifestCandidate.commit === candidateRecord.commit &&
      manifestCandidate.version === candidateRecord.version &&
      manifestCandidate.target === candidateRecord.target &&
      manifestCandidate.nodeVersion === candidateRecord.nodeVersion,
  );
  if (
    !manifest ||
    item.candidate.nodeVersion !== '24.20.0' ||
    item.candidate.privateNodeVersion !== 'v24.20.0' ||
    !record(item.workflow) ||
    item.workflow.status !== 'verified' ||
    item.workflow.phase !== 'handoff' ||
    typeof item.workflow.workflowId !== 'string' ||
    !item.workflow.workflowId ||
    typeof item.workflow.taskId !== 'string' ||
    !item.workflow.taskId ||
    !Array.isArray(item.workflow.actions) ||
    !record(item.proof) ||
    item.proof.taskState !== 'verified' ||
    item.proof.independentReview !== 'passed' ||
    item.proof.handoff !== 'present'
  )
    return false;
  const workflow = item.workflow as JsonRecord & { actions: unknown[] };
  return requiredWorkflowPhases.every((phase) =>
    workflow.actions.some(
      (action) => record(action) && action.phase === phase && action.status === 'passed',
    ),
  );
}

async function inventory(directory: string, prefix = ''): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Archive contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...(await inventory(filename, relative)));
    else if (entry.isFile()) {
      const bytes = await readFile(filename);
      files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    } else throw new Error(`Archive contains a non-regular entry: ${relative}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function verifyEmbeddedArchive(
  archive: string,
  sidecarManifest: ReleaseManifest,
  sidecarSbom: JsonRecord,
): Promise<void> {
  const commandOptions = { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 };
  const listing = String((await archiveCommand(archive, ['-tf', archive], commandOptions)).stdout)
    .split(/\r?\n/)
    .filter(Boolean);
  const normalized = listing
    .map((name) => name.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean);
  if (
    normalized.some((name) => !safeArchivePath(name)) ||
    new Set(normalized).size !== normalized.length
  )
    throw new Error('Archive contains an unsafe or duplicate entry.');
  const verbose = String((await archiveCommand(archive, ['-tvf', archive], commandOptions)).stdout)
    .split(/\r?\n/)
    .filter(Boolean);
  if (verbose.some((line) => !/^[-d]/.test(line)))
    throw new Error('Archive contains a link or non-regular entry.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'latchkit-release-verify-'));
  try {
    if (!path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
      throw new Error('Unexpected archive verification temporary directory.');
    await archiveCommand(archive, ['-xf', archive, '-C', temporary], commandOptions);
    const embedded = JSON.parse(
      await readFile(path.join(temporary, 'bundle-manifest.json'), 'utf8'),
    ) as ReleaseManifest;
    const expected: Partial<ReleaseManifest> = { ...sidecarManifest };
    delete expected.archive;
    delete expected.sha256;
    if (canonical(embedded) !== canonical(expected))
      throw new Error('Embedded bundle manifest differs from its sidecar manifest.');
    const embeddedSbom = JSON.parse(
      await readFile(path.join(temporary, 'sbom.spdx.json'), 'utf8'),
    ) as JsonRecord & { packages?: JsonRecord[] };
    if (canonical(embeddedSbom) !== canonical(sidecarSbom))
      throw new Error('Embedded SBOM differs from its sidecar SBOM.');
    const actual = await inventory(temporary);
    const recorded = [
      ...embedded.files,
      {
        path: 'bundle-manifest.json',
        bytes: await readFile(path.join(temporary, 'bundle-manifest.json')).then(
          (value) => value.length,
        ),
        sha256: sha256(await readFile(path.join(temporary, 'bundle-manifest.json'))),
      },
    ].sort((left, right) => left.path.localeCompare(right.path));
    if (canonical(actual) !== canonical(recorded))
      throw new Error('Archive file inventory differs from its embedded manifest.');
    const licenses = JSON.parse(await readFile(path.join(temporary, 'licenses.json'), 'utf8')) as {
      schemaVersion?: number;
      files?: unknown[];
    };
    if (
      !licenses ||
      licenses.schemaVersion !== 1 ||
      !Array.isArray(licenses.files) ||
      licenses.files.some(
        (item) => !safeArchivePath(item) || !actual.some((file) => file.path === item),
      )
    )
      throw new Error('Embedded license inventory is invalid.');
    for (const packageItem of embedded.packages) {
      const sbomItem = embeddedSbom.packages?.find(
        (item) => item.SPDXID === `SPDXRef-${sha256(Buffer.from(packageItem.path)).slice(0, 24)}`,
      );
      if (
        !sbomItem ||
        sbomItem.name !== packageItem.name ||
        sbomItem.versionInfo !== packageItem.version ||
        sbomItem.licenseConcluded !== packageItem.license
      )
        throw new Error('SBOM package identity differs from the embedded production closure.');
    }
    const expectedPackages = new Map(embedded.packages.map((item) => [item.path, item]));
    for (const file of actual.filter(
      (item) =>
        item.path === 'app/package.json' ||
        /^app\/node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(item.path),
    )) {
      const metadata = JSON.parse(
        await readFile(path.join(temporary, ...file.path.split('/')), 'utf8'),
      ) as { name?: string; version?: string; license?: unknown };
      const packagePath =
        file.path === 'app/package.json' ? 'app' : file.path.slice(0, -'/package.json'.length);
      const expectedPackage = expectedPackages.get(packagePath);
      if (
        !expectedPackage ||
        metadata.name !== expectedPackage.name ||
        metadata.version !== expectedPackage.version ||
        (typeof metadata.license === 'string' ? metadata.license : 'NOASSERTION') !==
          expectedPackage.license
      )
        throw new Error(`Delivered package identity is unlisted or mismatched: ${packagePath}`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyReleaseArtifacts(
  directory: string,
  { tag, requireClean = false, commit }: ReleaseVerificationOptions = {},
): Promise<ReleaseManifest[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.manifest.json'));
  if (!files.length) throw new Error('No standalone bundle manifests were supplied.');
  const targets = new Set();
  const manifests: ReleaseManifest[] = [];
  const embeddedChecks: { archive: string; manifest: ReleaseManifest; sbom: JsonRecord }[] = [];
  for (const file of files) {
    const manifest = JSON.parse(
      await readFile(path.join(directory, file), 'utf8'),
    ) as ReleaseManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.package !== 'latchkit' ||
      !['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'].includes(manifest.target) ||
      typeof manifest.archive !== 'string' ||
      path.basename(manifest.archive) !== manifest.archive ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)
    )
      throw new Error('Invalid standalone bundle manifest.');
    if (targets.has(manifest.target)) throw new Error('Duplicate bundle target.');
    targets.add(manifest.target);
    if (tag && tag !== `v${manifest.version}`)
      throw new Error('Tag does not match bundle version.');
    if (commit && commit !== manifest.commit)
      throw new Error('Bundle was not built from the approved tag commit.');
    if (requireClean && manifest.dirty !== false)
      throw new Error('Publication requires a clean committed source tree.');
    if (manifest.nodeVersion !== '24.20.0')
      throw new Error('Runtime pins do not match the qualified release.');
    if (sha256(await readFile(path.join(directory, manifest.archive))) !== manifest.sha256)
      throw new Error('Bundle checksum verification failed.');
    const checksum = (
      await readFile(path.join(directory, `${manifest.archive}.sha256`), 'utf8')
    ).trim();
    if (checksum !== `${manifest.sha256}  ${manifest.archive}`)
      throw new Error('Checksum file disagrees with bundle manifest.');
    const sbom = JSON.parse(
      await readFile(path.join(directory, `${manifest.archive}.spdx.json`), 'utf8'),
    ) as JsonRecord & { packages?: JsonRecord[] };
    if (
      !Array.isArray(manifest.packages) ||
      !Array.isArray(sbom.packages) ||
      manifest.packages.length !== sbom.packages.length ||
      !manifest.packages.some((item) => item.name === 'node') ||
      !manifest.packages.some((item) => item.name === 'latchkit')
    )
      throw new Error('The SBOM must cover the bundled Node runtime and application.');
    embeddedChecks.push({ archive: path.join(directory, manifest.archive), manifest, sbom });
    manifests.push(manifest);
  }
  if (requireClean && (targets.size !== 1 || !targets.has('win32-x64') || manifests.length !== 1))
    throw new Error('Publication requires one qualified Windows standalone bundle.');
  if (requireClean) {
    for (const item of embeddedChecks)
      await verifyEmbeddedArchive(item.archive, item.manifest, item.sbom);
    const allowed = new Set(['install.ps1']);
    for (const manifest of manifests) {
      allowed.add(manifest.archive);
      allowed.add(`${manifest.archive}.sha256`);
      allowed.add(`${manifest.archive}.manifest.json`);
      allowed.add(`${manifest.archive}.spdx.json`);
    }
    const published = await readdir(directory);
    for (const name of published) {
      if (allowed.has(name) || name === 'previous' || name.endsWith('.evidence.json')) continue;
      throw new Error(`Publication directory contains an unrecognized artifact: ${name}`);
    }
    for (const bootstrap of ['install.ps1']) {
      if (
        sha256(await readFile(path.join(directory, bootstrap))) !==
        sha256(await readFile(path.join(repository, bootstrap)))
      )
        throw new Error(`Publication bootstrap differs from the reviewed ${bootstrap}.`);
    }
    const evidence = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith('.evidence.json'))
        .map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))),
    );
    for (const manifest of manifests) {
      const matching = (
        await Promise.all(
          evidence.map(async (item) => ({
            item,
            valid: await exactSmokeEvidence(directory, item, manifest),
          })),
        )
      )
        .filter(({ valid }) => valid)
        .map(({ item }) => item);
      if (!matching.some((item) => item.runtime === 'native'))
        throw new Error(
          'Exact prior-archive qualification evidence is missing for ' + manifest.target,
        );
      const native = matching.filter((item) => item.runtime === 'native');
      if (manifest.target === 'win32-x64' && !native.some(windows11Qualification))
        throw new Error(
          'Windows qualification requires exact prior-archive evidence from Windows 11, not Windows Server.',
        );
    }
    if (!evidence.some((item) => exactWorkflowEvidence(item, manifests)))
      throw new Error('Exact current-artifact live workflow qualification evidence is missing.');
  }
  return manifests;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const argument = args[index + 1];
    if (!argument || argument.startsWith('--')) throw new Error(`${name} needs a value.`);
    return argument;
  };
  const output = path.resolve(value('--output') ?? path.join(repository, 'release-artifacts'));
  const metadata = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  const version = value('--version') ?? metadata.version;
  const tag = value('--tag');
  if (tag && tag !== `v${version}`)
    throw new Error(`Release tag ${tag} does not match package version v${version}.`);
  if (args.includes('--verify-only')) {
    if (!tag) throw new Error('Publication verification requires an existing exact tag.');
    const commit = (
      await command('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {
        cwd: repository,
        windowsHide: true,
      })
    ).stdout.trim();
    const manifests = await verifyReleaseArtifacts(output, { tag, commit, requireClean: true });
    console.log(
      JSON.stringify(
        { status: 'verified', tag, commit, targets: manifests.map((item) => item.target) },
        null,
        2,
      ),
    );
  } else {
    const result = await prepareReleaseArtifacts({ output, version, target: value('--target') });
    console.log(
      JSON.stringify(
        {
          status: 'prepared',
          publication: 'not published; maintainer approval required',
          ...result,
        },
        null,
        2,
      ),
    );
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`Release artifact preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
