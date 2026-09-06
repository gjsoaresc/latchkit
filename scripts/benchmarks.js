import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { initProject, syncProject } from '../dist/src/core.js';
import { validateProjectMemory } from '../dist/src/project-memory/contracts.js';
import { searchProjectMemory } from '../dist/src/project-memory/service.js';
import { writeProjectMemory } from '../dist/src/project-memory/store.js';
import { inspectDiff } from '../dist/src/reviews/diff-annotations.js';
import { createTask } from '../dist/src/task-state/service.js';
import { createTaskWorkspace } from '../dist/src/workspaces/git.js';

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nodePath = process.execPath;
const output = path.join(root, '.github', 'release-evidence', 'rc2', 'benchmarks-windows.json');
const packs = 1_000;
const memories = 10_000;
const diffFiles = 300;
const heavyRuns = 3;
const startupRuns = 7;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (directory, args) => execFile('git', ['-C', directory, ...args], { windowsHide: true });
const now = () => new Date().toISOString();
const toMilliseconds = (start) => Number(process.hrtime.bigint() - start) / 1_000_000;

function statistics(samples) {
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

async function measure(operation) {
  const start = process.hrtime.bigint();
  const details = await operation();
  return { durationMs: toMilliseconds(start), ...memorySnapshot(), ...details };
}

async function temporary(prefix, operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function createLargePack(base) {
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

async function largePackSync(packRoot) {
  return temporary('latchkit-bench-pack-', async (base) => {
    const project = path.join(base, 'project');
    await fs.mkdir(project);
    await initProject(project, {
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
      const result = await syncProject(project);
      return {
        installedFiles: result.changes.filter((change) => change.action === 'create').length,
      };
    });
  });
}

function benchmarkUuid(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function memoryState() {
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
  return validateProjectMemory(state);
}

async function largeMemorySearch() {
  return temporary('latchkit-bench-memory-', async (project) => {
    await writeProjectMemory(project, memoryState());
    return measure(async () => {
      const result = await searchProjectMemory(project, 'needle synthetic', { limit: 20 });
      return { matchedRecords: result.length };
    });
  });
}

async function diffFixture() {
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
    const task = await createTask(project, { title: 'Synthetic diff benchmark' });
    const workspace = await createTaskWorkspace(project, { taskId: task.id });
    if (!('path' in workspace) || typeof workspace.path !== 'string')
      throw new Error('The isolated workspace was not created.');
    for (let index = 0; index < diffFiles; index += 1)
      await fs.writeFile(
        path.join(workspace.path, 'files', `file-${String(index).padStart(4, '0')}.txt`),
        `changed ${index}\n`,
      );
    return measure(async () => {
      const result = await inspectDiff(project, { taskId: task.id });
      return { diffBytes: Buffer.byteLength(result.diff), truncated: result.truncated };
    });
  });
}

async function cliVersion() {
  const cli = pathToFileURL(path.join(root, 'dist', 'src', 'cli.js')).href;
  const source = [
    'const started = process.hrtime.bigint();',
    `process.argv = [process.execPath, 'latchkit', '--version'];`,
    `await import(${JSON.stringify(cli)});`,
    'const usage = process.resourceUsage();',
    "console.log('__LATCHKIT_BENCHMARK__' + JSON.stringify({ durationMs: Number(process.hrtime.bigint() - started) / 1e6, rssAfterBytes: process.memoryUsage.rss(), resourceUsageMaxRssBytes: usage.maxRSS * 1024 }));",
  ].join('\n');
  const { stdout } = await execFile(nodePath, ['--input-type=module', '--eval', source], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const marker = stdout.split(/\r?\n/).find((line) => line.startsWith('__LATCHKIT_BENCHMARK__'));
  if (!marker) throw new Error('CLI benchmark child emitted no metric marker.');
  return JSON.parse(marker.slice('__LATCHKIT_BENCHMARK__'.length));
}

async function main() {
  if (process.platform !== 'win32')
    throw new Error('This evidence target is the native Windows baseline; run it on Windows.');
  const startup = [];
  for (let index = 0; index < startupRuns; index += 1) startup.push(await cliVersion());
  const packResults = await temporary('latchkit-bench-pack-source-', async (base) => {
    const pack = await createLargePack(base);
    const samples = [];
    for (let index = 0; index < heavyRuns; index += 1) samples.push(await largePackSync(pack));
    return statistics(samples);
  });
  const memoryResults = [];
  for (let index = 0; index < heavyRuns; index += 1) memoryResults.push(await largeMemorySearch());
  const diffResults = [];
  for (let index = 0; index < heavyRuns; index += 1) diffResults.push(await diffFixture());
  const evidence = {
    schemaVersion: 1,
    recordedAt: now(),
    target: 'development compiled tree; not a standalone release bundle',
    environment: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      nodeExecutable: path.basename(nodePath),
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
        'Each sample creates a fresh initialized project and synchronizes one validated local pack containing 1,000 synthetic portable skill files.',
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
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output, measurements: evidence.measurements }, null, 2));
}

await main();
