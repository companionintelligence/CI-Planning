/**
 * Browser error reporting.
 *
 * Opt-out — on by default once configured — behind TWO gates that both have to open:
 *
 *   1. `VITE_SENTRY_DSN` must have been baked in at BUILD time. Without it nothing
 *      below runs and the SDK is dead-code-eliminated out of the bundle entirely.
 *   2. The server must say reporting is permitted right now
 *      (`GET /api/config/telemetry`). The build-time DSN can't know about
 *      `CI_TELEMETRY=off` or `CI_LOCAL_ONLY=true`, which are runtime env on the
 *      container — and `CI_TELEMETRY` is what the CI-Marketplace "Share crash reports"
 *      toggle sets. Without gate 2 that toggle would apply to the server half only
 *      while the browser kept reporting. We fail CLOSED: if the check fails, errors, or
 *      times out, reporting stays off. "Can't confirm permission" is not permission.
 *
 * Nothing user-identifying is sent — `sendDefaultPii` is off, there is no session
 * replay (it would record the user's own calendar and reflections on screen), and
 * every payload goes through the scrubber in ./telemetry-scrub.ts, the twin of the
 * server's.
 *
 * `@sentry/browser` rather than `@sentry/solid`: the Solid package's value is router
 * tracing instrumentation, and tracing is exactly what we switch off.
 */

import * as Sentry from '@sentry/browser';
import { scrubBreadcrumbData, scrubHeaders, scrubString, scrubUrl, scrubValue } from './telemetry-scrub.js';

let initialized = false;

/** `component` tag inside the shared `ci-planning` Sentry project. */
const COMPONENT = 'ci-planning-client';

/** How long to wait for the server's permission verdict before giving up (and staying off). */
const PERMISSION_TIMEOUT_MS = 3000;

/** Noise that says nothing about a defect: a stale chunk requested after a redeploy. */
const CHUNK_LOAD_PATTERNS = [
  /Loading chunk \S+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

/** Extension/browser noise the app can neither cause nor fix. */
const IGNORED_PATTERNS = [
  /ResizeObserver loop/i,
  /^Non-Error promise rejection captured/i,
  ...CHUNK_LOAD_PATTERNS,
];

function messagesOf(event: Sentry.ErrorEvent): string[] {
  return [event.message, ...(event.exception?.values ?? []).map((value) => value.value)].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

export function shouldDropEvent(event: Sentry.ErrorEvent): boolean {
  return messagesOf(event).some((text) => IGNORED_PATTERNS.some((pattern) => pattern.test(text)));
}

export function scrubBrowserEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (shouldDropEvent(event)) return null;

  if (event.message) event.message = scrubString(event.message);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);

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
    // `url` is the full href (query + hash) and `headers.Referer` is document.referrer,
    // which keeps the full same-origin previous URL. Both carry task text and the date
    // the user is looking at.
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) event.request.headers = scrubHeaders(event.request.headers);
  }

  // Every breadcrumb, not just navigation: fetch/xhr crumbs carry `data.url` with the
  // query string, console crumbs carry the logged message and raw `data.arguments`.
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubString(breadcrumb.message);
    if (breadcrumb.data) breadcrumb.data = scrubBreadcrumbData(breadcrumb.data);
  }

  return event;
}

/**
 * Ask the server whether reporting is permitted for this deployment right now.
 * Fails closed on any error, non-2xx, timeout, or malformed body.
 */
async function reportingPermitted(): Promise<boolean> {
  try {
    const res = await fetch('/api/config/telemetry', {
      // Policy, not user data — no credentials needed, and the endpoint is public.
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(PERMISSION_TIMEOUT_MS),
    });
    if (!res.ok) return false;

    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && (body as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/** True when `Sentry.init` actually ran; `captureException` is a no-op otherwise. */
export function isTelemetryEnabled(): boolean {
  return initialized;
}

/**
 * Call once, before the root render. Async because of the permission check above;
 * callers fire and forget (`void initTelemetry()`) rather than delaying first paint on
 * a network round trip. The trade-off is a short window at startup — from first paint
 * until the verdict lands — in which a thrown error is not reported. Reporting an error
 * we have not been given permission to send would be the worse failure.
 */
export async function initTelemetry(): Promise<void> {
  if (initialized || typeof window === 'undefined') return;

  // MUST stay the first check. With `VITE_SENTRY_DSN` unset Vite inlines `undefined`
  // here, which makes everything below statically unreachable and lets the bundler drop
  // @sentry/browser from the bundle altogether (verified: no DSN ⇒ zero occurrences of
  // "sentry" in the output, and the bundle is the same size as before this feature).
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return;

  if (!(await reportingPermitted())) return;
  // Re-check: two concurrent calls could both have been awaiting the fetch.
  if (initialized) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_CI_PLANNING_ENVIRONMENT?.trim() || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE?.trim() || undefined,
    enabled: true,
    // Errors only — no tracing, no session replay, no PII.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubBrowserEvent,
  });

  initialized = true;
  Sentry.setTag('component', COMPONENT);
}

/** Report an error, with optional context attached as `extra`. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context ?? {})) {
      if (value !== undefined) scope.setExtra(key, value);
    }
    Sentry.captureException(error);
  });
}

export { scrubUrl };
