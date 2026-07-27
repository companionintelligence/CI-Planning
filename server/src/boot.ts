// The real startup sequence. Loaded via a dynamic import from index.ts so that a boot
// guard which throws during module evaluation (the config.ts env checks fire at import
// time) is caught there and surfaced as one clean `FATAL: <reason>` line instead of a
// raw uncaught-exception stack trace. See index.ts for the wrapper.
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { buildApp } from './app.js';
import { startCronJobs } from './jobs/index.js';
import { pushEnabled } from './lib/push.js';
import { status as ollamaStatus } from './mcp/ollama.js';

// DB is initialised on import (runs setup + seed).
import './db/index.js';
import { recoverStaleFreezeLocks } from './engine/auto-defense.js';
import { ensureLocalAuthBootstrap } from './lib/auth/localBootstrap.js';

// Local-auth mode (AUTH_MODE=sso + DISABLE_OIDC): seed the default owner or fail
// closed if there's no way to log in. No-op in every other mode. Awaited before we
// listen so a misconfigured local deployment refuses to start (matches config.ts guards).
await ensureLocalAuthBootstrap();

// Heal any auto blocks left `is_locked` by a reflow that was interrupted before its
// unfreeze could run (pre-fix databases). No-op once clean; reflow no longer freezes.
const recovered = recoverStaleFreezeLocks();
if (recovered > 0) logger.info(`Recovered ${recovered} stale auto-block lock(s) from an interrupted reflow`);

const app = await buildApp();

const server = app.listen(config.port, () => {
  logger.info(`Companion Planning running on http://localhost:${config.port}`);
});

// Warm the installed-model cache so the FIRST inference already auto-selects a model that
// is really pulled (lib/models.ts). Deliberately not awaited: Ollama is optional and may
// come up after us — until this resolves, resolution falls back to the configured names,
// and every later status() call refreshes the cache anyway. status() never throws.
void ollamaStatus().then((s) => {
  if (!s.available) {
    logger.info(`Ollama not reachable at ${s.url} — AI features degrade to their deterministic paths.`);
  } else if (!s.ready) {
    logger.warn(
      `Ollama is running but ${s.missingModels.join(', ')} is not installed — ` +
        `AI features stay off. Pull it (\`ollama pull …\`) or pick an installed model in Settings → Models.`,
    );
  } else {
    logger.info(`Ollama ready — small=${s.smallModel} medium=${s.mediumModel} embed=${s.embedModel}`);
  }
});

startCronJobs();

// Phase H: VAPID keys are now auto-provisioned at boot (services/vapid-config.ts), so push
// is normally live out of the box. It only stays dormant in two deliberate cases: a
// half-set env keypair (one of VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY), or a stored private key
// whose sealing KEK was removed/rotated. Surface that so an operator knows it's
// unconfigured, not broken — the vapid-config warning above says which case applies.
if (!pushEnabled()) {
  logger.warn('Web Push disabled — no usable VAPID keypair (in-app reminders still work). See the vapid-config warning above; set both VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or unset both to auto-generate.');
}

// Graceful shutdown: docker stop / Hub restarts send SIGTERM. Exit 0 so the
// container stops cleanly instead of surfacing a pnpm ELIFECYCLE failure.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received — shutting down`);
    server.close(() => process.exit(0));
    // Open SSE streams keep the server alive; don't wait on them forever.
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
