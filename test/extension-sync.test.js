import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  initProject,
  materializePackSource,
  planSync,
  saveConfig,
  syncProject,
} from '../dist/src/core.js';

const execFile = promisify(execFileCallback);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function git(directory, args) {
  await execFile('git', args, { cwd: directory, windowsHide: true });
}

async function commitPack(repository, version, content) {
  const skill = path.join(repository, 'skills', 'team-review');
  const resource = `# Team review ${content}\n`;
  const guide = `# Supporting guide ${content}\n`;
  await fs.mkdir(path.join(skill, 'references'), { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), resource);
  await fs.writeFile(path.join(skill, 'references', 'guide.md'), guide);
  await fs.writeFile(
    path.join(repository, 'latchkit-pack.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'team-review',
        version,
        author: 'Fixture Team',
        license: 'MIT',
        provenance: 'Original fixture material for Latchkit tests.',
        compatibility: { configSchemaVersions: [3], providers: ['codex'] },
        files: [
          { path: 'skills/team-review/SKILL.md', sha256: sha256(resource) },
          { path: 'skills/team-review/references/guide.md', sha256: sha256(guide) },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await git(repository, ['add', '.']);
  await git(repository, [
    '-c',
    'user.name=Latchkit test',
    '-c',
    'user.email=latchkit@example.invalid',
    'commit',
    '-m',
    `pack ${version}`,
  ]);
  return (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
}

function selection(repository, version, commit) {
  return {
    id: 'team-review',
    version,
    source: { type: 'git', repository, commit },
    pinned: true,
  };
}

test('explicit Git materialization locks immutable bytes, supports deliberate upgrades, and preserves edits', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-extension-sync-'));
  const repository = path.join(base, 'source');
  const project = path.join(base, 'project');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(repository);
  await fs.mkdir(project);
  await git(repository, ['init']);
  const first = await commitPack(repository, '1.0.0', 'one');
  await git(repository, ['tag', 'release']);

  await initProject(project, {
    providers: ['codex'],
    skills: [],
    packs: [selection(repository, '1.0.0', first)],
  });
  const before = await fs.readdir(project);
  await assert.rejects(planSync(project), { code: 'PACK_SOURCE_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(project), before, 'preview never fetches or creates a cache');

  const cli = path.resolve('dist', 'src', 'cli.js');
  const fetched = JSON.parse(
    (
      await execFile(process.execPath, [
        cli,
        'pack',
        'fetch',
        '--project',
        project,
        '--id',
        'team-review',
      ])
    ).stdout,
  );
  assert.equal(fetched.materialized[0].commit, first);
  const preview = await planSync(project);
  assert.deepEqual(preview.conflicts, []);
  await syncProject(project);
  const installed = path.join(project, '.agents', 'skills', 'team-review', 'SKILL.md');
  const guide = path.join(project, '.agents', 'skills', 'team-review', 'references', 'guide.md');
  assert.equal(await fs.readFile(installed, 'utf8'), '# Team review one\n');
  assert.equal(await fs.readFile(guide, 'utf8'), '# Supporting guide one\n');
  const lock = JSON.parse(
    await fs.readFile(path.join(project, '.latchkit', 'manifest.json'), 'utf8'),
  );
  assert.equal(lock.packs[0].resolvedCommit, first);
  assert.equal(lock.packs[0].files.length, 2);

  const second = await commitPack(repository, '2.0.0', 'two');
  await git(repository, ['tag', '-f', 'release']);
  await materializePackSource(project, { id: 'team-review' });
  assert.equal(
    await fs.readFile(installed, 'utf8'),
    '# Team review one\n',
    'moved tag cannot change a pinned cache',
  );

  const config = JSON.parse(
    await fs.readFile(path.join(project, '.latchkit', 'config.json'), 'utf8'),
  );
  await saveConfig(project, { ...config, packs: [selection(repository, '2.0.0', second)] });
  await assert.rejects(planSync(project), { code: 'PACK_SOURCE_UNAVAILABLE' });
  await materializePackSource(project, { id: 'team-review' });
  assert.equal(
    (await planSync(project)).changes.find((change) =>
      change.path.endsWith('/team-review/SKILL.md'),
    ).action,
    'update',
  );
  await syncProject(project);
  assert.equal(await fs.readFile(installed, 'utf8'), '# Team review two\n');

  await fs.writeFile(installed, '# Team-local customization\n');
  await saveConfig(project, { ...config, packs: [selection(repository, '1.0.0', first)] });
  await assert.rejects(syncProject(project), /Managed file has local edits/);
  assert.equal(await fs.readFile(installed, 'utf8'), '# Team-local customization\n');

  await fs.rm(repository, { recursive: true, force: true });
  await assert.rejects(materializePackSource(project, { id: 'team-review' }), {
    code: 'PACK_SOURCE_UNAVAILABLE',
  });
  assert.equal(await fs.readFile(installed, 'utf8'), '# Team-local customization\n');
});

test('a failed cache transaction rolls back and a tampered cache blocks sync before mutation', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-extension-rollback-'));
  const repository = path.join(base, 'source');
  const project = path.join(base, 'project');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(repository);
  await fs.mkdir(project);
  await git(repository, ['init']);
  const commit = await commitPack(repository, '1.0.0', 'one');
  await initProject(project, {
    providers: ['codex'],
    skills: [],
    packs: [selection(repository, '1.0.0', commit)],
  });
  await assert.rejects(
    materializePackSource(project, {
      faultBoundary(boundary) {
        if (boundary === 'resource:0') throw new Error('injected interruption');
      },
    }),
    /injected interruption/,
  );
  await assert.rejects(planSync(project), { code: 'PACK_SOURCE_UNAVAILABLE' });
  await materializePackSource(project);
  await syncProject(project);
  const cache = (await fs.readdir(path.join(project, '.latchkit', 'packs', 'git')))[0];
  assert.ok(cache);
  const filename = path.join(project, '.latchkit', 'packs', 'git', cache);
  const tampered = JSON.parse(await fs.readFile(filename, 'utf8'));
  tampered.files[0].bytes = Buffer.from('# altered\n').toString('base64');
  await fs.writeFile(filename, `${JSON.stringify(tampered)}\n`);
  const installed = path.join(project, '.agents', 'skills', 'team-review', 'SKILL.md');
  const original = await fs.readFile(installed, 'utf8');
  await assert.rejects(planSync(project), { code: 'PACK_INTEGRITY_FAILED' });
  assert.equal(await fs.readFile(installed, 'utf8'), original);
});
