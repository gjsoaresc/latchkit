import { randomUUID } from 'node:crypto';

export const DIAGNOSTICS_SCHEMA_VERSION = 1;

const CODE_BY_ERROR = new Map([
  ['CONFIG_INVALID', 'CONFIG_INVALID'],
  ['CONFIG_INVALID_JSON', 'CONFIG_INVALID_JSON'],
  ['CONFIG_UNSUPPORTED_VERSION', 'CONFIG_UNSUPPORTED_VERSION'],
  ['CONFIG_MIGRATION_UNSUPPORTED', 'CONFIG_MIGRATION_UNSUPPORTED'],
  ['RECOVERY_LOCK_BLOCKED', 'RECOVERY_LOCK_BLOCKED'],
]);

export function operationId() {
  return randomUUID();
}

export function operationalError(error, { operation = 'unknown', stage = 'operation', id } = {}) {
  const code =
    CODE_BY_ERROR.get(error?.code) ??
    (error?.conflicts ? 'OPERATION_CONFLICT' : 'OPERATION_FAILED');
  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    operationId: id ?? operationId(),
    operation,
    stage,
    timestamp: new Date().toISOString(),
    code,
    message: error?.message || 'Operation failed.',
    retry:
      code === 'OPERATION_CONFLICT'
        ? 'Review the listed conflicts and retry.'
        : 'Review the diagnostics and retry if appropriate.',
    ...(error?.path ? { path: error.path } : {}),
    ...(error?.conflicts ? { conflictCount: error.conflicts.length } : {}),
  };
}

export function statusForError(error) {
  return error?.status ?? (error?.conflicts ? 409 : 400);
}
