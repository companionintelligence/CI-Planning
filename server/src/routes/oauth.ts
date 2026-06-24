import Router from '@koa/router';
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { currentOwnerId, runWithOwner } from '../lib/context.js';
import { loadKek, open } from '../lib/crypto/index.js';
import { BaseOAuth2Client, revoke } from '../connectors/index.js';

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

/** base64url-encode a buffer (RFC 7636 / 4648 §5) — no padding, URL-safe alphabet. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256 challenge: base64url(SHA-256(verifier)). */
function s256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

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

interface IdTokenClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  email?: string;
  nonce?: string;
  [k: string]: unknown;
}

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GOOGLE_JWKS_URI = process.env.CP_GOOGLE_JWKS_URI ?? 'https://www.googleapis.com/oauth2/v3/certs';

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** Fetch Google's signing keys (JWKS). Returns [] on any failure (treated as unverifiable). */
async function fetchGoogleJwks(): Promise<Jwk[]> {
  try {
    const res = await fetch(GOOGLE_JWKS_URI);
    if (!res.ok) return [];
    const json = (await res.json()) as { keys?: Jwk[] };
    return Array.isArray(json.keys) ? json.keys : [];
  } catch {
    return [];
  }
}

/**
 * Verify a Google id_token end to end (I1). Returns the claims ONLY if:
 *  - it is a well-formed 3-segment RS256 JWT,
 *  - its signature checks against a JWKS key (matched by `kid`),
 *  - iss ∈ {accounts.google.com, https://accounts.google.com},
 *  - aud === config.google.clientId,
 *  - exp is in the future,
 *  - nonce matches the one we stored (when we issued one).
 * A tampered / unsigned / alg=none token returns null — it can NEVER establish identity.
 */
async function verifyIdToken(idToken: string, expectedNonce: string | null): Promise<IdTokenClaims | null> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  // Reject anything that isn't an asymmetric RS256 signature (notably alg=none).
  if (header.alg !== 'RS256') return null;
  if (!signatureB64) return null;

  const jwks = await fetchGoogleJwks();
  const candidates = header.kid ? jwks.filter((k) => k.kid === header.kid) : jwks;
  if (candidates.length === 0) return null;

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, 'base64url');

  let signatureValid = false;
  for (const jwk of candidates) {
    if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    try {
      const key = createPublicKey({ key: jwk as object, format: 'jwk' });
      if (cryptoVerify('RSA-SHA256', signingInput, key, signature)) {
        signatureValid = true;
        break;
      }
    } catch {
      // try the next key
    }
  }
  if (!signatureValid) return null;

  // Signature is genuine — now enforce the registered-claims contract.
  if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) return null;
  if (!config.google.clientId || claims.aud !== config.google.clientId) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
  if (expectedNonce && claims.nonce !== expectedNonce) return null;

  return claims;
}

interface OAuthStateRow {
  id: string;
  owner_id: string;
  code_verifier: string;
  nonce: string | null;
  redirect_uri: string | null;
  scopes: string | null;
}

export function oauthRouter() {
  const router = new Router({ prefix: '/api/oauth/google' });

  // ── GET /api/oauth/google/start ───────────────────────────────────────────
  // Begin the Authorization Code + PKCE flow. Refused in test mode (no real owner
  // identity to bind the connection to — I2).
  router.get('/start', (ctx) => {
    if (config.auth.mode === 'test') {
      ctx.status = 409;
      ctx.body = { error: 'oauth_disabled_in_test_mode' };
      return;
    }

    const ownerId = currentOwnerId();
    const codeVerifier = base64url(randomBytes(64)); // ~86 chars (within 43–128)
    const codeChallenge = s256(codeVerifier);
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));

    // Calendar scopes always; Gmail only when explicitly enabled via env.
    const scopes = [...config.google.scopes.calendar];
    if (config.google.enableGmail) scopes.push(...config.google.scopes.gmail);

    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO oauth_states (id, owner_id, provider, state, code_verifier, nonce, redirect_uri, scopes, created_at, expires_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        ownerId,
        state,
        codeVerifier,
        nonce,
        config.google.redirectUri,
        JSON.stringify(scopes),
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
    const row = sqlite
      .prepare(
        `DELETE FROM oauth_states WHERE state = ? AND provider = 'google'
         RETURNING id, owner_id, code_verifier, nonce, redirect_uri, scopes, expires_at`,
      )
      .get(state) as (OAuthStateRow & { expires_at: string | null }) | undefined;

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
      const existing = sqlite
        .prepare(
          'SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?',
        )
        .get(row.owner_id, 'google', email) as { iv: string; auth_tag: string; ciphertext: string } | undefined;
      if (existing) {
        const decoded = JSON.parse(
          open({ iv: existing.iv, authTag: existing.auth_tag, ciphertext: existing.ciphertext }, loadKek()),
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
    runWithOwner(row.owner_id, () => {
      BaseOAuth2Client.storeToken('google', email, {
        accessToken: tok.access_token!,
        refreshToken,
        expiresAt,
      });
      sqlite
        .prepare(
          `UPDATE connection_tokens SET status = 'active'
           WHERE owner_id = ? AND provider = 'google' AND account = ?`,
        )
        .run(row.owner_id, email);
    });

    logger.info('OAuth connection established', { provider: 'google', owner: row.owner_id });
    ctx.redirect(settingsRedirect('google=connected'));
  });

  // ── GET /api/oauth/google/accounts ──────────────────────────────────────────
  // Gated. Lists connected accounts WITHOUT leaking any ciphertext/iv/tokens.
  router.get('/accounts', (ctx) => {
    const ownerId = currentOwnerId();
    const rows = sqlite
      .prepare(
        `SELECT account, status, updated_at FROM connection_tokens
         WHERE owner_id = ? AND provider = 'google' ORDER BY account`,
      )
      .all(ownerId) as { account: string; status: string; updated_at: string }[];
    ctx.body = { accounts: rows };
  });

  // ── DELETE /api/oauth/google/accounts/:account ──────────────────────────────
  // Gated. Best-effort token revoke at Google, then delete the connection AND any
  // pending outbound queue rows for it (I12) so a re-connect starts clean.
  router.delete('/accounts/:account', async (ctx) => {
    const ownerId = currentOwnerId();
    const account = ctx.params.account;

    // Best-effort revoke using the stored refresh token (decrypted just-in-time).
    const tokRow = sqlite
      .prepare(
        'SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?',
      )
      .get(ownerId, 'google', account) as { iv: string; auth_tag: string; ciphertext: string } | undefined;

    if (tokRow) {
      try {
        const decoded = JSON.parse(
          open({ iv: tokRow.iv, authTag: tokRow.auth_tag, ciphertext: tokRow.ciphertext }, loadKek()),
        ) as { refreshToken?: string; accessToken?: string };
        const token = decoded.refreshToken || decoded.accessToken;
        if (token) await revoke(token);
      } catch (err) {
        logger.warn('Could not decrypt token for revoke (continuing)', { err: (err as Error).message });
      }
    }

    const delTokens = sqlite
      .prepare("DELETE FROM connection_tokens WHERE owner_id = ? AND provider = 'google' AND account = ?")
      .run(ownerId, account);
    sqlite
      .prepare("DELETE FROM outbound_queue WHERE owner_id = ? AND provider = 'google' AND account = ?")
      .run(ownerId, account);

    if (delTokens.changes === 0) {
      ctx.status = 404;
      ctx.body = { error: 'account_not_found' };
      return;
    }

    logger.info('OAuth connection removed', { provider: 'google', owner: ownerId });
    ctx.body = { disconnected: account };
  });

  return router;
}
