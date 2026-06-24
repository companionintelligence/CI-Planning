type Level = 'debug' | 'info' | 'warn' | 'error';

const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = levels[(process.env.LOG_LEVEL as Level) ?? 'info'];

// Keys whose VALUES are secrets — masked wholesale wherever they appear in `meta`.
const SECRET_KEY_RE =
  /access_?token|refresh_?token|id_token|client_secret|authorization|password|code_verifier|code|kek|ciphertext|iv|auth_?tag/i;

// URL query params whose values must be scrubbed even inside a string value.
const URL_SECRET_PARAMS = new Set(['token', 'access_token', 'code', 'client_secret']);

const REDACTED = '[REDACTED]';

/** Scrub secret-bearing query params from a URL-shaped string. Non-URLs pass through. */
function scrubUrl(value: string): string {
  // Cheap guard: only attempt URL parsing on strings that look like URLs with a query.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || !value.includes('?')) return value;
  try {
    const url = new URL(value);
    let touched = false;
    for (const key of [...url.searchParams.keys()]) {
      if (URL_SECRET_PARAMS.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED);
        touched = true;
      }
    }
    return touched ? url.toString() : value;
  } catch {
    return value;
  }
}

/**
 * Recursively redact secrets from a log `meta` payload before serialization:
 *  - object keys matching SECRET_KEY_RE → '[REDACTED]' (at any depth),
 *  - string values that are URLs → secret query params scrubbed.
 * Cycle-safe (tracks seen objects) and depth-guarded so a hostile/looping structure
 * can never hang the logger.
 */
export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return scrubUrl(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redact(v, seen, depth + 1);
  }
  return out;
}

function fmt(level: Level, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] ${msg}`;
  return meta !== undefined ? `${base} ${JSON.stringify(redact(meta))}` : base;
}

export const logger = {
  debug: (msg: string, meta?: unknown) => levels.debug >= minLevel && console.debug(fmt('debug', msg, meta)),
  info:  (msg: string, meta?: unknown) => levels.info  >= minLevel && console.info(fmt('info',  msg, meta)),
  warn:  (msg: string, meta?: unknown) => levels.warn  >= minLevel && console.warn(fmt('warn',  msg, meta)),
  error: (msg: string, meta?: unknown) => levels.error >= minLevel && console.error(fmt('error', msg, meta)),
};
