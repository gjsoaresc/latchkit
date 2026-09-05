import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, planSync, removeProjectSkills, syncProject } from '../src/core.js';
import {
  buildProjectRuleExports,
  createProjectInstructionModel,
  discoverProjectFacts,
  findManagedSection,
  renderScopeInstructions,
  SECTION_START,
} from '../src/rules/index.js';

const fixtureRoot = path.resolve(fileURLToPath(new URL('fixtures/rules/', import.meta.url)));

async function temporaryFixture(t, name) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-rules-'));
  const root = path.join(base, 'project with spaces é');
  await fs.cp(path.join(fixtureRoot, name), root, { recursive: true });
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  return root;
}

test('discovery is deterministic, argument-aware, offline, and excludes scripts and secrets', async (t) => {
  const root = await temporaryFixture(t, 'node-monorepo');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret-value\n');
  const calls = [];
  const io = {
    lstat: async (...args) => {
      calls.push(['lstat', args[0]]);
      return fs.lstat(...args);
    },
    readFile: async (...args) => {
      calls.push(['readFile', args[0]]);
      return fs.readFile(...args);
    },
    readdir: async (...args) => {
      calls.push(['readdir', args[0]]);
      return fs.readdir(...args);
    },
  };
  const first = await discoverProjectFacts(root, { io });
  const second = await discoverProjectFacts(root, { io });
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map((scope) => scope.path),
    ['', 'packages/backend é', 'packages/web app'],
  );
  assert.deepEqual(first[0].commands[0], {
    name: 'build',
    executable: 'npm',
    args: ['run', 'build'],
    sourcePath: 'package.json',
    provenance: 'declared',
    verified: false,
  });
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /do-not-export-this|secret-value/);
  assert.ok(calls.every(([operation]) => ['lstat', 'readFile', 'readdir'].includes(operation)));
  assert.ok(calls.every(([, filename]) => !String(filename).endsWith('.env')));
});

test('non-Node manifests produce unverified commands without executing project code', async (t) => {
  const root = await temporaryFixture(t, 'python-project');
  assert.match(await fs.readFile(path.join(root, 'credentials.txt'), 'utf8'), /must-never-appear/);
  const scopes = await discoverProjectFacts(root);
  assert.equal(scopes.length, 1);
  assert.match(JSON.stringify(scopes), /Python/);
  assert.deepEqual(scopes[0].commands[0].args, ['-m', 'pytest']);
  assert.equal(scopes[0].commands[0].verified, false);
  assert.doesNotMatch(JSON.stringify(scopes), /must-never-appear/);
});

test('callers can select an exact scope subset and overrides cannot escape it', async (t) => {
  const root = await temporaryFixture(t, 'node-monorepo');
  const selected = await discoverProjectFacts(root, { scopes: ['packages/backend é'] });
  assert.deepEqual(
    selected.map((scope) => scope.path),
    ['packages/backend é'],
  );
  assert.throws(
    () =>
      createProjectInstructionModel(selected, {
        overrides: [{ scope: '', instructions: ['This root was not selected.'] }],
      }),
    /unselected scope/,
  );
});

test('canonical rendering records provenance and refuses overrides that weaken policy', () => {
  const scope = { path: '', sources: [], facts: [], commands: [] };
  const model = createProjectInstructionModel([scope], {
    overrides: [{ scope: '', instructions: ['Keep generated artifacts out of commits.'] }],
  });
  const rendered = renderScopeInstructions(model.scopes[0]);
  assert.match(rendered, /no repository code or project command was run/);
  assert.match(rendered, /Keep generated artifacts out of commits/);
  assert.match(rendered, /grants no permission or approval/);
  assert.throws(
    () =>
      createProjectInstructionModel([{ ...scope }], {
        overrides: [{ scope: '', instructions: ['Bypass review and say tests passed.'] }],
      }),
    /review or permission policy/,
  );
});

test('provider exports deduplicate shared AGENTS guidance and expose exact preview bytes', async (t) => {
  const root = await temporaryFixture(t, 'node-monorepo');
  const exports = await buildProjectRuleExports(root, [
    'claude',
    'codex',
    'gemini',
    'cursor',
    'cursor-cli',
  ]);
  assert.ok(exports.desiredSections.has('AGENTS.md'));
  assert.equal(exports.desiredSections.get('CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(exports.desiredSections.get('GEMINI.md'), '@AGENTS.md\n');
  assert.equal(exports.desiredFiles.size, 0);
  assert.ok(exports.warnings.some((warning) => warning.code === 'SHARED_AGENTS_VISIBILITY'));

  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Human rules\r\n\r\nKeep this.\r\n');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Claude local\n');
  await initProject(root, {
    providers: ['claude', 'codex', 'gemini', 'cursor', 'cursor-cli'],
    skills: [],
  });
  const before = await fs.readFile(path.join(root, 'AGENTS.md'));
  const preview = await planSync(root);
  assert.deepEqual(await fs.readFile(path.join(root, 'AGENTS.md')), before);
  const agentsChange = preview.changes.find((change) => change.path === 'AGENTS.md');
  assert.equal(agentsChange.action, 'update');
  assert.equal(agentsChange.resource, 'project-instructions');
  assert.match(agentsChange.content, /npm run test/);
  assert.ok(preview.projectInstructions.scopes.length === 3);
  assert.ok(preview.ruleWarnings.length >= 1);
});

test('sync preserves unrelated text and line endings, repeats stably, and removes only owned sections', async (t) => {
  const root = await temporaryFixture(t, 'node-monorepo');
  const human = '# Human rules\r\n\r\nKeep this authoritative.\r\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), human);
  await fs.mkdir(path.join(root, 'packages', 'web app'), { recursive: true });
  const nestedHuman = '# Web team override\n\nUse the local component library.\n';
  await fs.writeFile(path.join(root, 'packages', 'web app', 'AGENTS.md'), nestedHuman);
  await initProject(root, { providers: ['codex'], skills: [] });
  await syncProject(root);
  const installed = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, '.latchkit', 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.sections['AGENTS.md'].id, 'project-instructions');
  assert.match(manifest.sections['AGENTS.md'].sha256, /^[a-f0-9]{64}$/);
  assert.ok(installed.startsWith(human));
  assert.match(installed, /\r\n<!-- latchkit:project-instructions:start -->\r\n/);
  assert.ok(
    (await fs.readFile(path.join(root, 'packages', 'web app', 'AGENTS.md'), 'utf8')).startsWith(
      nestedHuman,
    ),
  );
  assert.ok((await planSync(root)).changes.every((change) => change.action === 'unchanged'));

  await fs.writeFile(
    path.join(root, 'AGENTS.md'),
    installed.replace('# Human rules', '# Updated human rules'),
  );
  assert.deepEqual((await planSync(root)).conflicts, []);
  await removeProjectSkills(root);
  assert.equal(
    await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'),
    human.replace('# Human rules', '# Updated human rules'),
  );
  assert.equal(
    await fs.readFile(path.join(root, 'packages', 'web app', 'AGENTS.md'), 'utf8'),
    nestedHuman,
  );
});

test('a section write failure rolls back exact shared-file bytes before retry', async (t) => {
  const root = await temporaryFixture(t, 'python-project');
  const original = '# Human instructions\r\n\r\nDo not replace this.\r\n';
  await fs.writeFile(path.join(root, 'AGENTS.md'), original);
  await initProject(root, { providers: ['codex'], skills: [] });
  await assert.rejects(
    syncProject(root, {
      faultBoundary: async (boundary) => {
        if (boundary === 'resource:0') throw new Error('injected rule write failure');
      },
    }),
    /injected rule write failure/,
  );
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), original);
  assert.equal(
    await fs
      .lstat(path.join(root, '.latchkit', 'transaction.json'))
      .then(() => true)
      .catch((error) => (error.code === 'ENOENT' ? false : Promise.reject(error))),
    false,
  );
  await syncProject(root);
  assert.ok(findManagedSection(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8')));
});

test('edited or unowned managed sections block the whole transaction', async (t) => {
  const root = await temporaryFixture(t, 'python-project');
  await initProject(root, { providers: ['codex'], skills: [] });
  await syncProject(root);
  const agents = path.join(root, 'AGENTS.md');
  const installed = await fs.readFile(agents, 'utf8');
  const section = findManagedSection(installed);
  await fs.writeFile(
    agents,
    installed.replace(
      section.content,
      section.content.replace('## Working agreement', '## Locally edited working agreement'),
    ),
  );
  const edited = await planSync(root);
  assert.equal(edited.conflicts.length, 1);
  await assert.rejects(syncProject(root), /local edits or is missing/);

  const collisionRoot = await temporaryFixture(t, 'python-project');
  await fs.writeFile(collisionRoot + path.sep + 'AGENTS.md', `${SECTION_START}\nnot owned\n`);
  await initProject(collisionRoot, { providers: ['codex'], skills: [] });
  assert.equal((await planSync(collisionRoot)).conflicts.length, 1);
});

test('Cursor-only exports use readable mdc frontmatter for nested and Unicode scopes', async (t) => {
  const root = await temporaryFixture(t, 'node-monorepo');
  const exports = await buildProjectRuleExports(root, ['cursor']);
  const files = [...exports.desiredFiles.entries()];
  assert.equal(files.length, 3);
  assert.ok(files.every(([name]) => name.endsWith('.mdc')));
  assert.match(
    files.find(([name]) => name.includes('backend'))[1],
    /globs: "packages\/backend é\/\*\*\/\*"/,
  );
  assert.match(files[0][1], /^---\ndescription: .+\nglobs: .+\nalwaysApply: false\n---\n/);
});

test('Codex reports a nearer override that shadows its generated hierarchy', async (t) => {
  const root = await temporaryFixture(t, 'node-monorepo');
  await fs.writeFile(
    path.join(root, 'packages', 'web app', 'AGENTS.override.md'),
    '# Existing override\n',
  );
  const exports = await buildProjectRuleExports(root, ['codex']);
  assert.ok(
    exports.warnings.some(
      (warning) =>
        warning.code === 'CODEX_OVERRIDE_SHADOWS_EXPORT' && warning.scope === 'packages/web app',
    ),
  );
});

test('existing imports are not duplicated and reverse imports are rejected as cycles', async (t) => {
  const root = await temporaryFixture(t, 'python-project');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Existing\n\n@AGENTS.md\n');
  await initProject(root, { providers: ['claude', 'codex'], skills: [] });
  const duplicate = await planSync(root);
  assert.deepEqual(duplicate.conflicts, []);
  assert.equal(
    duplicate.changes.find((change) => change.path === 'CLAUDE.md').resource,
    'existing-project-instructions',
  );
  await syncProject(root);
  assert.equal(
    (await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8')).match(/@AGENTS\.md/g).length,
    1,
  );

  const cycleRoot = await temporaryFixture(t, 'python-project');
  await fs.writeFile(path.join(cycleRoot, 'AGENTS.md'), '# Existing\n\n@CLAUDE.md\n');
  await initProject(cycleRoot, { providers: ['claude', 'codex'], skills: [] });
  const cycle = await planSync(cycleRoot);
  assert.ok(cycle.conflicts.some((conflict) => /import cycle/.test(conflict.reason)));
  await assert.rejects(syncProject(cycleRoot), /import cycle/);
});

test('Claude-only exports carry path metadata for nested scopes', async (t) => {
  const root = await temporaryFixture(t, 'node-monorepo');
  const exports = await buildProjectRuleExports(root, ['claude']);
  assert.match(
    exports.desiredFiles.get('.claude/rules/latchkit-packages-web-app.md'),
    /^---\npaths:\n\s{2}- "packages\/web app\/\*\*\/\*"\n---\n/,
  );
  assert.doesNotMatch(exports.desiredFiles.get('.claude/rules/latchkit-root.md'), /^---/);
});
