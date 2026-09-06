import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
export function benchmarkRepositoryRoot(moduleDirectory = here): string {
  return path.basename(path.dirname(moduleDirectory)) === 'dist'
    ? path.resolve(moduleDirectory, '..', '..')
    : path.resolve(moduleDirectory, '..');
}
const root = benchmarkRepositoryRoot();
const nodePath = process.execPath;
const packs = 1_000;
const memories = 10_000;
const diffFiles = 300;
const heavyRuns = 3;
const startupRuns = 7;

type BenchmarkOptions = { app?: string; output: string; profileSync: boolean };
type JsonRecord = Record<string, unknown>;
type Receipt = { path: string; sha256: string };
type BundleManifest = JsonRecord & {
  schemaVersion: number;
  package: string;
  version: string;
  target: string;
  nodeVersion: string;
  commit: string;
  dirty: boolean;
  files: unknown[];
  packages: unknown[];
};
type Metric = {
  durationMs: number;
  rssAfterBytes: number;
  resourceUsageMaxRssBytes: number;
} & JsonRecord;
type ApplicationApi = Pick<typeof import('../src/core.js'), 'initProject' | 'syncProject'> &
  Pick<typeof import('../src/project-memory/contracts.js'), 'validateProjectMemory'> &
  Pick<typeof import('../src/project-memory/service.js'), 'searchProjectMemory'> &
  Pick<typeof import('../src/project-memory/store.js'), 'writeProjectMemory'> &
  Pick<typeof import('../src/reviews/diff-annotations.js'), 'inspectDiff'> &
  Pick<typeof import('../src/task-state/service.js'), 'createTask'> &
  Pick<typeof import('../src/workspaces/git.js'), 'createTaskWorkspace'>;
type BenchmarkContext = { app: string; dist: string; runtime: string };

const errorCode = (error: unknown) =>
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const git = (directory: string, args: string[]) =>
  execFile('git', ['-C', directory, ...args], { windowsHide: true });
const now = () => new Date().toISOString();
const toMilliseconds = (start: bigint) => Number(process.hrtime.bigint() - start) / 1_000_000;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function samePath(left: string, right: string) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function parseBenchmarkOptions(args: string[], repository = root): BenchmarkOptions {
  const options: BenchmarkOptions = {
    app: undefined,
    output: path.join(repository, '.github', 'release-evidence', 'rc2', 'benchmarks-windows.json'),
    profileSync: false,
  };
  const supplied = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--profile-sync') {
      if (options.profileSync) throw new Error('--profile-sync can be supplied only once.');
      options.profileSync = true;
      continue;
    }
    if (argument !== '--app' && argument !== '--output')
      throw new Error(`Unknown benchmark option: ${argument}`);
    if (supplied.has(argument)) throw new Error(`${argument} can be supplied only once.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`);
    if (argument === '--app') options.app = path.resolve(value);
    else options.output = path.resolve(value);
    supplied.add(argument);
  }
  return options;
}

async function requiredFile(filename: string, description: string) {
  let stat;
  try {
    stat = await fs.lstat(filename);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`${description} is missing: ${filename}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${description} must be a regular file.`);
}

async function readJson(filename: string, description: string): Promise<JsonRecord> {
  try {
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`${description} is missing: ${filename}`);
    if (error instanceof SyntaxError || errorText(error) === 'not an object')
      throw new Error(`${description} is not a JSON object.`);
    throw error;
  }
}

function manifestFile(manifest: BundleManifest, relative: string): Receipt {
  const entry = manifest.files.find(
    (item): item is JsonRecord => isRecord(item) && item.path === relative,
  );
  if (!entry || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256))
    throw new Error(`Bundle manifest has no valid receipt for ${relative}.`);
  return { path: relative, sha256: entry.sha256 };
}

/** Validates an extracted or installed standalone app directory without claiming archive provenance. */
export async function validateStandaloneApp(
  app: string,
  { callerNode = process.execPath }: { callerNode?: string } = {},
) {
  const application = path.resolve(app);
  const applicationStat = await fs.lstat(application).catch((error) => {
    if (errorCode(error) === 'ENOENT')
      throw new Error(`Standalone app directory is missing: ${application}`);
    throw error;
  });
  if (!applicationStat.isDirectory() || applicationStat.isSymbolicLink())
    throw new Error('--app must name a regular standalone app directory.');
  const bundle = path.dirname(application);
  const manifestPath = path.join(bundle, 'bundle-manifest.json');
  const manifest = (await readJson(manifestPath, 'Adjacent bundle manifest')) as BundleManifest;
  const target = `${process.platform}-${process.arch}`;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package !== 'latchkit' ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    manifest.target !== target ||
    typeof manifest.nodeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion) ||
    typeof manifest.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    manifest.dirty !== false ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.packages)
  )
    throw new Error('Adjacent bundle manifest is not a clean native standalone bundle binding.');
  for (const [name, version, location] of [
    ['latchkit', manifest.version, 'app'],
    ['node', manifest.nodeVersion, 'runtime'],
  ]) {
    if (
      !manifest.packages.some(
        (item) =>
          isRecord(item) &&
          item.name === name &&
          item.version === version &&
          item.path === location,
      )
    )
      throw new Error(`Bundle manifest does not bind ${name} ${version} at ${location}.`);
  }
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const runtime = path.join(bundle, 'runtime', executable);
  const receipts: Array<[string, string]> = [
    ['app/package.json', path.join(application, 'package.json')],
    ['app/dist/package.json', path.join(application, 'dist', 'package.json')],
    ['app/dist/src/cli.js', path.join(application, 'dist', 'src', 'cli.js')],
    [`runtime/${executable}`, runtime],
  ];
  for (const [relative, filename] of receipts) {
    await requiredFile(filename, `Standalone bundle file ${relative}`);
    const receipt = manifestFile(manifest, relative);
    if (sha256(await fs.readFile(filename)) !== receipt.sha256)
      throw new Error(`Standalone bundle file does not match its manifest receipt: ${relative}`);
  }
  for (const filename of [
    path.join(application, 'package.json'),
    path.join(application, 'dist', 'package.json'),
  ]) {
    const metadata = await readJson(filename, 'Standalone package metadata');
    if (metadata.version !== manifest.version)
      throw new Error('Standalone app version does not match its adjacent bundle manifest.');
  }
  const [resolvedRuntime, resolvedCaller] = await Promise.all([
    fs.realpath(runtime),
    fs.realpath(callerNode),
  ]);
  if (!samePath(resolvedRuntime, resolvedCaller))
    throw new Error('Run this benchmark through the standalone app private Node runtime.');
  const reportedRuntime = (
    await execFile(runtime, ['--version'], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 })
  ).stdout.trim();
  if (reportedRuntime !== `v${manifest.nodeVersion}`)
    throw new Error('Standalone private Node runtime does not match its adjacent bundle manifest.');
  return {
    app: application,
    dist: path.join(application, 'dist'),
    runtime,
    manifest: {
      version: manifest.version,
      target: manifest.target,
      commit: manifest.commit,
      nodeVersion: manifest.nodeVersion,
    },
  };
}

function exportedFunction(
  module: JsonRecord,
  name: keyof ApplicationApi,
): ApplicationApi[keyof ApplicationApi] {
  const value = module[name];
  if (typeof value !== 'function')
    throw new Error(`Emitted application module has no ${name} function.`);
  return value as ApplicationApi[keyof ApplicationApi];
}

async function loadApplicationModules(dist: string): Promise<ApplicationApi> {
  const load = (relative: string) =>
    import(pathToFileURL(path.join(dist, ...relative.split('/'))).href);
  const [core, contracts, memory, memoryStore, reviews, tasks, workspaces] = await Promise.all([
    load('src/core.js'),
    load('src/project-memory/contracts.js'),
    load('src/project-memory/service.js'),
    load('src/project-memory/store.js'),
    load('src/reviews/diff-annotations.js'),
    load('src/task-state/service.js'),
    load('src/workspaces/git.js'),
  ]);
  return {
    initProject: exportedFunction(core as JsonRecord, 'initProject'),
    syncProject: exportedFunction(core as JsonRecord, 'syncProject'),
    validateProjectMemory: exportedFunction(contracts as JsonRecord, 'validateProjectMemory'),
    searchProjectMemory: exportedFunction(memory as JsonRecord, 'searchProjectMemory'),
    writeProjectMemory: exportedFunction(memoryStore as JsonRecord, 'writeProjectMemory'),
    inspectDiff: exportedFunction(reviews as JsonRecord, 'inspectDiff'),
    createTask: exportedFunction(tasks as JsonRecord, 'createTask'),
    createTaskWorkspace: exportedFunction(workspaces as JsonRecord, 'createTaskWorkspace'),
  } as ApplicationApi;
}

function statistics(samples: Metric[]) {
  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const percentile = Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1);
  return {
    runs: samples.length,
    medianMs: durations[Math.floor(durations.length / 2)],
    p95Ms: durations[percentile],
    minMs: durations[0],
    maxMs: durations.at(-1),
    rssAfterBytes: Math.max(...samples.map((sample) => sample.rssAfterBytes)),
    resourceUsageMaxRssBytes: Math.max(...samples.map((sample) => sample.resourceUsageMaxRssBytes)),
    samples,
  };
}

function memorySnapshot() {
  const usage = process.resourceUsage();
  return {
    rssAfterBytes: process.memoryUsage.rss(),
    // Node documents maxRSS in KiB. On Windows it is process-level and may be
    // cumulative for the benchmark process rather than one isolated operation.
    resourceUsageMaxRssBytes: usage.maxRSS * 1024,
  };
}

async function measure<T extends JsonRecord>(operation: () => Promise<T>): Promise<Metric & T> {
  const start = process.hrtime.bigint();
  const details = await operation();
  return { durationMs: toMilliseconds(start), ...memorySnapshot(), ...details };
}

async function temporary<T>(
  prefix: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function createLargePack(base: string): Promise<string> {
  const packRoot = path.join(base, 'large-pack');
  const files = [];
  await fs.mkdir(packRoot, { recursive: true });
  for (let index = 0; index < packs; index += 1) {
    const name = `benchmark-${String(index).padStart(4, '0')}`;
    const relative = `skills/${name}/SKILL.md`;
    const content = `---\nname: ${name}\ndescription: Synthetic benchmark skill ${index}.\n---\n\n# ${name}\n`;
    const target = path.join(packRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    files.push({ path: relative, sha256: sha256(content) });
  }
  await fs.writeFile(
    path.join(packRoot, 'latchkit-pack.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'benchmark-pack',
        version: '1.0.0',
        provenance: 'Synthetic local benchmark fixture.',
        compatibility: { configSchemaVersions: [3], providers: ['codex'] },
        files,
      },
      null,
      2,
    )}\n`,
  );
  return packRoot;
}

async function largePackSync(packRoot: string, application: ApplicationApi, profileSync: boolean) {
  return temporary('latchkit-bench-pack-', async (base) => {
    const project = path.join(base, 'project');
    await fs.mkdir(project);
    await application.initProject(project, {
      providers: ['codex'],
      skills: [],
      packs: [
        {
          id: 'benchmark-pack',
          version: '1.0.0',
          source: { type: 'local', path: packRoot },
          pinned: true,
        },
      ],
    });
    return measure(async () => {
      const started = process.hrtime.bigint();
      const profile: {
        journalMs: number | null;
        firstResourceMs: number | null;
        lastResourceMs: number | null;
        manifestMs: number | null;
        resourceCount: number;
      } = {
        journalMs: null,
        firstResourceMs: null,
        lastResourceMs: null,
        manifestMs: null,
        resourceCount: 0,
      };
      const result = await application.syncProject(
        project,
        profileSync
          ? {
              faultBoundary: (boundary: string, journal: unknown) => {
                const elapsed = toMilliseconds(started);
                if (boundary === 'journal') {
                  if (!isRecord(journal) || !Array.isArray(journal.resources))
                    throw new Error('Benchmark sync journal has an invalid resource list.');
                  profile.journalMs = elapsed;
                  profile.resourceCount = journal.resources.length;
                } else if (boundary === 'resource:0') profile.firstResourceMs = elapsed;
                else if (boundary === `resource:${profile.resourceCount - 1}`)
                  profile.lastResourceMs = elapsed;
                else if (boundary === 'manifest') profile.manifestMs = elapsed;
              },
            }
          : undefined,
      );
      return {
        installedFiles: result.changes.filter((change) => change.action === 'create').length,
        ...(profileSync ? { syncProfile: profile } : {}),
      };
    });
  });
}

function benchmarkUuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function memoryState(application: ApplicationApi) {
  const at = '2026-01-01T00:00:00.000Z';
  const state = {
    schemaVersion: 1,
    project: { id: 'project_benchmark' },
    revision: 1,
    createdAt: at,
    updatedAt: at,
    memories: Array.from({ length: memories }, (_, index) => ({
      id: `memory_${benchmarkUuid(index)}`,
      revision: 1,
      kind: 'discovery',
      title: `Synthetic record ${index} ${index % 10 === 0 ? 'needle' : 'haystack'}`,
      text: `Synthetic benchmark memory ${index}; searchable local evidence needle ${index % 97}.`,
      tags: ['benchmark', index % 10 === 0 ? 'needle' : 'haystack'],
      sources: [],
      provenance: { kind: 'manual', reference: 'synthetic benchmark', importedId: null },
      supersedes: null,
      deletedAt: null,
      createdAt: at,
      updatedAt: at,
    })),
  };
  return application.validateProjectMemory(state);
}

async function largeMemorySearch(application: ApplicationApi) {
  return temporary('latchkit-bench-memory-', async (project) => {
    await application.writeProjectMemory(project, memoryState(application));
    return measure(async () => {
      const result = await application.searchProjectMemory(project, 'needle synthetic', {
        limit: 20,
      });
      return { matchedRecords: result.length };
    });
  });
}

async function diffFixture(application: ApplicationApi) {
  return temporary('latchkit-bench-diff-', async (base) => {
    const project = path.join(base, 'project');
    await fs.mkdir(project);
    await git(project, ['init']);
    await git(project, ['config', 'user.email', 'benchmark@example.invalid']);
    await git(project, ['config', 'user.name', 'Latchkit benchmark']);
    for (let index = 0; index < diffFiles; index += 1) {
      const file = path.join(project, 'files', `file-${String(index).padStart(4, '0')}.txt`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `base ${index}\n`);
    }
    await git(project, ['add', '.']);
    await git(project, ['commit', '-m', 'benchmark base']);
    const task = await application.createTask(project, { title: 'Synthetic diff benchmark' });
    const workspace = await application.createTaskWorkspace(project, { taskId: task.id });
    if (!('path' in workspace) || typeof workspace.path !== 'string')
      throw new Error('The isolated workspace was not created.');
    for (let index = 0; index < diffFiles; index += 1)
      await fs.writeFile(
        path.join(workspace.path, 'files', `file-${String(index).padStart(4, '0')}.txt`),
        `changed ${index}\n`,
      );
    return measure(async () => {
      const result = await application.inspectDiff(project, { taskId: task.id });
      return { diffBytes: Buffer.byteLength(result.diff), truncated: result.truncated };
    });
  });
}

async function cliVersion(context: BenchmarkContext): Promise<Metric> {
  const cli = pathToFileURL(path.join(context.dist, 'src', 'cli.js')).href;
  const source = [
    'const started = process.hrtime.bigint();',
    `process.argv = [process.execPath, 'latchkit', '--version'];`,
    `await import(${JSON.stringify(cli)});`,
    'const usage = process.resourceUsage();',
    "console.log('__LATCHKIT_BENCHMARK__' + JSON.stringify({ durationMs: Number(process.hrtime.bigint() - started) / 1e6, rssAfterBytes: process.memoryUsage.rss(), resourceUsageMaxRssBytes: usage.maxRSS * 1024 }));",
  ].join('\n');
  const { stdout } = await execFile(context.runtime, ['--input-type=module', '--eval', source], {
    cwd: context.app,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('__LATCHKIT_BENCHMARK__'));
  if (!marker) throw new Error('CLI benchmark child emitted no metric marker.');
  const value: unknown = JSON.parse(marker.slice('__LATCHKIT_BENCHMARK__'.length));
  if (
    !isRecord(value) ||
    !['durationMs', 'rssAfterBytes', 'resourceUsageMaxRssBytes'].every(
      (key) => typeof value[key] === 'number',
    )
  )
    throw new Error('CLI benchmark child emitted invalid metrics.');
  return value as Metric;
}

async function main() {
  const options = parseBenchmarkOptions(process.argv.slice(2));
  if (process.platform !== 'win32')
    throw new Error('This evidence target is the native Windows baseline; run it on Windows.');
  const standalone = options.app ? await validateStandaloneApp(options.app) : null;
  const context = standalone
    ? {
        ...standalone,
        label: 'verified standalone app directory; embedded manifest binding verified',
        archive: 'not asserted; no archive digest was supplied to this benchmark',
      }
    : {
        app: root,
        dist: path.join(root, 'dist'),
        runtime: nodePath,
        label: 'development compiled tree; not a standalone release bundle',
        archive: 'not applicable',
      };
  const application = await loadApplicationModules(context.dist);
  const startup: Metric[] = [];
  for (let index = 0; index < startupRuns; index += 1) startup.push(await cliVersion(context));
  const packResults = await temporary('latchkit-bench-pack-source-', async (base) => {
    const pack = await createLargePack(base);
    const samples: Metric[] = [];
    for (let index = 0; index < heavyRuns; index += 1)
      samples.push(await largePackSync(pack, application, options.profileSync));
    return statistics(samples);
  });
  const memoryResults: Metric[] = [];
  for (let index = 0; index < heavyRuns; index += 1)
    memoryResults.push(await largeMemorySearch(application));
  const diffResults: Metric[] = [];
  for (let index = 0; index < heavyRuns; index += 1)
    diffResults.push(await diffFixture(application));
  const evidence = {
    schemaVersion: 1,
    recordedAt: now(),
    target: context.label,
    standalone: standalone
      ? {
          app: standalone.app,
          version: standalone.manifest.version,
          commit: standalone.manifest.commit,
          target: standalone.manifest.target,
          nodeVersion: standalone.manifest.nodeVersion,
          archive: context.archive,
        }
      : null,
    environment: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      nodeExecutable: path.basename(context.runtime),
    },
    datasets: {
      startupRuns,
      largePackFiles: packs,
      memoryRecords: memories,
      diffChangedFiles: diffFiles,
      heavyRuns,
    },
    measurements: {
      cliVersionStartup: statistics(startup),
      largePackSync: packResults,
      memorySearch: statistics(memoryResults),
      isolatedWorktreeDiff: statistics(diffResults),
    },
    method: {
      startup:
        'Fresh Node child imports the emitted CLI with --version and emits post-operation memory measurements.',
      largePackSync:
        'Each sample creates a fresh initialized project and synchronizes one validated local pack containing 1,000 synthetic portable skill files. --profile-sync records journal and ordered-resource boundary times; it intentionally preserves ordered resource writes for that diagnostic run.',
      memorySearch:
        'Each sample writes a validated project-memory state with 10,000 synthetic records, then measures searchProjectMemory only.',
      diff: 'Each sample creates a temporary Git repository, records an owned task, creates an isolated worktree, changes 300 tracked files, then measures inspectDiff only.',
      memory:
        'rssAfterBytes is sampled after each operation. resourceUsageMaxRssBytes is Node maxRSS converted from KiB and is process cumulative on this host; it is not a per-operation allocator trace.',
    },
    limitations: [
      'Fixtures use local temporary directories and synthetic data; they do not represent an end-user repository or a final release bundle.',
      'The measurement is a development baseline, not a native-worker selection benchmark.',
      'No Go or Rust worker recommendation follows automatically from these measurements.',
    ],
  };
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({ output: options.output, measurements: evidence.measurements }, null, 2),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`Benchmark failed: ${error.message}`);
    process.exitCode = 1;
  });
