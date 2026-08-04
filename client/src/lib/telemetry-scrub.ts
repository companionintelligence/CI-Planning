/**
 * Browser payload scrubber — the twin of server/src/lib/telemetry/scrub.ts.
 *
 * The two files carry the SAME string and value rules so the two halves of the app
 * redact identically; `telemetry-parity.test.ts` in each package runs one shared
 * fixture set through both, so drift fails CI instead of quietly widening what the
 * browser sends. They are duplicated rather than shared because client and server are
 * separate pnpm packages with different bundlers, and the browser needs a handful of
 * extra rules the server doesn't (below). Same arrangement CI-Server uses for its
 * Python twins.
 *
 * BROWSER-SPECIFIC LEAKS — verified against @sentry/browser 10.69.0:
 *
 *   - `request.url` is `getLocationHref()`, i.e. the full URL including query and
 *     hash. On this app that is the task text and the date being viewed.
 *   - `request.headers.Referer` is `document.referrer`, and the default referrer
 *     policy keeps the FULL same-origin previous URL, query string included. It is a
 *     header the sensitive-key list would never match, so it needs URL treatment.
 *   - `breadcrumbsIntegration` is on by default and records far more than navigation:
 *     fetch/xhr crumbs carry `data.url` WITH the query string, and console crumbs
 *     carry `message` plus raw `data.arguments`. Scrubbing only `data.from`/`data.to`
 *     covers navigation and nothing else.
 */

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[_\- ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

// Windows FIRST — longest prefix wins; see the server twin. The macOS rule also
// matches the `/Users/<name>` inside `C:/Users/<name>`, so ordering it first makes
// the forward-slash Windows rule dead code and strands a `C:~` with the drive
// letter still attached.
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
];

// `signature` and `hub[-_]user` cover the rest of CI-Hub's signed identity triple:
// `IDENTITY_KEY_PATTERN` below is end-anchored (which is what keeps `user-agent`),
// so it caught only the bare `x-ci-hub-user` and let `-timestamp` and `-signature`
// through. See the server twin for the full reasoning.
const SECRET_KEY_PATTERN =
  /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_ ]?key|signature|hub[-_]user/i;

/**
 * Keys that identify a PERSON rather than carrying a credential. A bare identity value
 * matches no secret pattern, so the KEY is the only signal there is — see the server
 * twin for the full reasoning and the CI-Hub proxy header this exists for.
 *
 * Anchoring is deliberate: `(?:^|[-_])user$` keeps `user-agent`, which is real
 * diagnostic signal, and opaque row ids (`owner_id`, `user_id`) survive too.
 */
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

/** A key whose value must be redacted wholesale: a credential, or a person's identity. */
function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

const URL_HEADER_PATTERN = /^refer(?:er|rer)$/i;

/** Breadcrumb `data` keys whose value is a URL: fetch/xhr use `url`, navigation `from`/`to`. */
const URL_DATA_KEYS = new Set(['url', 'from', 'to']);

const MAX_STRING_LENGTH = 8000;

export function scrubString(value: string): string {
  let scrubbed = value;

  for (const pattern of HOME_PATH_PATTERNS) scrubbed = scrubbed.replace(pattern, '~');
  for (const pattern of SECRET_PATTERNS) scrubbed = scrubbed.replace(pattern, '[Filtered]');

  if (scrubbed.length > MAX_STRING_LENGTH) return `${scrubbed.slice(0, MAX_STRING_LENGTH)}… [truncated]`;
  return scrubbed;
}

/**
 * Drop a URL's query string and hash, then run the ordinary string rules over what is
 * left. Deliberately a plain split rather than `new URL()`: it leaves the origin and
 * path exactly as written (no percent-encoding, no base-URL guessing for the relative
 * paths the router reports) and cannot throw.
 */
export function scrubUrl(value: string): string {
  return scrubString(value.split(/[?#]/)[0] ?? value);
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';

  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? '[Filtered]' : scrubValue(nested, depth + 1);
    }
    return result;
  }

  return value;
}

export function scrubHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveKey(key)) {
      result[key] = '[Filtered]';
    } else if (typeof value === 'string') {
      result[key] = URL_HEADER_PATTERN.test(key) ? scrubUrl(value) : scrubString(value);
    } else {
      result[key] = String(scrubValue(value));
    }
  }

  return result;
}

export function scrubBreadcrumbData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveKey(key)) {
      result[key] = '[Filtered]';
    } else if (URL_DATA_KEYS.has(key) && typeof value === 'string') {
      result[key] = scrubUrl(value);
    } else {
      result[key] = scrubValue(value);
    }
  }

  return result;
}
