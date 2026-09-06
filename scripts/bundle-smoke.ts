#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertArtifact } from './artifact-smoke.js';
import { verifyReleaseArtifacts } from './release-artifacts.js';

const run = promisify(execFile);
const args = process.argv.slice(2);
type Manifest = { archive: string; sha256: string; target: string; version: string };
type StableHookDuration = { phase: string; version: string; durationMs: number };
type InstallationRequest = {
  command: 'install' | 'upgrade' | 'rollback' | 'uninstall';
  bundle?: string;
  version?: string;
};
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

async function extract(archive: string, destination: string, scratch: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (archive.endsWith('.zip')) {
    const script = path.join(scratch, 'extract.ps1');
    await writeFile(
      script,
      'param($Archive,$Destination)\n$ErrorActionPreference="Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination\n',
    );
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', script, archive, destination],
      { windowsHide: true, timeout: 120_000 },
    );
  } else await run('tar', ['-xzf', archive, '-C', destination], { timeout: 120_000 });
}

async function hook(node: string, file: string, hookArgs: string[] = []): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(node, [file, ...hookArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Packaged hook did not exit.'));
    }, 10_000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Packaged hook failed: ${stderr}`));
      else {
        try {
          JSON.parse(stdout);
          resolve();
        } catch {
          reject(new Error('Packaged hook returned invalid JSON.'));
        }
      }
    });
    child.stdin.end('{"session_id":"bundle-smoke","hook_event_name":"Stop"}\n');
  });
}

async function terminateOwnedHook(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32' && child.pid) {
    try {
      await run(
        path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/t', '/f'],
        { windowsHide: true, timeout: 5_000 },
      );
    } catch {
      child.kill();
    }
  } else child.kill('SIGKILL');
}

async function stableHook(
  command: string,
  hookArgs: string[] = [],
  label: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, hookArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const startedAt = performance.now();
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateOwnedHook(child).finally(() => {
        reject(new Error(`Stable hook ${label} did not exit within 30 seconds.`));
      });
    }, 30_000);
    const finish = (outcome: (value: number) => void, value: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      outcome(value);
    };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.once('error', (error: Error) => {
      if (!timedOut) reject(error);
    });
    child.once('close', (code) => {
      if (timedOut) return;
      if (code !== 0) reject(new Error(`Stable hook ${label} failed: ${stderr}`));
      else {
        try {
          const event = JSON.parse(stdout) as {
            kind?: string;
            payload?: { session_id?: string };
            eventId?: string;
          };
          assert.equal(event.kind, 'turn-completed');
          assert.equal(event.payload?.session_id, 'bundle-smoke');
          assert.match(event.eventId ?? '', /^bundle-smoke:Stop:/);
          finish(resolve, Math.round(performance.now() - startedAt));
        } catch (error) {
          reject(
            new Error('Stable hook did not preserve handler arguments or stdin.', { cause: error }),
          );
        }
      }
    });
    child.stdin.end('{"session_id":"bundle-smoke","hook_event_name":"Stop"}\n');
  });
}

async function main() {
  const directory = path.resolve(option('--directory') ?? 'release-artifacts');
  const manifests = await verifyReleaseArtifacts(directory);
  const manifest = manifests.find((item) => item.target === `${process.platform}-${process.arch}`);
  if (!manifest) throw new Error('No archive for this native host.');
  const previousDirectory = option('--previous-directory');
  const previousManifest = previousDirectory
    ? (await verifyReleaseArtifacts(path.resolve(previousDirectory))).find(
        (item) => item.target === manifest.target,
      )
    : undefined;
  if (previousDirectory && (!previousManifest || previousManifest.version === manifest.version))
    throw new Error(
      'Previous release directory must provide a distinct archive for this native target.',
    );
  if (
    args.includes('--require-wsl') &&
    !(
      process.platform === 'linux' &&
      (process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()))
    )
  )
    throw new Error('This cell must run in actual WSL.');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-native-smoke-'));
  const originalEnv = { ...process.env };
  try {
    const bundle = path.join(scratch, 'extracted bundle é');
    await extract(path.join(directory, manifest.archive), bundle, scratch);
    const executable = path.join(
      bundle,
      'runtime',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    const app = path.join(bundle, 'app');
    const entry = path.join(app, 'dist/src/cli.js');
    const manager = path.join(app, 'dist/src/installation/manager.js');
    const tools = path.join(scratch, 'system tools');
    await mkdir(tools);
    if (process.platform !== 'win32')
      for (const tool of [
        'awk',
        'cat',
        'cp',
        'dirname',
        'getconf',
        'gzip',
        'head',
        'mkdir',
        'mktemp',
        'rm',
        'sed',
        'sha256sum',
        'shasum',
        'tar',
        'tr',
        'uname',
      ]) {
        const location = (
          await run('/bin/sh', ['-c', 'command -v "$1" || true', 'sh', tool])
        ).stdout
          .trim()
          .split(/\r?\n/)[0];
        if (location && path.isAbsolute(location)) await cp(location, path.join(tools, tool));
      }
    process.env.PATH =
      process.platform === 'win32'
        ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
        : tools;
    if (process.platform === 'win32')
      process.env.PSModulePath = path.join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/Modules',
      );
    for (const name of ['NODE_PATH', 'NODE_OPTIONS']) delete process.env[name];
    process.env.HOME = path.join(scratch, 'isolated home');
    process.env.USERPROFILE = process.env.HOME;
    await mkdir(process.env.HOME);
    if (process.platform === 'win32') {
      process.env.APPDATA = path.join(process.env.HOME, 'AppData/Roaming');
      process.env.LOCALAPPDATA = path.join(process.env.HOME, 'AppData/Local');
      process.env.PSModuleAnalysisCachePath = path.join(process.env.HOME, 'module-cache');
      await mkdir(process.env.APPDATA, { recursive: true });
      await mkdir(process.env.LOCALAPPDATA, { recursive: true });
    }
    for (const command of ['node', 'npm', 'baml'])
      await assert.rejects(run(command, ['--version'], { windowsHide: true, timeout: 5000 }));
    const nodeVersion = (
      await run(executable, ['--version'], { windowsHide: true, timeout: 10_000 })
    ).stdout.trim();
    const qualificationOS =
      process.platform === 'linux' ? await readFile('/etc/os-release', 'utf8') : os.version();
    const qualificationVersion =
      process.platform === 'darwin'
        ? (await run('/usr/bin/sw_vers', ['-productVersion'], { timeout: 10_000 })).stdout.trim()
        : os.release();
    const version = await run(executable, [entry, '--version'], {
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(version.stdout.trim(), manifest.version);
    await run(
      executable,
      [
        '--input-type=module',
        '-e',
        "import {policy_version_async} from './dist/src/workflows/policy.js'; if(await policy_version_async() !== 'latchkit-workflow-v1') process.exitCode=1;",
      ],
      { cwd: app, windowsHide: true, timeout: 30_000 },
    );
    await assertArtifact(path.join(scratch, 'project'), executable, entry, 'standalone');
    if (option('--mounted-project'))
      await assertArtifact(
        path.resolve(option('--mounted-project') as string),
        executable,
        entry,
        'WSL mounted drive',
      );
    for (const [file, hookArgs] of [
      ['codex-handler.js', []],
      ['claude-hook.js', ['--event', 'Stop']],
      ['cursor-ide-hook.cjs', []],
    ] as [string, string[]][])
      await hook(executable, path.join(app, 'dist/src/providers', file), hookArgs);
    const installRoot = path.join(scratch, 'installed versions é');
    const manage = async (request: InstallationRequest): Promise<unknown> =>
      JSON.parse(
        (
          await run(
            executable,
            [
              '--input-type=module',
              '-e',
              "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); console.log(JSON.stringify(await m.runInstallationManager(JSON.parse(process.argv[2]))));",
              manager,
              JSON.stringify({ root: installRoot, ...request }),
            ],
            { windowsHide: true, timeout: 120_000 },
          )
        ).stdout,
      );
    const bootstrap = async (
      releaseDirectory: string,
      releaseManifest: Manifest,
      destination: string,
    ): Promise<void> => {
      const archive = path.join(releaseDirectory, releaseManifest.archive);
      const checksum = path.join(releaseDirectory, `${releaseManifest.archive}.sha256`);
      if (process.platform === 'win32') {
        await run(
          path.join(
            process.env.SystemRoot ?? 'C:/Windows',
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            path.join(releaseDirectory, 'install.ps1'),
            '-Root',
            destination,
            '-Artifact',
            archive,
            '-Checksum',
            checksum,
          ],
          { windowsHide: true, timeout: 120_000 },
        );
      } else {
        await run(
          '/bin/sh',
          [
            path.join(releaseDirectory, 'install.sh'),
            '--root',
            destination,
            '--artifact',
            archive,
            '--checksum',
            checksum,
          ],
          { timeout: 120_000 },
        );
      }
    };
    if (previousManifest)
      await bootstrap(path.resolve(previousDirectory as string), previousManifest, installRoot);
    await bootstrap(directory, manifest, installRoot);
    const active = await readFile(path.join(installRoot, 'current'), 'utf8');
    const hookLauncher =
      process.platform === 'win32'
        ? path.join(installRoot, 'bin', 'latchkit-hook.ps1')
        : path.join(installRoot, 'bin', 'latchkit-hook');
    const stableHookArgs =
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            hookLauncher,
            '--version',
            active.trim(),
            '--handler',
            'claude',
            '--event',
            'Stop',
          ]
        : ['--version', active.trim(), '--handler', 'claude', '--event', 'Stop'];
    const stableHookDurations: StableHookDuration[] = [];
    const runStableHook = async (phase: string, hookArgs: string[]): Promise<void> => {
      const durationMs = await stableHook(
        process.platform === 'win32'
          ? path.join(
              process.env.SystemRoot ?? 'C:/Windows',
              'System32/WindowsPowerShell/v1.0/powershell.exe',
            )
          : hookLauncher,
        hookArgs,
        `${phase} for ${hookArgs[hookArgs.indexOf('--version') + 1] ?? 'unknown'}`,
      );
      stableHookDurations.push({
        phase,
        version: hookArgs[hookArgs.indexOf('--version') + 1] ?? 'unknown',
        durationMs,
      });
    };
    await runStableHook('after-upgrade', stableHookArgs);
    await manage({ command: 'install', bundle });
    assert.equal(await readFile(path.join(installRoot, 'current'), 'utf8'), active);
    const launcher =
      process.platform === 'win32'
        ? path.join(installRoot, 'bin/latchkit.ps1')
        : path.join(installRoot, 'bin/latchkit');
    const launched =
      process.platform === 'win32'
        ? await run(
            path.join(
              process.env.SystemRoot ?? 'C:/Windows',
              'System32/WindowsPowerShell/v1.0/powershell.exe',
            ),
            ['-NoProfile', '-NonInteractive', '-File', launcher, '--version'],
            { windowsHide: true, timeout: 30_000 },
          )
        : await run(launcher, ['--version'], { timeout: 30_000 });
    assert.equal(launched.stdout.trim(), manifest.version);
    const corrupt = path.join(scratch, 'corrupt bundle');
    await cp(bundle, corrupt, { recursive: true });
    await writeFile(path.join(corrupt, 'app/dist/src/cli.js'), 'throw new Error("corrupt");\n');
    await assert.rejects(manage({ command: 'upgrade', bundle: corrupt }));
    assert.equal(await readFile(path.join(installRoot, 'current'), 'utf8'), active);
    const rollbackVersion = previousManifest?.version ?? manifest.version;
    await manage({ command: 'rollback', version: rollbackVersion });
    const rollbackKey = `${rollbackVersion}-${manifest.target}`;
    const rollbackHookArgs =
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            hookLauncher,
            '--version',
            rollbackKey,
            '--handler',
            'claude',
            '--event',
            'Stop',
          ]
        : ['--version', rollbackKey, '--handler', 'claude', '--event', 'Stop'];
    await runStableHook('after-rollback', rollbackHookArgs);
    if (previousManifest) {
      await manage({ command: 'rollback', version: manifest.version });
      await runStableHook('after-restore', stableHookArgs);
    }
    await manage({ command: 'uninstall' });
    await runStableHook('after-uninstall', stableHookArgs);
    assert(
      (await readdir(path.join(installRoot, 'versions'))).length > 0,
      'Compatibility versions must survive uninstall until references are detached.',
    );
    const evidence = {
      schemaVersion: 1,
      status: 'passed',
      archive: manifest.archive,
      sha256: manifest.sha256,
      target: manifest.target,
      node: nodeVersion,
      qualificationOS,
      qualificationVersion,
      runtime: args.includes('--require-wsl') ? 'WSL' : 'native',
      upgradeKind: previousManifest ? 'exact-prior-archive' : 'single-archive-fallback',
      prior: previousManifest
        ? {
            archive: previousManifest.archive,
            sha256: previousManifest.sha256,
            version: previousManifest.version,
          }
        : null,
      systemToolchains: 'absent from PATH',
      stableHookDurations,
      checks: [
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
        previousManifest
          ? 'exact prior archive upgrade and rollback'
          : 'single-archive reinstall fallback (not an exact two-archive upgrade)',
      ],
    };
    await writeFile(
      path.join(
        directory,
        `${manifest.archive}.${args.includes('--require-wsl') ? 'wsl' : os.release()}.evidence.json`,
      ),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    process.env = originalEnv;
    if (!scratch.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
      throw new Error('Unexpected smoke directory.');
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
