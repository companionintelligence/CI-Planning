import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, createSign, generateKeyPairSync } from 'node:crypto';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { issueApiKey } from '../src/lib/auth/apiKey.js';
import { SCOPE_READ, SCOPE_WRITE } from '../src/lib/auth/types.js';
import { seal, open, loadKek } from '../src/lib/crypto/index.js';
import { getConnectors, GoogleCalendarConnector } from '../src/connectors/index.js';
import { startTestServer, api, type TestServer } from './helpers.js';

/**
 * WP2 — standalone Google OAuth 2.1 (Auth Code + PKCE/S256).
 *
 * The whole flow is exercised with a stubbed `fetch` (vi.stubGlobal) — NO real network.
 * `config.auth.mode` is a runtime singleton; we flip it to 'standalone' and ALWAYS
 * restore 'test' in afterEach so the shared sequential DB/process doesn't leak a 401
 * into later files. CP_KEK_B64 is set per-test (the suite has no global KEK).
 */

const KEY = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;
const SAVED_CLIENT_ID = config.google.clientId;
const SAVED_CLIENT_SECRET = config.google.clientSecret;

// Capture the REAL fetch before any test stubs the global. Tests stub `fetch` to fake
// Google's token/JWKS/revoke endpoints — but the HTTP client that drives our own server
// must keep using the real implementation, or it would hit the stub instead of the app.
const realFetch = globalThis.fetch.bind(globalThis);

let srv: TestServer;

/** A standalone-mode read+write api key (the /start + gated routes need it). */
function authHeaders(): { headers: Record<string, string> } {
  const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ, SCOPE_WRITE]);
  return { headers: { 'x-api-key': key } };
}

/** Follow-redirect off so we can assert on the 302 Location. Uses the real fetch. */
async function rawGet(path: string, init?: RequestInit) {
  const res = await realFetch(`${srv.url}${path}`, { redirect: 'manual', ...init });
  return { status: res.status, location: res.headers.get('location'), res };
}

/** JSON request against our own server using the real fetch (stub-proof). */
async function realApi<T = any>(path: string, init?: RequestInit & { json?: unknown }) {
  const { json, ...rest } = init ?? {};
  const res = await realFetch(`${srv.url}${path}`, {
    ...rest,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : (rest.body as BodyInit | undefined),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  process.env.CP_KEK_B64 = KEY;
  config.google.clientId = 'test-client-id.apps.googleusercontent.com';
  config.google.clientSecret = 'test-secret';
});

afterEach(() => {
  config.auth.mode = 'test';
  config.google.clientId = SAVED_CLIENT_ID;
  config.google.clientSecret = SAVED_CLIENT_SECRET;
  if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED_KEK;
  sqlite.exec(
    'DELETE FROM outbound_queue; DELETE FROM oauth_states; DELETE FROM connection_tokens; DELETE FROM api_keys; DELETE FROM time_blocks;',
  );
  vi.unstubAllGlobals();
});

// ── /start ────────────────────────────────────────────────────────────────────
describe('GET /api/oauth/google/start', () => {
  it('returns { url } to Google with S256 + offline + consent and a verbatim redirect_uri', async () => {
    config.auth.mode = 'standalone';
    const { status, body } = await realApi<{ url: string }>('/api/oauth/google/start', authHeaders());
    expect(status).toBe(200);
    expect(body.url).toBeTruthy();
    const url = new URL(body.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(config.google.clientId);
    // redirect_uri is the configured value VERBATIM, never recomputed from the host.
    expect(url.searchParams.get('redirect_uri')).toBe(config.google.redirectUri);
    // calendar scope present.
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');

    // Exactly one oauth_states row, owned by SYSTEM_OWNER.
    const rows = sqlite.prepare('SELECT * FROM oauth_states').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id).toBe(SYSTEM_OWNER);

    // The PKCE verifier must NEVER appear in the redirect URL.
    const verifier = String(rows[0].code_verifier);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(body.url).not.toContain(verifier);
  });

  it('refuses with 409 in test mode and writes no oauth_states row (I2)', async () => {
    config.auth.mode = 'test';
    const { status } = await rawGet('/api/oauth/google/start');
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBe(409);
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_states').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// ── /callback ───────────────────────────────────────────────────────────────────
describe('GET /api/oauth/google/callback', () => {
  it('is public (no 401 without a credential) and 400s on an unknown state', async () => {
    config.auth.mode = 'standalone';
    const { status, body } = await api(srv.url, '/api/oauth/google/callback?state=nope&code=abc');
    expect(status).toBe(400); // NOT 401 → the route is in PUBLIC_PREFIXES
    expect(body).toEqual({ error: 'unknown_or_consumed_state' });
  });

  it('400s when state or code is missing', async () => {
    config.auth.mode = 'standalone';
    const { status } = await api(srv.url, '/api/oauth/google/callback?code=abc');
    expect(status).toBe(400);
  });

  /** Seed an oauth_states row directly (as /start would) and return its `state`. */
  function seedState(opts?: { nonce?: string; expiresAt?: string; owner?: string }): string {
    const state = `state-${newId()}`;
    sqlite
      .prepare(
        `INSERT INTO oauth_states (id, owner_id, provider, state, code_verifier, nonce, redirect_uri, expires_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        opts?.owner ?? SYSTEM_OWNER,
        state,
        'verifier-1234567890abcdefghij',
        opts?.nonce ?? null,
        config.google.redirectUri,
        opts?.expiresAt ?? new Date(Date.now() + 600_000).toISOString(),
      );
    return state;
  }

  it('happy path: stores an active token under the state owner; email from the token response (I1)', async () => {
    config.auth.mode = 'standalone';
    const state = seedState();

    // Stub the token endpoint — email comes DIRECTLY from this response (no id_token).
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: 'ACCESS-1',
          refresh_token: 'REFRESH-1',
          expires_in: 3600,
          email: 'user@example.com',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ));

    const { status, location } = await rawGet(`/api/oauth/google/callback?state=${state}&code=AUTH_CODE`);
    expect(status).toBe(302);
    expect(location).toContain('/settings?google=connected');

    // State row consumed.
    const remaining = sqlite.prepare('SELECT COUNT(*) AS n FROM oauth_states').get() as { n: number };
    expect(remaining.n).toBe(0);

    // Active connection token under SYSTEM_OWNER for the right account.
    const tok = sqlite
      .prepare("SELECT * FROM connection_tokens WHERE owner_id = ? AND provider = 'google' AND account = ?")
      .get(SYSTEM_OWNER, 'user@example.com') as Record<string, string>;
    expect(tok).toBeTruthy();
    expect(tok.status).toBe('active');

    // Decrypt → the exact tokens we exchanged.
    const decoded = JSON.parse(open({ iv: tok.iv, authTag: tok.auth_tag, ciphertext: tok.ciphertext }, loadKek()));
    expect(decoded.accessToken).toBe('ACCESS-1');
    expect(decoded.refreshToken).toBe('REFRESH-1');
  });

  it('R1 (I1): a tampered/unsigned id_token does NOT establish identity (rejected)', async () => {
    config.auth.mode = 'standalone';
    const state = seedState();

    // Forge an UNSIGNED id_token (alg=none style + garbage signature) carrying an email.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'forged' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: config.google.clientId,
        email: 'attacker@evil.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const forgedIdToken = `${header}.${payload}.${Buffer.from('not-a-real-signature').toString('base64url')}`;

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls++;
        const u = String(input);
        // Token endpoint: no `email`, only the forged id_token.
        if (u.includes('/token') || calls === 1) {
          return new Response(
            JSON.stringify({ access_token: 'ACCESS-X', refresh_token: 'R-X', expires_in: 3600, id_token: forgedIdToken }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // JWKS endpoint: return a real-but-unrelated RSA key so signature verify FAILS.
        const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'forged', alg: 'RS256', use: 'sig' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const { status } = await rawGet(`/api/oauth/google/callback?state=${state}&code=AUTH_CODE`);
    expect(status).toBe(400);
    // No connection established for the attacker (or anyone).
    const n = sqlite.prepare('SELECT COUNT(*) AS n FROM connection_tokens').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('a properly JWKS-signed id_token DOES establish identity', async () => {
    config.auth.mode = 'standalone';
    const nonce = 'the-nonce';
    const state = seedState({ nonce });

    // Mint a real RSA keypair, sign a real id_token, serve its public JWK at the JWKS URI.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const kid = 'kid-1';
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: config.google.clientId,
        email: 'verified@example.com',
        nonce,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(privateKey).toString('base64url');
    const idToken = `${header}.${payload}.${signature}`;

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ access_token: 'ACCESS-S', refresh_token: 'R-S', expires_in: 3600, id_token: idToken }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const { status, location } = await rawGet(`/api/oauth/google/callback?state=${state}&code=AUTH_CODE`);
    expect(status).toBe(302);
    expect(location).toContain('google=connected');
    const tok = sqlite
      .prepare("SELECT account, status FROM connection_tokens WHERE owner_id = ? AND provider = 'google'")
      .get(SYSTEM_OWNER) as { account: string; status: string };
    expect(tok.account).toBe('verified@example.com');
    expect(tok.status).toBe('active');
  });

  it('refresh-merge (I4): omitted refresh_token preserves the STORED one (never empty)', async () => {
    config.auth.mode = 'standalone';
    const account = 'merge@example.com';

    // Pre-seed an existing connection with refreshToken='STORED'.
    const sealed = seal(
      JSON.stringify({ accessToken: 'OLD', refreshToken: 'STORED', expiresAt: '2000-01-01T00:00:00.000Z' }),
      loadKek(),
    );
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, status)
         VALUES (?, ?, 'google', ?, ?, ?, ?, 'active')`,
      )
      .run(newId(), SYSTEM_OWNER, account, sealed.iv, sealed.authTag, sealed.ciphertext);

    const state = seedState();
    // Token response OMITS refresh_token but provides the matching email.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'NEW-ACCESS', expires_in: 3600, email: account }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ));

    const { status } = await rawGet(`/api/oauth/google/callback?state=${state}&code=AUTH_CODE`);
    expect(status).toBe(302);

    const tok = sqlite
      .prepare("SELECT * FROM connection_tokens WHERE owner_id = ? AND account = ?")
      .get(SYSTEM_OWNER, account) as Record<string, string>;
    const decoded = JSON.parse(open({ iv: tok.iv, authTag: tok.auth_tag, ciphertext: tok.ciphertext }, loadKek()));
    expect(decoded.accessToken).toBe('NEW-ACCESS');
    expect(decoded.refreshToken).toBe('STORED'); // preserved, never emptied
  });
});

// ── connector token endpoints (refresh / revoke) ───────────────────────────────
describe('GoogleCalendarConnector token endpoints', () => {
  /** Subclass to expose the protected refreshToken() for direct assertion. */
  class TestConnector extends GoogleCalendarConnector {
    public refresh(rt: string) {
      return (this as unknown as { refreshToken(rt: string): Promise<{ accessToken: string; expiresAt: string }> }).refreshToken(rt);
    }
  }

  it('refreshToken POSTs grant_type=refresh_token in the BODY (urlencoded)', async () => {
    config.google.clientId = 'cid';
    config.google.clientSecret = 'csec';
    let captured: { url: string; method?: string; body?: string; ct?: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = {
          url: String(input),
          method: init?.method,
          body: typeof init?.body === 'string' ? init.body : undefined,
          ct: (init?.headers as Record<string, string>)?.['Content-Type'],
        };
        return new Response(JSON.stringify({ access_token: 'A2', expires_in: 1800 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const c = new TestConnector('refresh@example.com');
    const out = await c.refresh('RT-XYZ');
    expect(out.accessToken).toBe('A2');
    expect(captured!.method).toBe('POST');
    expect(captured!.ct).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(captured!.body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('RT-XYZ');
    // The token endpoint URL carries NO query (everything in the body).
    expect(new URL(captured!.url).search).toBe('');
  });

  it('maps 400 invalid_grant to RevokedTokenError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":"invalid_grant"}', { status: 400, headers: { 'Content-Type': 'application/json' } }),
    ));
    const c = new TestConnector('revoked@example.com');
    const { RevokedTokenError } = await import('../src/connectors/index.js');
    await expect(c.refresh('DEAD')).rejects.toBeInstanceOf(RevokedTokenError);
  });

  it('revoke() POSTs the token in the BODY with an empty query (I3)', async () => {
    let captured: { url: string; method?: string; body?: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { url: String(input), method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined };
        return new Response('', { status: 200 });
      }),
    );
    const { revoke } = await import('../src/connectors/index.js');
    await revoke('TOK-TO-REVOKE');
    expect(captured!.method).toBe('POST');
    expect(new URL(captured!.url).search).toBe(''); // token NOT in the query
    const params = new URLSearchParams(captured!.body);
    expect(params.get('token')).toBe('TOK-TO-REVOKE');
  });
});

// ── /accounts + disconnect + getConnectors filter ───────────────────────────────
describe('accounts listing + disconnect', () => {
  function seedToken(account: string, status = 'active') {
    const sealed = seal(
      JSON.stringify({ accessToken: 'A', refreshToken: 'R', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
      loadKek(),
    );
    sqlite
      .prepare(
        `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, status)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`,
      )
      .run(newId(), SYSTEM_OWNER, account, sealed.iv, sealed.authTag, sealed.ciphertext, status);
  }

  it('GET /accounts lists status only — never leaks ciphertext/iv/tokens', async () => {
    config.auth.mode = 'standalone';
    seedToken('list@example.com');
    const { status, body } = await api<{ accounts: Record<string, unknown>[] }>(
      srv.url,
      '/api/oauth/google/accounts',
      authHeaders(),
    );
    expect(status).toBe(200);
    expect(body.accounts).toHaveLength(1);
    const acct = body.accounts[0];
    expect(acct.account).toBe('list@example.com');
    expect(acct.status).toBe('active');
    expect(acct.updated_at).toBeTruthy();
    // No secret material in the payload — check for the field names as JSON keys
    // (substring checks would false-positive, e.g. "active" contains "iv").
    const serialized = JSON.stringify(body);
    for (const leak of ['ciphertext', 'auth_tag', 'iv', 'accessToken', 'refreshToken', 'access_token', 'refresh_token']) {
      expect(serialized).not.toContain(`"${leak}"`);
    }
    // And the listed object exposes ONLY the three safe fields.
    expect(Object.keys(acct).sort()).toEqual(['account', 'status', 'updated_at']);
  });

  it('DELETE removes connection_tokens AND outbound_queue rows and calls revoke (I12)', async () => {
    config.auth.mode = 'standalone';
    const account = 'disc@example.com';
    seedToken(account);
    // A pending outbound_queue row for the same (owner, provider, account).
    // outbound_queue.block_id FKs time_blocks (FK pragma is ON), so seed a real block.
    const blockId = newId();
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, start_at, end_at, all_day, owner_id)
         VALUES (?, 'b', ?, ?, 0, ?)`,
      )
      .run(blockId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), SYSTEM_OWNER);
    sqlite
      .prepare(
        `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
         VALUES (?, ?, ?, 'google', ?)`,
      )
      .run(newId(), SYSTEM_OWNER, blockId, account);

    let revokeCalled = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('revoke')) revokeCalled = true;
      return new Response('', { status: 200 });
    }));

    const { status, body } = await realApi(
      `/api/oauth/google/accounts/${encodeURIComponent(account)}`,
      { method: 'DELETE', ...authHeaders() },
    );
    expect(status).toBe(200);
    expect(body).toEqual({ disconnected: account });
    expect(revokeCalled).toBe(true);

    const tokN = sqlite.prepare('SELECT COUNT(*) AS n FROM connection_tokens WHERE account = ?').get(account) as { n: number };
    const oqN = sqlite.prepare('SELECT COUNT(*) AS n FROM outbound_queue WHERE account = ?').get(account) as { n: number };
    expect(tokN.n).toBe(0);
    expect(oqN.n).toBe(0);

    // getConnectors() now returns nothing for this owner.
    const connectors = runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => getConnectors());
    expect(connectors).toHaveLength(0);
  });

  it('getConnectors() skips a status<>active row', async () => {
    seedToken('revoked@example.com', 'revoked');
    const connectors = runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => getConnectors());
    expect(connectors).toHaveLength(0);
  });

  it('getConnectors() returns a connector for an active row', async () => {
    seedToken('active@example.com', 'active');
    const connectors = runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => getConnectors());
    expect(connectors).toHaveLength(1);
    expect(connectors[0].account).toBe('active@example.com');
  });
});
