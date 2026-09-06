/** Optional adapter for colbymchenry/codegraph.  It never installs or configures CodeGraph. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readOptional, safePath, writeAtomic } from '../../storage.js';

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
  exclusions: ['.git/**', '.codegraph/**', '.latchkit/**', 'node_modules/**'],
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
const MAX_FILES = 2_000;
const MAX_BYTES = 32 * 1024 * 1024;
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
  let files = 0;
  let bytes = 0;
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
        if (++files > MAX_FILES || (bytes += stat.size) > MAX_BYTES)
          throw new Error('CodeGraph freshness scan exceeds 2,000 files or 32 MiB.');
        rows.push(
          `${rel}:${digest((await readFile(path.join(directory, entry.name))).toString('base64'))}`,
        );
      }
    }
  }
  await walk(root);
  return digest(rows.sort().join('\n'));
}
async function indexState(root: string): Promise<'present' | 'missing' | 'unsafe'> {
  try {
    const stat = await lstat(await safePath(root, '.codegraph/codegraph.db'));
    return stat.isFile() && !stat.isSymbolicLink() ? 'present' : 'unsafe';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}
export async function inspectCodegraph(root: string): Promise<Record<string, unknown>> {
  const project = await realpath(root);
  const settings = await readCodegraphSettings(project);
  const executable = await executableCapability();
  const index = await indexState(project);
  const fingerprint = await sourceFingerprint(project, settings.exclusions);
  const previous =
    index === 'present'
      ? await readOptional(project, '.codegraph/latchkit-source.sha256').catch(() => null)
      : null;
  return {
    contract: CODEGRAPH_CONTRACT,
    project,
    enabled: settings.enabled,
    exclusions: settings.exclusions,
    executable,
    index,
    freshness: index !== 'present' ? index : previous?.trim() === fingerprint ? 'current' : 'stale',
    sourceFingerprint: fingerprint,
    fallback:
      'ordinary bounded source search remains required when CodeGraph is disabled, missing, stale, or fails; graph output is advisory only.',
  };
}
export async function syncCodegraph(root: string): Promise<Record<string, unknown>> {
  const before = await inspectCodegraph(root);
  if (!before.enabled || (before.executable as { status?: string }).status !== 'ready')
    return { ...before, result: 'fallback', reason: 'CodeGraph is not enabled and supported.' };
  if (before.index === 'unsafe')
    return { ...before, result: 'fallback', reason: 'CodeGraph index path is unsafe.' };
  try {
    await run('codegraph', ['sync'], {
      cwd: before.project as string,
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    });
    const after = await inspectCodegraph(root);
    if (after.index !== 'present')
      return {
        ...after,
        result: 'fallback',
        reason: 'CodeGraph sync did not create a safe local index.',
      };
    await writeAtomic(
      after.project as string,
      '.codegraph/latchkit-source.sha256',
      `${after.sourceFingerprint as string}\n`,
    );
    return { ...(await inspectCodegraph(root)), result: 'synced' };
  } catch (error) {
    return {
      ...before,
      result: 'fallback',
      reason: `CodeGraph sync failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
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
    const revalidated = await inspectCodegraph(root);
    if (revalidated.index !== 'present' || revalidated.freshness !== 'current')
      return {
        ...revalidated,
        result: 'fallback',
        reason: 'CodeGraph source or index changed while the query was running.',
      };
    return {
      ...revalidated,
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
