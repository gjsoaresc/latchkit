import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { initProject, planSync, saveConfig, syncProject } from '../dist/src/core.js';
import { resolvePackResourceDependencies } from '../dist/src/packs/index.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, version, skillName = 'example-skill', content = '# Example\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-pack-project-'));
  const pack = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-pack-source-'));
  t.after(async () =>
    Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(pack, { recursive: true, force: true }),
    ]),
  );
  const relative = `skills/${skillName}/SKILL.md`;
  await fs.mkdir(path.join(pack, 'skills', skillName), { recursive: true });
  await fs.writeFile(path.join(pack, ...relative.split('/')), content);
  await fs.writeFile(
    path.join(pack, 'latchkit-pack.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: 'example-pack',
        version,
        provenance: 'Original test fixture.',
        compatibility: { configSchemaVersions: [3], providers: ['codex'] },
        files: [{ path: relative, sha256: sha256(content) }],
      },
      null,
      2,
    ),
  );
  return { root, pack, relative };
}

const packSelection = (pack, version, pinned = true) => ({
  id: 'example-pack',
  version,
  source: { type: 'local', path: pack },
  pinned,
});

test('a local pack records its version and updates only after an explicit version change', async (t) => {
  const { root, pack, relative } = await fixture(t, '1.0.0');
  await initProject(root, {
    providers: ['codex'],
    skills: [],
    packs: [packSelection(pack, '1.0.0')],
  });
  await syncProject(root);
  const installed = path.join(root, '.agents', ...relative.split('/'));
  assert.equal(await fs.readFile(installed, 'utf8'), '# Example\n');
  let manifest = JSON.parse(
    await fs.readFile(path.join(root, '.latchkit', 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.packs[0].version, '1.0.0');

  const next = '# Example version two\n';
  await fs.writeFile(path.join(pack, 'skills', 'example-skill', 'SKILL.md'), next);
  await fs.writeFile(
    path.join(pack, 'latchkit-pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example-pack',
      version: '2.0.0',
      provenance: 'Original test fixture.',
      compatibility: { configSchemaVersions: [3], providers: ['codex'] },
      files: [{ path: relative, sha256: sha256(next) }],
    }),
  );
  await assert.rejects(planSync(root), /does not match source/);
  const config = JSON.parse(await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8'));
  await saveConfig(root, { ...config, packs: [packSelection(pack, '2.0.0')] });
  assert.equal(
    (await planSync(root)).changes.find((change) => change.path.endsWith('example-skill/SKILL.md'))
      .action,
    'update',
  );
  await syncProject(root);
  manifest = JSON.parse(await fs.readFile(path.join(root, '.latchkit', 'manifest.json'), 'utf8'));
  assert.equal(manifest.packs[0].version, '2.0.0');
  assert.equal(await fs.readFile(installed, 'utf8'), next);
});

test('colliding custom skill IDs, altered checksums, and traversal declarations are refused', async (t) => {
  const { root, pack, relative } = await fixture(t, '1.0.0');
  const second = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-pack-second-'));
  t.after(async () => fs.rm(second, { recursive: true, force: true }));
  await fs.mkdir(path.join(second, 'skills', 'example-skill'), { recursive: true });
  await fs.writeFile(path.join(second, 'skills', 'example-skill', 'SKILL.md'), '# Other\n');
  await fs.writeFile(
    path.join(second, 'latchkit-pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'second-pack',
      version: '1.0.0',
      provenance: 'Original.',
      compatibility: { configSchemaVersions: [3], providers: ['codex'] },
      files: [{ path: relative, sha256: sha256('# Other\n') }],
    }),
  );
  await initProject(root, {
    providers: ['codex'],
    skills: [],
    packs: [
      packSelection(pack, '1.0.0'),
      {
        id: 'second-pack',
        version: '1.0.0',
        source: { type: 'local', path: second },
        pinned: true,
      },
    ],
  });
  await assert.rejects(planSync(root), /Pack collision/);

  await fs.writeFile(
    path.join(pack, 'latchkit-pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example-pack',
      version: '1.0.0',
      provenance: 'Original.',
      compatibility: { configSchemaVersions: [3], providers: ['codex'] },
      files: [{ path: '../escape', sha256: sha256('x') }],
    }),
  );
  await saveConfig(root, {
    ...JSON.parse(await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8')),
    packs: [packSelection(pack, '1.0.0')],
  });
  await assert.rejects(planSync(root), { code: 'PACK_PATH_INVALID' });
});

test('a rollback requested through a prior pack version preserves intervening user edits', async (t) => {
  const { root, pack, relative } = await fixture(t, '1.0.0');
  await initProject(root, {
    providers: ['codex'],
    skills: [],
    packs: [packSelection(pack, '1.0.0')],
  });
  await syncProject(root);
  const installed = path.join(root, '.agents', ...relative.split('/'));
  await fs.writeFile(installed, '# User edit\n');
  await assert.rejects(syncProject(root), /Managed file has local edits/);
  assert.equal(await fs.readFile(installed, 'utf8'), '# User edit\n');
});

function loadedFile(relativePath, content) {
  return { path: relativePath, bytes: Buffer.from(content, 'utf8') };
}

test('shared resource dependency resolution follows transitive links but rejects tree escapes and absolute links', () => {
  const pack = {
    schemaVersion: 1,
    id: 'escape-fixture',
    version: '1.0.0',
    provenance: 'Original test fixture.',
    compatibility: { configSchemaVersions: [3], providers: ['codex'] },
    source: { type: 'bundled' },
    files: [
      loadedFile(
        'skills/skill-a/SKILL.md',
        [
          '# Skill A',
          '',
          'Legitimate: [shared notes](../shared/notes.md).',
          'Traversal escape: [outside the tree](../../secret.md).',
          'Absolute POSIX: [root file](/etc/passwd).',
          'Absolute Windows: [drive path](C:\\Windows\\evil.md).',
          'UNC path: [network share](\\\\server\\share\\evil.md).',
          'Missing target: [never exported](../missing/gone.md).',
          'Scheme URL, left alone: [external](https://example.com/notes.md).',
        ].join('\n'),
      ),
      loadedFile('skills/skill-b/SKILL.md', '# Skill B\n\nNo local resource links here.\n'),
      loadedFile(
        'skills/shared/notes.md',
        'Shared notes that pull in a [follow-up](./followup.md) transitively.\n',
      ),
      loadedFile('skills/shared/followup.md', 'Leaf resource with no further links.\n'),
    ],
  };
  const { primarySkills, dependencies } = resolvePackResourceDependencies(pack);
  assert.deepEqual([...primarySkills].sort(), ['skill-a', 'skill-b']);
  // `shared` has no SKILL.md of its own, so it is never a selectable skill.
  assert.equal(primarySkills.has('shared'), false);
  assert.deepEqual([...(dependencies.get('skill-a') ?? [])].sort(), [
    'skills/shared/followup.md',
    'skills/shared/notes.md',
  ]);
  assert.deepEqual([...(dependencies.get('skill-b') ?? [])], []);
});

test('a local pack may declare a shared-resource folder with no SKILL.md, and syncing it needs no per-file collision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-pack-project-'));
  const pack = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-pack-source-'));
  t.after(async () =>
    Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(pack, { recursive: true, force: true }),
    ]),
  );
  const skillContent = '# Example\n\nSee [shared notes](../shared/notes.md).\n';
  const notesContent = '# Shared notes\n';
  await fs.mkdir(path.join(pack, 'skills', 'example-skill'), { recursive: true });
  await fs.mkdir(path.join(pack, 'skills', 'shared'), { recursive: true });
  await fs.writeFile(path.join(pack, 'skills', 'example-skill', 'SKILL.md'), skillContent);
  await fs.writeFile(path.join(pack, 'skills', 'shared', 'notes.md'), notesContent);
  await fs.writeFile(
    path.join(pack, 'latchkit-pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example-pack',
      version: '1.0.0',
      provenance: 'Original test fixture.',
      compatibility: { configSchemaVersions: [3], providers: ['codex'] },
      files: [
        { path: 'skills/example-skill/SKILL.md', sha256: sha256(skillContent) },
        { path: 'skills/shared/notes.md', sha256: sha256(notesContent) },
      ],
    }),
  );
  await initProject(root, {
    providers: ['codex'],
    skills: [],
    packs: [packSelection(pack, '1.0.0')],
  });
  const plan = await planSync(root);
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(
    plan.changes
      .filter((change) => change.action === 'create')
      .map((change) => change.path)
      .sort(),
    ['.agents/skills/example-skill/SKILL.md', '.agents/skills/shared/notes.md'],
  );
  await syncProject(root);
  assert.equal(
    await fs.readFile(path.join(root, '.agents', 'skills', 'shared', 'notes.md'), 'utf8'),
    notesContent,
  );
});
