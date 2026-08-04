// Thin boot wrapper. The real startup sequence lives in ./boot.ts and is loaded via a
// dynamic import so that a boot guard which throws is caught HERE and surfaced as a
// single, operator-facing `FATAL: <reason>` line + non-zero exit — instead of a raw
// uncaught-exception stack trace buried in `docker logs`. This matters because the
// config.ts env guards (AUTH_MODE=test in prod, missing SESSION_SECRET, etc.) throw at
// MODULE-EVALUATION time, before any code in boot.ts runs; a try/catch inside boot.ts
// could never see them. A dynamic import defers that evaluation to inside this try, so
// every fail-closed guard reads cleanly. Keep this file import-free (no static imports)
// so nothing — and no guard — evaluates before the try/catch is in place.

// Sentry error reporting — OPT-OUT: on by default wherever a SENTRY_DSN is configured
// (no SENTRY_DSN ⇒ nothing initialises and the process opens no outbound connection;
// see lib/telemetry/settings.ts for the CI_TELEMETRY / CI_LOCAL_ONLY kill switches that
// turn it off). Loaded first so instrumentation
// is in place before any application module evaluates, and dynamically for the same
// reason boot.ts is: nothing may evaluate outside a try/catch. Its own catch is
// separate and non-fatal — a telemetry problem must never be why the app won't start.
let flushTelemetry = async (): Promise<void> => {};
let captureException = (_err: unknown, _context?: Record<string, unknown>): void => {};
let isTelemetryEnabled = (): boolean => false;
try {
  const telemetry = await import('./lib/telemetry/index.js');
  telemetry.initTelemetry();
  ({ flushTelemetry, captureException, isTelemetryEnabled } = telemetry);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`warning: error reporting failed to load, continuing without it: ${message}\n`);
}

try {
  await import('./boot.js');
} catch (err) {
  // The guard messages already name the exact env var to set — surface just that line.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nFATAL: ${message}\n\n`);

  // With reporting off — the default — exit exactly as this file did before telemetry
  // existed: synchronously, on this turn. Awaiting even an already-resolved promise
  // defers the exit by a turn, and crash timing must not shift just because the module
  // is present. Only the reporting path pays for reporting.
  if (isTelemetryEnabled()) {
    captureException(err, { phase: 'boot' });
    // Sentry's transport is async, so exiting straight after the capture would drop the
    // report. Bounded at 2s and raced against a real timer, so a wedged network turns a
    // failed boot into a slightly slower failed boot rather than a hang.
    await flushTelemetry();
  }

  process.exit(1);
}
