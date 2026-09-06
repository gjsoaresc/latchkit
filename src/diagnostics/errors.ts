import { randomUUID } from 'node:crypto';
import { errorRecord } from '../types.js';

export const DIAGNOSTICS_SCHEMA_VERSION = 1;

const CODE_BY_ERROR = new Map([
  ['CONFIG_INVALID', 'CONFIG_INVALID'],
  ['CONFIG_INVALID_JSON', 'CONFIG_INVALID_JSON'],
  ['CONFIG_UNSUPPORTED_VERSION', 'CONFIG_UNSUPPORTED_VERSION'],
  ['CONFIG_MIGRATION_UNSUPPORTED', 'CONFIG_MIGRATION_UNSUPPORTED'],
  ['CONFIG_REVISION_CONFLICT', 'CONFIG_REVISION_CONFLICT'],
  ['SYNC_PLAN_STALE', 'SYNC_PLAN_STALE'],
  ['RECOVERY_LOCK_BLOCKED', 'RECOVERY_LOCK_BLOCKED'],
  ['PROJECT_MEMORY_INVALID', 'PROJECT_MEMORY_INVALID'],
  ['PROJECT_MEMORY_NOT_FOUND', 'PROJECT_MEMORY_NOT_FOUND'],
  ['PROJECT_MEMORY_REVISION_CONFLICT', 'PROJECT_MEMORY_REVISION_CONFLICT'],
  ['PROJECT_MEMORY_REDACTED', 'PROJECT_MEMORY_REDACTED'],
  ['TASK_REVISION_CONFLICT', 'TASK_REVISION_CONFLICT'],
  ...[
    'PROJECT_NOT_FOUND',
    'PROJECT_ROOT_INVALID',
    'PROJECT_ROOT_UNAVAILABLE',
    'PROJECT_ID_INVALID',
    'PROJECT_SOURCE_INVALID',
    'PROJECT_DISPLAY_NAME_INVALID',
    'PROJECT_REGISTRY_INVALID',
  ].map((code) => [code, code] as [string, string]),
  ...[
    'MCP_CONFIG_INVALID',
    'MCP_DOWNLOAD_REFUSED',
    'MCP_RUNTIME_DENIED',
    'MCP_TOOL_POLICY_UNSUPPORTED',
    'MCP_JSON_CONFLICT',
    'MCP_STATE_INVALID',
    'MCP_PLAN_REFUSED',
    'MCP_EDIT_CONFLICT',
    'MCP_PROJECT_UNINITIALIZED',
    'MCP_ENVIRONMENT_MISSING',
    'MCP_HEALTH_REFUSED',
    'MCP_HEALTH_INVALID',
  ].map((code) => [code, code] as [string, string]),
]);

export function operationId(): string {
  return randomUUID();
}

export interface OperationalError {
  schemaVersion: number;
  operationId: string;
  operation: string;
  stage: string;
  timestamp: string;
  code: string;
  message: string;
  retry: string;
  path?: string;
  conflictCount?: number;
}

export function operationalError(
  error: unknown,
  {
    operation = 'unknown',
    stage = 'operation',
    id,
  }: { operation?: string; stage?: string; id?: string } = {},
): OperationalError {
  const details = errorRecord(error);
  const code =
    CODE_BY_ERROR.get(typeof details.code === 'string' ? details.code : '') ??
    (details.conflicts ? 'OPERATION_CONFLICT' : 'OPERATION_FAILED');
  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    operationId: id ?? operationId(),
    operation,
    stage,
    timestamp: new Date().toISOString(),
    code,
    message:
      typeof details.message === 'string' && details.message
        ? details.message
        : 'Operation failed.',
    retry:
      code === 'OPERATION_CONFLICT'
        ? 'Review the listed conflicts and retry.'
        : 'Review the diagnostics and retry if appropriate.',
    ...(typeof details.path === 'string' ? { path: details.path } : {}),
    ...(Array.isArray(details.conflicts) ? { conflictCount: details.conflicts.length } : {}),
  };
}

export function statusForError(error: unknown): number {
  const details = errorRecord(error);
  return (
    (typeof details.status === 'number' ? details.status : undefined) ??
    (details.conflicts ||
    /_REVISION_CONFLICT$/.test(typeof details.code === 'string' ? details.code : '') ||
    (typeof details.code === 'string' && ['SYNC_PLAN_STALE'].includes(details.code))
      ? 409
      : 400)
  );
}
