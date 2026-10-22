import Koa, { type Context } from 'koa';
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
import { hydrateVapidConfig } from './services/vapid-config.js';
import { captureException, telemetrySettings } from './lib/telemetry/index.js';

/** Build the Koa app (routes + middleware) without listening or starting cron.
 * Async because the GraphQL (Apollo) server must `start()` before it can be mounted. */
export async function buildApp(): Promise<Koa> {
  const app = new Koa();

  // Apply the operator-saved in-app Google client (app_config) to the config
  // singleton. Runs after migrations (the db module migrated on import above) and is
  // a no-op when GOOGLE_MODE is env-pinned.
  await hydrateGoogleConfig();

  // Provision the Web Push VAPID keypair (generate + persist to app_config on first boot,
  // reuse thereafter). A no-op when an env keypair pins the config. Runs after migrations.
  await hydrateVapidConfig();

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
      // Report only genuine server faults. A thrown 4xx is the API working as designed
      // (bad input, 401, 404) and would bury the real defects in noise. No-op unless
      // error reporting is switched on; the URL is deliberately reduced to method+path,
      // since a query string here carries the user's own search terms.
      if (ctx.status >= 500) captureException(err, { method: ctx.method, path: ctx.path });
    }
  });

  // Track D2 — security headers on every response (the SPA shell, its assets, /api).
  app.use(securityHeaders());

  // The SPA is same-origin (koa-static in prod, the Vite proxy in dev), so no browser
  // origin needs cross-origin access by default. A wildcard here would let any page
  // that gets a browser to attach valid credentials read authenticated /api JSON
  // cross-origin — only exempt origins an operator explicitly names via
  // CORS_ALLOWED_ORIGINS (see lib/config.ts).
  app.use(
    cors({
      origin: (ctx: unknown) => {
        const origin = (ctx as Context).request.header.origin;
        return origin && config.corsOrigins.includes(origin) ? origin : '';
      },
    }),
  );
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

/**
 * Track D2 — security headers.
 *
 * The Content-Security-Policy is written for what the built client actually loads:
 * its own scripts (the theme-bootstrap script moved out of index.html into
 * /theme-init.js so no inline-script allowance is needed), its own styles plus inline
 * `style=` attributes (SolidJS sets them; hence 'unsafe-inline' for STYLES only), the
 * Manrope stylesheet from Google Fonts, same-origin fetch/SSE, the service worker, and
 * — only when crash reporting is on — the Sentry ingest origin. Anything else an
 * operator needs goes in CSP_EXTRA_CONNECT_SRC.
 *
 * The self-hosted GraphiQL sandbox (/api/graphql/sandbox, dev-on / prod-opt-in) is a
 * vendored IDE with inline bootstrap, eval-based workers and blob: URLs; it gets its
 * own looser policy rather than loosening the app's.
 *
 * HSTS is sent only when the request itself is HTTPS (ctx.protocol honours
 * X-Forwarded-Proto behind TRUST_PROXY), so an http:// local open never pins a
 * browser to TLS it cannot get.
 */
function securityHeaders(): Koa.Middleware {
  const sentryOrigin = (() => {
    const t = telemetrySettings();
    if (!t?.enabled || !t.dsn) return null;
    try {
      return new URL(t.dsn).origin;
    } catch {
      return null;
    }
  })();

  const connectSrc = () =>
    ["'self'", ...(sentryOrigin ? [sentryOrigin] : []), ...config.security.extraConnectSrc].join(' ');

  const appPolicy = () =>
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      `connect-src ${connectSrc()}`,
      "worker-src 'self'",
      "manifest-src 'self'",
    ].join('; ');

  const sandboxPolicy = () =>
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src ${connectSrc()}`,
    ].join('; ');

  return async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    ctx.set('X-Frame-Options', 'DENY');
    ctx.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    ctx.set(
      'Content-Security-Policy',
      ctx.path.startsWith('/api/graphql/sandbox') ? sandboxPolicy() : appPolicy(),
    );
    if (ctx.protocol === 'https') ctx.set('Strict-Transport-Security', 'max-age=15552000');
    await next();
  };
}
