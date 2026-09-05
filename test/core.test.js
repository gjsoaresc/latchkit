import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  initProject,
  readConfig,
  saveConfig,
  planSync,
  syncProject,
  removeProjectSkills,
  doctor,
} from '../src/core.js';

const providerIds = ['claude', 'codex', 'gemini', 'cursor', 'cursor-cli'];
const skillIds = ['spec', 'fix', 'review', 'handoff'];
const validConfig = (overrides = {}) => {
  const schemaVersion = overrides.schemaVersion ?? 2;
  return {
    schemaVersion,
    providers: [...providerIds],
    skills: [...skillIds],
    ...(schemaVersion === 2 ? { providerSettings: {} } : {}),
    ...overrides,
  };
};

async function temporaryProject(t) {
  const temporaryDirectory = path.resolve(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temporaryDirectory, 'latchkit-test-'));
  const root = path.join(base, 'project with spaces é');
  await fs.mkdir(root);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(base)), temporaryDirectory);
    assert.ok(path.basename(base).startsWith('latchkit-test-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { root, base };
}

const skillFile = (root, directory, skill) =>
  path.join(root, directory, 'skills', `latchkit-${skill}`, 'SKILL.md');

async function exists(filename) {
  try {
    await fs.lstat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeFile(filename, contents) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
}

// Include directories and link targets so a failed operation cannot quietly
// leave behind a partial installation. Never traverse a linked directory.
async function snapshot(directory) {
  const entries = {};
  async function visit(current, prefix = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        entries[relative] = { link: await fs.readlink(absolute) };
      } else if (entry.isDirectory()) {
        entries[`${relative}/`] = 'directory';
        await visit(absolute, relative);
      } else {
        entries[relative] = (await fs.readFile(absolute)).toString('base64');
      }
    }
  }
  await visit(directory);
  return entries;
}

function changedPaths(root, plan, action) {
  return plan.changes
    .filter((change) => change.action === action)
    .map((change) => {
      const relative = path.isAbsolute(change.path)
        ? path.relative(root, change.path)
        : change.path;
      return relative.replaceAll('\\', '/');
    })
    .sort();
}

test('initialization preserves an existing project configuration', async (t) => {
  const { root } = await temporaryProject(t);
  const selection = { providers: ['codex'], skills: ['review'] };
  const initial = await initProject(root, selection);
  assert.deepEqual(initial, validConfig(selection));
  assert.deepEqual(await readConfig(root), initial);

  const before = await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8');
  const again = await initProject(root, { providers: ['claude'], skills: ['fix'] });
  assert.deepEqual(again, initial);
  assert.equal(await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8'), before);
});

test('preview is read-only and five providers share eight skill files', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: providerIds, skills: skillIds });
  const before = await snapshot(root);
  const preview = await planSync(root);
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(await snapshot(root), before);

  const expected = ['.claude', '.agents']
    .flatMap((directory) => skillIds.map((id) => `${directory}/skills/latchkit-${id}/SKILL.md`))
    .sort();
  assert.deepEqual(changedPaths(root, preview, 'create'), expected);

  const installed = await syncProject(root);
  assert.deepEqual(installed.conflicts, []);
  assert.deepEqual(changedPaths(root, installed, 'create'), expected);
  for (const relative of expected) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    assert.match(content, /\S/);
  }

  const installedSnapshot = await snapshot(root);
  const repeated = await syncProject(root);
  assert.deepEqual(repeated.conflicts, []);
  assert.deepEqual(changedPaths(root, repeated, 'unchanged'), expected);
  assert.deepEqual(
    repeated.changes.filter((change) => change.action !== 'unchanged'),
    [],
  );
  assert.deepEqual(await snapshot(root), installedSnapshot);
});

test('changing selections removes stale managed skills without removing user files', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec', 'fix'] });
  await syncProject(root);
  const unrelated = path.join(root, '.agents', 'skills', 'personal-helper', 'SKILL.md');
  await writeFile(unrelated, '# My personal skill\n');

  await saveConfig(root, validConfig({ providers: ['codex'], skills: ['spec'] }));
  const preview = await planSync(root);
  assert.deepEqual(changedPaths(root, preview, 'remove'), ['.agents/skills/latchkit-fix/SKILL.md']);
  await syncProject(root);
  assert.equal(await exists(skillFile(root, '.agents', 'fix')), false);
  assert.equal(await exists(skillFile(root, '.agents', 'spec')), true);
  assert.equal(await fs.readFile(unrelated, 'utf8'), '# My personal skill\n');
});

test('invalid configurations are rejected without replacing the saved config', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: ['claude'], skills: ['spec'] });
  const before = await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8');
  const invalid = [
    validConfig({ schemaVersion: 99 }),
    validConfig({ providers: ['unknown-agent'] }),
    validConfig({ skills: ['unknown-skill'] }),
    validConfig({ providers: 'codex' }),
    validConfig({ skills: null }),
  ];
  for (const config of invalid) {
    await assert.rejects(async () => saveConfig(root, config));
    assert.equal(await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8'), before);
  }
});

test('invalid configuration read from disk cannot trigger skill installation', async (t) => {
  const { root } = await temporaryProject(t);
  await writeFile(
    path.join(root, '.latchkit', 'config.json'),
    JSON.stringify(validConfig({ skills: ['../escape'] })),
  );
  const before = await snapshot(root);
  await assert.rejects(async () => readConfig(root));
  await assert.rejects(async () => syncProject(root));
  assert.deepEqual(await snapshot(root), before);
});

test('an unowned destination blocks the entire sync before any files change', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: ['claude', 'codex'], skills: ['spec', 'fix'] });
  const userFile = skillFile(root, '.claude', 'spec');
  await writeFile(userFile, '# Existing skill owned by the developer\n');
  const before = await snapshot(root);

  const preview = await planSync(root);
  assert.ok(preview.conflicts.length > 0);
  assert.ok(preview.conflicts.every((conflict) => conflict.path && conflict.reason));
  await assert.rejects(async () => syncProject(root));
  assert.deepEqual(await snapshot(root), before);
  assert.equal(await exists(skillFile(root, '.agents', 'fix')), false);
});

test(
  'a failed Windows manifest replacement rolls back the new file and permits retry',
  {
    skip:
      process.platform !== 'win32'
        ? 'Uses the Windows read-only file attribute to force a manifest rename failure'
        : false,
  },
  async (t) => {
    const { root } = await temporaryProject(t);
    await initProject(root, { providers: ['codex'], skills: ['spec'] });
    await syncProject(root);
    await saveConfig(root, validConfig({ providers: ['codex'], skills: ['spec', 'fix'] }));
    const manifest = path.join(root, '.latchkit', 'manifest.json');
    const originalManifest = await fs.readFile(manifest, 'utf8');
    const existingSkill = await fs.readFile(skillFile(root, '.agents', 'spec'), 'utf8');

    await fs.chmod(manifest, 0o444);
    try {
      await assert.rejects(async () => syncProject(root));
      assert.equal(
        await exists(skillFile(root, '.agents', 'fix')),
        false,
        'A failed manifest write must not leave an unowned generated skill',
      );
      assert.equal(await fs.readFile(manifest, 'utf8'), originalManifest);
      assert.equal(await fs.readFile(skillFile(root, '.agents', 'spec'), 'utf8'), existingSkill);
    } finally {
      await fs.chmod(manifest, 0o666);
    }

    const preview = await planSync(root);
    assert.deepEqual(preview.conflicts, []);
    assert.deepEqual(changedPaths(root, preview, 'create'), [
      '.agents/skills/latchkit-fix/SKILL.md',
    ]);
    await syncProject(root);
    assert.equal(await exists(skillFile(root, '.agents', 'fix')), true);
    assert.deepEqual((await planSync(root)).conflicts, []);
  },
);

test('externally edited managed skills survive sync and uninstall', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec', 'fix'] });
  await syncProject(root);
  const edited = skillFile(root, '.agents', 'spec');
  const customContents = `${await fs.readFile(edited, 'utf8')}\nDeveloper changes: preserve these.\n`;
  await fs.writeFile(edited, customContents);
  const before = await snapshot(root);
  const originalConfig = await readConfig(root);

  const preview = await planSync(root);
  assert.ok(preview.conflicts.length > 0);
  await assert.rejects(async () => syncProject(root));
  assert.deepEqual(await snapshot(root), before);

  // Implementations may return conflicts or reject uninstall as a whole;
  // both are safe provided the user's changed skill is kept intact.
  try {
    await removeProjectSkills(root);
  } catch (error) {
    assert.ok(error instanceof Error);
  }
  assert.equal(await fs.readFile(edited, 'utf8'), customContents);
  assert.deepEqual(await readConfig(root), originalConfig);
});

test('deselecting an edited skill still preserves it and prevents a partial sync', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec', 'fix'] });
  await syncProject(root);
  const edited = skillFile(root, '.agents', 'fix');
  await fs.writeFile(edited, '# A custom replacement that must survive\n');
  await saveConfig(root, validConfig({ providers: ['claude'], skills: ['review'] }));
  const before = await snapshot(root);

  assert.ok((await planSync(root)).conflicts.length > 0);
  await assert.rejects(async () => syncProject(root));
  assert.deepEqual(await snapshot(root), before);
});

test('clean uninstall removes installed skills but preserves config and unrelated content', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: ['claude', 'codex'], skills: ['spec'] });
  await syncProject(root);
  const config = await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8');
  const sibling = path.join(root, '.agents', 'skills', 'latchkit-spec', 'notes.txt');
  const unrelated = path.join(root, '.claude', 'skills', 'my-helper', 'SKILL.md');
  await writeFile(sibling, 'My notes\n');
  await writeFile(unrelated, '# An unrelated skill\n');

  await removeProjectSkills(root);
  assert.equal(await exists(skillFile(root, '.agents', 'spec')), false);
  assert.equal(await exists(skillFile(root, '.claude', 'spec')), false);
  assert.equal(await fs.readFile(sibling, 'utf8'), 'My notes\n');
  assert.equal(await fs.readFile(unrelated, 'utf8'), '# An unrelated skill\n');
  assert.equal(await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8'), config);
});

test('a directory symlink or Windows junction cannot redirect installation outside the project', async (t) => {
  const { root, base } = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const outside = path.join(base, 'outside project');
  await fs.mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'Outside content\n');
  try {
    await fs.symlink(
      outside,
      path.join(root, '.agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`This environment cannot create directory links (${error.code})`);
      return;
    }
    throw error;
  }
  const before = await snapshot(root);
  const outsideBefore = await snapshot(outside);

  await assert.rejects(async () => syncProject(root));
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(await snapshot(outside), outsideBefore);
});

test('a managed skill replaced by a file symlink is never followed or removed', async (t) => {
  const { root, base } = await temporaryProject(t);
  await initProject(root, { providers: ['codex'], skills: ['spec'] });
  await syncProject(root);
  const installed = skillFile(root, '.agents', 'spec');
  const original = await fs.readFile(installed, 'utf8');
  const outside = path.join(base, 'external-skill.md');
  await fs.writeFile(outside, original);
  await fs.unlink(installed);
  try {
    await fs.symlink(outside, installed, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`This environment cannot create file symlinks (${error.code})`);
      return;
    }
    throw error;
  }

  await assert.rejects(async () => syncProject(root));
  try {
    await removeProjectSkills(root);
  } catch (error) {
    assert.ok(error instanceof Error);
  }
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, 'utf8'), original);
});

test('doctor reports every supported provider without changing the project', async (t) => {
  const { root } = await temporaryProject(t);
  await initProject(root, { providers: ['claude'], skills: ['review'] });
  const before = await snapshot(root);
  const report = await doctor(root);
  assert.equal(report.platform, process.platform);
  assert.ok(report.runtime);
  assert.ok(report.node);
  assert.ok(report.project);
  assert.deepEqual(report.providers.map((provider) => provider.id).sort(), [...providerIds].sort());
  for (const provider of report.providers) {
    assert.equal(typeof provider.label, 'string');
    assert.equal(typeof provider.command, 'string');
    assert.equal(typeof provider.skillDirectory, 'string');
    assert.ok(['verified', 'unverified'].includes(provider.verification.installed));
    assert.equal(provider.verification.authenticated, 'unknown');
    assert.equal(provider.verification.endToEnd, 'unverified');
    assert.equal(typeof provider.detected, 'boolean');
    if (provider.detected) assert.equal(typeof provider.path, 'string');
  }
  assert.deepEqual(await snapshot(root), before);
});
