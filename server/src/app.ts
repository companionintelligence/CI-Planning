import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import serve from 'koa-static';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { runWithOwner, SYSTEM_OWNER } from './lib/context.js';
import { mountRoutes } from './routes/index.js';

/** Build the Koa app (routes + middleware) without listening or starting cron. */
export function buildApp(): Koa {
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

  // Resolve the request owner and bind it for the handler chain. Single-owner
  // for now; Phase I swaps SYSTEM_OWNER for a verified-token resolver here.
  app.use((_ctx, next) => runWithOwner(SYSTEM_OWNER, () => next()));

  mountRoutes(app);

  // Serve built client in production; dev uses the Vite proxy.
  if (existsSync(config.staticDir)) {
    app.use(serve(config.staticDir));
    app.use(async (ctx) => {
      if (!ctx.path.startsWith('/api')) {
        ctx.type = 'html';
        ctx.body = readFileSync(`${config.staticDir}/index.html`, 'utf8');
      }
    });
  }

  return app;
}
