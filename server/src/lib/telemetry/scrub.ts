/**
 * `beforeSend` payload scrubber — the last thing that touches an event before it
 * leaves the process.
 *
 * A planner holds the user's calendar, tasks and reflections, so anything on its way
 * to Sentry is treated as hostile until proven otherwise: credentials are redacted,
 * home directories are collapsed to `~` (they leak the account name), request bodies
 * and cookies are dropped, and oversized strings are truncated so a stray blob can't
 * smuggle plan contents out inside an exception message.
 *
 * This is deliberately a near-copy of CI-Server's
 * `common/telemetry/scrubEvent.ts` (itself ported from CI-Hub's `sentry-scrubber.ts`)
 * so every first-party component redacts identically. lib/logger.ts does the same job
 * for logs; the two rule sets are kept separate because a log line and a Sentry event
 * have different shapes, not because they should disagree.
 */

import type { ErrorEvent } from '@sentry/node';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[_-]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  // Postgres/Redis/AMQP URLs carry credentials in the authority section.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

const HOME_PATH_PATTERNS = [
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
];

const SENSITIVE_KEY_PATTERN =
  /password|secret|token|authorization|cookie|jwt|apikey|api_key|dsn|pepper|private[_-]?key/i;

const MAX_STRING_LENGTH = 8000;

export function scrubString(value: string): string {
  let scrubbed = value;

  for (const pattern of HOME_PATH_PATTERNS) scrubbed = scrubbed.replace(pattern, '~');
  for (const pattern of SECRET_PATTERNS) scrubbed = scrubbed.replace(pattern, '[Filtered]');

  if (scrubbed.length > MAX_STRING_LENGTH) return `${scrubbed.slice(0, MAX_STRING_LENGTH)}… [truncated]`;
  return scrubbed;
}

function scrubValue(value: unknown, depth = 0): unknown {
  // Depth guard, not a cycle tracker: a runaway walk in beforeSend would stall the
  // reporting path on every captured error, and a cyclic payload hits this bound.
  if (depth > 8) return '[Truncated]';

  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[Filtered]' : scrubValue(nested, depth + 1);
    }
    return result;
  }

  return value;
}

/** Matches Sentry's `beforeSend` signature; the unused `hint` argument is simply omitted. */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.message) event.message = scrubString(event.message);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);
  }

  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;

  if (event.request) {
    // Bodies carry task/plan text the user wrote; query strings carry their search
    // terms; headers carry the session cookie and the x-api-key.
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.query_string) event.request.query_string = '[Filtered]';
    if (event.request.headers) {
      event.request.headers = scrubValue(event.request.headers) as Record<string, string>;
    }
  }

  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubString(breadcrumb.message);
    if (breadcrumb.data) breadcrumb.data = scrubValue(breadcrumb.data) as Record<string, unknown>;
  }

  return event;
}
