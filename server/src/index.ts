import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { buildApp } from './app.js';
import { startCronJobs } from './jobs/index.js';

// DB is initialised on import (runs setup + seed).
import './db/index.js';

const app = buildApp();

const server = app.listen(config.port, () => {
  logger.info(`Companion Planning running on http://localhost:${config.port}`);
});

startCronJobs();

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
