/**
 * A small, injectable, bounded HTTP request helper shared by release
 * discovery and archive download. Bounds requests along every axis issue
 * #139 calls out: a timeout per attempt, a cap on redirect hops (each
 * re-validated as HTTP(S) so a redirect cannot smuggle a `file:`/other
 * scheme target), and a bounded retry count for transient network failures.
 *
 * `fetchImpl` defaults to the platform global `fetch` but is always
 * injectable so tests point it at an in-process local HTTP fixture server
 * (loopback only) instead of ever reaching the real network.
 */

export type FetchLike = typeof fetch;

export interface BoundedFetchOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRedirects?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  headers?: Record<string, string>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  // Only transport-level failures (network errors, aborts/timeouts) are
  // retried. A non-2xx HTTP response is returned to the caller, which
  // decides what an explicit status code (404, 403, 429, ...) means.
  return error instanceof Error;
}

async function attempt(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  redirectsLeft: number,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (REDIRECT_STATUSES.has(response.status)) {
    if (redirectsLeft <= 0) throw new Error('Too many redirects.');
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect response is missing a Location header.');
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:')
      throw new Error(`Refusing a redirect to an unsupported scheme: ${next.protocol}`);
    return attempt(fetchImpl, next.toString(), headers, redirectsLeft - 1, timeoutMs);
  }
  return response;
}

export async function boundedFetch(
  url: string,
  options: BoundedFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 200;
  const headers = options.headers ?? {};
  let lastError: unknown;
  for (let tried = 0; tried <= maxRetries; tried += 1) {
    try {
      return await attempt(fetchImpl, url, headers, maxRedirects, timeoutMs);
    } catch (error) {
      lastError = error;
      if (tried >= maxRetries || !isRetryable(error)) throw error;
      await delay(retryDelayMs * (tried + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Request failed.');
}
