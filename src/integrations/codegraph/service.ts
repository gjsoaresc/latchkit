/** Optional adapter for colbymchenry/codegraph.  It never installs or configures CodeGraph. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOptional, writeAtomic } from '../../storage.js';

const run = promisify(execFile);
const CONFIG = '.latchkit/codegraph-v1.json';
const MAX_QUERY = 500;
const MAX_OUTPUT = 256 * 1024;
export const CODEGRAPH_CONTRACT = Object.freeze({
  upstream: 'https://github.com/colbymchenry/codegraph',
  package: '@colbymchenry/codegraph',
  version: '1.6.0',
  license: 'MIT',
  cli: ['status', 'explore', 'sync'],
  documentation: 'https://github.com/colbymchenry/codegraph#cli-reference',
});
export interface CodegraphSettings {
  schemaVersion: 1;
  enabled: boolean;
  exclusions: string[];
}
const defaults = (): CodegraphSettings => ({
  schemaVersion: 1,
  enabled: false,
  exclusions: ['.git/**', '.codegraph/**', 'node_modules/**'],
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function validExclusion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('..') &&
    !/[\\\0\r\n]/.test(value)
  );
}
export async function readCodegraphSettings(root: string): Promise<CodegraphSettings> {
  const raw = await readOptional(root, CONFIG);
  if (raw === null) return defaults();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid CodeGraph settings.');
  const item = value as Partial<CodegraphSettings>;
  if (
    item.schemaVersion !== 1 ||
    typeof item.enabled !== 'boolean' ||
    !Array.isArray(item.exclusions) ||
    !item.exclusions.every(validExclusion)
  )
    throw new Error('Invalid CodeGraph settings.');
  return { schemaVersion: 1, enabled: item.enabled, exclusions: [...item.exclusions] };
}
export async function saveCodegraphSettings(
  root: string,
  settings: CodegraphSettings,
): Promise<CodegraphSettings> {
  if (!settings.exclusions.every(validExclusion)) throw new Error('Invalid CodeGraph exclusions.');
  await writeAtomic(root, CONFIG, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
async function executableCapability(): Promise<{
  status: 'ready' | 'missing' | 'unsupported';
  version?: string;
}> {
  try {
    const { stdout } = await run('codegraph', ['--version'], {
      timeout: 3_000,
      maxBuffer: 4 * 1024,
      windowsHide: true,
    });
    const version = stdout.trim();
    return /^\D*1\.6\.0\b/.test(version)
      ? { status: 'ready', version }
      : { status: 'unsupported', version };
  } catch {
    return { status: 'missing' };
  }
}
async function sourceFingerprint(root: string, exclusions: readonly string[]): Promise<string> {
  const rows: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/');
      if (
        exclusions.some(
          (x) =>
            rel === x.replace('/**', '') || (x.endsWith('/**') && rel.startsWith(x.slice(0, -2))),
        )
      )
        continue;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
      else if (entry.isFile()) {
        const stat = await lstat(path.join(directory, entry.name));
        rows.push(`${rel}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return digest(rows.sort().join('\n'));
}
export async function inspectCodegraph(root: string): Promise<Record<string, unknown>> {
  const project = await realpath(root);
  const settings = await readCodegraphSettings(project);
  const executable = await executableCapability();
  const index = path.join(project, '.codegraph', 'codegraph.db');
  const indexed = await exists(index);
  const fingerprint = await sourceFingerprint(project, settings.exclusions);
  const marker = path.join(project, '.codegraph', 'latchkit-source.sha256');
  const previous = indexed ? await readFile(marker, 'utf8').catch(() => null) : null;
  return {
    contract: CODEGRAPH_CONTRACT,
    project,
    enabled: settings.enabled,
    exclusions: settings.exclusions,
    executable,
    index: indexed ? 'present' : 'missing',
    freshness: !indexed ? 'missing' : previous?.trim() === fingerprint ? 'current' : 'stale',
    sourceFingerprint: fingerprint,
    fallback:
      'ordinary bounded source search remains required when CodeGraph is disabled, missing, stale, or fails; graph output is advisory only.',
  };
}
export async function exploreCodegraph(
  root: string,
  query: string,
): Promise<Record<string, unknown>> {
  if (!query || query.length > MAX_QUERY)
    throw new Error(`--query must be 1-${MAX_QUERY} characters.`);
  const status = await inspectCodegraph(root);
  if (
    !status.enabled ||
    (status.executable as { status?: string }).status !== 'ready' ||
    status.index !== 'present' ||
    status.freshness !== 'current'
  )
    return { ...status, result: 'fallback', reason: 'CodeGraph is not ready.' };
  try {
    const result = await run('codegraph', ['explore', query], {
      cwd: status.project as string,
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    });
    return {
      ...status,
      result: 'graph',
      output: result.stdout.slice(0, MAX_OUTPUT),
      truncated: result.stdout.length > MAX_OUTPUT,
    };
  } catch (error) {
    return {
      ...status,
      result: 'fallback',
      reason: `CodeGraph query failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}
