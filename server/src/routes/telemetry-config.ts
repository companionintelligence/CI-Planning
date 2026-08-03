import Router from '@koa/router';
import { telemetryPermission } from '../lib/telemetry/index.js';

/**
 * Runtime telemetry gate for the BROWSER bundle.
 *
 * The client's DSN is inlined by Vite at build time, so once an image ships with one
 * the bundle has no way to learn that reporting was later switched off — and the
 * switches that matter are runtime env on the container: `CI_TELEMETRY=off` (which is
 * what the CI-Marketplace "Share crash reports" toggle sets) and `CI_LOCAL_ONLY=true`.
 * Without this endpoint that toggle would silently apply to the server half only,
 * while the browser kept reporting.
 *
 * The client calls this BEFORE `Sentry.init` and fails closed if it can't get an
 * answer, so a build-time DSN alone is never sufficient to start reporting.
 *
 * Allow-listed in requireAuth (lib/auth/requireAuth.ts): the page needs the answer
 * before it has a session, and the answer is a deployment-wide policy flag, not user
 * data. The response is deliberately two fields — a boolean and a reason string — and
 * never echoes `SENTRY_DSN` or any other configuration.
 */
export function telemetryConfigRouter() {
  const router = new Router();

  router.get('/api/config/telemetry', (ctx) => {
    const { permitted, disabledReason } = telemetryPermission(process.env);

    // No caching: an operator flipping CI_TELEMETRY and restarting the container must
    // take effect on the next page load, not whenever a proxy decides to revalidate.
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { enabled: permitted, disabledReason };
  });

  return router;
}
