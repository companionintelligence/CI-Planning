import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import serve from 'koa-static';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { mountRoutes } from './routes/index.js';
import { startCronJobs } from './jobs/index.js';

// DB is initialised on import (runs setup + seed)
import './db/index.js';

const app = new Koa();

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err: any) {
    ctx.status = err.status ?? 500;
    ctx.body = { error: err.message ?? 'internal server error' };
    logger.error('request error', { method: ctx.method, path: ctx.path, status: ctx.status, err: err.message });
  }
});

app.use(cors({ origin: '*' }));
app.use(bodyParser());

mountRoutes(app);

// Serve built client in production; dev uses Vite proxy
if (existsSync(config.staticDir)) {
  app.use(serve(config.staticDir));
  app.use(async (ctx) => {
    // SPA fallback
    if (!ctx.path.startsWith('/api')) {
      ctx.type = 'html';
      ctx.body = readFileSync(`${config.staticDir}/index.html`, 'utf8');
    }
  });
}

app.listen(config.port, () => {
  logger.info(`Companion Planning running on http://localhost:${config.port}`);
});

startCronJobs();
