import { createHash } from 'node:crypto';
import { CURRENT_CONFIG_SCHEMA_VERSION, ConfigContractError } from './contracts.js';

export function normalizeMigrationTarget(value = CURRENT_CONFIG_SCHEMA_VERSION) {
  const target = Number(value);
  if (!Number.isInteger(target)) {
    throw new ConfigContractError('Migration target must be an integer.', '$.toVersion', 'CONFIG_MIGRATION_UNSUPPORTED');
  }
  return target;
}

export function backupPathFor(raw, fromVersion) {
  const digest = createHash('sha256').update(raw).digest('hex');
  return `.latchkit/backups/config.v${fromVersion}.${digest}.json`;
}

export function buildMigration(raw, config, requestedTarget = CURRENT_CONFIG_SCHEMA_VERSION) {
  const toVersion = normalizeMigrationTarget(requestedTarget);
  const fromVersion = config.schemaVersion;
  if (toVersion < fromVersion) {
    throw new ConfigContractError(
      `Downgrade from version ${fromVersion} to ${toVersion} is not supported. Restore a reviewed original from .latchkit/backups/ manually.`,
      '$.toVersion',
      'CONFIG_MIGRATION_UNSUPPORTED',
    );
  }
  if (toVersion > CURRENT_CONFIG_SCHEMA_VERSION || toVersion < 1) {
    throw new ConfigContractError(
      `Migration target ${toVersion} is unsupported; the current version is ${CURRENT_CONFIG_SCHEMA_VERSION}.`,
      '$.toVersion',
      'CONFIG_MIGRATION_UNSUPPORTED',
    );
  }
  if (fromVersion === toVersion) {
    return { status: 'current', fromVersion, toVersion, backupPath: null, changes: [], config };
  }

  let migrated = config;
  for (let version = fromVersion; version < toVersion; version += 1) {
    if (version === 1) migrated = { ...migrated, schemaVersion: 2, providerSettings: {} };
    else throw new ConfigContractError(`No migration is available from version ${version}.`, '$.schemaVersion', 'CONFIG_MIGRATION_UNSUPPORTED');
  }
  const backupPath = backupPathFor(raw, fromVersion);
  return {
    status: 'ready',
    fromVersion,
    toVersion,
    backupPath,
    changes: [
      { action: 'create', path: backupPath },
      { action: 'update', path: '.latchkit/config.json' },
    ],
    config: migrated,
  };
}

export async function executeMigration(raw, migration, { readBackup, writeBackup, writeConfig }) {
  if (migration.status === 'current') return migration;
  const existingBackup = await readBackup(migration.backupPath);
  if (existingBackup !== null && existingBackup !== raw) {
    throw new ConfigContractError(
      `Backup already exists with different contents: ${migration.backupPath}.`,
      '$.backupPath',
      'CONFIG_MIGRATION_BACKUP_CONFLICT',
    );
  }
  if (existingBackup === null) await writeBackup(migration.backupPath, raw);
  await writeConfig(migration.config);
  return { ...migration, status: 'migrated' };
}
