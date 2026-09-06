import { createHash } from 'node:crypto';

import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  ConfigContractError,
  type LatchkitConfig,
} from './contracts.js';

export interface MigrationChange {
  action: 'create' | 'update';
  path: string;
}
export interface ConfigMigration {
  status: 'current' | 'ready' | 'migrated';
  fromVersion: number;
  toVersion: number;
  backupPath: string | null;
  changes: MigrationChange[];
  config: LatchkitConfig;
}
export interface MigrationWriter {
  readBackup(path: string): Promise<string | null>;
  writeBackup(path: string, raw: string): Promise<void>;
  writeConfig(config: LatchkitConfig): Promise<void>;
}

export function normalizeMigrationTarget(value: unknown = CURRENT_CONFIG_SCHEMA_VERSION): number {
  const target = Number(value);
  if (!Number.isInteger(target)) {
    throw new ConfigContractError(
      'Migration target must be an integer.',
      '$.toVersion',
      'CONFIG_MIGRATION_UNSUPPORTED',
    );
  }
  return target;
}

export function backupPathFor(raw: string, fromVersion: number): string {
  const digest = createHash('sha256').update(raw).digest('hex');
  return `.latchkit/backups/config.v${fromVersion}.${digest}.json`;
}

export function buildMigration(
  raw: string,
  config: LatchkitConfig,
  requestedTarget: unknown = CURRENT_CONFIG_SCHEMA_VERSION,
): ConfigMigration {
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
  if (fromVersion === toVersion)
    return { status: 'current', fromVersion, toVersion, backupPath: null, changes: [], config };

  let migrated: LatchkitConfig = config;
  for (let version = fromVersion; version < toVersion; version += 1) {
    if (version === 1) migrated = { ...migrated, schemaVersion: 2, providerSettings: {} };
    else if (version === 2)
      migrated = {
        ...migrated,
        schemaVersion: 3,
        packs: [
          { id: 'latchkit-core', version: '1.0.0', source: { type: 'bundled' }, pinned: true },
        ],
      };
    else
      throw new ConfigContractError(
        `No migration is available from version ${version}.`,
        '$.schemaVersion',
        'CONFIG_MIGRATION_UNSUPPORTED',
      );
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

export async function executeMigration(
  raw: string,
  migration: ConfigMigration,
  { readBackup, writeBackup, writeConfig }: MigrationWriter,
): Promise<ConfigMigration> {
  if (migration.status === 'current') return migration;
  if (!migration.backupPath) throw new ConfigContractError('Migration has no backup path.');
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
