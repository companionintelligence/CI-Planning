import type Koa from 'koa';

/**
 * Where a person goes after signing in. When the app sends someone to the login screen it keeps
 * the page they asked for, and the Companion Portal round trip brings them back there, as
 * Companion Memory does (its `oidc_redirect` cookie). The value starts in the browser, so it is
 * checked on the way in (`/start`) and again on the way out (the callback and the confirmation
 * step): only a same-origin path is ever used. Anything else means the home page.
 */

export const PORTAL_REDIRECT_COOKIE = 'cp_portal_redirect';
export const PORTAL_REDIRECT_TTL_MS = 10 * 60 * 1000;
const MAX_LENGTH = 1024;

/** A same-origin path to return to, or null: one leading `/`, no `//`, no backslash or control characters, no scheme. */
export function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x5c || code === 0x7f) return null;
  }
  // Belt and braces: resolved against a fixed origin, the path must stay on that origin.
  const base = 'https://planning.invalid';
  try {
    if (new URL(value, base).origin !== base) return null;
  } catch {
    return null;
  }
  return value;
}

/** Remember the page to return to for the login starting now. A missing or unsafe one forgets any earlier. */
export function setPortalRedirect(ctx: Koa.Context, path: unknown): void {
  const safe = safeRelativePath(path);
  if (!safe) {
    clearPortalRedirect(ctx);
    return;
  }
  ctx.cookies.set(PORTAL_REDIRECT_COOKIE, encodeURIComponent(safe), {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.protocol === 'https',
    path: '/',
    maxAge: PORTAL_REDIRECT_TTL_MS,
  });
}

/** The remembered page, checked again. A tampered or malformed cookie reads as absent. */
export function readPortalRedirect(ctx: Koa.Context): string | null {
  const raw = ctx.cookies.get(PORTAL_REDIRECT_COOKIE);
  if (!raw) return null;
  try {
    return safeRelativePath(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

export function clearPortalRedirect(ctx: Koa.Context): void {
  ctx.cookies.set(PORTAL_REDIRECT_COOKIE, null, { path: '/' });
}
