// Thin boot wrapper. The real startup sequence lives in ./boot.ts and is loaded via a
// dynamic import so that a boot guard which throws is caught HERE and surfaced as a
// single, operator-facing `FATAL: <reason>` line + non-zero exit — instead of a raw
// uncaught-exception stack trace buried in `docker logs`. This matters because the
// config.ts env guards (AUTH_MODE=test in prod, missing SESSION_SECRET, etc.) throw at
// MODULE-EVALUATION time, before any code in boot.ts runs; a try/catch inside boot.ts
// could never see them. A dynamic import defers that evaluation to inside this try, so
// every fail-closed guard reads cleanly. Keep this file import-free (no static imports)
// so nothing — and no guard — evaluates before the try/catch is in place.
try {
  await import('./boot.js');
} catch (err) {
  // The guard messages already name the exact env var to set — surface just that line.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nFATAL: ${message}\n\n`);
  process.exit(1);
}
