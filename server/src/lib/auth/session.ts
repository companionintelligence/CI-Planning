import type Koa from 'koa';
import { sqlite } from '../../db/index.js';
import { SYSTEM_OWNER_ID } from '../ids.js';
import { SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN, type VerifiedClaims } from './types.js';

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

// `secure` is derived per-request from ctx.protocol: the Secure flag is set only over
// HTTPS, so cookies still work over plain http on the tailnet but get Secure once TLS-
// fronted. Behind a TLS-terminating proxy the app listens on http, so ctx.protocol is
// 'https' ONLY when TRUST_PROXY=true enables Koa proxy mode (then ctx.protocol honors
// X-Forwarded-Proto). Koa also refuses to emit a Secure cookie unless it considers the
// connection secure, so this + app.proxy are what actually make Secure work behind a proxy.
function cookieOpts(ctx: Koa.Context, maxAge?: number) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.protocol === 'https',
    overwrite: true,
    path: '/',
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

// Auth epoch (V): the session is a STATELESS signed cookie, so there is no server-side
// row to revoke. Instead the cookie carries `${ownerId}.${epoch}` and verifySession
// rejects any cookie whose epoch ≠ the owner's current `owners.session_epoch`. A password
// reset bumps that column (bumpSessionEpoch), instantly invalidating every outstanding
// cookie for the owner — the stateless model's equivalent of "revoke all sessions".
function ownerEpoch(ownerId: string): number {
  const row = sqlite.prepare(`SELECT session_epoch FROM owners WHERE id = ?`).get(ownerId) as
    | { session_epoch: number }
    | undefined;
  return row?.session_epoch ?? 0;
}

/** Issue a session for a freshly-authenticated local owner, stamped with the owner's
 * current auth epoch so a later reset (epoch bump) invalidates it. */
export function setSession(ctx: Koa.Context, ownerId: string): void {
  ctx.cookies.set(SESSION_COOKIE, `${ownerId}.${ownerEpoch(ownerId)}`, cookieOpts(ctx, MAX_AGE_MS));
}

/** Advance an owner's auth epoch → every existing session cookie for them stops
 * validating (V, password reset "invalidate all sessions"). */
export function bumpSessionEpoch(ownerId: string): void {
  sqlite.prepare(`UPDATE owners SET session_epoch = session_epoch + 1 WHERE id = ?`).run(ownerId);
}

/** Clear the session cookie (logout). Passing null deletes both it and its `.sig`. */
export function clearSession(ctx: Koa.Context): void {
  ctx.cookies.set(SESSION_COOKIE, null, cookieOpts(ctx));
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
  ctx.cookies.set(LOGIN_STATE_COOKIE, state, cookieOpts(ctx, LOGIN_STATE_MAX_AGE_MS));
}

/** Read AND clear the login-state cookie at /callback (single-use). */
export function consumeLoginState(ctx: Koa.Context): string | null {
  const state = ctx.cookies.get(LOGIN_STATE_COOKIE, { signed: true }) ?? null;
  ctx.cookies.set(LOGIN_STATE_COOKIE, null, cookieOpts(ctx));
  return state;
}

/**
 * Resolve the session cookie to owner claims, or null if absent/tampered/stale.
 * A full-owner session (SSO or local login) carries read+write AND admin (W12): a
 * logged-in owner is the operator of their own instance, so they may run/inspect the
 * system job surfaces. Re-checks that the owner still exists (and is not the sentinel)
 * so a cookie for a since-deleted owner can't resurrect a dangling identity.
 */
export function verifySession(ctx: Koa.Context): VerifiedClaims | null {
  const raw = ctx.cookies.get(SESSION_COOKIE, { signed: true });
  if (!raw) return null;
  // The value is `${ownerId}.${epoch}`. A legacy cookie minted before V is the bare
  // owner id (no '.') and is read as epoch 0, so live sessions survive the upgrade
  // (session_epoch also defaults to 0). Owner ids are UUIDs — no '.' — so splitting on
  // the last '.' is unambiguous.
  const dot = raw.lastIndexOf('.');
  const ownerId = dot === -1 ? raw : raw.slice(0, dot);
  const epoch = dot === -1 ? 0 : Number(raw.slice(dot + 1));
  const row = sqlite
    .prepare(`SELECT session_epoch FROM owners WHERE id = ? AND id <> ? LIMIT 1`)
    .get(ownerId, SYSTEM_OWNER_ID) as { session_epoch: number } | undefined;
  if (!row) return null;
  // Reject a cookie whose epoch doesn't match the owner's current one — a password reset
  // bumped it, so every pre-reset cookie is now invalid. Fail closed on a malformed epoch.
  if (!Number.isInteger(epoch) || epoch !== row.session_epoch) return null;
  return { ownerId, scopes: [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN] };
}
