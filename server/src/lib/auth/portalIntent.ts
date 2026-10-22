import type Koa from 'koa';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * B3 — the first-time Companion Portal sign-in confirmation (Companion Memory's
 * "Create account?" page). When the portal callback verifies an id_token whose `sub`
 * has no Companion Planning owner yet, it does NOT provision silently: it parks the
 * verified identity in this short-lived cookie and sends the browser to a no-JS
 * confirmation page. Only an explicit "Create account" POST provisions — so signing
 * in to the wrong Portal account (a second persona, a shared device) cannot mint an
 * unwanted tenant, and on an operator-less instance cannot accidentally claim the
 * operator role (A3).
 *
 * The cookie is Koa-signed (app.keys = SESSION_SECRET, same as the session cookie):
 * a tampered value fails the HMAC and reads as absent. It carries its own `exp` —
 * the browser-side maxAge is a courtesy, the server enforces the 10-minute window
 * itself — and a random CSRF token that the confirmation form must echo back. SameSite
 * =Lax already keeps the cookie off cross-site POSTs; the token is the second lock, so
 * nothing that cannot READ the confirmation page (a same-site page, a top-level
 * navigation trick) can submit the "Create account" decision on the user's behalf.
 *
 * Identity is only ever what the callback VERIFIED — never re-read from the request.
 */

export const PORTAL_INTENT_COOKIE = 'cp_portal_intent';
export const PORTAL_INTENT_TTL_MS = 10 * 60 * 1000;

export interface PortalIntent {
  sub: string;
  name: string;
  email?: string;
  /** Echoed by the confirmation form; compared in constant time. */
  csrf: string;
  /** Absolute expiry (ms since epoch) — enforced server-side. */
  exp: number;
}

// Mirrors lib/auth/session.ts cookieOpts: signed, httpOnly, Lax, Secure over HTTPS.
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

/** Park a verified-but-unprovisioned portal identity; returns the intent written. */
export function setPortalIntent(ctx: Koa.Context, identity: { sub: string; name: string; email?: string }): PortalIntent {
  const intent: PortalIntent = {
    sub: identity.sub,
    name: identity.name,
    ...(identity.email ? { email: identity.email } : {}),
    csrf: randomBytes(32).toString('base64url'),
    exp: Date.now() + PORTAL_INTENT_TTL_MS,
  };
  ctx.cookies.set(PORTAL_INTENT_COOKIE, Buffer.from(JSON.stringify(intent)).toString('base64url'), cookieOpts(ctx, PORTAL_INTENT_TTL_MS));
  return intent;
}

/**
 * Read the intent, or null when absent, tampered (signature mismatch), malformed, or
 * expired. Does not clear it — the confirmation page is allowed to be reloaded; the
 * POST handlers clear it explicitly via {@link clearPortalIntent}.
 */
export function readPortalIntent(ctx: Koa.Context): PortalIntent | null {
  const raw = ctx.cookies.get(PORTAL_INTENT_COOKIE, { signed: true });
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Partial<PortalIntent>;
  if (typeof p.sub !== 'string' || !p.sub) return null;
  if (typeof p.name !== 'string') return null;
  if (typeof p.csrf !== 'string' || !p.csrf) return null;
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp) || p.exp <= Date.now()) return null;
  return {
    sub: p.sub,
    name: p.name,
    ...(typeof p.email === 'string' && p.email ? { email: p.email } : {}),
    csrf: p.csrf,
    exp: p.exp,
  };
}

export function clearPortalIntent(ctx: Koa.Context): void {
  ctx.cookies.set(PORTAL_INTENT_COOKIE, null, cookieOpts(ctx));
}

/** Constant-time comparison of the form's CSRF token against the cookie's. */
export function csrfMatches(intent: PortalIntent, presented: unknown): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const a = Buffer.from(intent.csrf);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
