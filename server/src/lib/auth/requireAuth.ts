import type Koa from 'koa';
import { config } from '../config.js';
import { runWithOwner, SYSTEM_OWNER } from '../context.js';
import { verifyApiKey } from './apiKey.js';
import { verifyBearer } from './jwks.js';
import { checkAuthRateLimit } from './rateLimit.js';
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
// needs *before* it has a credential. Everything else under /api is gated.
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/config'];

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
      return runWithOwner(SYSTEM_OWNER, () => next());
    }

    // Rate-limit BEFORE any signature/hash work — the limiter must blunt (not
    // amplify) a credential-grinding flood. Writes 429 + Retry-After on trip.
    if (!checkAuthRateLimit(ctx)) return;

    let claims: VerifiedClaims;
    try {
      const bearer = ctx.get('authorization').replace(/^Bearer\s+/i, '');
      const apiKey = presentedApiKey(ctx);
      if (bearer) {
        claims = await verifyBearer(bearer); // SSO — JWKS-verified JWT
      } else if (apiKey) {
        claims = verifyApiKey(apiKey); // standalone — hashed key
      } else {
        ctx.status = 401;
        ctx.body = { error: 'unauthenticated' };
        return;
      }
    } catch (e) {
      // A verified-but-unprovisioned subject is 403 (forbidden); anything else
      // about the credential itself is 401 (unauthenticated).
      const status = (e as { status?: number }).status ?? 401;
      ctx.status = status;
      ctx.body = { error: status === 403 ? 'forbidden' : 'unauthenticated' };
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
