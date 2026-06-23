import Router from '@koa/router';

/**
 * Liveness probe. Allow-listed in requireAuth (lib/auth/requireAuth.ts) so it
 * answers without a credential — used by container orchestration + smoke tests.
 */
export function healthRouter() {
  const router = new Router();
  router.get('/api/health', (ctx) => {
    ctx.body = { ok: true };
  });
  return router;
}
