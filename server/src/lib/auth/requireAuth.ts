import type Koa from 'koa';
import { config } from '../config.js';
import { runWithOwner, SYSTEM_OWNER } from '../context.js';
import { verifyApiKey } from './apiKey.js';
import { hasScope } from './scopes.js';
import type { VerifiedClaims } from './types.js';

/**
 * The single auth guard (Phase I). Mounted in app.ts after bodyParser and before
 * the routers, so every `/api/*` route — including the SSE stream — sits behind it.
 * It turns a credential into an owner via `runWithOwner`, so downstream handlers
 * keep reading `currentOwnerId()` and never see the credential.
 *
 *   - `test` mode  → fixed SYSTEM_OWNER, no credential (dev + the test suite). This
 *                    path is hard-rejected at boot under NODE_ENV=production.
 *   - otherwise    → a hashed `x-api-key` (standalone). SSO Bearer JWTs land in PR2.
 *
 * Read methods need `planning:read`, mutations `planning:write` (403 on mismatch).
 */

// Reachable without authentication: liveness + the auth-bootstrap config a client
// needs *before* it has a credential, plus the Google OAuth callback — Google's
// redirect arrives with no app credential and the owner is resolved SOLELY from the
// matched oauth_states row (I2). Everything else under /api is gated.
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/config', '/api/oauth/google/callback'];

function isPublic(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The presented API key. Browsers can't set headers on `EventSource`, so the SSE
 * stream also accepts the key as a `?api_key=` query param. The query path is only
 * meaningful for that endpoint; normal fetch calls use the header.
 */
function presentedApiKey(ctx: Koa.Context): string | undefined {
  const header = ctx.get('x-api-key');
  if (header) return header;
  const q = ctx.query.api_key;
  return typeof q === 'string' ? q : undefined;
}

export function requireAuth(): Koa.Middleware {
  return async (ctx, next) => {
    // Only the API surface is gated; static assets + the SPA shell fall through.
    if (!ctx.path.startsWith('/api') || isPublic(ctx.path)) {
      return next();
    }

    // Read mode per-request (config is a singleton the tests flip), so a single
    // built app can serve every mode.
    if (config.auth.mode === 'test') {
      // Test-only: let a test drive a request AS a specific owner (multi-tenant
      // isolation tests) via the `x-test-owner` header. Honored ONLY in test mode,
      // so it adds zero auth surface to standalone/SSO. Defaults to SYSTEM_OWNER.
      const testOwner = ctx.get('x-test-owner');
      return runWithOwner(testOwner || SYSTEM_OWNER, () => next());
    }

    let claims: VerifiedClaims;
    try {
      const apiKey = presentedApiKey(ctx);
      if (!apiKey) {
        ctx.status = 401;
        ctx.body = { error: 'unauthenticated' };
        return;
      }
      claims = verifyApiKey(apiKey); // SSO Bearer path is added in PR2
    } catch (e) {
      ctx.status = (e as { status?: number }).status ?? 401;
      ctx.body = { error: 'unauthenticated' };
      return;
    }

    if (!hasScope(claims.scopes, ctx.method)) {
      ctx.status = 403;
      ctx.body = { error: 'forbidden' };
      return;
    }

    await runWithOwner(claims.ownerId, () => next());
  };
}
