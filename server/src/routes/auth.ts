import Router from '@koa/router';
import { config } from '../lib/config.js';
import { httpError } from '../lib/http-error.js';
import { findOwnerByUsername, verifyLoginPassword } from '../lib/auth/password.js';
import { setSession, clearSession } from '../lib/auth/session.js';

/**
 * The `/api/auth/*` router (U2). Local username/password login for
 * `AUTH_MODE=sso && DISABLE_OIDC=true`. U1's CI-Portal OAuth routes will join this
 * same file (one auth router). `/config` and `/login`/`/logout` are allow-listed in
 * requireAuth (they must be reachable before a session exists).
 */

// Minimal in-memory sliding-window limiter — the first real consumer of
// config.auth.rateLimit. Keyed by client IP; bounds `issueMax` login attempts per
// `windowMs`. In-process only (single-node deployment); resets on restart.
const attempts = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const { windowMs, issueMax } = config.auth.rateLimit;
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((t) => now - t < windowMs);
  attempts.set(ip, recent);
  if (recent.length >= issueMax) return true;
  recent.push(now);
  return false;
}

const localLoginEnabled = () => config.auth.mode === 'sso' && config.auth.disableOidc;

/** Test-only: clear the in-memory login rate-limiter so tests don't bleed attempts into each other. */
export function __resetAuthRateLimit(): void {
  attempts.clear();
}

export function authRouter() {
  const router = new Router();

  // Public (no credential): tells the client which auth mode is active, so the SPA
  // knows whether to show a login screen at all (U3 consumes this).
  router.get('/api/auth/config', (ctx) => {
    ctx.body = { mode: config.auth.mode, disableOidc: config.auth.disableOidc };
  });

  router.post('/api/auth/login', async (ctx) => {
    if (!localLoginEnabled()) throw httpError(404, 'local login is not enabled');
    if (rateLimited(ctx.ip)) throw httpError(429, 'too many login attempts — try again shortly');

    const { username, password } = (ctx.request.body ?? {}) as {
      username?: unknown;
      password?: unknown;
    };
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      throw httpError(400, 'username and password are required');
    }

    const owner = findOwnerByUsername(username);
    // Constant-work verify (one argon2id op regardless of whether the username exists
    // or is OIDC-only) → generic 401 that reveals nothing by status, body, OR timing.
    const ok = await verifyLoginPassword(owner?.password_hash ?? null, password);
    if (!owner || !ok) {
      throw httpError(401, 'invalid credentials');
    }

    setSession(ctx, owner.id);
    ctx.body = { ok: true };
  });

  router.post('/api/auth/logout', (ctx) => {
    // Guard like login: clearSession writes a SIGNED cookie, which throws when
    // app.keys is unset — and app.keys is only set in local-login mode. Without this
    // guard, an unauthenticated logout in standalone/test/sso-OIDC mode 500s.
    if (!localLoginEnabled()) throw httpError(404, 'local login is not enabled');
    clearSession(ctx);
    ctx.body = { ok: true };
  });

  return router;
}
