/**
 * `beforeSend` payload scrubber — the last thing that touches an event before it
 * leaves the process.
 *
 * A planner holds the user's calendar, tasks and reflections, so anything on its way
 * to Sentry is treated as hostile until proven otherwise: credentials are redacted,
 * home directories are collapsed to `~` (they leak the account name), URLs lose their
 * query and hash, request bodies and cookies are dropped, and oversized strings are
 * truncated so a stray blob can't smuggle plan contents out inside an exception
 * message.
 *
 * TWIN FILE: client/src/lib/telemetry-scrub.ts carries the same string/value rules for
 * the browser bundle. The two are duplicated rather than shared because they live in
 * separate pnpm packages with different bundlers; a parity test in each package
 * asserts they still agree on one shared fixture set, so drift fails CI rather than
 * silently widening what we send. Same arrangement CI-Server uses for its Python twins.
 *
 * WHY EACH RULE EXISTS — all verified against @sentry/core 10.69.0, because
 * `sendDefaultPii: false` gates far less than its name suggests
 * (`defaultPiiToCollectionOptions` maps it to a *denylist*, not "off"):
 *
 *   - `request.url` is attached unconditionally. `requestDataIntegration` sets
 *     `include.url = true` with the comment "URL is always included", and
 *     `httpRequestToRequestData` builds it from `req.url`, which on a Node server is
 *     path + query. Filtering `query_string` while leaving `url` alone therefore
 *     redacts nothing — the same bytes ship one field over.
 *   - Request headers are attached with only ["forwarded","-ip","remote-","via","-user"]
 *     denied, so `authorization` and `x-api-key` arrive in cleartext unless filtered
 *     here. Note `x-api-key` does NOT match a bare `apikey|api_key` pattern.
 *   - `stackFrameVariables` stays `true` even with PII off, so `frame.vars` holds
 *     captured locals, and Node's stack parser keeps absolute paths in
 *     `frame.filename` / `frame.abs_path`.
 *   - `server_name` is the machine hostname, set by the client constructor regardless
 *     of PII settings — the same identifying data we collapse `/Users/<name>` to `~`
 *     to avoid. Disabled at init AND deleted here.
 */

import type { ErrorEvent } from '@sentry/node';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[_\- ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  // Postgres/Redis/AMQP URLs carry credentials in the authority section.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

// Windows FIRST — longest prefix wins. The macOS rule also matches the
// `/Users/<name>` inside `C:/Users/<name>`, so with macOS ahead of it the
// forward-slash Windows rule is unreachable dead code and the replacement leaves a
// stranded `C:~/…` with the drive letter still attached. The backslash form is
// order-independent, which is why a suite covering only that form stays green.
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
];

// `api[-_ ]?key` rather than a bare `apikey|api_key`, so the hyphenated `x-api-key`
// header this app actually authenticates with is caught.
//
// `signature` is fleet-mandated (CI-Server's scrubber carries it) and load-bearing
// here: CI-Hub's Traefik forward-auth is configured with
// `authResponseHeaders: X-CI-Hub-User,X-CI-Hub-User-Timestamp,X-CI-Hub-User-Signature`,
// so all three arrive on EVERY request and `@sentry/core` attaches
// `headers: headersToDict(headers)` unfiltered. `IDENTITY_KEY_PATTERN` below is
// end-anchored on purpose — that is what keeps `user-agent` — so it caught only the
// bare `x-ci-hub-user` and let the timestamp and the signature ship in cleartext.
// `hub[-_]user` (unanchored) closes the rest of the triple.
const SECRET_KEY_PATTERN =
  /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_ ]?key|signature|hub[-_]user/i;

/**
 * Keys that identify a PERSON rather than carrying a credential — the same class of
 * data as the hostname we drop from `server_name` and the account name we collapse
 * `/Users/<name>` to `~` for. It just arrives as a key/value pair, so no secret pattern
 * would ever match it.
 *
 * This matters here specifically: the app runs behind the CI-Hub Traefik proxy
 * (`TRUST_PROXY`, `X-Forwarded-*`), and the SDK captures the headers that ARRIVED, not
 * the ones application code reads — so a proxy-injected `x-ci-hub-user` reaches
 * `event.request.headers` even though nothing in this repo looks at it. `x-test-owner`
 * the app does read.
 *
 * Sentry's own denylist covers part of this for headers (`PII_HEADER_SNIPPETS` denies
 * `-user`, `forwarded`, `-ip`, `remote-`, `via`) but NOT for breadcrumb data, and
 * `x-ci-owner` matches none of it. Leaning on that denylist is precisely the mistake
 * this scrubber exists to correct, so we re-cover the ground ourselves.
 *
 * Anchoring is deliberate. `(?:^|[-_])user$` keeps `user-agent`, which is real
 * diagnostic signal; opaque internal row ids (`owner_id`, `user_id`) also survive,
 * being pseudonymous and the thing that makes a multi-tenant bug debuggable.
 */
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

/** A key whose value must be redacted wholesale: a credential, or a person's identity. */
function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

/** Header names whose value is a URL, and therefore carries a query string. */
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
 * left (a path can still hold a home directory, a connection URL still holds
 * credentials). Deliberately a plain split rather than `new URL()`: it leaves the
 * origin and path exactly as written and cannot throw on a relative path.
 */
export function scrubUrl(value: string): string {
  return scrubString(value.split(/[?#]/)[0] ?? value);
}

export function scrubValue(value: unknown, depth = 0): unknown {
  // Depth guard, not a cycle tracker: a runaway walk in beforeSend would stall the
  // reporting path on every captured error, and a cyclic payload hits this bound.
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

/**
 * Headers get key-based filtering plus URL treatment for `Referer`/`Referrer`, whose
 * value is the full previous URL — query string included.
 */
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

/** Breadcrumbs from the http/fetch/console integrations carry URLs and raw arguments. */
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

/** Matches Sentry's `beforeSend` signature; the unused `hint` argument is simply omitted. */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.message) event.message = scrubString(event.message);

  // The machine hostname. `includeServerName: false` at init already stops it being
  // set; deleting it here means a hand-built event, or a future SDK default, can't
  // reinstate it behind our back.
  delete event.server_name;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);

    // Absolute paths (filename/abs_path/module), captured locals (vars — still
    // collected with PII off), and the surrounding source lines.
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = scrubString(frame.filename);
      if (frame.abs_path) frame.abs_path = scrubString(frame.abs_path);
      if (frame.module) frame.module = scrubString(frame.module);
      if (frame.context_line) frame.context_line = scrubString(frame.context_line);
      if (frame.pre_context) frame.pre_context = frame.pre_context.map(scrubString);
      if (frame.post_context) frame.post_context = frame.post_context.map(scrubString);
      if (frame.vars) frame.vars = scrubValue(frame.vars) as Record<string, unknown>;
    }
  }

  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;

  if (event.request) {
    // Bodies carry task/plan text the user wrote; query strings carry their search
    // terms; headers carry the session cookie and the x-api-key.
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.query_string) event.request.query_string = '[Filtered]';
    // Load-bearing: `url` is path+query on Node, so this is where the search terms
    // actually live — filtering `query_string` alone accomplishes nothing.
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    if (event.request.headers) event.request.headers = scrubHeaders(event.request.headers);
  }

  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubString(breadcrumb.message);
    if (breadcrumb.data) breadcrumb.data = scrubBreadcrumbData(breadcrumb.data);
  }

  return event;
}
