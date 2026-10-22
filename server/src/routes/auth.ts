import Router from '@koa/router';
import { randomBytes } from 'node:crypto';
import { store } from '../db/store.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { newId, SYSTEM_OWNER_ID } from '../lib/ids.js';
import { currentOwnerId } from '../lib/context.js';
import { httpError } from '../lib/http-error.js';
import { provisionOwner } from '../lib/owners.js';
import { base64url, s256 } from '../lib/auth/pkce.js';
import { verifyOidcIdToken } from '../lib/auth/verifyOidcIdToken.js';
import { discoverOidc, type OidcDiscoveryDoc } from '../lib/auth/oidcDiscovery.js';
import { normalizeRole } from '../lib/auth/scopes.js';
import { findOwnerByUsername, verifyLoginPassword, hashPassword } from '../lib/auth/password.js';
import { setSession, clearSession, setLoginState, consumeLoginState, bumpSessionEpoch, SESSION_COOKIE } from '../lib/auth/session.js';
import { issueResetToken, consumeResetToken } from '../lib/auth/resetToken.js';
import { claimSignupCode, bindSignupCode, releaseSignupCode } from '../lib/auth/signupCodes.js';
import { setPortalIntent, readPortalIntent, clearPortalIntent, csrfMatches, type PortalIntent } from '../lib/auth/portalIntent.js';
import { writeAudit } from '../lib/audit.js';
import { sendMail } from '../lib/mail/index.js';

/**
 * The `/api/auth/*` router.
 *
 * U2 — local username/password login (served in BOTH `AUTH_MODE=sso` sub-modes since A3):
 *   POST /api/auth/login · POST /api/auth/logout
 * B2 — local self-serve sign-up (`AUTH_SIGNUP=open|invite`; invite codes from
 *   routes/accounts.ts):
 *   GET /api/auth/signup/requirements · POST /api/auth/signup
 * U1 — CI-Portal SSO login (`AUTH_MODE=sso && DISABLE_OIDC=false`), a full OAuth 2.1
 * Authorization-Code + PKCE(S256) Relying-Party flow mirroring the proven Google
 * connector flow (routes/oauth.ts), with the two structural differences the plan
 * calls out: state rows live in `auth_states` (no owner exists pre-login), and the
 * callback resolves/provisions an OWNER + starts a SESSION instead of storing a
 * connection token:
 *   GET /api/auth/ciportal/start · GET /api/auth/ciportal/callback
 * B3 — a verified portal identity with NO owner yet is not provisioned silently; the
 * callback parks it in a signed intent cookie and the user confirms on a no-JS page:
 *   GET /api/auth/ciportal/confirm-account · POST /api/auth/ciportal/confirm-account
 * Shared:
 *   GET /api/auth/config (public — which methods are on; the U3/A4 bootstrap probe)
 *   GET /api/auth/me     (gated — session/identity probe for the client shell)
 *
 * Every login path ends identically: a signed httpOnly session cookie (lib/auth/
 * session.ts), so requireAuth treats their requests the same.
 */

const STATE_TTL_MS = 10 * 60 * 1000; // authorize redirects are short-lived (10 min)
const MIN_PASSWORD_LENGTH = 8;       // V: server-side floor for a reset password (client also checks)
// B2 sign-up field limits. The username rules mirror PATCH /api/owner/profile
// (routes/owner.ts): non-empty, ≤64 chars, no whitespace, NOT case-folded (the unique
// index and findOwnerByUsername are binary-collated — lower-casing here would store a
// handle the person then cannot log in with). The email check is the same pragmatic
// shape as there: one `@`, dot-bearing domain, no whitespace.
const MAX_NAME_LENGTH = 120;
const MAX_USERNAME_LENGTH = 64;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A hung CI-Portal token endpoint must not hang the callback the browser is sitting on
// mid-redirect. 10s (vs oidcDiscovery's 5s): this is a POST the provider does real work
// for (validate the code, mint tokens), not a static document GET.
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
/** Longest accepted reset identifier — RFC 5321's max address length. */
const MAX_IDENTIFIER_LENGTH = 254;

// Minimal in-memory sliding-window limiter — the consumer of config.auth.rateLimit.
// Bounds `issueMax` attempts per `windowMs` for a given KEY. In-process only (single-node
// deployment); resets on restart. Keys are namespaced so different axes don't collide:
// `ip:<addr>` for per-IP (login, ciportal start, reset-request) and `reset:<identifier>`
// for the per-account reset-request axis (V9 — hammering one account's mailbox).
//
// THE MAP IS BOUNDED, deliberately and on three axes. It used to grow forever: every
// bucket was re-inserted on read even when its whole window had expired, and nothing
// ever removed one. The `reset:` axis makes that reachable from an UNAUTHENTICATED
// endpoint whose key is request-supplied, so a distinct identifier per request minted
// a permanent entry — 100k requests measured at 100k retained keys. The bounds:
//   1. key length — one bucket can never be larger than MAX_KEY_LEN;
//   2. an expiry sweep, so idle buckets are reclaimed rather than kept for ever;
//   3. a hard MAX_BUCKETS ceiling with LRU eviction, so even a flood that outruns the
//      sweep has an absolute memory cost.
const attempts = new Map<string, number[]>();

// Once-per-process latch for the reset-request "SMTP not configured" warning — the
// endpoint is public, so a per-request warn would let anyone spam the logs.
let warnedResetWithoutSmtp = false;

/** Longest key we will store. Longer keys are truncated, never rejected — colliding
 *  two over-long identifiers into one bucket only makes the limit *stricter*, and this
 *  is a coarse abuse defence, not an identity. */
const MAX_KEY_LEN = 256;
/** Buckets held before a sweep is worth the O(n) pass. */
const SWEEP_AT = 1_024;
/** Absolute bucket ceiling, enforced by LRU eviction after the sweep. */
const MAX_BUCKETS = 4_096;

/**
 * Drop every bucket whose window has fully expired.
 *
 * `times` is append-only and ascending, so the LAST entry is the newest: if that one is
 * outside the window, all of them are. A bucket in that state is indistinguishable from
 * one that never existed, which is exactly why keeping it was pure waste.
 */
function sweepAttempts(now: number, windowMs: number): void {
  for (const [key, times] of attempts) {
    const newest = times[times.length - 1];
    if (newest === undefined || now - newest >= windowMs) attempts.delete(key);
  }
}

function rateLimitedKey(rawKey: string): boolean {
  const key = rawKey.length > MAX_KEY_LEN ? rawKey.slice(0, MAX_KEY_LEN) : rawKey;
  const { windowMs, issueMax } = config.auth.rateLimit;
  const now = Date.now();

  if (attempts.size >= SWEEP_AT) {
    sweepAttempts(now, windowMs);
    // Still over the ceiling ⇒ a live flood the sweep can't keep up with. Evict the
    // least-recently-touched buckets: they are the ones closest to expiring anyway, so
    // this costs an attacker-shaped caller a few extra attempts and costs a legitimate
    // one nothing. Failing CLOSED here instead (refusing new keys) would hand any
    // stranger a way to lock every account out of login, which is the worse trade.
    while (attempts.size >= MAX_BUCKETS) {
      const oldest = attempts.keys().next();
      if (oldest.done) break;
      attempts.delete(oldest.value);
    }
  }

  const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  const limited = recent.length >= issueMax;
  if (!limited) recent.push(now);
  // delete-then-set keeps Map iteration order as least-recently-touched first, which is
  // what makes the eviction above an LRU rather than a first-seen cull.
  attempts.delete(key);
  attempts.set(key, recent);
  return limited;
}
/** Per-IP limiter (login, ciportal start). */
function rateLimited(ip: string): boolean {
  return rateLimitedKey(`ip:${ip}`);
}

/**
 * Local username/password login is served in BOTH `sso` sub-modes. Under DISABLE_OIDC it
 * is the only login; under OIDC it is the break-glass path for the operator seeded from
 * AUTH_DEFAULT_* (A3) and for any invited local account. With no local owners the route
 * simply 401s after its constant-work verify, so enabling it costs nothing. The login
 * SCREEN decides what to show from GET /api/auth/config (A4), not from this gate.
 */
const localLoginEnabled = () => config.auth.mode === 'sso';
/** CI-Portal SSO active (shared by the login flow AND the AA0b memory connector flow). */
export const ssoLoginEnabled = () => config.auth.mode === 'sso' && !config.auth.disableOidc;
/**
 * B2 — local self-serve sign-up is served whenever local login is (both `sso`
 * sub-modes) and the operator hasn't switched it off. `invite` additionally demands a
 * code. Independent of the portal: on a portal install `/signup` is the operator's
 * escape hatch for someone without a Portal account, reached by direct link.
 */
const localSignupEnabled = () => localLoginEnabled() && config.auth.signup !== 'off';

/**
 * A4 — what `GET /api/auth/config` reports (the client's bootstrap probe). One shape
 * for every mode so the login screen is driven by capability flags, not by inferring
 * them from `mode` + `disableOidc` (kept for one release; clients should read the
 * flags). `signup` names the sign-up AFFORDANCE the login screen should offer:
 * `portal` whenever Companion Portal is on (B1 — the portal owns sign-up; a Hub user
 * must be a member of the Hub's organization, which the portal enforces at the
 * redirect check), else the local policy (B2) or `off`.
 */
export interface AuthConfigPayload {
  mode: typeof config.auth.mode;
  /** Deprecated for clients — superseded by `portal`/`local`. Removed next release. */
  disableOidc: boolean;
  portal: boolean;
  local: boolean;
  signup: 'portal' | 'open' | 'invite' | 'off';
}
export function authConfigPayload(): AuthConfigPayload {
  const portal = ssoLoginEnabled();
  const local = localLoginEnabled();
  return {
    mode: config.auth.mode,
    disableOidc: config.auth.disableOidc,
    portal,
    local,
    signup: portal ? 'portal' : local ? config.auth.signup : 'off',
  };
}

/**
 * A5 — which `redirect_uri` a Portal login should come back to.
 *
 * The configured value (`CIPORTAL_REDIRECT_URI`, default `${PUBLIC_BASE_URL}/api/auth/
 * ciportal/callback`) is the rule: it is never recomputed from an arbitrary request
 * `Host`, because an attacker-controlled Host header must not steer where the Portal
 * sends the authorization code. One deliberate exception: the browser is on a LOOPBACK
 * host (`localhost`, `127.0.0.1`, `::1`, any port). That is CI-Hub's "local open"
 * (ADR 001: `http://127.0.0.1:<host-port>`), where the configured base is the public
 * tunnel host — sending the user there would land their session on a host they did not
 * open and that may not even be reachable from the LAN. A loopback redirect can only
 * ever deliver the code to the user's own machine, Companion Portal accepts on-device
 * hosts for this client without consent, and the state row stores the choice so the
 * token exchange echoes exactly what was sent.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
export function loginRedirectUriFor(req: { hostname: string; host: string; protocol: string }): string {
  if (LOOPBACK_HOSTNAMES.has(req.hostname)) return `${req.protocol}://${req.host}/api/auth/ciportal/callback`;
  return config.ciportal.redirectUri;
}

/** Minimal config to attempt a login: issuer (for discovery) + our client id. */
export function ciportalConfigured(): boolean {
  const c = config.ciportal;
  return Boolean(c.clientId && c.issuer);
}

/**
 * Resolve the CI-Portal endpoints + canonical issuer. Discovery-driven by default
 * (fetch `<issuer>/.well-known/openid-configuration`); if all three endpoint overrides
 * are set, use them verbatim and skip discovery (air-gapped/test — the operator then
 * owns making CIPORTAL_ISSUER equal the token's `iss` claim). `doc.issuer` is what the
 * callback validates the id_token `iss` against — for better-auth that's the bare
 * origin, NOT the `…/api/auth` discovery URL.
 */
export async function ciportalEndpoints(): Promise<OidcDiscoveryDoc> {
  const c = config.ciportal;
  if (c.authorizeUri && c.tokenUri && c.jwksUri) {
    return {
      issuer: c.issuer!,
      authorization_endpoint: c.authorizeUri,
      token_endpoint: c.tokenUri,
      jwks_uri: c.jwksUri,
    };
  }
  return discoverOidc(c.issuer!);
}

/** Test-only: clear the in-memory login rate-limiter so tests don't bleed attempts into each other. */
export function __resetAuthRateLimit(): void {
  attempts.clear();
}

/** Test-only: live bucket count, so the bounds above can be asserted rather than assumed. */
export function __authRateLimitSize(): number {
  return attempts.size;
}

/** Test-only: drive the limiter directly. The bounds are a property of the map, and
 *  proving them through HTTP would need tens of thousands of requests to say less. */
export function __rateLimitedKeyForTest(key: string): boolean {
  return rateLimitedKey(key);
}

interface AuthStateRow {
  id: string;
  code_verifier: string;
  nonce: string;
  redirect_uri: string | null;
  expires_at: string;
}

interface PortalTokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

export function authRouter() {
  const router = new Router();

  // Public (no credential): tells the client which auth mode is active and which
  // methods are on, so the SPA knows whether to show a login screen at all (U3) and
  // what to put on it (A4). See authConfigPayload.
  router.get('/api/auth/config', (ctx) => {
    ctx.body = authConfigPayload();
  });

  // Gated: identity of the current session/credential — the client shell's session
  // probe (U3). 401s via requireAuth when there is no valid credential.
  router.get('/api/auth/me', async (ctx) => {
    const ownerId = currentOwnerId();
    const row = await store()
      .prepare(`SELECT id, name, email, username, backup_email, role FROM owners WHERE id = ?`)
      .get<{ id: string; name: string; email: string | null; username: string | null; backup_email: string | null; role: string }>(
        ownerId);
    if (!row) throw httpError(401, 'unknown owner');
    // Phase AG: `role` + derived `isOperator` let the client show/hide the operator
    // surfaces (Settings → Accounts, the Jobs nav entry) without probing an admin GET.
    // normalizeRole keeps the payload on the operator/member/viewer union the client
    // types promise — an unrecognized DB value reads as 'viewer', matching the
    // read-only scopes roleToScopes actually grants it.
    const role = normalizeRole(row.role);
    ctx.body = {
      ownerId: row.id, name: row.name, email: row.email, username: row.username,
      backupEmail: row.backup_email, role, isOperator: role === 'operator',
    };
  });

  // ── U2: local username/password ─────────────────────────────────────────────

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

    const owner = await findOwnerByUsername(username);
    // Constant-work verify (one argon2id op regardless of whether the username exists
    // or is OIDC-only) → generic 401 that reveals nothing by status, body, OR timing.
    const ok = await verifyLoginPassword(owner?.password_hash ?? null, password);
    if (!owner || !ok) {
      throw httpError(401, 'invalid credentials');
    }

    await setSession(ctx, owner.id);
    ctx.body = { ok: true };
  });

  router.post('/api/auth/logout', (ctx) => {
    // Guard like login: clearSession writes a SIGNED cookie, which throws when
    // app.keys is unset — and app.keys is only set in sso mode. Without this guard,
    // an unauthenticated logout in standalone/test mode 500s.
    if (config.auth.mode !== 'sso') throw httpError(404, 'sessions are not enabled');
    // Only clear when the caller actually presented a *valid signed* session cookie. SameSite=Lax
    // keeps the cookie off cross-site POSTs, so a forged cross-site logout sees no cookie
    // here and is a no-op — defeating logout-CSRF (a forced Set-Cookie deletion).
    if (ctx.cookies.get(SESSION_COOKIE, { signed: true })) clearSession(ctx);
    ctx.body = { ok: true };
  });

  // ── B2: local self-serve sign-up ────────────────────────────────────────────

  // Public: what the /signup page needs before it has anything to send. Config-derived
  // only — never varies with who is asking.
  router.get('/api/auth/signup/requirements', (ctx) => {
    const enabled = localSignupEnabled();
    ctx.body = { enabled, codeRequired: enabled && config.auth.signup === 'invite' };
  });

  // Public: create a local account for yourself. Body { name, username, email,
  // password, code? }. Under AUTH_SIGNUP=invite a valid, unused, unrevoked, unexpired
  // code is mandatory and is consumed with the account; under `open` none is needed.
  // The first account on an instance with no operator becomes the operator (A3's
  // provisionOwner claim — the same path the portal uses), every later one a member.
  // Signs the new owner in on success. Rate-limited per IP with the login limiter: an
  // argon2id hash + ~15 inserts per request is not something a stranger gets to
  // repeat freely.
  router.post('/api/auth/signup', async (ctx) => {
    if (!localSignupEnabled()) throw httpError(404, 'sign-up is not enabled');
    if (rateLimited(ctx.ip)) throw httpError(429, 'too many attempts — try again shortly');

    const body = (ctx.request.body ?? {}) as {
      name?: unknown; username?: unknown; email?: unknown; password?: unknown; code?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw httpError(400, `name is required (max ${MAX_NAME_LENGTH} characters)`);
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!username) throw httpError(400, 'username is required');
    if (username.length > MAX_USERNAME_LENGTH) throw httpError(400, `username must be at most ${MAX_USERNAME_LENGTH} characters`);
    if (/\s/.test(username)) throw httpError(400, 'username cannot contain spaces');
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || !EMAIL_RE.test(email)) throw httpError(400, 'email must be a valid address');
    if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const codeRequired = config.auth.signup === 'invite';
    if (codeRequired && !code) throw httpError(400, 'an invite code is required');

    // Hash BEFORE claiming the code: argon2id takes real time, and a claim held across
    // it would widen the window in which a failed sign-up has the code "used".
    const passwordHash = await hashPassword(body.password);

    // Claim first (one guarded UPDATE — see lib/auth/signupCodes.ts for why this is
    // not wrapped in a transaction with the insert), release on any failure below.
    let claimedCodeId: string | null = null;
    if (codeRequired) {
      claimedCodeId = await claimSignupCode(code);
      // One answer for unknown / used / revoked / expired — nothing here distinguishes
      // "a code exists but is spent" from "no such code", so codes can't be probed.
      if (!claimedCodeId) throw httpError(400, 'that invite code is invalid, already used, or has expired');
    }

    let id: string;
    try {
      id = await provisionOwner({ name, username, email, passwordHash, claimOperatorIfNone: true });
    } catch (err) {
      if (claimedCodeId) await releaseSignupCode(claimedCodeId);
      // ux_owners_username (0101) is the single enforcer of uniqueness. The message is
      // the same for every taken handle and says nothing about the email — a sign-up
      // form inevitably reveals that a username is taken; it must not reveal more.
      if (/UNIQUE/i.test((err as Error).message)) throw httpError(409, 'that username is not available');
      throw err;
    }
    if (claimedCodeId) await bindSignupCode(claimedCodeId, id);

    const minted = await store().prepare(`SELECT role FROM owners WHERE id = ?`).get<{ role: string }>(id);
    const role = normalizeRole(minted?.role);
    writeAudit({ ownerId: id, actor: 'owner', action: 'signup', entity: `account:${id}` });
    logger.info('local sign-up created an owner', { owner: id, role, viaCode: Boolean(claimedCodeId) });
    if (role === 'operator') {
      logger.warn('local sign-up: first account on an instance with no operator — this owner is now the OPERATOR', { owner: id });
    }

    await setSession(ctx, id);
    ctx.status = 201;
    ctx.body = { ok: true, ownerId: id, role };
  });

  // ── V: password reset (local sign-in only) ──────────────────────────────────

  // Public: begin a reset. Body { identifier } — a username OR email. ALWAYS returns the
  // same neutral 200 regardless of whether the account exists or has a deliverable
  // address, so it can't be used to enumerate accounts. Rate-limited per-IP AND per
  // supplied identifier (V9). Only meaningful in local-login mode — SSO owners reset in
  // CI-Portal.
  router.post('/api/auth/reset-request', async (ctx) => {
    if (!localLoginEnabled()) throw httpError(404, 'password reset is not enabled');

    const { identifier } = (ctx.request.body ?? {}) as { identifier?: unknown };
    if (typeof identifier !== 'string' || !identifier.trim()) {
      throw httpError(400, 'identifier (username or email) is required');
    }
    const id = identifier.trim();
    // Length-check BEFORE the limiter, which keys a bucket on this string. The body
    // parser accepts 20mb (app.ts), so without this an unauthenticated caller chose how
    // much memory each request cost us. 254 is the RFC 5321 ceiling for an address, so
    // nothing this rejects could have matched an account anyway — and the check reads
    // only the length of what was sent, never whether it names anyone, so the
    // anti-enumeration invariant below is untouched.
    if (id.length > MAX_IDENTIFIER_LENGTH) {
      throw httpError(400, 'identifier is too long');
    }

    // Per-IP and per-account limits. The per-IP bucket is shared with login/start (all
    // "issue" ops); the per-account bucket stops one mailbox being hammered. Keyed on the
    // SUPPLIED identifier (not a resolved owner) so it leaks nothing about existence.
    if (rateLimitedKey(`ip:${ctx.ip}`) || rateLimitedKey(`reset:${id.toLowerCase()}`)) {
      throw httpError(429, 'too many reset requests — try again shortly');
    }

    // Resolve by username OR email, excluding the sentinel (N-SENTINEL). Prefer an email match
    // when the identifier looks like an email to avoid ambiguity with email-shaped usernames.
    const looksLikeEmail = id.includes('@');
    const owner = await (looksLikeEmail
      ? store()
          .prepare(`SELECT id, email, backup_email FROM owners WHERE email = ? AND id <> ? LIMIT 1`)
          .get<{ id: string; email: string | null; backup_email: string | null }>(id, SYSTEM_OWNER_ID)
      : store()
          .prepare(`SELECT id, email, backup_email FROM owners WHERE username = ? AND id <> ? LIMIT 1`)
          .get<{ id: string; email: string | null; backup_email: string | null }>(id, SYSTEM_OWNER_ID));

    // The response is returned in every branch below and depends ONLY on server config,
    // never on whether the identifier matched — the anti-enumeration invariant. With no
    // SMTP configured the mail adapter can only log the link to the server console
    // (lib/mail: console transport), so promising "a reset link is on its way" to a
    // remote user would be a lie; say what actually happens instead. Config-derived text
    // is constant across real and fake identifiers, so it leaks nothing about accounts.
    const NEUTRAL = config.mail.host
      ? { ok: true, delivery: 'email' as const, message: 'If an account matches, a reset link is on its way.' }
      : {
          ok: true,
          delivery: 'log' as const,
          message:
            'This server has no outgoing email configured. If an account matches, the reset link was written to the server log — ask the operator for it.',
        };
    if (!config.mail.host && !warnedResetWithoutSmtp) {
      // Once per process: this endpoint is public and rate-limit-spammable, and the
      // condition is config-level, so repeating it per request is pure log noise.
      // (Startup already warns via lib/config.ts when local login is on in production.)
      warnedResetWithoutSmtp = true;
      logger.warn('reset-request: SMTP not configured — any reset link is only written to the server log');
    }

    if (owner) {
      // Primary destination is owners.email; backup_email is the fallback. A local owner
      // seeded with only a username has NEITHER — we can't email them, but we still return
      // the neutral 200 (never reveal "no address on file"). Operator sees the warning.
      const dest = owner.email ?? owner.backup_email;
      if (!dest) {
        logger.warn('reset-request: account has no email or backup_email — cannot send', { owner: owner.id });
      } else {
        const rawToken = await issueResetToken(owner.id);
        const link = `${config.mail.appBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
        const subject = 'Reset your Companion Planning password';
        const text =
          `Someone requested a password reset for your Companion Planning account.\n\n` +
          `Reset your password: ${link}\n\n` +
          `This link expires in ${Math.round(config.auth.resetTokenTtlMs / 60000)} minutes and can be used once. ` +
          `If you didn't request this, you can ignore this email.`;
        const html =
          `<p>Someone requested a password reset for your Companion Planning account.</p>` +
          `<p><a href="${link}">Reset your password</a></p>` +
          `<p>This link expires in ${Math.round(config.auth.resetTokenTtlMs / 60000)} minutes and can be used once. ` +
          `If you didn't request this, you can ignore this email.</p>`;
        // Fire-and-forget: don't let SMTP latency (or failure) shape the response time —
        // that would be an enumeration timing oracle — and don't leak a send error to the
        // caller. The token is already persisted; a failed send just means no link arrived.
        void sendMail({ to: dest, subject, text, html }).catch((err) =>
          logger.error('reset-request: sendMail failed', { owner: owner.id, err: (err as Error).message }),
        );
      }
    }

    ctx.body = NEUTRAL;
  });

  // Public: complete a reset. Body { token, newPassword }. Validates + consumes the
  // single-use token, argon2id-hashes the new password, and ALWAYS bumps the owner's
  // session epoch (D5 = invalidate every existing session, matching CI-Portal's
  // revokeSessionsOnPasswordReset). The user is then sent to /login to sign in fresh.
  router.post('/api/auth/reset', async (ctx) => {
    if (!localLoginEnabled()) throw httpError(404, 'password reset is not enabled');
    if (rateLimited(ctx.ip)) throw httpError(429, 'too many attempts — try again shortly');

    const { token, newPassword } = (ctx.request.body ?? {}) as { token?: unknown; newPassword?: unknown };
    if (typeof token !== 'string' || !token || typeof newPassword !== 'string') {
      throw httpError(400, 'token and newPassword are required');
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const ownerId = await consumeResetToken(token);
    if (!ownerId) throw httpError(400, 'this reset link is invalid or has expired — request a new one');

    const passwordHash = await hashPassword(newPassword);
    // Belt-and-suspenders sentinel guard (tokens are only ever issued for real owners).
    await store()
      .prepare(`UPDATE owners SET password_hash = ? WHERE id = ? AND id <> ?`)
      .run(passwordHash, ownerId, SYSTEM_OWNER_ID);
    // Invalidate all existing sessions for this owner (every device is signed out).
    await bumpSessionEpoch(ownerId);

    logger.info('password reset completed', { owner: ownerId });
    ctx.body = { ok: true };
  });

  // ── U1: CI-Portal SSO (OAuth 2.1 + PKCE Relying-Party login) ────────────────

  // Public: begins the login. The SPA does a TOP-LEVEL navigation here (not a
  // fetch), so unlike Google's /start (credentialed JSON) this 302s straight to the
  // portal. Rate-limited: each hit writes an auth_states row pre-authentication.
  router.get('/api/auth/ciportal/start', async (ctx) => {
    if (!ssoLoginEnabled()) throw httpError(404, 'Companion Portal login is not enabled');
    if (!ciportalConfigured()) {
      throw httpError(503, 'Companion Portal is not configured — set CIPORTAL_ISSUER + CIPORTAL_CLIENT_ID (see .env.example)');
    }
    if (rateLimited(ctx.ip)) throw httpError(429, 'too many login attempts — try again shortly');

    // Resolve endpoints via discovery FIRST — if the portal is unreachable/misconfigured
    // we 503 without minting a state row or setting the login cookie.
    let doc: OidcDiscoveryDoc;
    try {
      doc = await ciportalEndpoints();
    } catch (err) {
      logger.warn('CI-Portal discovery failed', { err: (err as Error).message });
      throw httpError(503, 'Companion Portal discovery failed — check CIPORTAL_ISSUER and connectivity to the portal');
    }

    // Opportunistic hygiene: expired rows are minted unauthenticated and abandoned
    // logins never consume theirs, so prune on every start.
    await store().prepare(`DELETE FROM auth_states WHERE expires_at <= ?`).run(new Date().toISOString());

    const codeVerifier = base64url(randomBytes(64)); // ~86 chars (within 43–128)
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    // Stored with the state so /callback exchanges the code with the SAME redirect_uri
    // the Portal saw (RFC 6749 §4.1.3), whichever of the two shapes this login used.
    const redirectUri = loginRedirectUriFor(ctx);

    const now = Date.now();
    await store()
      .prepare(
        `INSERT INTO auth_states (id, state, code_verifier, nonce, redirect_uri, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        state,
        codeVerifier,
        nonce,
        redirectUri,
        new Date(now).toISOString(),
        new Date(now + STATE_TTL_MS).toISOString(),
      );

    // Bind this login to the initiating browser (login-CSRF defense): the callback
    // will require the returned `state` to match this cookie before proceeding.
    setLoginState(ctx, state);

    // authorization_endpoint from discovery. redirect_uri is the configured value, or
    // the loopback form for a local-open browser — see loginRedirectUriFor for why an
    // arbitrary request Host never steers it. The code_verifier is NEVER in the URL —
    // only S256.
    const authUrl = new URL(doc.authorization_endpoint);
    const params = authUrl.searchParams;
    params.set('client_id', config.ciportal.clientId!);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('scope', config.ciportal.scopes);
    params.set('code_challenge', s256(codeVerifier));
    params.set('code_challenge_method', 'S256');
    params.set('state', state);
    params.set('nonce', nonce);

    logger.info('CI-Portal login start');
    ctx.redirect(authUrl.toString());
  });

  // Public (the portal redirects here with no app credential). The flow is resolved
  // SOLELY from the matched auth_states row + the verified id_token.
  router.get('/api/auth/ciportal/callback', async (ctx) => {
    if (!ssoLoginEnabled()) throw httpError(404, 'Companion Portal login is not enabled');
    if (!ciportalConfigured()) {
      throw httpError(503, 'Companion Portal is not configured — set the CIPORTAL_* variables (see .env.example)');
    }
    const error = typeof ctx.query.error === 'string' ? ctx.query.error : undefined;
    const code = typeof ctx.query.code === 'string' ? ctx.query.code : undefined;
    const state = typeof ctx.query.state === 'string' ? ctx.query.state : undefined;

    if (error) {
      // The portal itself declined (user cancelled, consent denied…) — bounce back
      // to the login screen with a displayable reason, mirroring Google's UX shape.
      logger.warn('CI-Portal callback returned provider error', { error });
      ctx.redirect(`/login?sso_error=${encodeURIComponent(error)}`);
      return;
    }

    if (!state || !code) {
      ctx.status = 400;
      ctx.body = { error: 'missing_state_or_code' };
      return;
    }

    // Login-CSRF defense (BEFORE consuming the state row): the returned `state` must
    // match the login-state cookie set on THIS browser at /start. A response replayed
    // into another browser has no matching cookie → rejected, so a victim can't be
    // silently logged into the attacker's account. Single-use (consume clears it).
    const boundState = consumeLoginState(ctx);
    if (!boundState || boundState !== state) {
      ctx.status = 400;
      ctx.body = { error: 'state_not_bound' };
      return;
    }

    // Atomically consume the state row (single-use): DELETE ... RETURNING means a
    // replayed callback finds nothing. Reject unknown / already-consumed states.
    const row = await store()
      .prepare(
        `DELETE FROM auth_states WHERE state = ?
         RETURNING id, code_verifier, nonce, redirect_uri, expires_at`,
      )
      .get<AuthStateRow>(state);

    if (!row) {
      ctx.status = 400;
      ctx.body = { error: 'unknown_or_consumed_state' };
      return;
    }
    if (new Date(row.expires_at) <= new Date()) {
      ctx.status = 400;
      ctx.body = { error: 'expired_state' };
      return;
    }

    // Resolve endpoints via discovery (the state is already consumed; a discovery
    // failure here is a genuine in-flight fault → 503).
    let doc: OidcDiscoveryDoc;
    try {
      doc = await ciportalEndpoints();
    } catch (err) {
      logger.warn('CI-Portal discovery failed in callback', { err: (err as Error).message });
      ctx.status = 503;
      ctx.body = { error: 'ci_portal_unavailable' };
      return;
    }

    // Exchange the authorization code (+ PKCE verifier) for tokens.
    const tokenParams: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      code_verifier: row.code_verifier,
      redirect_uri: row.redirect_uri ?? config.ciportal.redirectUri,
      client_id: config.ciportal.clientId ?? '',
    };
    if (config.ciportal.clientSecret) tokenParams.client_secret = config.ciportal.clientSecret;

    let tok: PortalTokenResponse;
    try {
      const res = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenParams).toString(),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn('CI-Portal token exchange failed', { status: res.status });
        ctx.status = 400;
        ctx.body = { error: 'token_exchange_failed', status: res.status };
        return;
      }
      tok = (await res.json()) as PortalTokenResponse;
    } catch (err) {
      logger.error('CI-Portal token exchange error', { err: (err as Error).message });
      ctx.status = 502;
      ctx.body = { error: 'token_exchange_error' };
      return;
    }

    // Identity comes ONLY from a fully-verified id_token (I1 — never decode-and-trust).
    // The nonce is always enforced: we minted one for this flow (auth_states.nonce
    // is NOT NULL), so a token from any other flow can't be spliced in.
    if (!tok.id_token) {
      ctx.status = 400;
      ctx.body = { error: 'no_id_token' };
      return;
    }
    // Validate `iss` against the DISCOVERY DOC's issuer, not the configured discovery
    // URL: better-auth serves discovery at `…/api/auth` but stamps the bare origin as
    // the token `iss`. Using doc.issuer is what makes real CI-Portal tokens verify.
    const claims = await verifyOidcIdToken(tok.id_token, {
      issuers: new Set([doc.issuer]),
      audience: config.ciportal.clientId,
      jwksUri: doc.jwks_uri,
      expectedNonce: row.nonce,
    });
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
      ctx.status = 400;
      ctx.body = { error: 'invalid_id_token' };
      return;
    }

    // sub → owner. EXCLUDES the sentinel owner (N-SENTINEL, U0): an external
    // login must never take over the single-owner dev/test identity.
    const owner = await findOwnerBySub(claims.sub);

    if (!owner) {
      if (!config.auth.autoProvision) {
        logger.warn('CI-Portal login rejected: unknown subject and auto-provision is off');
        ctx.status = 403;
        ctx.body = { error: 'unknown_subject_auto_provision_disabled' };
        return;
      }
      // A sub the SENTINEL holds is unknown to findOwnerBySub by design; refuse it here
      // rather than after asking the user to confirm an account that can never exist.
      if (await subHeldBySentinel(claims.sub)) {
        logger.warn('CI-Portal login rejected: subject is reserved (N-SENTINEL)');
        ctx.status = 403;
        ctx.body = { error: 'subject_unavailable' };
        return;
      }
      // B3: do NOT provision silently. Park the verified identity in a signed,
      // 10-minute intent cookie and let the person confirm on a no-JS page — the
      // guard against creating a tenant from the wrong Portal account (and, on an
      // operator-less instance, against accidentally claiming the operator role).
      setPortalIntent(ctx, portalIdentity(claims));
      logger.info('CI-Portal login: unknown subject — awaiting account confirmation');
      ctx.redirect('/api/auth/ciportal/confirm-account');
      return;
    }

    await setSession(ctx, owner.id);
    logger.info('CI-Portal login established', { owner: owner.id });
    ctx.redirect('/');
  });

  // ── B3: first-time portal sign-in confirmation (no-JS, CSRF-bound) ───────────

  // Public (the browser arrives here from the callback's redirect carrying only the
  // intent cookie). Renders "Create an account for <name>?" — a plain HTML form so it
  // works before the SPA has any session to boot with. An absent/expired/tampered
  // intent bounces to /login with a reason the login screen can show.
  router.get('/api/auth/ciportal/confirm-account', (ctx) => {
    if (!ssoLoginEnabled()) throw httpError(404, 'Companion Portal login is not enabled');
    const intent = readPortalIntent(ctx);
    if (!intent) {
      clearPortalIntent(ctx);
      ctx.redirect('/login?sso_error=confirmation_expired');
      return;
    }
    ctx.set('Cache-Control', 'no-store');
    ctx.type = 'html';
    ctx.body = renderConfirmAccountPage(intent);
  });

  // Public: the form's decision. `create` provisions through the same path a silent
  // provision used to take (A3 operator claim included) and signs in; `cancel` (or
  // anything else) provisions nothing. Both clear the intent. The CSRF token must
  // match the cookie's; auto-provision is re-checked so a policy flip between the
  // callback and the click still holds.
  router.post('/api/auth/ciportal/confirm-account', async (ctx) => {
    if (!ssoLoginEnabled()) throw httpError(404, 'Companion Portal login is not enabled');
    const intent = readPortalIntent(ctx);
    if (!intent) {
      clearPortalIntent(ctx);
      ctx.redirect('/login?sso_error=confirmation_expired');
      return;
    }
    const body = (ctx.request.body ?? {}) as { csrf?: unknown; decision?: unknown };
    if (!csrfMatches(intent, body.csrf)) {
      // Refused WITHOUT clearing the intent: the legitimate page in another tab must
      // still be able to confirm, and the attacker gains nothing from the refusal.
      ctx.status = 403;
      ctx.body = { error: 'invalid_csrf_token' };
      return;
    }
    clearPortalIntent(ctx);
    if (body.decision !== 'create') {
      logger.info('CI-Portal account confirmation declined — nothing provisioned');
      ctx.redirect('/login');
      return;
    }
    if (!config.auth.autoProvision) {
      logger.warn('CI-Portal account confirmation refused: auto-provision is off');
      ctx.status = 403;
      ctx.body = { error: 'unknown_subject_auto_provision_disabled' };
      return;
    }
    const outcome = await provisionPortalOwner(intent);
    if (outcome === 'subject_unavailable') {
      ctx.status = 403;
      ctx.body = { error: 'subject_unavailable' };
      return;
    }
    await setSession(ctx, outcome.id);
    logger.info('CI-Portal login established', { owner: outcome.id });
    ctx.redirect('/');
  });

  return router;
}

// ── Portal provisioning helpers (shared by the B3 confirmation POST) ─────────────

/** sub → owner, EXCLUDING the sentinel (N-SENTINEL). */
async function findOwnerBySub(sub: string): Promise<{ id: string } | undefined> {
  return store()
    .prepare(`SELECT id FROM owners WHERE external_subject = ? AND id <> ?`)
    .get<{ id: string }>(sub, SYSTEM_OWNER_ID);
}

/** Is this sub held by the sentinel row (which the owner lookup deliberately hides)? */
async function subHeldBySentinel(sub: string): Promise<boolean> {
  const held = await store().prepare(`SELECT id FROM owners WHERE external_subject = ?`).get<{ id: string }>(sub);
  return held?.id === SYSTEM_OWNER_ID;
}

/** The display identity a NEW owner is minted with, from verified claims only. */
function portalIdentity(claims: Record<string, unknown>): { sub: string; name: string; email?: string } {
  const name =
    (typeof claims.name === 'string' && claims.name) ||
    (typeof claims.email === 'string' && claims.email) ||
    'Portal user';
  const email = typeof claims.email === 'string' && claims.email ? claims.email : undefined;
  return { sub: claims.sub as string, name, email };
}

/**
 * Provision (or resolve) the owner for a confirmed portal identity. Phase AG closed
 * the "every SSO tenant is an admin" hole: a portal user is provisioned as a 'member'.
 * A3 adds the one exception, matching Companion Memory: on an instance with NO
 * operator yet — a portal-only install, where the install-time local admin was never
 * seeded — the FIRST portal login claims the operator role, so somebody can manage
 * accounts. Every later portal user is a member, and an operator promotes them via
 * /api/accounts if needed. The claim is decided inside the insert itself (see
 * provisionOwner). A sub provisioned meanwhile (two tabs confirming) is reused.
 */
async function provisionPortalOwner(identity: Pick<PortalIntent, 'sub' | 'name' | 'email'>): Promise<{ id: string } | 'subject_unavailable'> {
  const existing = await findOwnerBySub(identity.sub);
  if (existing) return existing;
  try {
    const id = await provisionOwner({
      name: identity.name, email: identity.email, externalSubject: identity.sub, claimOperatorIfNone: true,
    });
    const minted = await store().prepare(`SELECT role FROM owners WHERE id = ?`).get<{ role: string }>(id);
    logger.info('CI-Portal provisioned a new owner', { owner: id, role: minted?.role ?? 'member' });
    if (minted?.role === 'operator') {
      logger.warn('CI-Portal: first login on an instance with no operator — this owner is now the OPERATOR', { owner: id });
    }
    return { id };
  } catch (err) {
    // Two concurrent confirmations for the same sub: the UNIQUE(external_subject)
    // index makes the loser's insert throw — re-read and use the winner's row.
    const winner = await findOwnerBySub(identity.sub);
    if (winner) return winner;
    // Re-read still empty. Distinguish the one benign case — the sub is held by the
    // sentinel, which the owner lookup EXCLUDES (N-SENTINEL) — from a real provisioning
    // failure (a constraint deeper in provisionOwner's ~15 inserts). Only if the
    // sentinel holds it do we fail closed with 403; anything else must surface (500).
    if (await subHeldBySentinel(identity.sub)) {
      logger.warn('CI-Portal login rejected: subject is reserved (N-SENTINEL)');
      return 'subject_unavailable';
    }
    throw err; // real provisioning failure — do not mask as a 403
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The B3 confirmation page. Deliberately self-contained — inline styles on the app's
 * own palette, no script, no external assets — so it renders identically with JS off,
 * inside a webview, or before the SPA bundle is reachable. Every interpolated value is
 * escaped; the CSRF token rides in a hidden field the POST compares to the cookie.
 */
function renderConfirmAccountPage(intent: PortalIntent): string {
  const who = intent.email && intent.email !== intent.name
    ? `${escapeHtml(intent.name)} <span class="muted">(${escapeHtml(intent.email)})</span>`
    : escapeHtml(intent.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Create your Companion Planning account</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0b1114; color: #e2e8f0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 26rem; padding: 1.5rem; box-sizing: border-box; }
  .brand { text-align: center; margin-bottom: 1.5rem; }
  .brand .mark { width: 3rem; height: 3rem; margin: 0 auto .75rem; border-radius: 1rem;
                 background: linear-gradient(135deg, #58ebbf, #409b9b); }
  .brand .kicker { font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: #409b9b; font-weight: 500; }
  .brand .name { font-size: 1.25rem; letter-spacing: .04em; color: #f1f5f9; }
  .card { background: #121b1f; border: 1px solid #1f2a30; border-radius: .9rem; padding: 1.25rem; }
  h1 { font-size: 1rem; margin: 0 0 .5rem; }
  p { margin: 0 0 .75rem; color: #94a3b8; font-size: .9rem; }
  .who { color: #e2e8f0; font-weight: 600; }
  .muted { color: #94a3b8; font-weight: 400; }
  form { display: flex; flex-direction: column; gap: .6rem; margin-top: 1rem; }
  button { font: inherit; border-radius: .6rem; padding: .6rem 1rem; cursor: pointer; border: 1px solid transparent; }
  .primary { background: #58ebbf; color: #0b1114; font-weight: 600; }
  .ghost { background: transparent; color: #94a3b8; border-color: #1f2a30; }
  footer { text-align: center; font-size: 11px; color: #64748b; margin-top: 1rem; }
</style>
</head>
<body>
<main>
  <div class="brand"><div class="mark"></div><div class="kicker">Companion</div><div class="name">Planning</div></div>
  <div class="card">
    <h1>Create a Companion Planning account?</h1>
    <p>You signed in to Companion Portal as <span class="who">${who}</span>, but there is no Companion Planning account for it yet.</p>
    <p>Create one now, or cancel if this isn't the account you meant to use.</p>
    <form method="post" action="/api/auth/ciportal/confirm-account">
      <input type="hidden" name="csrf" value="${escapeHtml(intent.csrf)}">
      <button type="submit" class="primary" name="decision" value="create">Create account</button>
      <button type="submit" class="ghost" name="decision" value="cancel">Cancel</button>
    </form>
  </div>
  <footer>Companion Planning</footer>
</main>
</body>
</html>
`;
}
