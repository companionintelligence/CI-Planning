/**
 * Sentry bootstrap for the server.
 *
 * `initTelemetry()` MUST run before the application modules load — index.ts imports
 * this module (dynamically, so the wrapper's try/catch is already in place) ahead of
 * ./boot.js. Instrumentation applied after the app modules are loaded misses whatever
 * they set up at import time.
 *
 * Reporting is opt-out: with a `SENTRY_DSN` configured this initialises and reports by
 * default. With no `SENTRY_DSN` it initialises nothing and the process makes no
 * outbound connection — an unconfigured build rather than an opted-out one. See
 * ./settings.ts for the two kill switches that beat a configured DSN, and ./scrub.ts
 * for what is stripped from every payload.
 */

import * as Sentry from '@sentry/node';
import { logger } from '../logger.js';
import { scrubEvent } from './scrub.js';
import { resolveTelemetrySettings, type TelemetrySettings } from './settings.js';
import { withTimeout } from './timeout.js';

export { withTimeout } from './timeout.js';

export {
  isLocalOnly,
  isTelemetryOptedOut,
  resolveTelemetrySettings,
  telemetryPermission,
} from './settings.js';
export type { TelemetryDisabledReason, TelemetrySettings } from './settings.js';
export { scrubEvent, scrubString, scrubUrl } from './scrub.js';

/** Sentry project + `component` tag. One project per marketplace app id (`ci-planning`). */
export const COMPONENT = 'ci-planning-server';

let settings: TelemetrySettings | null = null;

/**
 * Resolve the gate and, only if it opens, call `Sentry.init`. Idempotent: a second
 * call returns the settings from the first without re-initialising. Never throws —
 * a reporting problem must never be the reason the app fails to start.
 */
export function initTelemetry(env: NodeJS.ProcessEnv = process.env): TelemetrySettings {
  if (settings) return settings;

  settings = resolveTelemetrySettings(env, COMPONENT);

  if (!settings.enabled || !settings.dsn) {
    // Only worth a line when an operator switch (not the default) is what's holding it
    // off — an install with no DSN is the normal case and needs no explanation.
    if (settings.disabledReason !== 'no-dsn') {
      logger.info(`Error reporting disabled (${settings.disabledReason}) — no events will be sent`);
    }
    return settings;
  }

  try {
    Sentry.init({
      dsn: settings.dsn,
      environment: settings.environment,
      release: settings.release,
      enabled: true,
      // Errors only. Tracing on an app that holds the user's whole calendar would ship
      // request shapes we have no consent to collect; profiling and session replay are
      // not installed at all.
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      // Never attach IPs, cookies or request bodies. Deliberate, and different from
      // CI-Hub's current `sendDefaultPii: true` — tracked as gap #7 in CI-Engineering's
      // architecture/subsystems/security-trust-and-ops.md. We do not repeat it.
      //
      // Note this flag gates less than its name implies: @sentry/core maps it to a
      // DENYLIST (`defaultPiiToCollectionOptions`), so request headers and stack-frame
      // locals still ship. scrub.ts is what actually closes those; see its header.
      sendDefaultPii: false,
      // Otherwise the client constructor stamps every event with os.hostname() —
      // identifying data of exactly the kind we collapse `/Users/<name>` to `~` to
      // avoid. The scrubber deletes the field too, belt and braces.
      includeServerName: false,
      beforeSend: scrubEvent,
      // The SDK's own onUncaughtException / onUnhandledRejection integrations are kept:
      // this app registers no crash handlers of its own, and theirs capture AND flush
      // before the process dies (an async transport loses the report otherwise).
    });

    Sentry.setTag('component', COMPONENT);
    if (settings.deploymentVersion) Sentry.setTag('deployment_version', settings.deploymentVersion);

    logger.info('Error reporting enabled', {
      component: COMPONENT,
      environment: settings.environment,
      release: settings.release,
    });
  } catch (err) {
    logger.warn(`Error reporting failed to initialise — continuing without it: ${(err as Error).message}`);
    settings = { ...settings, enabled: false, disabledReason: 'no-dsn' };
  }

  return settings;
}

/** True when `Sentry.init` actually ran; every capture below is a no-op otherwise. */
export function isTelemetryEnabled(): boolean {
  return settings?.enabled === true;
}

/** The resolved gate, for callers that want the reason as well as the verdict. */
export function telemetrySettings(): TelemetrySettings | null {
  return settings;
}

/** Report an error, with optional context attached as `extra` (scrubbed like everything else). */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!isTelemetryEnabled()) return;

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context ?? {})) {
      if (value !== undefined) scope.setExtra(key, value);
    }
    Sentry.captureException(error);
  });
}

/**
 * Flush buffered events, bounded so a wedged network can't hold shutdown open.
 * Resolves immediately (and never throws) when reporting is disabled.
 *
 * Every `process.exit` on an error or shutdown path must await this first: the Sentry
 * transport is asynchronous, so exiting straight after `captureException` drops the
 * report on the floor. Callers that exit MUST also check `isTelemetryEnabled()` first
 * and exit synchronously when it is false — awaiting even an already-resolved promise
 * defers the exit by a turn, and crash-path timing should not change just because this
 * module exists.
 */
export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  if (!isTelemetryEnabled()) return;

  try {
    await withTimeout(Sentry.close(timeoutMs), timeoutMs);
  } catch {
    // Never let a reporting failure change how the process exits.
  }
}
