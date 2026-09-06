/**
 * Bounded archive download for a staged update (issue #139 slice 1). Bounds
 * the declared `Content-Length` and the actual bytes received against the
 * same cap (a server cannot bypass the bound by omitting or lying about the
 * header), and never writes past that cap to disk.
 */
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { errorMessage } from '../../types.js';
import { boundedFetch } from './bounded-fetch.js';
import type { FetchLike } from './bounded-fetch.js';

export interface DownloadOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  maxRedirects?: number;
  /** Hard cap on both the declared and the actually received byte count.
   * Defaults to 512 MiB, comfortably above a Latchkit standalone archive. */
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

export async function downloadToFile(
  url: string,
  destination: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const response = await boundedFetch(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    maxRedirects: options.maxRedirects,
    headers: options.headers,
  });
  if (!response.ok) throw new Error(`Download failed with status ${response.status}.`);
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
      throw new Error(
        `Declared download size (${declaredBytes} bytes) exceeds the allowed bound (${maxBytes} bytes).`,
      );
  }
  if (!response.body) throw new Error('Download response had no body.');
  const hash = createHash('sha256');
  let total = 0;
  const handle = await open(destination, 'wx', 0o600);
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Downloaded content exceeded the allowed bound (${maxBytes} bytes).`);
      }
      hash.update(value);
      await handle.write(value);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(destination, { force: true }).catch(() => {});
    throw new Error(`Download failed: ${errorMessage(error)}`, { cause: error });
  }
  await handle.close();
  return { bytes: total, sha256: hash.digest('hex') };
}

const SHA256_LINE = /^([a-f0-9]{64})\b/i;

/** Fetch and parse a small `<asset>.sha256` sidecar file, matching the
 * layout `install.ps1`/`install.sh` already publish and verify. */
export async function fetchChecksumSidecar(
  url: string,
  options: DownloadOptions = {},
): Promise<string> {
  const response = await boundedFetch(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    maxRedirects: options.maxRedirects,
    headers: options.headers,
  });
  if (!response.ok)
    throw new Error(`Checksum sidecar request failed with status ${response.status}.`);
  const text = (await response.text()).trim();
  const match = SHA256_LINE.exec(text);
  if (!match) throw new Error('Checksum sidecar did not contain a recognizable SHA-256 digest.');
  return match[1]!.toLowerCase();
}
