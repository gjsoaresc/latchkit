const SECRET_KEY =
  /token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|private[-_]?key/i;
const PATH_SECRET =
  /(^|[\\/._-])(\.env(?:\.[^\\/]*)?|credentials?|secrets?|tokens?|private|ssh|\.npmrc|\.netrc)(?=($|[\\/._-]))/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_SECRET = /([?&#](?:token|secret|key|api[_-]?key|password|auth|code)=)[^&#\s]+/gi;
const ASSIGNMENT =
  /((?:token|secret|password|api[_-]?key|authorization|credential|cookie)\s*[:=]\s*)([^,\s;]+)/gi;

export const REDACTED = '[REDACTED]';

export function redactString(value, suppliedSecrets = []) {
  let result = String(value);
  for (const secret of suppliedSecrets.filter(
    (item) => typeof item === 'string' && item.length > 0,
  ))
    result = result.split(secret).join(REDACTED);
  return result
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(URL_SECRET, `$1${REDACTED}`)
    .replace(ASSIGNMENT, `$1${REDACTED}`);
}

export function redactPath(value) {
  return redactString(String(value))
    .split(/[\\/]/)
    .map((part) => (PATH_SECRET.test(part) ? REDACTED : part))
    .join('/');
}

export function redact(value, suppliedSecrets = [], key = '') {
  if (typeof value === 'string')
    return /path|file|output/i.test(key)
      ? redactPath(redactString(value, suppliedSecrets))
      : redactString(value, suppliedSecrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, suppliedSecrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        SECRET_KEY.test(name) ? REDACTED : redact(item, suppliedSecrets, name),
      ]),
    );
  }
  return value;
}

export function redactError(error, suppliedSecrets = []) {
  return redact(
    {
      name: error?.name,
      code: error?.code,
      message: error?.message,
      path: error?.path,
      stack: error?.stack,
    },
    suppliedSecrets,
  );
}
