/**
 * Browser error reporting.
 *
 * Opt-in and off by default: without `VITE_SENTRY_DSN` baked in at BUILD time nothing
 * initialises and the bundle never talks to Sentry. `initTelemetry` is safe to call
 * more than once and safe to call when reporting is disabled, so callers don't have to
 * guard it.
 *
 * Nothing user-identifying is sent — `sendDefaultPii` is off, there is no session
 * replay (it would record the user's own calendar and reflections on screen), and
 * `beforeSend` strips the query string AND the hash from every reported URL: on this
 * app those carry task text, search terms and the date the user is looking at.
 *
 * `@sentry/browser` rather than `@sentry/solid`: the Solid package's value is router
 * tracing instrumentation, and tracing is exactly what we switch off. The plain browser
 * SDK is the smaller, stabler dependency for an errors-only posture.
 *
 * The server half lives in server/src/lib/telemetry/ and follows the same contract.
 */

import * as Sentry from '@sentry/browser';

let initialized = false;

/** `component` tag inside the shared `ci-planning` Sentry project. */
const COMPONENT = 'ci-planning-client';

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

/**
 * Strip query and hash. Deliberately a plain split rather than `new URL()`: it leaves
 * the origin and path exactly as written (no percent-encoding, no base-URL guessing for
 * the relative paths the router reports) and cannot throw.
 */
export function scrubUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

export function scrubBrowserEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (shouldDropEvent(event)) return null;

  if (event.request?.url) event.request.url = scrubUrl(event.request.url);
  delete event.request?.cookies;
  delete event.request?.query_string;

  for (const breadcrumb of event.breadcrumbs ?? []) {
    const from = breadcrumb.data?.from;
    const to = breadcrumb.data?.to;
    if (typeof from === 'string') breadcrumb.data!.from = scrubUrl(from);
    if (typeof to === 'string') breadcrumb.data!.to = scrubUrl(to);
  }

  return event;
}

/** True when `Sentry.init` actually ran; `captureException` is a no-op otherwise. */
export function isTelemetryEnabled(): boolean {
  return initialized;
}

/** Call once, before the root render, so a throw during mount is still reported. */
export function initTelemetry(): void {
  if (initialized || typeof window === 'undefined') return;

  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return;

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
