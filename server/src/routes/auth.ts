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
import { sendMail } from '../lib/mail/index.js';

/**
 * The `/api/auth/*` router.
 *
 * U2 — local username/password login (`AUTH_MODE=sso && DISABLE_OIDC=true`):
 *   POST /api/auth/login · POST /api/auth/logout
 * U1 — CI-Portal SSO login (`AUTH_MODE=sso && DISABLE_OIDC=false`), a full OAuth 2.1
 * Authorization-Code + PKCE(S256) Relying-Party flow mirroring the proven Google
 * connector flow (routes/oauth.ts), with the two structural differences the plan
 * calls out: state rows live in `auth_states` (no owner exists pre-login), and the
 * callback resolves/provisions an OWNER + starts a SESSION instead of storing a
 * connection token:
 *   GET /api/auth/ciportal/start · GET /api/auth/ciportal/callback
 * Shared:
 *   GET /api/auth/config (public — which mode is active; the U3 bootstrap probe)
 *   GET /api/auth/me     (gated — session/identity probe for the client shell)
 *
 * Both login paths end identically: a signed httpOnly session cookie (lib/auth/
 * session.ts), so requireAuth treats their requests the same.
 */

const STATE_TTL_MS = 10 * 60 * 1000; // authorize redirects are short-lived (10 min)
const MIN_PASSWORD_LENGTH = 8;       // V: server-side floor for a reset password (client also checks)

// Minimal in-memory sliding-window limiter — the consumer of config.auth.rateLimit.
// Bounds `issueMax` attempts per `windowMs` for a given KEY. In-process only (single-node
// deployment); resets on restart. Keys are namespaced so different axes don't collide:
// `ip:<addr>` for per-IP (login, ciportal start, reset-request) and `reset:<identifier>`
// for the per-account reset-request axis (V9 — hammering one account's mailbox).
const attempts = new Map<string, number[]>();
// Once-per-process latch for the reset-request "SMTP not configured" warning — the
// endpoint is public, so a per-request warn would let anyone spam the logs.
let warnedResetWithoutSmtp = false;
function rateLimitedKey(key: string): boolean {
  const { windowMs, issueMax } = config.auth.rateLimit;
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  attempts.set(key, recent);
  if (recent.length >= issueMax) return true;
  recent.push(now);
  return false;
}
/** Per-IP limiter (login, ciportal start). */
function rateLimited(ip: string): boolean {
  return rateLimitedKey(`ip:${ip}`);
}

const localLoginEnabled = () => config.auth.mode === 'sso' && config.auth.disableOidc;
/** CI-Portal SSO active (shared by the login flow AND the AA0b memory connector flow). */
export const ssoLoginEnabled = () => config.auth.mode === 'sso' && !config.auth.disableOidc;

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

  // Public (no credential): tells the client which auth mode is active, so the SPA
  // knows whether to show a login screen at all (U3 consumes this).
  router.get('/api/auth/config', (ctx) => {
    ctx.body = { mode: config.auth.mode, disableOidc: config.auth.disableOidc };
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
    if (!ssoLoginEnabled()) throw httpError(404, 'CI-Portal login is not enabled');
    if (!ciportalConfigured()) {
      throw httpError(503, 'CI-Portal is not configured — set CIPORTAL_ISSUER + CIPORTAL_CLIENT_ID (see .env.example)');
    }
    if (rateLimited(ctx.ip)) throw httpError(429, 'too many login attempts — try again shortly');

    // Resolve endpoints via discovery FIRST — if the portal is unreachable/misconfigured
    // we 503 without minting a state row or setting the login cookie.
    let doc: OidcDiscoveryDoc;
    try {
      doc = await ciportalEndpoints();
    } catch (err) {
      logger.warn('CI-Portal discovery failed', { err: (err as Error).message });
      throw httpError(503, 'CI-Portal discovery failed — check CIPORTAL_ISSUER / tailnet connectivity');
    }

    // Opportunistic hygiene: expired rows are minted unauthenticated and abandoned
    // logins never consume theirs, so prune on every start.
    await store().prepare(`DELETE FROM auth_states WHERE expires_at <= ?`).run(new Date().toISOString());

    const codeVerifier = base64url(randomBytes(64)); // ~86 chars (within 43–128)
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));

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
        config.ciportal.redirectUri,
        new Date(now).toISOString(),
        new Date(now + STATE_TTL_MS).toISOString(),
      );

    // Bind this login to the initiating browser (login-CSRF defense): the callback
    // will require the returned `state` to match this cookie before proceeding.
    setLoginState(ctx, state);

    // authorization_endpoint from discovery. redirect_uri is taken VERBATIM from config
    // — never recomputed from the request host (an attacker-controlled Host header must
    // not steer the OAuth redirect). The code_verifier is NEVER in the URL — only S256.
    const authUrl = new URL(doc.authorization_endpoint);
    const params = authUrl.searchParams;
    params.set('client_id', config.ciportal.clientId!);
    params.set('redirect_uri', config.ciportal.redirectUri);
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
    if (!ssoLoginEnabled()) throw httpError(404, 'CI-Portal login is not enabled');
    if (!ciportalConfigured()) {
      throw httpError(503, 'CI-Portal is not configured — set the CIPORTAL_* variables (see .env.example)');
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
    const findBySub = store().prepare(`SELECT id FROM owners WHERE external_subject = ? AND id <> ?`);
    let owner = await findBySub.get<{ id: string }>(claims.sub, SYSTEM_OWNER_ID);

    if (!owner) {
      if (!config.auth.autoProvision) {
        logger.warn('CI-Portal login rejected: unknown subject and auto-provision is off');
        ctx.status = 403;
        ctx.body = { error: 'unknown_subject_auto_provision_disabled' };
        return;
      }
      const name =
        (typeof claims.name === 'string' && claims.name) ||
        (typeof claims.email === 'string' && claims.email) ||
        'Portal user';
      const email = typeof claims.email === 'string' ? claims.email : undefined;
      try {
        // Phase AG: an auto-provisioned portal user is a 'member', never an operator —
        // this is what closes the "every SSO tenant is an admin" hole. An operator
        // promotes them via /api/accounts if they should run the instance.
        owner = { id: await provisionOwner({ name, email, externalSubject: claims.sub, role: 'member' }) };
        logger.info('CI-Portal auto-provisioned a new owner', { owner: owner.id });
      } catch (err) {
        // Two concurrent first-logins for the same sub: the UNIQUE(external_subject)
        // index makes the loser's insert throw — re-read and use the winner's row.
        owner = await findBySub.get<{ id: string }>(claims.sub, SYSTEM_OWNER_ID);
        if (!owner) {
          // Re-read still empty. Distinguish the one benign case — the sub is held by
          // the sentinel, which the owner lookup EXCLUDES (N-SENTINEL) — from a real
          // provisioning failure (a constraint deeper in provisionOwner's ~15 inserts).
          // Query INCLUDING the sentinel: only if IT holds the sub do we fail closed
          // with 403; anything else is a genuine internal fault that must surface (500).
          const held = await store()
            .prepare(`SELECT id FROM owners WHERE external_subject = ?`)
            .get<{ id: string }>(claims.sub);
          if (held?.id === SYSTEM_OWNER_ID) {
            logger.warn('CI-Portal login rejected: subject is reserved (N-SENTINEL)');
            ctx.status = 403;
            ctx.body = { error: 'subject_unavailable' };
            return;
          }
          throw err; // real provisioning failure — do not mask as a 403
        }
      }
    }

    await setSession(ctx, owner.id);
    logger.info('CI-Portal login established', { owner: owner.id });
    ctx.redirect('/');
  });

  return router;
}
