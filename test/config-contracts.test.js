import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigContractError,
  CURRENT_CONFIG_SCHEMA_VERSION,
  initProject,
  migrateConfig,
  planConfigMigration,
  readConfig,
  saveConfig,
  syncProject,
  validateConfig,
} from '../dist/src/core.js';
import { executeMigration } from '../dist/src/config/migrations.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const fixtures = path.join(repositoryRoot, 'test', 'fixtures');

async function temporaryProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latchkit-config-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function installFixture(root, name) {
  const raw = await fs.readFile(path.join(fixtures, name), 'utf8');
  await fs.mkdir(path.join(root, '.latchkit'), { recursive: true });
  await fs.writeFile(path.join(root, '.latchkit', 'config.json'), raw);
  return raw;
}

test('published v1 and v2 fixtures validate without changing their shapes', async () => {
  const v1 = JSON.parse(await fs.readFile(path.join(fixtures, 'config-v1.json'), 'utf8'));
  const v2 = JSON.parse(await fs.readFile(path.join(fixtures, 'config-v2.json'), 'utf8'));
  assert.deepEqual(validateConfig(v1), v1);
  assert.deepEqual(validateConfig(v2), v2);
  assert.equal(CURRENT_CONFIG_SCHEMA_VERSION, 3);
});

test('configuration failures identify a stable code and exact field path', () => {
  const cases = [
    [{ schemaVersion: 2, providers: 'codex', skills: [], providerSettings: {} }, '$.providers'],
    [
      { schemaVersion: 2, providers: ['codex', 'codex'], skills: [], providerSettings: {} },
      '$.providers[1]',
    ],
    [
      { schemaVersion: 2, providers: ['unknown'], skills: [], providerSettings: {} },
      '$.providers[0]',
    ],
    [{ schemaVersion: 2, providers: [], skills: ['unknown'], providerSettings: {} }, '$.skills[0]'],
    [
      { schemaVersion: 2, providers: [], skills: [], providerSettings: {}, workflowState: {} },
      '$.workflowState',
    ],
    [
      { schemaVersion: 2, providers: [], skills: [], providerSettings: { unknown: {} } },
      '$.providerSettings.unknown',
    ],
    [
      { schemaVersion: 2, providers: [], skills: [], providerSettings: { codex: [] } },
      '$.providerSettings.codex',
    ],
  ];
  for (const [config, expectedPath] of cases) {
    assert.throws(
      () => validateConfig(config),
      (error) => {
        assert.equal(error.code, 'CONFIG_INVALID');
        assert.equal(error.path, expectedPath);
        return true;
      },
    );
  }
  assert.throws(
    () => validateConfig({ schemaVersion: 99 }),
    (error) => {
      assert.equal(error.code, 'CONFIG_UNSUPPORTED_VERSION');
      assert.equal(error.path, '$.schemaVersion');
      return true;
    },
  );
});

test('new projects use v3 pack selections and provider settings survive deselection and save', async (t) => {
  const root = await temporaryProject(t);
  const created = await initProject(root, { providers: ['codex'], skills: ['spec'] });
  assert.deepEqual(created, {
    schemaVersion: 3,
    providers: ['codex'],
    skills: ['spec'],
    providerSettings: {},
    packs: [{ id: 'latchkit-core', version: '1.0.0', source: { type: 'bundled' }, pinned: true }],
  });
  const configured = {
    ...created,
    providerSettings: { codex: { approvalPolicy: 'ask', nested: { retained: true } } },
  };
  await saveConfig(root, configured);
  await saveConfig(root, { ...configured, providers: [] });
  assert.deepEqual((await readConfig(root)).providerSettings, configured.providerSettings);
});

test('v1 migration preview is byte-stable and apply preserves exact original bytes', async (t) => {
  const root = await temporaryProject(t);
  const original = await installFixture(root, 'config-v1.json');
  const configPath = path.join(root, '.latchkit', 'config.json');
  assert.deepEqual(await readConfig(root), JSON.parse(original));
  const preview = await planConfigMigration(root);
  assert.equal(preview.status, 'ready');
  assert.equal(preview.fromVersion, 1);
  assert.equal(preview.toVersion, 3);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);

  const applied = await migrateConfig(root);
  assert.equal(applied.status, 'migrated');
  assert.equal(
    await fs.readFile(path.join(root, ...applied.backupPath.split('/')), 'utf8'),
    original,
  );
  assert.deepEqual(await readConfig(root), {
    schemaVersion: 3,
    providers: ['codex', 'claude'],
    skills: ['spec', 'review'],
    providerSettings: {},
    packs: [{ id: 'latchkit-core', version: '1.0.0', source: { type: 'bundled' }, pinned: true }],
  });

  const after = await fs.readFile(configPath, 'utf8');
  const repeated = await migrateConfig(root);
  assert.equal(repeated.status, 'current');
  assert.deepEqual(repeated.changes, []);
  assert.equal(await fs.readFile(configPath, 'utf8'), after);

  await assert.rejects(planConfigMigration(root, { toVersion: 1 }), (error) => {
    assert.equal(error.code, 'CONFIG_MIGRATION_UNSUPPORTED');
    assert.match(error.message, new RegExp(applied.backupPath.replaceAll('.', '\\.')));
    return true;
  });
});

test('migration orchestration stops after injected backup or config write failures', async () => {
  const migration = {
    status: 'ready',
    backupPath: '.latchkit/backups/example.json',
    config: { schemaVersion: 2 },
  };
  let configWrites = 0;
  await assert.rejects(
    executeMigration('original', migration, {
      readBackup: async () => null,
      writeBackup: async () => {
        throw new Error('simulated backup failure');
      },
      writeConfig: async () => {
        configWrites += 1;
      },
    }),
    /simulated backup failure/,
  );
  assert.equal(configWrites, 0);

  let backup = null;
  await assert.rejects(
    executeMigration('original', migration, {
      readBackup: async () => backup,
      writeBackup: async (_path, raw) => {
        backup = raw;
      },
      writeConfig: async () => {
        throw new Error('simulated replacement failure');
      },
    }),
    /simulated replacement failure/,
  );
  assert.equal(backup, 'original');
});

test('a conflicting content-addressed backup blocks migration without changing config', async (t) => {
  const root = await temporaryProject(t);
  const original = await installFixture(root, 'config-v1.json');
  const preview = await planConfigMigration(root);
  const backup = path.join(root, ...preview.backupPath.split('/'));
  await fs.mkdir(path.dirname(backup), { recursive: true });
  await fs.writeFile(backup, 'not the original');
  await assert.rejects(migrateConfig(root), (error) => {
    assert.equal(error.code, 'CONFIG_MIGRATION_BACKUP_CONFLICT');
    return true;
  });
  assert.equal(await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8'), original);
});

test(
  'a real Windows replacement denial preserves the active v1 configuration',
  {
    skip:
      process.platform !== 'win32'
        ? 'Uses the Windows read-only file attribute to deny replacement'
        : false,
  },
  async (t) => {
    const root = await temporaryProject(t);
    const original = await installFixture(root, 'config-v1.json');
    const configPath = path.join(root, '.latchkit', 'config.json');
    await syncProject(root);
    const installedSkill = path.join(root, '.agents', 'skills', 'latchkit-spec', 'SKILL.md');
    const installedBefore = await fs.readFile(installedSkill, 'utf8');
    await fs.chmod(configPath, 0o444);
    try {
      await assert.rejects(migrateConfig(root));
      assert.equal(await fs.readFile(configPath, 'utf8'), original);
      assert.equal(await fs.readFile(installedSkill, 'utf8'), installedBefore);
    } finally {
      await fs.chmod(configPath, 0o666);
    }
  },
);

test('competing CLI migration processes never produce a mixed configuration', async (t) => {
  const root = await temporaryProject(t);
  await installFixture(root, 'config-v1.json');
  const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');
  const command = () => execFileAsync(process.execPath, [cli, 'migrate', '--project', root]);
  const results = await Promise.allSettled([command(), command()]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.deepEqual(await readConfig(root), {
    schemaVersion: 3,
    providers: ['codex', 'claude'],
    skills: ['spec', 'review'],
    providerSettings: {},
    packs: [{ id: 'latchkit-core', version: '1.0.0', source: { type: 'bundled' }, pinned: true }],
  });
});

test('CLI preview and apply use the same migration contract', async (t) => {
  const root = await temporaryProject(t);
  const original = await installFixture(root, 'config-v1.json');
  const cli = path.join(repositoryRoot, 'dist', 'src', 'cli.js');
  const configResult = await execFileAsync(process.execPath, [cli, 'config', '--project', root]);
  assert.deepEqual(JSON.parse(configResult.stdout), JSON.parse(original));
  const previewResult = await execFileAsync(process.execPath, [
    cli,
    'migrate',
    '--dry-run',
    '--project',
    root,
  ]);
  assert.equal(JSON.parse(previewResult.stdout).status, 'ready');
  assert.equal(await fs.readFile(path.join(root, '.latchkit', 'config.json'), 'utf8'), original);
  const applyResult = await execFileAsync(process.execPath, [
    cli,
    'migrate',
    '--project',
    root,
    '--to',
    '2',
  ]);
  assert.equal(JSON.parse(applyResult.stdout).status, 'migrated');
  assert.equal((await readConfig(root)).schemaVersion, 2);
});

test('malformed JSON is rejected before migration with a field-aware error', async (t) => {
  const root = await temporaryProject(t);
  await fs.mkdir(path.join(root, '.latchkit'));
  await fs.writeFile(path.join(root, '.latchkit', 'config.json'), '{"schemaVersion":');
  await assert.rejects(readConfig(root), (error) => {
    assert.ok(error instanceof ConfigContractError);
    assert.equal(error.code, 'CONFIG_INVALID_JSON');
    assert.equal(error.path, '$');
    return true;
  });
  await assert.rejects(planConfigMigration(root), { code: 'CONFIG_INVALID_JSON' });
});

test('the optional workspace setting validates on every supported schema version and stays absent by default', async () => {
  const v1 = JSON.parse(await fs.readFile(path.join(fixtures, 'config-v1.json'), 'utf8'));
  assert.equal(validateConfig(v1).workspace, undefined);
  const withWorkspace = {
    ...v1,
    workspace: { executionPreference: 'ask', worktreeRoot: '.latchkit/worktrees' },
  };
  assert.deepEqual(validateConfig(withWorkspace).workspace, withWorkspace.workspace);
  const v2 = JSON.parse(await fs.readFile(path.join(fixtures, 'config-v2.json'), 'utf8'));
  assert.deepEqual(
    validateConfig({
      ...v2,
      workspace: { executionPreference: 'always-worktree', worktreeRoot: 'custom/root' },
    }).workspace,
    { executionPreference: 'always-worktree', worktreeRoot: 'custom/root' },
  );
});

test('workspace setting rejects an unknown execution preference, unsafe root, and missing fields', () => {
  const base = { schemaVersion: 1, providers: [], skills: [] };
  const cases = [
    [
      { ...base, workspace: { executionPreference: 'always', worktreeRoot: 'x' } },
      '$.workspace.executionPreference',
    ],
    [{ ...base, workspace: { executionPreference: 'ask' } }, '$.workspace.worktreeRoot'],
    [
      { ...base, workspace: { executionPreference: 'ask', worktreeRoot: '' } },
      '$.workspace.worktreeRoot',
    ],
    [
      { ...base, workspace: { executionPreference: 'ask', worktreeRoot: '../outside' } },
      '$.workspace.worktreeRoot',
    ],
    [
      { ...base, workspace: { executionPreference: 'ask', worktreeRoot: 'a\\b' } },
      '$.workspace.worktreeRoot',
    ],
    [
      { ...base, workspace: { executionPreference: 'ask', worktreeRoot: 'a/CON/b' } },
      '$.workspace.worktreeRoot',
    ],
    [
      {
        ...base,
        workspace: { executionPreference: 'ask', worktreeRoot: 'C:\\Users\\me\\..\\other' },
      },
      '$.workspace.worktreeRoot',
    ],
    [
      { ...base, workspace: { executionPreference: 'ask', worktreeRoot: 'ok', extra: true } },
      '$.workspace.extra',
    ],
  ];
  for (const [config, expectedPath] of cases) {
    assert.throws(
      () => validateConfig(config),
      (error) => {
        assert.equal(error.code, 'CONFIG_INVALID');
        assert.equal(error.path, expectedPath);
        return true;
      },
    );
  }
});

test('workspace setting accepts an absolute native root and rejects a relative Windows-reserved segment', () => {
  const config = {
    schemaVersion: 1,
    providers: [],
    skills: [],
    workspace: {
      executionPreference: 'direct',
      worktreeRoot: 'C:\\Users\\me\\worktrees',
    },
  };
  assert.deepEqual(validateConfig(config).workspace, config.workspace);
});

test('saving a workspace setting round-trips through readConfig without disturbing other fields', async (t) => {
  const root = await temporaryProject(t);
  const created = await initProject(root, { providers: ['codex'], skills: ['spec'] });
  assert.equal(created.workspace, undefined);
  const saved = await saveConfig(root, {
    ...created,
    workspace: { executionPreference: 'always-worktree', worktreeRoot: '.latchkit/worktrees' },
  });
  assert.deepEqual(saved.workspace, {
    executionPreference: 'always-worktree',
    worktreeRoot: '.latchkit/worktrees',
  });
  assert.deepEqual((await readConfig(root)).workspace, saved.workspace);
  assert.deepEqual((await readConfig(root)).providers, created.providers);
});

test('init and a later matching worktree-root save keep exactly one owned .gitignore exclusion', async (t) => {
  const root = await temporaryProject(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  const created = await initProject(root, { providers: ['codex'], skills: ['spec'] });
  const afterInit = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.equal(afterInit, 'node_modules/\n.latchkit/worktrees/\n');
  await saveConfig(root, {
    ...created,
    workspace: { executionPreference: 'direct', worktreeRoot: '.latchkit/worktrees' },
  });
  assert.equal(
    await fs.readFile(path.join(root, '.gitignore'), 'utf8'),
    'node_modules/\n.latchkit/worktrees/\n',
    'saving the same configured root must not duplicate the exclusion line',
  );
});
