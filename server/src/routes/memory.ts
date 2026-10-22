import Router from '@koa/router';
import { randomBytes } from 'node:crypto';
import { currentOwnerId, runWithOwner } from '../lib/context.js';
import { store } from '../db/store.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { newId, SYSTEM_OWNER_ID } from '../lib/ids.js';
import { httpError } from '../lib/http-error.js';
import { writeAudit } from '../lib/audit.js';
import { SCOPE_READ, SCOPE_WRITE } from '../lib/auth/types.js';
import { base64url, s256 } from '../lib/auth/pkce.js';
import { verifyOidcIdToken } from '../lib/auth/verifyOidcIdToken.js';
import type { OidcDiscoveryDoc } from '../lib/auth/oidcDiscovery.js';
import { ciportalConfigured, ssoLoginEnabled, ciportalEndpoints } from './auth.js';
import { memoryStatus, syncToMemory } from '../services/memory.js';
import { listConnections, disconnectConnection } from '../lib/connections.js';
import {
  storeMemoryConnection,
  storeMemoryOidcConnection,
  memoryOidcSubject,
  MEMORY_PROVIDER,
} from '../connectors/memory.js';
import { suggestFromMemory } from '../agents/memory-suggest.js';

const STATE_TTL_MS = 10 * 60 * 1000; // authorize redirects are short-lived (10 min)
// A hung CI-Portal token endpoint must not hang the callback the browser is sitting on
// mid-redirect. 10s (vs oidcDiscovery's 5s): this is a POST the provider does real work
// for (validate the code, mint tokens), not a static document GET.
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/** Where the SPA settings page lives; the connector callback bounces back here. */
function settingsRedirect(query: string): string {
  return `/settings?${query}`;
}

/**
 * The connector scope set: the login scopes PLUS `offline_access` (so CI-Portal issues
 * a refresh token we can store and use to self-refresh the CI-Server bearer). Deduped.
 */
export function memoryConnectorScopes(): string {
  const set = new Set(config.ciportal.scopes.split(/\s+/).filter(Boolean));
  set.add('offline_access');
  return [...set].join(' ');
}

interface MemoryStateRow {
  owner_id: string;
  code_verifier: string;
  nonce: string | null;
  redirect_uri: string | null;
  expires_at: string | null;
}

interface PortalTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export function memoryRouter() {
  const router = new Router();

  // GET /api/memory/status — connection + sync state for the Settings panel.
  // AA0: `pull` reports the CI-Server pull connector (flag / availability / source).
  // The CONNECTION block (`connected` / `account`) is sourced from listConnections —
  // the one connection surface — so this endpoint and GET /api/connections can never
  // disagree about whether memory is connected. The rest (pull/sync flags, scopes, creds
  // source) are not connection facts, which is why this endpoint still exists.
  router.get('/api/memory/status', async (ctx) => {
    ctx.body = await memoryStatus(currentOwnerId());
  });

  // POST /api/memory/connect — store the owner's CI-Server connection (AA0).
  // Body: { url, api_key? } (apiKey accepted too). Sealed with the KEK into
  // connection_tokens (provider='ci_memory'); also stamps memory_account (the URL
  // host) so the Settings card's "Connected as …" reflects the connection.
  router.post('/api/memory/connect', async (ctx) => {
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const apiKey =
      typeof body.api_key === 'string' ? body.api_key : typeof body.apiKey === 'string' ? body.apiKey : undefined;
    const bearer = typeof body.bearer === 'string' ? body.bearer : undefined;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      ctx.status = 422;
      ctx.body = { error: 'url must be a valid http(s) URL' };
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.status = 422;
      ctx.body = { error: 'url must be a valid http(s) URL' };
      return;
    }

    let account: string;
    try {
      account = await storeMemoryConnection(owner, { url, apiKey, bearer });
    } catch (err) {
      // Almost always a missing/short CP_KEK_B64 — surface the real message, never the key.
      ctx.status = 500;
      ctx.body = { error: `Could not store the connection: ${(err as Error).message}` };
      return;
    }
    await store().prepare(`UPDATE scheduling_prefs SET memory_account = ? WHERE owner_id = ?`).run(account, owner);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'connect', entity: 'memory:ci_server' });
    ctx.status = 201;
    ctx.body = await memoryStatus(owner);
  });

  // POST /api/memory/disconnect — drop the stored connection. Env-fallback creds
  // (CI_SERVER_URL) are deployment config, not per-owner state, so `pull.available` may
  // remain true afterwards — `source` says why.
  //
  // NOT a second disconnect implementation: it delegates to the same
  // disconnectConnection() the generic DELETE /api/connections/:provider/:account route
  // uses (which also clears scheduling_prefs.memory_account). It survives only because it
  // answers with the full MemoryStatus the Settings panel re-renders from; the Settings
  // card itself now drops the connection through the generic route.
  router.post('/api/memory/disconnect', async (ctx) => {
    const owner = currentOwnerId();
    for (const c of await listConnections(owner)) {
      if (c.provider === MEMORY_PROVIDER) await disconnectConnection(owner, c.provider, c.account);
    }
    writeAudit({ ownerId: owner, actor: 'owner', action: 'disconnect', entity: 'memory:ci_server' });
    ctx.body = await memoryStatus(owner);
  });

  // ── AA0b: connect via CI-Portal SSO (OAuth 2.1 + PKCE + offline_access) ───────
  //
  // A dedicated connector OAuth flow, distinct from the login flow (routes/auth.ts):
  // it requests `offline_access` and STORES the resulting refresh token so the
  // connector self-refreshes its CI-Server bearer — CP login sessions are stateless
  // cookies and their id_tokens expire in ~1h, so they can't back the connector.
  // Mirrors the Google connector flow (routes/oauth.ts): owner is known at /start
  // (credentialed), and the public /callback resolves the owner SOLELY from the
  // matched oauth_states row.

  // GET /api/memory/ciportal/start — begin the connector login. Credentialed (the
  // SPA fetches with its session, then top-level-navigates to the returned url).
  router.get('/api/memory/ciportal/start', async (ctx) => {
    if (!ssoLoginEnabled()) throw httpError(404, 'Companion Portal sign-in is not enabled');
    if (!ciportalConfigured()) {
      throw httpError(503, 'Companion Portal is not configured — set CIPORTAL_ISSUER + CIPORTAL_CLIENT_ID (see .env.example)');
    }
    if (!config.memory.serverUrl) {
      throw httpError(503, 'Set CI_SERVER_URL to the Companion Memory API base before connecting via Companion Portal');
    }

    // Resolve endpoints FIRST — if the portal is unreachable we 503 without minting a row.
    let doc: OidcDiscoveryDoc;
    try {
      doc = await ciportalEndpoints();
    } catch (err) {
      logger.warn('CI-Portal discovery failed (memory start)', { err: (err as Error).message });
      throw httpError(503, 'Companion Portal discovery failed — check CIPORTAL_ISSUER and connectivity to the portal');
    }

    const owner = currentOwnerId();
    // Opportunistic hygiene: prune this owner's abandoned/expired connector states.
    await store()
      .prepare(`DELETE FROM oauth_states WHERE provider = ? AND (expires_at <= ? OR owner_id = ?)`)
      .run(MEMORY_PROVIDER, new Date().toISOString(), owner);

    const codeVerifier = base64url(randomBytes(64)); // ~86 chars (within 43–128)
    const state = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(32));
    const scopes = memoryConnectorScopes();
    const redirectUri = config.ciportal.memoryRedirectUri;

    const now = Date.now();
    await store()
      .prepare(
        `INSERT INTO oauth_states (id, owner_id, provider, state, code_verifier, nonce, redirect_uri, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        owner,
        MEMORY_PROVIDER,
        state,
        codeVerifier,
        nonce,
        redirectUri,
        new Date(now).toISOString(),
        new Date(now + STATE_TTL_MS).toISOString(),
      );

    // redirect_uri is taken VERBATIM from config — never recomputed from the request
    // host. The code_verifier is NEVER placed in the URL — only its S256 challenge.
    const authUrl = new URL(doc.authorization_endpoint);
    const params = authUrl.searchParams;
    params.set('client_id', config.ciportal.clientId!);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('scope', scopes);
    params.set('code_challenge', s256(codeVerifier));
    params.set('code_challenge_method', 'S256');
    params.set('state', state);
    params.set('nonce', nonce);

    logger.info('memory CI-Portal connect start', { owner });
    ctx.body = { url: authUrl.toString() };
  });

  // GET /api/memory/ciportal/callback — public (the portal redirects here with no app
  // credential). Owner is resolved SOLELY from the matched oauth_states row.
  router.get('/api/memory/ciportal/callback', async (ctx) => {
    if (!ssoLoginEnabled() || !ciportalConfigured()) {
      throw httpError(404, 'Companion Portal sign-in is not enabled');
    }
    const error = typeof ctx.query.error === 'string' ? ctx.query.error : undefined;
    const code = typeof ctx.query.code === 'string' ? ctx.query.code : undefined;
    const state = typeof ctx.query.state === 'string' ? ctx.query.state : undefined;

    if (error) {
      logger.warn('memory CI-Portal callback provider error', { error });
      ctx.redirect(settingsRedirect(`memory=error&reason=${encodeURIComponent(error)}`));
      return;
    }
    if (!state || !code) {
      ctx.status = 400;
      ctx.body = { error: 'missing_state_or_code' };
      return;
    }

    // Atomically consume the state row (single-use): a replayed callback finds nothing.
    const row = await store()
      .prepare(
        `DELETE FROM oauth_states WHERE state = ? AND provider = ?
         RETURNING owner_id, code_verifier, nonce, redirect_uri, expires_at`,
      )
      .get<MemoryStateRow>(state, MEMORY_PROVIDER);
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

    let doc: OidcDiscoveryDoc;
    try {
      doc = await ciportalEndpoints();
    } catch (err) {
      logger.warn('CI-Portal discovery failed (memory callback)', { err: (err as Error).message });
      ctx.status = 503;
      ctx.body = { error: 'ci_portal_unavailable' };
      return;
    }

    const tokenParams: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      code_verifier: row.code_verifier,
      redirect_uri: row.redirect_uri ?? config.ciportal.memoryRedirectUri,
      client_id: config.ciportal.clientId ?? '',
    };
    if (config.ciportal.clientSecret) tokenParams.client_secret = config.ciportal.clientSecret;

    let tok: PortalTokenResponse;
    try {
      const res = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(tokenParams).toString(),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn('memory CI-Portal token exchange failed', { status: res.status });
        ctx.redirect(settingsRedirect('memory=error&reason=token_exchange_failed'));
        return;
      }
      tok = (await res.json()) as PortalTokenResponse;
    } catch (err) {
      logger.error('memory CI-Portal token exchange error', { err: (err as Error).message });
      ctx.redirect(settingsRedirect('memory=error&reason=token_exchange_error'));
      return;
    }

    // Need an access token to talk to CI-Server AND — since offline_access was requested —
    // a refresh token, or the connector can't self-refresh and would silently die in ~1h.
    // Report each missing piece distinctly so a broken grant is diagnosable.
    if (!tok.access_token) {
      ctx.redirect(settingsRedirect('memory=error&reason=no_access_token'));
      return;
    }
    if (!tok.refresh_token) {
      ctx.redirect(settingsRedirect('memory=error&reason=no_refresh_token'));
      return;
    }

    // Identity comes ONLY from a fully-verified id_token (never decode-and-trust). The
    // nonce is enforced (we minted one for this flow), so a token from any other flow
    // can't be spliced in. Validate `iss` against the discovery doc's issuer.
    if (!tok.id_token) {
      ctx.redirect(settingsRedirect('memory=error&reason=no_id_token'));
      return;
    }
    const claims = await verifyOidcIdToken(tok.id_token, {
      issuers: new Set([doc.issuer]),
      audience: config.ciportal.clientId,
      jwksUri: doc.jwks_uri,
      expectedNonce: row.nonce,
    });
    if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
      ctx.redirect(settingsRedirect('memory=error&reason=invalid_id_token'));
      return;
    }

    // Bind the connection to the OWNER'S OWN SSO identity: if the logged-in owner was
    // provisioned from CI-Portal (external_subject set), the token's subject MUST match
    // — you can only connect your own memory, never another account's.
    const ownerRow = await store()
      .prepare(`SELECT external_subject FROM owners WHERE id = ? AND id <> ?`)
      .get<{ external_subject: string | null }>(row.owner_id, SYSTEM_OWNER_ID);
    if (ownerRow?.external_subject && ownerRow.external_subject !== claims.sub) {
      logger.warn('memory CI-Portal connect rejected: subject mismatch', { owner: row.owner_id });
      ctx.redirect(settingsRedirect('memory=error&reason=subject_mismatch'));
      return;
    }

    // That guard is VACUOUS for a local-login owner (`DISABLE_OIDC`), whose
    // external_subject is NULL by construction — there is no SSO identity to match
    // against, so the first connect may legitimately name any CI-Portal account. What
    // must not happen is a SILENT re-bind afterwards: a reconnect replaces the stored
    // row wholesale, so without this the connection could move to a different portal
    // identity with no signal. Trust-on-first-use closes that: once bound, a callback
    // carrying a different `sub` is refused until the owner explicitly disconnects.
    // A distinct reason so the UI can say what to do, rather than reusing the SSO one.
    const boundSubject = await memoryOidcSubject(row.owner_id);
    if (boundSubject && boundSubject !== claims.sub) {
      logger.warn('memory CI-Portal connect rejected: connection already bound to another subject', {
        owner: row.owner_id,
      });
      ctx.redirect(settingsRedirect('memory=error&reason=already_bound_disconnect_first'));
      return;
    }

    const url = config.memory.serverUrl;
    if (!url) {
      ctx.redirect(settingsRedirect('memory=error&reason=ci_server_url_unset'));
      return;
    }
    const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString();

    // Store under the state's owner (NOT the request's — the callback is credential-less).
    let account: string;
    try {
      // Awaited INSIDE the try: runWithOwner is a generic passthrough over
      // AsyncLocalStorage.run, so it now returns the promise rather than the account.
      // Unawaited, the KEK failure this catch exists for would surface as an unhandled
      // rejection instead — the redirect below would never run. ALS context survives the
      // await, so the owner scope still covers the write.
      account = await runWithOwner(row.owner_id, [SCOPE_READ, SCOPE_WRITE], () =>
        storeMemoryOidcConnection(row.owner_id, {
          url,
          accessToken: tok.access_token!,
          refreshToken: tok.refresh_token!,
          expiresAt,
          tokenEndpoint: doc.token_endpoint,
          clientId: config.ciportal.clientId!,
          clientSecret: config.ciportal.clientSecret,
          subject: claims.sub, // pins the connection for the guard above
        }),
      );
    } catch (err) {
      // Almost always a missing/short CP_KEK_B64 — never leak the key.
      logger.error('memory CI-Portal connect: could not store connection', { err: (err as Error).message });
      ctx.redirect(settingsRedirect('memory=error&reason=store_failed'));
      return;
    }
    await store().prepare(`UPDATE scheduling_prefs SET memory_account = ? WHERE owner_id = ?`).run(account, row.owner_id);
    writeAudit({ ownerId: row.owner_id, actor: 'owner', action: 'connect', entity: 'memory:ci_portal' });

    logger.info('memory CI-Portal connection established', { owner: row.owner_id });
    ctx.redirect(settingsRedirect('memory=connected'));
  });

  // POST /api/memory/suggest — manual AA1 trigger (testing/UX "pull now"). Same
  // gates as the scheduled job: flag on AND connector available.
  router.post('/api/memory/suggest', async (ctx) => {
    const r = await suggestFromMemory();
    if (r.status === 'flag_off') {
      ctx.status = 400;
      ctx.body = { reason: 'disabled', error: 'Memory suggestions are turned off' };
      return;
    }
    if (r.status === 'unavailable') {
      ctx.status = 503;
      ctx.body = { reason: 'unavailable', error: 'Companion Memory is not reachable — connect it in Settings' };
      return;
    }
    ctx.body = r;
  });

  // POST /api/memory/sync — trigger a one-way push now (AA4). On success returns the
  // per-scope + ingest counts; sync off → 400, not connected → 400, connector/creds
  // unreachable → 503 'unavailable'.
  router.post('/api/memory/sync', async (ctx) => {
    const r = await syncToMemory(currentOwnerId());
    if (!r.ok) {
      ctx.status = r.reason === 'unavailable' ? 503 : 400;
      ctx.body = {
        reason: r.reason,
        error:
          r.reason === 'disabled'
            ? 'Memory sync is turned off'
            : r.reason === 'not_connected'
              ? 'Connect Companion Memory first'
              : 'Companion Memory is not reachable — connect it in Settings',
      };
      return;
    }
    ctx.body = r;
  });

  return router;
}
