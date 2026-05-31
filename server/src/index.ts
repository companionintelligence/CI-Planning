import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { buildApp } from './app.js';
import { startCronJobs } from './jobs/index.js';

// DB is initialised on import (runs setup + seed).
import './db/index.js';

const app = buildApp();

app.listen(config.port, () => {
  logger.info(`Companion Planning running on http://localhost:${config.port}`);
});

startCronJobs();
