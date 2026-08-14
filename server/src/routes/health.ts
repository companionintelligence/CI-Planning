import Router from '@koa/router';
import { initTelemetry } from '../lib/telemetry/index.js';

/**
 * Liveness probe. Allow-listed in requireAuth (lib/auth/requireAuth.ts) so it
 * answers without a credential — used by container orchestration + smoke tests.
 *
 * `release` rides the same value Sentry would tag events with — `initTelemetry` is
 * idempotent (memoized after boot's real call), so this just reads the cached
 * settings, it never re-initialises. The client compares it against its own
 * build-time VITE_SENTRY_RELEASE (stores/updateAvailable.ts) on every SSE reconnect
 * to notice a redeploy happened under an open tab and offer a reload.
 */
export function healthRouter() {
  const router = new Router();
  router.get('/api/health', (ctx) => {
    ctx.body = { ok: true, release: initTelemetry().release ?? null };
  });
  return router;
}
