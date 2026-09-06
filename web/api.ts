import type { ApiError } from './types.js';

export type Api = <T = Record<string, unknown>>(
  route: string,
  options?: { method?: string; body?: unknown; revision?: string },
) => Promise<T>;

// Keep the launch token in this module, never in React props, markup, or localStorage.
const sessionKey = `latchkit-session:${location.host}`;
const fragment = location.hash.slice(1);
let token = /^[a-f0-9]{64}$/.test(fragment) ? fragment : '';
try {
  if (token) sessionStorage.setItem(sessionKey, token);
  else token = sessionStorage.getItem(sessionKey) || '';
} catch {
  /* The launch URL still works when browser storage is disabled. */
}
if (/^[a-f0-9]{64}$/.test(fragment)) history.replaceState(null, '', location.pathname);
export const hasSession = () => Boolean(token);

export const api: Api = async <T>(
  route: string,
  { method = 'GET', body, revision }: { method?: string; body?: unknown; revision?: string } = {},
): Promise<T> => {
  let response;
  try {
    response = await fetch(`/api/${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(revision ? { 'If-Match': revision } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(
      'The local server is unavailable. Check the terminal running Latchkit and retry.',
    );
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Expected an API object.');
    data = parsed as Record<string, unknown>;
  } catch {
    throw new Error('The local server returned an unreadable response.');
  }
  if (!response.ok) {
    const message =
      response.status === 401
        ? 'This session key has expired. Reopen the complete URL printed by Latchkit.'
        : typeof data.error === 'string'
          ? data.error
          : `Request failed (${response.status}).`;
    const error: ApiError = new Error(message);
    Object.assign(error, data);
    error.status = response.status;
    if (response.status === 401) {
      token = '';
      try {
        sessionStorage.removeItem(sessionKey);
      } catch {
        /* Storage may be disabled. */
      }
    }
    throw error;
  }
  if (data.apiVersion !== 1)
    throw new Error('This console needs a newer local API. Restart Latchkit.');
  return data as T;
};
