import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { buildApp } from './app.js';
import { startCronJobs } from './jobs/index.js';
import { pushEnabled } from './lib/push.js';

// DB is initialised on import (runs setup + seed).
import './db/index.js';
import { recoverStaleFreezeLocks } from './engine/auto-defense.js';

// Heal any auto blocks left `is_locked` by a reflow that was interrupted before its
// unfreeze could run (pre-fix databases). No-op once clean; reflow no longer freezes.
const recovered = recoverStaleFreezeLocks();
if (recovered > 0) logger.info(`Recovered ${recovered} stale auto-block lock(s) from an interrupted reflow`);

const app = buildApp();

const server = app.listen(config.port, () => {
  logger.info(`Companion Planning running on http://localhost:${config.port}`);
});

startCronJobs();

// Phase H: surface that push is dormant so an operator knows it's unconfigured, not broken.
if (!pushEnabled()) {
  logger.warn('Web Push disabled — VAPID keys not set (in-app reminders still work). Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable; see server/.env.example.');
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
