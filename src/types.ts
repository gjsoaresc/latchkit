export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorRecord(error: unknown): UnknownRecord {
  return isRecord(error) ? error : {};
}

export function errorCode(error: unknown): string | undefined {
  const code = errorRecord(error).code;
  return typeof code === 'string' ? code : undefined;
}

export function errorMessage(error: unknown, fallback = 'Operation failed.'): string {
  const message = errorRecord(error).message;
  return typeof message === 'string' && message ? message : fallback;
}
