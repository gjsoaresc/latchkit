import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readOptional, writeAtomic } from '../storage.js';
import { redact } from './redact.js';
import { errorCode } from '../types.js';

export const LOG_RELATIVE_PATH = '.latchkit/diagnostics/events.ndjson';
export const MAX_LOG_BYTES = 256 * 1024;
export const MAX_LOG_EVENTS = 500;

export async function appendEvent(
  root: string,
  event: unknown,
  { secrets = [] }: { secrets?: readonly unknown[] } = {},
): Promise<unknown> {
  const clean = redact(event, secrets);
  const line = `${JSON.stringify(clean)}\n`;
  const existing = (await readOptional(root, LOG_RELATIVE_PATH)) ?? '';
  const lines = `${existing}${line}`.split('\n').filter(Boolean).slice(-MAX_LOG_EVENTS);
  let contents = `${lines.join('\n')}\n`;
  while (Buffer.byteLength(contents) > MAX_LOG_BYTES && lines.length > 1) {
    lines.shift();
    contents = `${lines.join('\n')}\n`;
  }
  await writeAtomic(root, LOG_RELATIVE_PATH, contents, 0o600);
  return clean;
}

export async function readEvents(root: string): Promise<unknown[]> {
  const raw = (await readOptional(root, LOG_RELATIVE_PATH)) ?? '';
  return raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export async function clearDiagnostics(root: string): Promise<{ cleared: true }> {
  const target = path.join(root, LOG_RELATIVE_PATH);
  try {
    await unlink(target);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return { cleared: true };
}

export async function ensureDiagnostics(root: string): Promise<void> {
  await mkdir(path.join(root, '.latchkit', 'diagnostics'), { recursive: true });
}
