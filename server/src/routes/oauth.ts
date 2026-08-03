import Router from '@koa/router';
import { randomBytes } from 'node:crypto';
import { store } from '../db/store.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { currentOwnerId, runWithOwner } from '../lib/context.js';
import { SCOPE_READ, SCOPE_WRITE } from '../lib/auth/types.js';
import { loadKek, open } from '../lib/crypto/index.js';
import { verifyOidcIdToken, type OidcClaims } from '../lib/auth/verifyOidcIdToken.js';
import { base64url, s256 } from '../lib/auth/pkce.js';
import { BaseOAuth2Client } from '../connectors/index.js';
import { disconnectConnection } from '../lib/connections.js';
import { buildGoogleScopes } from '../mcp/gmail-flag.js';

/**
 * WP2 — standalone Google OAuth 2.1 (Authorization Code + PKCE/S256). Auth-only:
 * after a successful callback there is an `active` connection_tokens row and
 * BaseOAuth2Client.getAccessToken() returns a live, self-refreshing token. No live
 * MCP / calendar calls here (WP4).
 *
 * Routes (all under /api/oauth/google):
 *   GET    /start              → returns { url } for the SPA to navigate to (refused in test mode)
 *   GET    /callback           → exchanges the code, stores tokens, 302 to the SPA
 *   GET    /accounts           → list connected accounts (status only, no secrets)
 *   DELETE /accounts/:account  → revoke + delete the connection
 *
 * The callback is in requireAuth's PUBLIC_PREFIXES (Google redirects with no app
 * credential); it resolves the owner SOLELY from the matched oauth_states row (I2).
 */

const STATE_TTL_MS = 10 * 60 * 1000; // authorize redirects are short-lived (10 min)

/** Where the SPA settings page lives; the callback bounces back here. */
function settingsRedirect(query: string): string {
  return `${config.google.publicBaseUrl}/settings?${query}`;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
  email?: string;
}

/**
 * Resolve the connected account's email. Order of trust (I1 — NEVER decode-and-trust):
 *  1. A direct `email` field on the token response, if Google ever returns one.
 *  2. The id_token, but ONLY after full JWKS signature + claims verification.
 * Returns null when neither yields a verified email.
 */
async function resolveAccountEmail(tok: GoogleTokenResponse, expectedNonce: string | null): Promise<string | null> {
  if (typeof tok.email === 'string' && tok.email.includes('@')) return tok.email;
  if (tok.id_token) {
    const claims = await verifyIdToken(tok.id_token, expectedNonce);
    if (claims?.email && typeof claims.email === 'string') return claims.email;
  }
  return null;
}

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GOOGLE_JWKS_URI = process.env.CP_GOOGLE_JWKS_URI ?? 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * Verify a Google id_token end to end (I1) — delegates to the SHARED OIDC verifier
 * (lib/auth/verifyOidcIdToken.ts, extracted from this file's original implementation
 * in U1 so the CI-Portal login and this connector share one copy of the JWKS/RS256/
 * claims-contract code). Same guarantees as before: tampered / unsigned / alg=none /
 * wrong-iss / wrong-aud / expired / nonce-mismatched tokens can NEVER establish identity.
 */
function verifyIdToken(idToken: string, expectedNonce: string | null): Promise<OidcClaims | null> {
  return verifyOidcIdToken(idToken, {
    issuers: GOOGLE_ISSUERS,
    audience: config.google.clientId,
    jwksUri: GOOGLE_JWKS_URI,
    expectedNonce,
  });
}

interface OAuthStateRow {
  id: string;
  owner_id: string;
  code_verifier: string;
  nonce: string | null;
  redirect_uri: string | null;
}

export function oauthRouter() {
  const router = new Router({ prefix: '/api/oauth/google' });

  // ── GET /api/oauth/google/start ───────────────────────────────────────────
  // Begin the Authorization Code + PKCE flow. Refused in test mode (no real owner
  // identity to bind the connection to — I2).
  router.get('/start', async (ctx) => {
    if (config.auth.mode === 'test') {
      ctx.status = 409;
      ctx.body = { error: 'oauth_disabled_in_test_mode' };
      return;
    }
    // Fail closed: a connect attempt in off/fixture mode would mint a broken authorize
    // URL (no client_id). The Settings button is disabled in these modes; this guards
    // direct API calls too.
    if (config.google.mode !== 'live') {
      ctx.status = 409;
      ctx.body = { error: 'google_mode_not_live' };
      return;
    }

    const ownerId = currentOwnerId();
    const codeVerifier = base64url(randomBytes(64)); // ~86 chars (within 43–128)
    const codeChallenge = s256(codeVerifier);
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));

    const scopes = buildGoogleScopes({ gmail: true });

    const now = Date.now();
    await store()
      .prepare(
        `INSERT INTO oauth_states (id, owner_id, provider, state, code_verifier, nonce, redirect_uri, created_at, expires_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        ownerId,
        state,
        codeVerifier,
        nonce,
        config.google.redirectUri,
        new Date(now).toISOString(),
        new Date(now + STATE_TTL_MS).toISOString(),
      );

    // Build the authorize URL. redirect_uri is taken VERBATIM from config — never
    // recomputed from the request host (an attacker-controlled Host header must not
    // be able to steer the OAuth redirect).
    const authUrl = new URL(config.google.authUri);
    const params = authUrl.searchParams;
    if (config.google.clientId) params.set('client_id', config.google.clientId);
    params.set('redirect_uri', config.google.redirectUri);
    params.set('response_type', 'code');
    params.set('scope', scopes.join(' '));
    params.set('access_type', 'offline'); // ask for a refresh_token
    params.set('prompt', 'consent'); // force the refresh_token to be (re)issued
    params.set('include_granted_scopes', 'true');
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
    params.set('state', state);
    params.set('nonce', nonce);

    // The code_verifier is NEVER placed in the URL or logged — only the challenge.
    // Return the authorize URL as JSON rather than a 302: /start is credentialed
    // (x-api-key), so the SPA fetches it with the key, then does a top-level browser
    // navigation to Google. A 302 here would be followed by fetch() and fail to parse.
    logger.info('OAuth start', { provider: 'google', owner: ownerId });
    ctx.body = { url: authUrl.toString() };
  });

  // ── GET /api/oauth/google/callback ──────────────────────────────────────────
  // Public (no app credential — Google's redirect). Owner is resolved SOLELY from
  // the matched oauth_states row (I2).
  router.get('/callback', async (ctx) => {
    const error = typeof ctx.query.error === 'string' ? ctx.query.error : undefined;
    const code = typeof ctx.query.code === 'string' ? ctx.query.code : undefined;
    const state = typeof ctx.query.state === 'string' ? ctx.query.state : undefined;

    if (error) {
      logger.warn('OAuth callback returned provider error', { error });
      ctx.redirect(settingsRedirect(`google=error&reason=${encodeURIComponent(error)}`));
      return;
    }

    if (!state || !code) {
      ctx.status = 400;
      ctx.body = { error: 'missing_state_or_code' };
      return;
    }

    // Atomically consume the state row (single-use): DELETE ... RETURNING means a
    // replayed callback finds nothing. Reject unknown / already-consumed states.
    const row = await store()
      .prepare(
        `DELETE FROM oauth_states WHERE state = ? AND provider = 'google'
         RETURNING id, owner_id, code_verifier, nonce, redirect_uri, expires_at`,
      )
      .get<OAuthStateRow & { expires_at: string | null }>(state);

    if (!row) {
      ctx.status = 400;
      ctx.body = { error: 'unknown_or_consumed_state' };
      return;
    }
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      ctx.status = 400;
      ctx.body = { error: 'expired_state' };
      return;
    }

    // Exchange the authorization code (+ PKCE verifier) for tokens.
    const tokenParams: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      code_verifier: row.code_verifier,
      redirect_uri: row.redirect_uri ?? config.google.redirectUri,
    };
    if (config.google.clientId) tokenParams.client_id = config.google.clientId;
    if (config.google.clientSecret) tokenParams.client_secret = config.google.clientSecret;

    let tok: GoogleTokenResponse;
    try {
      const res = await fetch(config.google.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(tokenParams).toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn('OAuth token exchange failed', { status: res.status });
        ctx.status = 400;
        ctx.body = { error: 'token_exchange_failed', status: res.status, detail: text.slice(0, 200) };
        return;
      }
      tok = (await res.json()) as GoogleTokenResponse;
    } catch (err) {
      logger.error('OAuth token exchange error', { err: (err as Error).message });
      ctx.status = 502;
      ctx.body = { error: 'token_exchange_error' };
      return;
    }

    if (!tok.access_token) {
      ctx.status = 400;
      ctx.body = { error: 'no_access_token' };
      return;
    }

    const email = await resolveAccountEmail(tok, row.nonce);
    if (!email) {
      ctx.status = 400;
      ctx.body = { error: 'could_not_verify_account_identity' };
      return;
    }

    // Reconcile the refresh token: Google omits it on a re-consent if one already
    // exists, so reuse the stored value rather than persisting an empty one (I4).
    let existingRefresh: string | null = null;
    try {
      const existing = await store()
        .prepare(
          'SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?',
        )
        .get<{ iv: string; auth_tag: string; ciphertext: string }>(row.owner_id, 'google', email);
      if (existing) {
        const decoded = JSON.parse(
          open({ iv: existing.iv, authTag: existing.auth_tag, ciphertext: existing.ciphertext }, await loadKek()),
        ) as { refreshToken?: string };
        existingRefresh = decoded.refreshToken ?? null;
      }
    } catch (err) {
      logger.warn('Could not read existing connection token for refresh merge', {
        err: (err as Error).message,
      });
    }

    let refreshToken: string;
    try {
      refreshToken = BaseOAuth2Client.mergeRefreshToken(existingRefresh, tok.refresh_token ?? null);
    } catch {
      // Both empty: no usable refresh token at all — refuse rather than store a
      // connection that can never self-refresh.
      ctx.status = 400;
      ctx.body = { error: 'no_refresh_token' };
      return;
    }

    const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();

    // Store under the state's owner (NOT the request's — the callback is credential-less).
    // A normal owner context (no admin) — this only writes the owner's own connector token.
    await runWithOwner(row.owner_id, [SCOPE_READ, SCOPE_WRITE], async () => {
      // Awaited: the UPDATE below activates the very row this writes. Floated, the
      // status flip would run first and match nothing, leaving the connection stored
      // but never 'active' — and getConnectors()/googleAccounts() both filter on
      // status='active', so the account would silently never sync.
      await BaseOAuth2Client.storeToken('google', email, {
        accessToken: tok.access_token!,
        refreshToken,
        expiresAt,
      });
      await store()
        .prepare(
          `UPDATE connection_tokens SET status = 'active'
           WHERE owner_id = ? AND provider = 'google' AND account = ?`,
        )
        .run(row.owner_id, email);
    });

    logger.info('OAuth connection established', { provider: 'google', owner: row.owner_id });
    ctx.redirect(settingsRedirect('google=connected'));
  });

  // ── DELETE /api/oauth/google/accounts/:account ──────────────────────────────
  // Gated. Best-effort token revoke at Google, then delete the connection AND any
  // pending outbound queue rows for it (I12) so a re-connect starts clean. The
  // revoke+delete+queue-cleanup body lives in the shared disconnectConnection()
  // (server/src/lib/connections.ts), which the generic DELETE /api/connections/
  // :provider/:account route (T13 #349) also delegates to. This route keeps its
  // original { disconnected: account } / 404 { error: 'account_not_found' } contract.
  // (The former dead GET /accounts list route was removed in T13 — Settings sources
  // the account list from GET /api/connections + /api/integrations.)
  router.delete('/accounts/:account', async (ctx) => {
    const ownerId = currentOwnerId();
    const account = ctx.params.account;

    const removed = await disconnectConnection(ownerId, 'google', account);
    if (!removed) {
      ctx.status = 404;
      ctx.body = { error: 'account_not_found' };
      return;
    }

    logger.info('OAuth connection removed', { provider: 'google', owner: ownerId });
    ctx.body = { disconnected: account };
  });

  return router;
}
