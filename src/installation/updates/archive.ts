/**
 * Bounded archive extraction for a downloaded update (issue #139 slice 1).
 *
 * Latchkit ships no bundled zip/tar reader (the project has zero runtime
 * dependencies), so extraction shells out to the platform tool already
 * proven for this exact job: PowerShell's `Expand-Archive` for the qualified
 * `win32-x64` `.zip` target (the same mechanism `install.ps1` and
 * `scripts/bundle-smoke.js` already use), and `tar` for the deferred
 * experimental `.tar.gz` targets. No administrator rights, WSL, or Bash are
 * required on Windows. The extraction itself is bounded by a timeout; the
 * *result* is bounded by walking the extracted tree afterward and rejecting
 * (and removing) it if it exceeds the configured total-bytes or file-count
 * cap — there is no pre-extraction streaming cap without a hand-rolled
 * archive reader, so a hostile archive still touches disk under `destination`
 * before being rejected. `destination` must always be a caller-owned,
 * already-isolated scratch directory for exactly this reason.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ExtractOptions {
  timeoutMs?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;

async function extractZipOnWindows(
  archive: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  // A script file (rather than an inline -Command string) survives paths
  // with spaces and Unicode without shell-quoting concerns, matching the
  // technique already proven in scripts/bundle-smoke.js.
  const script = path.join(destination, '..', `extract-${path.basename(destination)}.ps1`);
  await writeFile(
    script,
    'param($Archive,$Destination)\n$ErrorActionPreference="Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\n',
  );
  try {
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', script, archive, destination],
      { windowsHide: true, timeout: timeoutMs },
    );
  } finally {
    await rm(script, { force: true }).catch(() => {});
  }
}

async function extractTarball(
  archive: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  await run('tar', ['-xzf', archive, '-C', destination], { timeout: timeoutMs });
}

async function measureDirectory(
  directory: string,
): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0;
  let fileCount = 0;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Extracted archive contains a symlink: ${full}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += (await stat(full)).size;
      }
    }
  }
  await walk(directory);
  return { totalBytes, fileCount };
}

/** Extract `archive` (a `.zip` on Windows, a `.tar.gz` elsewhere) into
 * `destination`, which must already exist and be owned exclusively by the
 * caller. Throws (and removes everything under `destination`) if the
 * extracted content exceeds the configured bounds. */
export async function extractArchive(
  archive: string,
  destination: string,
  options: ExtractOptions = {},
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (process.platform === 'win32') await extractZipOnWindows(archive, destination, timeoutMs);
  else await extractTarball(archive, destination, timeoutMs);
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  let measured: { totalBytes: number; fileCount: number };
  try {
    measured = await measureDirectory(destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  if (measured.totalBytes > maxTotalBytes || measured.fileCount > maxFiles) {
    await rm(destination, { recursive: true, force: true });
    throw new Error(
      `Extracted archive exceeded the allowed bound (${measured.totalBytes} bytes across ${measured.fileCount} files).`,
    );
  }
}
