#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { publishArchiveSet } from './atomic-publish.js';

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..', '..');
type JsonObject = Record<string, unknown>;
type InventoryFile = { path: string; bytes: number; sha256: string };
type DependencyPackage = { name: string; version: string; license: string; path: string };
type RuntimePin = { archive: string; executable: string; sha256: string };
type RuntimePins = { nodeVersion: string; targets: Record<string, RuntimePin> };
type PackageMetadata = JsonObject & {
  version: string;
  license: string;
  dependencies?: Record<string, string>;
};
type PackageLock = JsonObject & {
  version: string;
  packages: Record<string, JsonObject & { version: string }>;
};
type BrowserDependency = { name: string; version: string; license: string; path: string };
export type BundleResult = {
  archive: string;
  sha256: string;
  version: string;
  target: string;
  commit: string;
  dirty: boolean;
};
export type BuildBundleOptions = { output?: string; version?: string; target?: string };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

async function inventory(directory: string, prefix = ''): Promise<InventoryFile[]> {
  const files: InventoryFile[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle must not require symlinks: ${relative}`);
    if (entry.isDirectory()) files.push(...(await inventory(absolute, relative)));
    else if (entry.isFile()) {
      const data = await readFile(absolute);
      files.push({ path: relative, bytes: data.length, sha256: hash(data) });
    }
  }
  return files;
}

async function dependencyPackages(app: string): Promise<DependencyPackage[]> {
  const packages: DependencyPackage[] = [];
  async function visit(modules: string): Promise<void> {
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const location = path.join(modules, entry.name);
      if (entry.name.startsWith('@')) {
        await visit(location);
        continue;
      }
      const metadata = await json<DependencyPackage>(path.join(location, 'package.json'));
      packages.push({
        name: metadata.name,
        version: metadata.version,
        license: typeof metadata.license === 'string' ? metadata.license : 'NOASSERTION',
        path: path.relative(app, location).replaceAll('\\', '/'),
      });
      try {
        await visit(path.join(location, 'node_modules'));
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error;
      }
    }
  }
  try {
    await visit(path.join(app, 'node_modules'));
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

export async function buildBundle({
  output = path.join(repository, 'release-artifacts'),
  version,
  target = `${process.platform}-${process.arch}`,
}: BuildBundleOptions = {}): Promise<BundleResult> {
  const pins = await json<RuntimePins>(path.join(repository, 'scripts/runtime-pins.json'));
  const pin = pins.targets[target];
  if (!pin || target !== `${process.platform}-${process.arch}`)
    throw new Error('Build each supported native bundle on its matching host.');
  const report = process.report.getReport();
  if (
    process.platform === 'linux' &&
    !('glibcVersionRuntime' in ((report as { header?: object }).header ?? {}))
  )
    throw new Error('Linux bundles require glibc.');
  const metadata = await json<PackageMetadata>(path.join(repository, 'package.json'));
  version ??= metadata.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error('Invalid bundle version.');
  const lock = await json<PackageLock>(path.join(repository, 'package-lock.json'));
  output = path.resolve(output);
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'latchkit-bundle-'));
  try {
    const bundle = path.join(temporary, 'bundle');
    const app = path.join(bundle, 'app');
    const runtime = path.join(bundle, 'runtime');
    await mkdir(app, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await cp(path.join(repository, 'dist'), path.join(app, 'dist'), { recursive: true });
    await cp(path.join(repository, 'docs'), path.join(app, 'docs'), { recursive: true });
    await cp(path.join(repository, 'LICENSE'), path.join(app, 'LICENSE'));
    await cp(path.join(repository, 'README.md'), path.join(app, 'README.md'));
    metadata.version = version;
    lock.version = version;
    const rootPackage = lock.packages[''];
    if (!rootPackage) throw new Error('package-lock.json lacks a root package entry.');
    rootPackage.version = version;
    await writeFile(path.join(app, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(path.join(app, 'dist/package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(path.join(app, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    const productionDependencies = Object.keys(metadata.dependencies ?? {});
    if (productionDependencies.length) {
      const npmCli = process.env.npm_execpath;
      if (!npmCli)
        throw new Error(
          'Run bundle preparation through npm so the development npm CLI is explicit.',
        );
      await run(
        process.execPath,
        [
          npmCli,
          'ci',
          '--omit=dev',
          '--ignore-scripts',
          '--bin-links=false',
          '--no-audit',
          '--no-fund',
        ],
        { cwd: app, windowsHide: true, timeout: 180_000 },
      );
    }
    const dependencies = await dependencyPackages(app);
    const browserDependencies = await json<BrowserDependency[]>(
      path.join(app, 'dist/web/licenses/manifest.json'),
    );
    const nodeUrl = `https://nodejs.org/dist/v${pins.nodeVersion}/${pin.archive}`;
    const response = await fetch(nodeUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== pin.sha256)
      throw new Error('Node archive checksum does not match the reviewed runtime pin.');
    const archive = path.join(temporary, pin.archive);
    await writeFile(archive, bytes);
    const unpacked = path.join(temporary, 'node');
    await mkdir(unpacked);
    if (process.platform === 'win32') {
      const script = path.join(temporary, 'extract.ps1');
      await writeFile(
        script,
        'param($Archive, $Destination)\n$ErrorActionPreference="Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n',
      );
      await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', script, archive, unpacked],
        { windowsHide: true, timeout: 120_000 },
      );
    } else await run('tar', ['-xzf', archive, '-C', unpacked], { timeout: 120_000 });
    const nodeDirectory = path.join(unpacked, pin.archive.replace(/\.(zip|tar\.gz)$/, ''));
    const executable = process.platform === 'win32' ? 'node.exe' : 'node';
    await cp(path.join(nodeDirectory, pin.executable), path.join(runtime, executable));
    await cp(path.join(nodeDirectory, 'LICENSE'), path.join(runtime, 'LICENSE'));
    if (process.platform !== 'win32') await chmod(path.join(runtime, executable), 0o755);
    const packages = [
      { name: 'latchkit', version, license: metadata.license, path: 'app' },
      {
        name: 'node',
        version: pins.nodeVersion,
        license: 'MIT AND ISC AND BSD-2-Clause AND BSD-3-Clause AND Apache-2.0',
        path: 'runtime',
      },
      ...dependencies.map((item) => ({ ...item, path: `app/${item.path}` })),
      ...browserDependencies.map(({ name, version, license, path: location }) => ({
        name,
        version,
        license,
        path: `app/${location}`,
      })),
    ];
    const licenses = [];
    for (const file of await inventory(bundle))
      if (/(^|\/)(licen[cs]e|notice|copying)([.-]|$)/i.test(file.path)) licenses.push(file.path);
    await writeFile(
      path.join(bundle, 'licenses.json'),
      `${JSON.stringify({ schemaVersion: 1, files: licenses }, null, 2)}\n`,
    );
    const sbom = {
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `latchkit-${version}-${target}`,
      documentNamespace: `https://github.com/willahealm/latchkit/releases/${version}/${target}`,
      creationInfo: { creators: ['Tool: latchkit bundle'], created: new Date().toISOString() },
      packages: packages.map((item) => ({
        SPDXID: `SPDXRef-${hash(item.path).slice(0, 24)}`,
        name: item.name,
        versionInfo: item.version,
        licenseConcluded: item.license,
        licenseDeclared: item.license,
        downloadLocation: item.name === 'node' ? nodeUrl : 'NOASSERTION',
        filesAnalyzed: false,
      })),
    };
    await writeFile(path.join(bundle, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
    const commit = (
      await run('git', ['rev-parse', 'HEAD'], { cwd: repository, windowsHide: true })
    ).stdout.trim();
    const dirty = Boolean(
      (
        await run('git', ['status', '--porcelain'], { cwd: repository, windowsHide: true })
      ).stdout.trim(),
    );
    const manifest = {
      schemaVersion: 1,
      package: 'latchkit',
      version,
      target,
      nodeVersion: pins.nodeVersion,
      commit,
      dirty,
      packages,
      files: await inventory(bundle),
    };
    await writeFile(
      path.join(bundle, 'bundle-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const smoke = await run(
      path.join(runtime, executable),
      [path.join(app, 'dist/src/cli.js'), '--version'],
      { windowsHide: true, timeout: 30_000 },
    );
    if (smoke.stdout.trim() !== version) throw new Error('Staged CLI version smoke failed.');
    await run(
      path.join(runtime, executable),
      [
        '--input-type=module',
        '-e',
        "import {policy_version_async} from './dist/src/workflows/policy.js'; if(await policy_version_async() !== 'latchkit-workflow-v1') throw new Error('Workflow policy smoke failed');",
      ],
      { cwd: app, windowsHide: true, timeout: 30_000 },
    );
    const archiveName = `latchkit-${version}-${target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const finalArchive = path.join(output, archiveName);
    // Stage the archive itself next to its final name (same directory as
    // `output`, so the eventual rename in publishArchiveSet is a
    // same-device operation even when the system temp root lives on a
    // different drive) before touching `output` for real.
    const stagedArchive = `${finalArchive}.${randomUUID()}.tmp`;
    let archiveHash;
    try {
      if (process.platform === 'win32') {
        const script = path.join(temporary, 'archive.ps1');
        await writeFile(
          script,
          'param($Source, $Archive)\n$ErrorActionPreference="Stop"\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\nif (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive }\n[System.IO.Compression.ZipFile]::CreateFromDirectory($Source, $Archive)\n',
        );
        await run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-File', script, bundle, stagedArchive],
          { windowsHide: true, timeout: 120_000 },
        );
      } else await run('tar', ['-czf', stagedArchive, '-C', bundle, '.'], { timeout: 120_000 });
      archiveHash = hash(await readFile(stagedArchive));
      await publishArchiveSet(finalArchive, stagedArchive, [
        { path: `${finalArchive}.sha256`, bytes: `${archiveHash}  ${archiveName}\n` },
        {
          path: `${finalArchive}.spdx.json`,
          bytes: await readFile(path.join(bundle, 'sbom.spdx.json')),
        },
        {
          path: `${finalArchive}.manifest.json`,
          bytes: `${JSON.stringify({ ...manifest, archive: archiveName, sha256: archiveHash }, null, 2)}\n`,
        },
      ]);
    } catch (error) {
      // publishArchiveSet already reclaims everything it staged or
      // committed; this guards the case where archive creation itself
      // (the tar/PowerShell step above) failed or was interrupted before
      // reaching that call, possibly after partially writing stagedArchive.
      await rm(stagedArchive, { force: true });
      throw error;
    }
    return { archive: finalArchive, sha256: archiveHash, version, target, commit, dirty };
  } finally {
    // temporary is an absolute directory created by this function under the system temp root.
    if (!temporary.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
      throw new Error('Unexpected temporary bundle location.');
    await rm(temporary, { recursive: true, force: true });
  }
}
