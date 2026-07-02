import type Koa from 'koa';
import { sqlite } from '../../db/index.js';
import { SYSTEM_OWNER_ID } from '../ids.js';
import { SCOPE_READ, SCOPE_WRITE, type VerifiedClaims } from './types.js';

/**
 * Local-login session (U2). The session mechanism decided for `sso + DISABLE_OIDC`
 * mode: a signed, httpOnly cookie carrying the owner id, via Koa's built-in
 * `app.keys` (set in app.ts from `SESSION_SECRET`) — no session/cookie package.
 *
 * The value is the plaintext owner id; the sibling `.sig` cookie is Koa's HMAC over
 * it, so a client cannot forge or alter it (tamper ⇒ `.get(…, {signed:true})` returns
 * undefined). httpOnly keeps it out of `document.cookie` (XSS can't read it). This is
 * a *local* trust boundary — the app minting its own session, never speaking for
 * CI-Portal (the SSO path never mints tokens).
 */

export const SESSION_COOKIE = 'cp_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const COOKIE_OPTS = {
  signed: true,
  httpOnly: true,
  sameSite: 'lax' as const,
  overwrite: true,
  path: '/',
};

/** Issue a session for a freshly-authenticated local owner. */
export function setSession(ctx: Koa.Context, ownerId: string): void {
  ctx.cookies.set(SESSION_COOKIE, ownerId, { ...COOKIE_OPTS, maxAge: MAX_AGE_MS });
}

/** Clear the session cookie (logout). Passing null deletes both it and its `.sig`. */
export function clearSession(ctx: Koa.Context): void {
  ctx.cookies.set(SESSION_COOKIE, null, COOKIE_OPTS);
}

// ── Pre-login state binding (U1, login-CSRF defense) ─────────────────────────
// The OAuth `state` alone is only a server-side lookup key; to actually bind the
// login to the browser that STARTED it (RFC 6749 §10.12), /start also drops this
// short-lived signed httpOnly cookie carrying the same `state`, and /callback
// requires the query `state` to equal it before doing anything. A replayed
// authorization response opened in a DIFFERENT browser lacks the cookie → rejected,
// so an attacker can't silently log a victim into the attacker's account.
export const LOGIN_STATE_COOKIE = 'cp_login_state';
const LOGIN_STATE_MAX_AGE_MS = 10 * 60 * 1000; // matches the auth_states TTL

/** Bind the initiating browser to `state` at /start. */
export function setLoginState(ctx: Koa.Context, state: string): void {
  ctx.cookies.set(LOGIN_STATE_COOKIE, state, { ...COOKIE_OPTS, maxAge: LOGIN_STATE_MAX_AGE_MS });
}

/** Read AND clear the login-state cookie at /callback (single-use). */
export function consumeLoginState(ctx: Koa.Context): string | null {
  const state = ctx.cookies.get(LOGIN_STATE_COOKIE, { signed: true }) ?? null;
  ctx.cookies.set(LOGIN_STATE_COOKIE, null, COOKIE_OPTS);
  return state;
}

/**
 * Resolve the session cookie to owner claims, or null if absent/tampered/stale.
 * A full-owner local session carries both scopes (read+write). Re-checks that the
 * owner still exists (and is not the sentinel) so a cookie for a since-deleted owner
 * can't resurrect a dangling identity.
 */
export function verifySession(ctx: Koa.Context): VerifiedClaims | null {
  const ownerId = ctx.cookies.get(SESSION_COOKIE, { signed: true });
  if (!ownerId) return null;
  const row = sqlite
    .prepare(`SELECT id FROM owners WHERE id = ? AND id <> ? LIMIT 1`)
    .get(ownerId, SYSTEM_OWNER_ID) as { id: string } | undefined;
  if (!row) return null;
  return { ownerId, scopes: [SCOPE_READ, SCOPE_WRITE] };
}
