import Router from '@koa/router';
import { randomBytes } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { newId, SYSTEM_OWNER_ID } from '../lib/ids.js';
import { currentOwnerId } from '../lib/context.js';
import { httpError } from '../lib/http-error.js';
import { provisionOwner } from '../lib/owners.js';
import { base64url, s256 } from '../lib/auth/pkce.js';
import { verifyOidcIdToken } from '../lib/auth/verifyOidcIdToken.js';
import { findOwnerByUsername, verifyLoginPassword } from '../lib/auth/password.js';
import { setSession, clearSession, setLoginState, consumeLoginState } from '../lib/auth/session.js';

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

// Minimal in-memory sliding-window limiter — the first real consumer of
// config.auth.rateLimit. Keyed by client IP; bounds `issueMax` login attempts per
// `windowMs`. In-process only (single-node deployment); resets on restart. Also
// applied to /ciportal/start: it's public and writes an auth_states row per hit.
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
const ssoLoginEnabled = () => config.auth.mode === 'sso' && !config.auth.disableOidc;

/** All CI-Portal endpoint values present? (No invented defaults — see config.ts.) */
function ciportalConfigured(): boolean {
  const c = config.ciportal;
  return Boolean(c.clientId && c.issuer && c.authorizeUri && c.tokenUri && c.jwksUri);
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
  router.get('/api/auth/me', (ctx) => {
    const ownerId = currentOwnerId();
    const row = sqlite
      .prepare(`SELECT id, name, email, username FROM owners WHERE id = ?`)
      .get(ownerId) as { id: string; name: string; email: string | null; username: string | null } | undefined;
    if (!row) throw httpError(401, 'unknown owner');
    ctx.body = { ownerId: row.id, name: row.name, email: row.email, username: row.username };
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
    // app.keys is unset — and app.keys is only set in sso mode. Without this guard,
    // an unauthenticated logout in standalone/test mode 500s.
    if (config.auth.mode !== 'sso') throw httpError(404, 'sessions are not enabled');
    clearSession(ctx);
    ctx.body = { ok: true };
  });

  // ── U1: CI-Portal SSO (OAuth 2.1 + PKCE Relying-Party login) ────────────────

  // Public: begins the login. The SPA does a TOP-LEVEL navigation here (not a
  // fetch), so unlike Google's /start (credentialed JSON) this 302s straight to the
  // portal. Rate-limited: each hit writes an auth_states row pre-authentication.
  router.get('/api/auth/ciportal/start', (ctx) => {
    if (!ssoLoginEnabled()) throw httpError(404, 'CI-Portal login is not enabled');
    if (!ciportalConfigured()) {
      throw httpError(503, 'CI-Portal is not configured — set the CIPORTAL_* variables (see .env.example)');
    }
    if (rateLimited(ctx.ip)) throw httpError(429, 'too many login attempts — try again shortly');

    // Opportunistic hygiene: expired rows are minted unauthenticated and abandoned
    // logins never consume theirs, so prune on every start.
    sqlite.prepare(`DELETE FROM auth_states WHERE expires_at <= ?`).run(new Date().toISOString());

    const codeVerifier = base64url(randomBytes(64)); // ~86 chars (within 43–128)
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));

    const now = Date.now();
    sqlite
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

    // redirect_uri is taken VERBATIM from config — never recomputed from the request
    // host (an attacker-controlled Host header must not steer the OAuth redirect).
    // The code_verifier is NEVER placed in the URL — only the S256 challenge.
    const authUrl = new URL(config.ciportal.authorizeUri!);
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
    const row = sqlite
      .prepare(
        `DELETE FROM auth_states WHERE state = ?
         RETURNING id, code_verifier, nonce, redirect_uri, expires_at`,
      )
      .get(state) as AuthStateRow | undefined;

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
      const res = await fetch(config.ciportal.tokenUri!, {
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
    const claims = await verifyOidcIdToken(tok.id_token, {
      issuers: new Set([config.ciportal.issuer!]),
      audience: config.ciportal.clientId,
      jwksUri: config.ciportal.jwksUri!,
      expectedNonce: row.nonce,
    });
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
      ctx.status = 400;
      ctx.body = { error: 'invalid_id_token' };
      return;
    }

    // sub → owner. EXCLUDES the sentinel owner (N-SENTINEL, U0): an external
    // login must never take over the single-owner dev/test identity.
    const findBySub = sqlite.prepare(`SELECT id FROM owners WHERE external_subject = ? AND id <> ?`);
    let owner = findBySub.get(claims.sub, SYSTEM_OWNER_ID) as { id: string } | undefined;

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
        owner = { id: provisionOwner({ name, email, externalSubject: claims.sub }) };
        logger.info('CI-Portal auto-provisioned a new owner', { owner: owner.id });
      } catch (err) {
        // Two concurrent first-logins for the same sub: the UNIQUE(external_subject)
        // index makes the loser's insert throw — re-read and use the winner's row.
        owner = findBySub.get(claims.sub, SYSTEM_OWNER_ID) as { id: string } | undefined;
        if (!owner) {
          // Re-read still empty. Distinguish the one benign case — the sub is held by
          // the sentinel, which the owner lookup EXCLUDES (N-SENTINEL) — from a real
          // provisioning failure (a constraint deeper in provisionOwner's ~15 inserts).
          // Query INCLUDING the sentinel: only if IT holds the sub do we fail closed
          // with 403; anything else is a genuine internal fault that must surface (500).
          const held = sqlite
            .prepare(`SELECT id FROM owners WHERE external_subject = ?`)
            .get(claims.sub) as { id: string } | undefined;
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

    setSession(ctx, owner.id);
    logger.info('CI-Portal login established', { owner: owner.id });
    ctx.redirect('/');
  });

  return router;
}
