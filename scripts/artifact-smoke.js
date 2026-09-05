#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = process.argv.slice(2);
const requireWsl = args.includes('--require-wsl');
const requireLinks = args.includes('--require-links');
const mountedArg = valueAfter('--mounted-project');

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function command(file, commandArgs, options = {}) {
  const result = await run(file, commandArgs, {
    ...options,
    ...(file === npmCommand && process.platform === 'win32' ? { shell: true } : {}),
    encoding: 'utf8',
  });
  return result.stdout;
}

async function cli(node, entry, commandArgs, options = {}) {
  const stdout = await command(node, [entry, ...commandArgs], options);
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]+)\s/);
      if (match) {
        cleanup();
        resolve(`http://${match[0].split('/')[2]}/#${match[1]}`);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Installed UI exited before startup (code ${code}).\n${output}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!stopped && process.platform === 'win32') {
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  }
}

async function assertArtifact(root, node, entry, label) {
  const fs = await import('node:fs/promises');
  await fs.mkdir(root, { recursive: true });
  const project = path.join(root, 'project with spaces é');
  await fs.mkdir(project, { recursive: true });
  await (
    await run(node, [
      entry,
      'init',
      '--project',
      project,
      '--providers',
      'codex',
      '--skills',
      'spec,fix',
    ])
  ).stdout;
  await (
    await run(node, [entry, 'sync', '--project', project])
  ).stdout;
  const repeat = await cli(node, entry, ['sync', '--project', project, '--dry-run']);
  if (repeat.conflicts.length || repeat.changes.some((change) => change.action !== 'unchanged'))
    throw new Error(`${label}: repeat sync is not clean`);

  const installedSkill = path.join(project, '.agents', 'skills', 'latchkit-spec', 'SKILL.md');
  const original = await readFile(installedSkill, 'utf8');
  await writeFile(installedSkill, `${original}\nlocal edit\n`);
  try {
    await run(node, [entry, 'sync', '--project', project]);
    throw new Error(`${label}: edited skill did not block sync`);
  } catch (error) {
    if (!/Sync blocked/.test(error.stderr ?? error.message)) throw error;
  }
  await writeFile(installedSkill, original);

  const crlfNotes = path.join(project, '.agents', 'skills', 'personal', 'notes.txt');
  await fs.mkdir(path.dirname(crlfNotes), { recursive: true });
  await writeFile(crlfNotes, 'line one\r\nline two\r\n');
  const readOnly = path.join(project, 'read-only.txt');
  await writeFile(readOnly, 'preserve me\n');
  await fs.chmod(readOnly, 0o444);
  const removed = await cli(node, entry, ['remove', '--project', project]);
  if (
    removed.conflicts?.length ||
    (await stat(installedSkill).then(
      () => true,
      () => false,
    ))
  )
    throw new Error(`${label}: removal did not remove the managed skill`);
  if ((await readFile(crlfNotes, 'utf8')) !== 'line one\r\nline two\r\n')
    throw new Error(`${label}: CRLF user content changed`);
  if ((await readFile(readOnly, 'utf8')) !== 'preserve me\n')
    throw new Error(`${label}: read-only user content changed`);

  const longDirectory = path.join(project, 'long-segment-'.repeat(14));
  await fs.mkdir(longDirectory, { recursive: true });
  await writeFile(path.join(longDirectory, 'edge.txt'), 'long path\n');
  if ((await readFile(path.join(longDirectory, 'edge.txt'), 'utf8')) !== 'long path\n')
    throw new Error(`${label}: long path failed`);
  const upper = path.join(project, 'CaseCollision');
  const lower = path.join(project, 'casecollision');
  await fs.mkdir(upper, { recursive: true });
  await fs.mkdir(lower, { recursive: true });
  if (process.platform === 'win32' && (await fs.realpath(upper)) !== (await fs.realpath(lower)))
    throw new Error(`${label}: case collision was not observed on Windows`);

  await (
    await run(node, [entry, 'init', '--project', project])
  ).stdout;
  const child = spawn(node, [entry, 'ui', '--project', project, '--port', '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await waitForServer(child);
  const parsed = new URL(url);
  const token = parsed.hash.slice(1);
  const origin = parsed.origin;
  const page = await fetch(origin);
  if (page.status !== 200 || !(await page.text()).includes('Latchkit'))
    throw new Error(`${label}: installed UI asset failed`);
  const state = await fetch(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (state.status !== 200 || (await state.json()).config.schemaVersion !== 3)
    throw new Error(`${label}: installed configuration API failed`);
  await stopChild(child);
}

async function linkCapability(root, node, entry) {
  const fs = await import('node:fs/promises');
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, 'link-target');
  const junction = path.join(root, 'junction');
  const fileTarget = path.join(root, 'file-target.txt');
  const fileLink = path.join(root, 'file-link.txt');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(fileTarget, 'link target\n');
  try {
    await fs.symlink(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(fileTarget, fileLink, 'file');
    if (
      !(await fs.lstat(junction)).isSymbolicLink() ||
      !(await fs.lstat(fileLink)).isSymbolicLink()
    )
      throw new Error('links were not created as links');
    const guardedProject = path.join(root, 'guarded-project');
    await fs.mkdir(guardedProject, { recursive: true });
    await command(node, [
      entry,
      'init',
      '--project',
      guardedProject,
      '--providers',
      'codex',
      '--skills',
      'spec',
    ]);
    await fs.symlink(
      target,
      path.join(guardedProject, '.agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    let blocked = false;
    try {
      await command(node, [entry, 'sync', '--project', guardedProject]);
    } catch (error) {
      if (/Refusing symlink or junction|Sync blocked/.test(error.stderr ?? error.message))
        blocked = true;
      else throw error;
    }
    if (!blocked) throw new Error('directory link safeguard did not block sync');
    const fileProject = path.join(root, 'file-guard-project');
    await fs.mkdir(fileProject, { recursive: true });
    await command(node, [
      entry,
      'init',
      '--project',
      fileProject,
      '--providers',
      'codex',
      '--skills',
      'spec',
    ]);
    await command(node, [entry, 'sync', '--project', fileProject]);
    const managed = path.join(fileProject, '.agents', 'skills', 'latchkit-spec', 'SKILL.md');
    await fs.unlink(managed);
    await fs.symlink(fileTarget, managed, 'file');
    blocked = false;
    try {
      await command(node, [entry, 'sync', '--project', fileProject]);
    } catch (error) {
      if (/Refusing symlink or junction|Sync blocked/.test(error.stderr ?? error.message))
        blocked = true;
      else throw error;
    }
    if (!blocked) throw new Error('file link safeguard did not block sync');
  } catch (error) {
    throw new Error(
      `Required link capability unavailable (${error.code ?? error.message}); release evidence cannot claim link safeguards.`,
    );
  }
}

async function main() {
  const repository = path.resolve(import.meta.dirname, '..');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'latchkit-artifact-'));
  try {
    if (
      requireWsl &&
      !(
        process.platform === 'linux' &&
        (process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()))
      )
    )
      throw new Error('WSL smoke must run under WSL, not a Linux container or native host.');
    const packDir = path.join(scratch, 'pack');
    const installDir = path.join(scratch, 'install');
    const projectRoot = path.join(scratch, 'linux project é');
    const fs = await import('node:fs/promises');
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });
    const artifact =
      valueAfter('--artifact') ??
      JSON.parse(
        await command(npmCommand, ['pack', '--json', '--pack-destination', packDir], {
          cwd: repository,
        }),
      )[0].filename;
    const artifactPath = path.resolve(packDir, artifact);
    const checksum = createHash('sha256')
      .update(await readFile(artifactPath))
      .digest('hex');
    await command(
      npmCommand,
      ['install', '--ignore-scripts', '--no-package-lock', '--prefix', installDir, artifactPath],
      { cwd: repository },
    );
    const node = process.execPath;
    const entry = path.join(installDir, 'node_modules', 'latchkit', 'src', 'cli.js');
    await assertArtifact(projectRoot, node, entry, 'artifact');
    if (requireLinks) await linkCapability(path.join(scratch, 'link-capability'), node, entry);
    if (mountedArg) await assertArtifact(path.resolve(mountedArg), node, entry, 'mounted-project');
    console.log(
      JSON.stringify(
        {
          status: 'passed',
          platform: process.platform,
          runtime: requireWsl ? 'WSL' : 'native',
          node: process.version,
          artifact: path.basename(artifactPath),
          sha256: checksum,
          links: requireLinks ? 'exercised' : 'not-required',
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(`Artifact smoke failed: ${error.message}`);
  process.exitCode = 1;
});
