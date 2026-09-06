import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject, planSync } from '../dist/src/core.js';
import { loadBundledPack } from '../dist/src/packs/index.js';
import { findSkillFiles, validateSkillTree } from '../scripts/validate-skills.js';

const ids = ['requirements', 'spec', 'build', 'fix', 'review', 'handoff', 'setup'];

test('the expanded workflow tree has stable metadata and local references', async () => {
  const files = await validateSkillTree(path.resolve('skills'));
  assert.deepEqual(
    files
      .map((file) => path.basename(path.dirname(file)))
      .filter((name) => name.startsWith('latchkit-'))
      .sort(),
    ids.map((id) => `latchkit-${id}`).sort(),
  );
  assert.equal((await findSkillFiles(path.resolve('skills/references'))).length, 0);
  const pack = await loadBundledPack();
  assert.deepEqual(
    pack.files.map((file) => file.path).sort(),
    ids.map((id) => `skills/latchkit-${id}/SKILL.md`).sort(),
  );
  assert.equal(pack.version, '1.0.0');
});

test('the bundled pack exports the new workflows while preserving old IDs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-workflow-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { providers: ['codex'], skills: ids });
  const plan = await planSync(root);
  assert.deepEqual(
    plan.changes
      .filter((change) => change.action === 'create')
      .map((change) => change.path)
      .sort(),
    ids.map((id) => `.agents/skills/latchkit-${id}/SKILL.md`).sort(),
  );
});

test('setup conflicts remain reviewable and preserve existing guidance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-workflow-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { providers: ['codex'], skills: ['setup'] });
  await mkdir(path.join(root, '.agents', 'skills', 'latchkit-setup'), { recursive: true });
  const existing = '# User-authored setup guidance\n';
  const target = path.join(root, '.agents', 'skills', 'latchkit-setup', 'SKILL.md');
  await writeFile(target, existing);
  const plan = await planSync(root);
  assert.equal(plan.conflicts[0].path, '.agents/skills/latchkit-setup/SKILL.md');
  assert.match(plan.conflicts[0].reason, /not managed/);
  assert.equal(await readFile(target, 'utf8'), existing);
});

test('shared roots report duplicate visibility instead of duplicating skills', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-workflow-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { providers: ['claude', 'codex'], skills: ['requirements'] });
  const plan = await planSync(root);
  assert.equal(
    plan.ruleWarnings.some((warning) => warning.code === 'CLAUDE_AGENTS_IMPORT'),
    true,
  );
  assert.deepEqual(
    plan.changes
      .filter((change) => change.action === 'create')
      .map((change) => change.path)
      .sort(),
    [
      '.agents/skills/latchkit-requirements/SKILL.md',
      '.claude/skills/latchkit-requirements/SKILL.md',
    ],
  );
});
