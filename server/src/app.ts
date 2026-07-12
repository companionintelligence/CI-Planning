import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import serve from 'koa-static';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { requireAuth } from './lib/auth/requireAuth.js';
import { mountRoutes } from './routes/index.js';
import { mountGraphql } from './graphql/index.js';
import { hydrateGoogleConfig } from './services/google-config.js';

/** Build the Koa app (routes + middleware) without listening or starting cron.
 * Async because the GraphQL (Apollo) server must `start()` before it can be mounted. */
export async function buildApp(): Promise<Koa> {
  const app = new Koa();

  // Apply the operator-saved in-app Google client (app_config) to the config
  // singleton. Runs after migrations (the db module migrated on import above) and is
  // a no-op when GOOGLE_MODE is env-pinned.
  hydrateGoogleConfig();

  // Behind a trusted TLS-terminating proxy (CI-Hub tunnel): honor X-Forwarded-Proto
  // (⇒ ctx.protocol='https' ⇒ Secure session cookie) and X-Forwarded-For (⇒ ctx.ip is
  // the real client, for per-IP login rate-limiting). Off by default (don't trust
  // spoofable headers when directly reachable).
  if (config.trustProxy) app.proxy = true;

  // Sign the local-login session cookie (U2). config.ts fails boot when
  // DISABLE_OIDC=true without SESSION_SECRET, so local mode always has keys here;
  // harmless (unset) in every other mode, which never sets a signed cookie.
  if (config.auth.sessionSecret) app.keys = [config.auth.sessionSecret];

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
  app.use(bodyParser({ jsonLimit: '20mb' }));

  // Authenticate the request and bind its owner for the handler chain (Phase I).
  // Accepts a hashed x-api-key (standalone) or, in test/dev mode, a fixed owner;
  // 401s otherwise. Every /api/* route + the SSE stream sits behind it.
  app.use(requireAuth());

  mountRoutes(app);

  // Phase W: GraphQL at /api/graphql, mounted AFTER requireAuth so it's auth-gated and
  // resolvers read the owner bound in AsyncLocalStorage. Additive to REST.
  await mountGraphql(app);

  // Serve built client in production; dev uses the Vite proxy.
  if (existsSync(config.staticDir)) {
    app.use(
      serve(config.staticDir, {
        // The service worker must control the root scope and never be stale-cached
        // (a stale SW is the #1 PWA footgun). koa-static's setHeaders runs after its
        // own Cache-Control, so setting them here reliably overrides the default.
        setHeaders: (res, path) => {
          if (path.replace(/\\/g, '/').endsWith('/sw.js')) {
            res.setHeader('Service-Worker-Allowed', '/');
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.use(async (ctx) => {
      if (!ctx.path.startsWith('/api')) {
        ctx.type = 'html';
        ctx.body = readFileSync(`${config.staticDir}/index.html`, 'utf8');
      }
    });
  }

  return app;
}
