import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findSkillFiles, validateSkillTree } from '../scripts/validate-skills.js';

async function withSkillTree(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'latchkit-skills-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('skill validation discovers nested skills', async () => {
  await withSkillTree(async (root) => {
    const skill = path.join(root, 'nested', 'latchkit-example');
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, 'SKILL.md'),
      '---\nname: latchkit-example\ndescription: Example\n---\n',
    );
    assert.deepEqual(await findSkillFiles(root), [path.join(skill, 'SKILL.md')]);
    await assert.doesNotReject(() => validateSkillTree(root));
  });
});

test('skill validation reports invalid metadata and path', async () => {
  await withSkillTree(async (root) => {
    const skill = path.join(root, 'latchkit-broken');
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, 'SKILL.md'),
      '---\nname: latchkit-broken\ndescription: Broken\n---\n[missing](./references/nope.md)\n',
    );
    await assert.rejects(
      () => validateSkillTree(root),
      /referenced local resource does not exist: \.\/references\/nope\.md/,
    );
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: wrong\ndescription: Broken\n---\n');
    await assert.rejects(() => validateSkillTree(root), /metadata name must be latchkit-broken/);
  });
});
