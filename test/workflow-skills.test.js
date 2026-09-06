import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  initProject,
  planSync,
  removeProjectSkills,
  saveConfig,
  syncProject,
} from '../dist/src/core.js';
import { loadBundledPack, resolvePackResourceDependencies } from '../dist/src/packs/index.js';
import { findSkillFiles, validateSkillTree } from '../scripts/validate-skills.js';

const ids = ['requirements', 'spec', 'build', 'fix', 'review', 'handoff', 'setup'];
const referenceFiles = [
  'efficiency.md',
  'prd-template.md',
  'technical-plan-template.md',
  'workflow-evidence.md',
];
// The exact shared-resource dependency each bundled skill's SKILL.md links
// to today, via `../references/<file>`. This is what regresses (silently,
// with no export-time error) if a skill's link text or a reference
// filename drifts without updating the other -- see the link-resolution
// regression test below, which does not depend on this table at all.
const expectedDependencies = {
  'latchkit-requirements': ['efficiency.md', 'workflow-evidence.md'],
  'latchkit-spec': ['efficiency.md', 'prd-template.md', 'technical-plan-template.md'],
  'latchkit-build': ['efficiency.md', 'workflow-evidence.md'],
  'latchkit-fix': [],
  'latchkit-review': ['efficiency.md'],
  'latchkit-handoff': [],
  'latchkit-setup': [],
};

async function tempProject(t, prefix = 'latchkit-workflow-') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function createdPaths(plan) {
  return plan.changes
    .filter((change) => change.action === 'create')
    .map((change) => change.path)
    .sort();
}

/** Read every exported SKILL.md under `root` and assert its relative
 * Markdown links resolve on disk from its own directory. Returns the flat
 * list of `{ skill, reference }` links actually checked, so a test can
 * additionally assert on which references were reachable. */
async function assertExportedLinksResolve(root, ...skillDirectories) {
  const checked = [];
  for (const skillDirectory of skillDirectories) {
    const skillFile = path.join(skillDirectory, 'SKILL.md');
    const content = await readFile(skillFile, 'utf8');
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const reference = match[1]?.split(/[?#]/, 1)[0];
      if (!reference || /^[a-z][a-z+.-]*:/i.test(reference) || reference.startsWith('#')) continue;
      const resolved = path.resolve(path.dirname(skillFile), reference);
      await assert.doesNotReject(
        access(resolved),
        `${skillFile} links to ${reference}, which must exist at ${resolved}`,
      );
      checked.push({ skill: skillDirectory, reference });
    }
  }
  return checked;
}

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
    [
      ...ids.map((id) => `skills/latchkit-${id}/SKILL.md`),
      ...referenceFiles.map((name) => `skills/references/${name}`),
    ].sort(),
  );
  assert.equal(pack.version, '1.0.0');
});

test('every bundled skill only depends on shared resources actually present in the pack', async () => {
  const pack = await loadBundledPack();
  const { primarySkills, dependencies } = resolvePackResourceDependencies(pack);
  assert.deepEqual([...primarySkills].sort(), ids.map((id) => `latchkit-${id}`).sort());
  for (const folder of primarySkills) {
    const found = [...(dependencies.get(folder) ?? [])].map((p) => p.split('/').pop()).sort();
    assert.deepEqual(found, [...expectedDependencies[folder]].sort(), folder);
  }
  // `references` itself is a shared-resource collection, never a selectable skill.
  assert.equal(primarySkills.has('references'), false);
});

test('the bundled pack exports the new workflows, their shared resources, and preserves old IDs', async (t) => {
  const root = await tempProject(t, 'latchkit-workflow-export-');
  await initProject(root, { providers: ['codex'], skills: ids });
  const plan = await planSync(root);
  assert.deepEqual(
    createdPaths(plan),
    [
      ...ids.map((id) => `.agents/skills/latchkit-${id}/SKILL.md`),
      ...referenceFiles.map((name) => `.agents/skills/references/${name}`),
    ].sort(),
  );
  await syncProject(root);
  await assertExportedLinksResolve(
    root,
    ...ids.map((id) => path.join(root, '.agents', 'skills', `latchkit-${id}`)),
  );
});

test('an unrelated skill selection installs no shared-resource folder', async (t) => {
  const root = await tempProject(t, 'latchkit-workflow-no-refs-');
  await initProject(root, { providers: ['codex'], skills: ['fix', 'handoff', 'setup'] });
  const plan = await planSync(root);
  assert.deepEqual(createdPaths(plan), [
    '.agents/skills/latchkit-fix/SKILL.md',
    '.agents/skills/latchkit-handoff/SKILL.md',
    '.agents/skills/latchkit-setup/SKILL.md',
  ]);
});

test('two selected skills share one exported copy of a common resource without a collision', async (t) => {
  const root = await tempProject(t, 'latchkit-workflow-dedup-');
  await initProject(root, { providers: ['codex'], skills: ['build', 'requirements'] });
  const plan = await planSync(root);
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(createdPaths(plan), [
    '.agents/skills/latchkit-build/SKILL.md',
    '.agents/skills/latchkit-requirements/SKILL.md',
    '.agents/skills/references/efficiency.md',
    '.agents/skills/references/workflow-evidence.md',
  ]);
});

test('deselecting one skill keeps a resource still needed by another selected skill', async (t) => {
  const root = await tempProject(t, 'latchkit-workflow-partial-');
  await initProject(root, { providers: ['codex'], skills: ['build', 'review'] });
  await syncProject(root);
  const efficiency = path.join(root, '.agents', 'skills', 'references', 'efficiency.md');
  const workflowEvidence = path.join(
    root,
    '.agents',
    'skills',
    'references',
    'workflow-evidence.md',
  );
  await assert.doesNotReject(access(efficiency));
  await assert.doesNotReject(access(workflowEvidence));

  // Deselect `build` (the only selected skill that needed workflow-evidence.md)
  // and keep only `review`, which still needs efficiency.md.
  const config = JSON.parse(await readFile(path.join(root, '.latchkit', 'config.json'), 'utf8'));
  await saveConfig(root, { ...config, skills: ['review'] });
  const plan = await planSync(root);
  assert.deepEqual(
    plan.changes
      .filter((c) => c.action === 'remove')
      .map((c) => c.path)
      .sort(),
    [
      '.agents/skills/latchkit-build/SKILL.md',
      '.agents/skills/references/workflow-evidence.md',
    ].sort(),
  );
  await syncProject(root);
  await assert.doesNotReject(access(efficiency));
  await assert.rejects(access(workflowEvidence));
});

test('removing every selected skill removes its shared resources but preserves unrelated user files', async (t) => {
  const root = await tempProject(t, 'latchkit-workflow-remove-');
  await initProject(root, { providers: ['codex'], skills: ['requirements'] });
  await syncProject(root);
  const referencesDirectory = path.join(root, '.agents', 'skills', 'references');
  await writeFile(path.join(referencesDirectory, 'user-notes.md'), '# Kept\n');
  await removeProjectSkills(root);
  await assert.rejects(access(path.join(referencesDirectory, 'efficiency.md')));
  await assert.rejects(access(path.join(referencesDirectory, 'workflow-evidence.md')));
  await assert.doesNotReject(access(path.join(referencesDirectory, 'user-notes.md')));
  assert.equal(await readFile(path.join(referencesDirectory, 'user-notes.md'), 'utf8'), '# Kept\n');
});

test('an edited shared resource blocks sync as a conflict and keeps the local edit', async (t) => {
  const root = await tempProject(t, 'latchkit-workflow-conflict-resource-');
  await initProject(root, { providers: ['codex'], skills: ['requirements'] });
  await syncProject(root);
  const efficiency = path.join(root, '.agents', 'skills', 'references', 'efficiency.md');
  const edited = '# Locally edited efficiency policy\n';
  await writeFile(efficiency, edited);
  const plan = await planSync(root);
  const conflict = plan.conflicts.find((c) => c.path === '.agents/skills/references/efficiency.md');
  assert.ok(conflict, 'expected a conflict for the edited shared resource');
  assert.match(conflict.reason, /local edits/);
  await assert.rejects(syncProject(root), /Sync blocked/);
  assert.equal(await readFile(efficiency, 'utf8'), edited);
});

test('setup conflicts remain reviewable and preserve existing guidance', async (t) => {
  const root = await tempProject(t, 'latchkit-workflow-conflict-');
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
  const root = await tempProject(t, 'latchkit-workflow-roots-');
  await initProject(root, { providers: ['claude', 'codex'], skills: ['requirements'] });
  const plan = await planSync(root);
  assert.equal(
    plan.ruleWarnings.some((warning) => warning.code === 'CLAUDE_AGENTS_IMPORT'),
    true,
  );
  assert.deepEqual(createdPaths(plan), [
    '.agents/skills/latchkit-requirements/SKILL.md',
    '.agents/skills/references/efficiency.md',
    '.agents/skills/references/workflow-evidence.md',
    '.claude/skills/latchkit-requirements/SKILL.md',
    '.claude/skills/references/efficiency.md',
    '.claude/skills/references/workflow-evidence.md',
  ]);
});

test('a fresh sync resolves every exported reference from a project path with spaces and a non-ASCII character', async (t) => {
  const container = await tempProject(t, 'latchkit-workflow-unicode-');
  const root = path.join(container, 'issue 103 préparation projet');
  await mkdir(root, { recursive: true });
  await initProject(root, { providers: ['claude', 'codex'], skills: ids });
  await syncProject(root);
  const checked = await assertExportedLinksResolve(
    root,
    ...ids.map((id) => path.join(root, '.claude', 'skills', `latchkit-${id}`)),
    ...ids.map((id) => path.join(root, '.agents', 'skills', `latchkit-${id}`)),
  );
  assert.ok(
    checked.length >= referenceFiles.length * 2,
    'expected shared references to resolve on both roots',
  );
});
