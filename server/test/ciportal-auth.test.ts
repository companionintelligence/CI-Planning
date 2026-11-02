import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { sign as cryptoSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { newId, SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { provisionOwner, operatorCount } from '../src/lib/owners.js';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { __resetAuthRateLimit } from '../src/routes/auth.js';
import { __resetOidcDiscoveryCache } from '../src/lib/auth/oidcDiscovery.js';

/**
 * U1 — CI-Portal SSO (OAuth 2.1 + PKCE Relying-Party login).
 *
 * Endpoints are exercised against a STUBBED portal (vi.stubGlobal fetch for the
 * token + JWKS endpoints, real RS256 AND Ed25519 keypairs — the pattern oauth.test.ts proved for
 * Google). No real network. Every callback test drives /start first (via startFlow)
 * so it carries the real login-state cookie — this both exercises the whole flow and
 * satisfies the login-CSRF binding (the callback rejects a `state` not bound to the
 * browser that started the login). Negative matrix: no code, unbound/unknown/replayed/
 * expired state, alg:none, HS256-forged, tampered signature, wrong iss/aud, expired
 * token, nonce mismatch, missing sub. Plus provisioning + session + logout.
 *
 * B3 (2026-10-21): a verified token for an UNKNOWN sub no longer provisions in the
 * callback. The callback parks the identity in a signed intent cookie and redirects to
 * the no-JS confirmation page; only "Create account" there provisions. `completeLogin`
 * follows that step, so every provisioning test below exercises the real path; the
 * B3 describe pins the step itself (decline, expiry, tampering, CSRF).
 */

const PORTAL = {
  clientId: 'companion-planning-test',
  issuer: 'https://portal.test',
  authorizeUri: 'https://portal.test/authorize',
  tokenUri: 'https://portal.test/token',
  jwksUri: 'https://portal.test/jwks',
};

// Capture the REAL fetch before stubbing — the client driving our server must not hit the stub.
const realFetch = globalThis.fetch.bind(globalThis);

let srv: TestServer;
let savedAuth: typeof config.auth;
let savedPortal: typeof config.ciportal;

const cookieHeader = (setCookies: string[]) => setCookies.map((c) => c.split(';')[0]).join('; ');

async function rawGet(path: string, headers?: Record<string, string>) {
  const res = await realFetch(`${srv.url}${path}`, { redirect: 'manual', headers });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {
    status: res.status,
    location: res.headers.get('location'),
    setCookies: res.headers.getSetCookie?.() ?? [],
    body,
  };
}

type RawResponse = Awaited<ReturnType<typeof rawGet>>;

/** A form POST (what the no-JS confirmation page submits). */
async function rawPost(path: string, form: Record<string, string>, headers?: Record<string, string>): Promise<RawResponse> {
  const res = await realFetch(`${srv.url}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, location: res.headers.get('location'), setCookies: res.headers.getSetCookie?.() ?? [], body };
}

/** Drive /start: returns the login-state cookie, the issued state, and its row nonce. */
async function startFlow(query = ''): Promise<{ state: string; cookie: string; nonce: string }> {
  const res = await realFetch(`${srv.url}/api/auth/ciportal/start${query}`, { redirect: 'manual' });
  const cookie = cookieHeader(res.headers.getSetCookie?.() ?? []);
  const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
  const row = sqlite.prepare('SELECT nonce FROM auth_states WHERE state = ?').get(state) as { nonce: string };
  return { state, cookie, nonce: row.nonce };
}

// ── B3 — the first-time confirmation step ──────────────────────────────────────
const CONFIRM_PATH = '/api/auth/ciportal/confirm-account';
const INTENT_COOKIE = 'cp_portal_intent';

/** The callback's answer for an unknown sub: parked, not provisioned, no session. */
function expectAwaitingConfirmation(res: RawResponse): void {
  expect(res.status).toBe(302);
  expect(res.location).toBe(CONFIRM_PATH);
  const joined = res.setCookies.join('\n');
  expect(joined).toMatch(new RegExp(`${INTENT_COOKIE}=[^;]+`));
  expect(joined).toMatch(new RegExp(`${INTENT_COOKIE}\\.sig=[^;]+`));
  expect(joined).not.toContain('cp_session=');
}

/** Open the confirmation page with the callback's cookies; hand back what the form needs. */
async function openConfirmPage(cb: RawResponse): Promise<{ cookie: string; csrf: string; html: string }> {
  const cookie = cookieHeader(cb.setCookies);
  const page = await rawGet(CONFIRM_PATH, { Cookie: cookie });
  expect(page.status).toBe(200);
  const html = String(page.body);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  expect(csrf).toBeTruthy();
  return { cookie, csrf: csrf!, html };
}

/** Click "Create account": GET the page, echo its CSRF token, POST the decision. */
async function confirmCreate(cb: RawResponse): Promise<RawResponse> {
  const { cookie, csrf } = await openConfirmPage(cb);
  return rawPost(CONFIRM_PATH, { csrf, decision: 'create' }, { Cookie: cookie });
}

/** The whole login as a browser experiences it: callback, then (first time only) the
 *  confirmation step. Returns the response that carries the session. */
async function completeLogin(cb: RawResponse): Promise<RawResponse> {
  if (cb.status === 302 && cb.location === CONFIRM_PATH) {
    expectAwaitingConfirmation(cb);
    return confirmCreate(cb);
  }
  return cb;
}

interface TokenPayloadOverrides {
  iss?: string; aud?: string | string[]; azp?: string; sub?: string | null; exp?: number;
  iat?: number; nbf?: number; nonce?: string; name?: string; email?: string;
}

type IdTokenAlg = 'RS256' | 'EdDSA';

interface MakeIdTokenOpts {
  /** Which keypair to mint and how to sign: RS256 (RSA — Google) or EdDSA (Ed25519 — CI-Portal). */
  alg?: IdTokenAlg;
  /** What the JOSE header CLAIMS, when it should lie about `alg` (alg-confusion cases). */
  headerAlg?: string;
  /** Edwards curve for EdDSA keys; Ed448 is a real curve the verifier must still refuse. */
  curve?: 'ed25519' | 'ed448';
  /** Sign with a different key than the one served in the JWKS (tampering). */
  signWith?: KeyObject;
  kid?: string;
  /** The served JWK's own `alg`: omit the field entirely with null (the live portal JWKS
   *  carries no `use`, and a JWK's `alg` is optional per RFC 7517). */
  jwkAlg?: string | null;
  jwkUse?: string | null;
}

/**
 * Mint a keypair + sign an id_token; return it plus the public JWK to serve. RS256 by
 * default (the shape every pre-existing case in this file was written against); EdDSA
 * mints an Ed25519 key — the shape the real CI-Portal issues (better-auth `jwt()`
 * default) and the one its live JWKS carries exclusively.
 */
function makeIdToken(overrides: TokenPayloadOverrides, opts?: MakeIdTokenOpts) {
  const alg: IdTokenAlg = opts?.alg ?? 'RS256';
  const { publicKey, privateKey } =
    alg === 'EdDSA' ? generateKeyPairSync(opts?.curve ?? 'ed25519') : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = opts?.kid ?? 'kid-test';
  const header = Buffer.from(JSON.stringify({ alg: opts?.headerAlg ?? alg, kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: overrides.iss ?? PORTAL.issuer,
      aud: overrides.aud ?? PORTAL.clientId,
      ...(overrides.azp !== undefined ? { azp: overrides.azp } : {}),
      ...(overrides.sub === null ? {} : { sub: overrides.sub ?? 'portal-sub-1' }),
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 300,
      ...(overrides.iat !== undefined ? { iat: overrides.iat } : {}),
      ...(overrides.nbf !== undefined ? { nbf: overrides.nbf } : {}),
      nonce: overrides.nonce,
      name: overrides.name ?? 'Portal User',
      email: overrides.email ?? 'portal.user@ci.test',
    }),
  ).toString('base64url');
  // Ed25519/Ed448 are "pure" EdDSA — node takes a null digest; RS256 names SHA-256.
  const signature = cryptoSign(alg === 'EdDSA' ? null : 'RSA-SHA256', Buffer.from(`${header}.${payload}`), opts?.signWith ?? privateKey)
    .toString('base64url');
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const served: Record<string, unknown> = { ...jwk, kid };
  if (opts?.jwkAlg !== null) served.alg = opts?.jwkAlg ?? alg;
  if (opts?.jwkUse !== null) served.use = opts?.jwkUse ?? 'sig';
  return { idToken: `${header}.${payload}.${signature}`, jwks: [served] };
}

function stubPortal(tokenResponse: unknown, jwks: unknown[] = [], tokenStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith(PORTAL.tokenUri)) {
        return new Response(JSON.stringify(tokenResponse), { status: tokenStatus, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.startsWith(PORTAL.jwksUri)) {
        return new Response(JSON.stringify({ keys: jwks }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    }),
  );
}

beforeAll(async () => {
  savedAuth = { ...config.auth };
  savedPortal = { ...config.ciportal };
  config.auth.mode = 'sso';
  config.auth.disableOidc = false;
  config.auth.sessionSecret = 'test-session-secret';
  config.auth.autoProvision = true;
  config.auth.rateLimit = { ...config.auth.rateLimit, issueMax: 1000 };
  Object.assign(config.ciportal, PORTAL, { redirectUri: 'http://localhost:3848/api/auth/ciportal/callback' });
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  Object.assign(config.auth, savedAuth);
  Object.assign(config.ciportal, savedPortal);
});

beforeEach(() => {
  resetDb();
  __resetAuthRateLimit();
  config.auth.autoProvision = true;
});

afterEach(() => {
  sqlite.exec('DELETE FROM auth_states;');
  vi.unstubAllGlobals();
});

// ── /start ────────────────────────────────────────────────────────────────────
describe('GET /api/auth/ciportal/start', () => {
  it('302s to the portal with PKCE S256 + state + nonce, stores the row, and binds the browser', async () => {
    const { status, location, setCookies } = await rawGet('/api/auth/ciportal/start');
    expect(status).toBe(302);
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(PORTAL.authorizeUri);
    expect(url.searchParams.get('client_id')).toBe(PORTAL.clientId);
    // The test server is reached on 127.0.0.1 — a LOOPBACK host — so A5's local-open rule
    // applies: the redirect is the loopback callback, not the configured public base.
    expect(url.searchParams.get('redirect_uri')).toBe(`${srv.url}/api/auth/ciportal/callback`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();

    // Login-CSRF binding: a login-state cookie carrying the state is set on the browser.
    expect(setCookies.join('\n')).toMatch(/cp_login_state=/);
    expect(setCookies.every((c) => /httponly/i.test(c))).toBe(true);

    const rows = sqlite.prepare('SELECT * FROM auth_states').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(url.searchParams.get('state'));
    // The PKCE verifier must NEVER appear in the redirect URL.
    expect(location).not.toContain(String(rows[0].code_verifier));
  });

  // ── A5: redirect_uri selection — configured base vs. loopback "local open" ──────────
  // `fetch` (undici) silently drops a caller-supplied Host header, so these go through
  // node:http to present the Host the browser would.
  function rawHttpGet(path: string, headers: Record<string, string>) {
    return new Promise<{ status: number; location: string | null; setCookies: string[] }>((resolve, reject) => {
      const u = new URL(srv.url);
      const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET', headers }, (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location ?? null,
            setCookies: ([] as string[]).concat(res.headers['set-cookie'] ?? []),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('A5: a non-loopback Host never steers redirect_uri — the configured value is sent verbatim', async () => {
    const res = await rawHttpGet('/api/auth/ciportal/start', { Host: 'evil.example:443' });
    expect(res.status).toBe(302);
    const url = new URL(res.location!);
    expect(url.searchParams.get('redirect_uri')).toBe(config.ciportal.redirectUri);
    const row = sqlite.prepare(`SELECT redirect_uri FROM auth_states ORDER BY created_at DESC LIMIT 1`).get() as { redirect_uri: string };
    expect(row.redirect_uri).toBe(config.ciportal.redirectUri);
  });

  it('A5: a loopback Host (CI-Hub local open, ADR 001) gets the loopback callback on its own port, and the exchange echoes it', async () => {
    const res = await rawHttpGet('/api/auth/ciportal/start', { Host: '127.0.0.1:18829' });
    expect(res.status).toBe(302);
    const url = new URL(res.location!);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:18829/api/auth/ciportal/callback');
    const row = sqlite.prepare(`SELECT redirect_uri FROM auth_states ORDER BY created_at DESC LIMIT 1`).get() as { redirect_uri: string };
    expect(row.redirect_uri).toBe('http://127.0.0.1:18829/api/auth/ciportal/callback');

    // The token exchange must send the SAME redirect_uri the Portal saw (RFC 6749 §4.1.3).
    const state = url.searchParams.get('state')!;
    const cookie = cookieHeader(res.setCookies);
    const nonce = (sqlite.prepare(`SELECT nonce FROM auth_states WHERE state = ?`).get(state) as { nonce: string }).nonce;
    const { idToken, jwks } = makeIdToken({ nonce, sub: 'local-open-sub' });
    let exchanged: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.startsWith(PORTAL.tokenUri)) {
          exchanged = new URLSearchParams(String(init?.body ?? '')).get('redirect_uri');
          return new Response(JSON.stringify({ access_token: 'A', id_token: idToken }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (u.startsWith(PORTAL.jwksUri)) return new Response(JSON.stringify({ keys: jwks }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        throw new Error(`unexpected fetch in test: ${u}`);
      }),
    );
    const cb = await rawHttpGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie, Host: '127.0.0.1:18829' });
    expect([302, 200]).toContain(cb.status); // 302 into the app, or B3's confirm-account page for a new sub
    expect(exchanged).toBe('http://127.0.0.1:18829/api/auth/ciportal/callback');
  });

  it('prunes expired auth_states rows on each start', async () => {
    sqlite
      .prepare(`INSERT INTO auth_states (id, state, code_verifier, nonce, expires_at) VALUES (?, 'old', 'v', 'n', ?)`)
      .run(newId(), new Date(Date.now() - 1000).toISOString());
    await rawGet('/api/auth/ciportal/start');
    const rows = sqlite.prepare('SELECT state FROM auth_states').all() as { state: string }[];
    expect(rows.map((r) => r.state)).not.toContain('old'); // expired row pruned
  });

  it('404s when DISABLE_OIDC=true (local mode owns login)', async () => {
    config.auth.disableOidc = true;
    try {
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(404);
    } finally {
      config.auth.disableOidc = false;
    }
  });

  it('503s when the CIPORTAL_* endpoints are not configured', async () => {
    const saved = config.ciportal.clientId;
    config.ciportal.clientId = undefined;
    try {
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(503);
      expect(sqlite.prepare('SELECT COUNT(*) n FROM auth_states').get()).toEqual({ n: 0 });
    } finally {
      config.ciportal.clientId = saved;
    }
  });

  it('rate limits (429) once issueMax attempts are exceeded', async () => {
    const saved = config.auth.rateLimit;
    config.auth.rateLimit = { windowMs: 60_000, max: 60, issueMax: 2 };
    __resetAuthRateLimit();
    try {
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(302);
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(302);
      expect((await rawGet('/api/auth/ciportal/start')).status).toBe(429);
    } finally {
      config.auth.rateLimit = saved;
    }
  });
});

// ── /callback: state handling + login-CSRF binding ──────────────────────────────
describe('GET /api/auth/ciportal/callback — state handling', () => {
  it('is public (400, NOT 401) and 400s when state or code is missing', async () => {
    expect((await rawGet('/api/auth/ciportal/callback?code=abc')).status).toBe(400);
    expect((await rawGet('/api/auth/ciportal/callback?state=abc')).status).toBe(400);
  });

  it('503s (fail closed) when CIPORTAL_* is not configured — not a confusing 502/invalid_id_token', async () => {
    const saved = config.ciportal.clientId;
    config.ciportal.clientId = undefined; // makes ciportalConfigured() false
    try {
      expect((await rawGet('/api/auth/ciportal/callback?state=x&code=y')).status).toBe(503);
    } finally {
      config.ciportal.clientId = saved;
    }
  });

  it('rejects a state not bound to this browser (login-CSRF): no login-state cookie → 400', async () => {
    // Attacker starts a flow (gets state + its cookie); the victim's browser hits the
    // callback with that state but WITHOUT the cookie → rejected, no session.
    const { state } = await startFlow();
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`); // no Cookie
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'state_not_bound' });
    expect(res.setCookies.join('')).not.toContain('cp_session=');
  });

  it('400s on an expired state row', async () => {
    const { state, cookie } = await startFlow();
    sqlite.prepare(`UPDATE auth_states SET expires_at = ? WHERE state = ?`).run(new Date(Date.now() - 1000).toISOString(), state);
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=abc`, { Cookie: cookie });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'expired_state' });
  });

  it('400s unknown/consumed state (cookie matches, but the row is gone)', async () => {
    const { state, cookie } = await startFlow();
    sqlite.prepare(`DELETE FROM auth_states WHERE state = ?`).run(state); // simulate already-consumed
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=abc`, { Cookie: cookie });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_or_consumed_state' });
  });

  it('a state is single-use: a replayed callback is rejected', async () => {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeIdToken({ nonce });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    expect((await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C1`, { Cookie: cookie })).status).toBe(302);
    const replay = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C1`, { Cookie: cookie });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ error: 'unknown_or_consumed_state' });
  });

  it('a provider error bounces back to /login with a displayable reason', async () => {
    const { status, location } = await rawGet('/api/auth/ciportal/callback?error=access_denied');
    expect(status).toBe(302);
    expect(location).toContain('/login?sso_error=access_denied');
  });
});

// ── /callback: id_token verification (the negative matrix) ─────────────────────
describe('GET /api/auth/ciportal/callback — id_token verification', () => {
  async function expectRejected(makeToken: (nonce: string) => { idToken: string; jwks: unknown[] }, error = 'invalid_id_token') {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeToken(nonce);
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect((sqlite.prepare('SELECT COUNT(*) n FROM owners').get() as { n: number }).n).toBe(1); // sentinel only
    expect(res.setCookies.join('')).not.toContain('cp_session=');
  }

  const rawToken = (alg: string, sig: string, nonce: string) => {
    const header = Buffer.from(JSON.stringify({ alg })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ iss: PORTAL.issuer, aud: PORTAL.clientId, sub: 'x', nonce, exp: Math.floor(Date.now() / 1000) + 300 }),
    ).toString('base64url');
    return `${header}.${payload}.${sig}`;
  };

  it('rejects a failed token exchange', async () => {
    const { state, cookie } = await startFlow();
    stubPortal({ error: 'invalid_grant' }, [], 400);
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=BAD`, { Cookie: cookie });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('token_exchange_failed');
  });

  it('rejects a token response with no id_token', async () => {
    const { state, cookie } = await startFlow();
    stubPortal({ access_token: 'A-only' });
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'no_id_token' });
  });

  // The JWKS fetch sits on the synchronous path of this callback and `fetch` has no
  // default timeout, so an endpoint that accepts the connection and then never answers
  // would hold the request open forever. Two properties are locked here: the call is
  // given an AbortSignal at all (delete it and this fails), and an aborted fetch is
  // fail-CLOSED — no keys, no candidate, token rejected. Never a skipped signature check.
  it('bounds the JWKS fetch with an abort signal and rejects the token when it times out', async () => {
    const { state, cookie, nonce } = await startFlow();
    const { idToken } = makeIdToken({ nonce });
    let jwksSignal: AbortSignal | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.startsWith(PORTAL.tokenUri)) {
          return new Response(JSON.stringify({ access_token: 'A', id_token: idToken }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.startsWith(PORTAL.jwksUri)) {
          jwksSignal = init?.signal ?? undefined;
          // What a real hang looks like once the deadline fires. Thrown immediately so
          // the test asserts the contract without burning the real timeout.
          throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        }
        throw new Error(`unexpected fetch in test: ${u}`);
      }),
    );

    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });

    expect(jwksSignal).toBeInstanceOf(AbortSignal); // the deadline is actually wired
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_id_token' });
    expect(res.setCookies.join('')).not.toContain('cp_session='); // no session on a dead JWKS
    expect((sqlite.prepare('SELECT COUNT(*) n FROM owners').get() as { n: number }).n).toBe(1); // sentinel only
  });

  it('rejects alg:none', async () => {
    await expectRejected((nonce) => ({ idToken: rawToken('none', '', nonce), jwks: [] }));
  });

  it('rejects an HS256-forged token', async () => {
    await expectRejected((nonce) => ({ idToken: rawToken('HS256', Buffer.from('hmac-forgery').toString('base64url'), nonce), jwks: [] }));
  });

  it('rejects a tampered signature (signed by an unrelated key)', async () => {
    const { privateKey: rogue } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expectRejected((nonce) => makeIdToken({ nonce }, { signWith: rogue })); // JWKS holds the real key
  });

  it('rejects a wrong issuer', async () => {
    await expectRejected((nonce) => makeIdToken({ iss: 'https://evil.example', nonce }));
  });

  it('rejects a wrong audience', async () => {
    await expectRejected((nonce) => makeIdToken({ aud: 'some-other-app', nonce }));
  });

  // Expired by an hour — comfortably outside the 60s clock-skew allowance, so this
  // asserts "expired" rather than "expired by less than the leeway" (it previously used
  // −10s, which the skew now deliberately forgives; see the boundary tests below).
  it('rejects an expired token', async () => {
    await expectRejected((nonce) => makeIdToken({ exp: Math.floor(Date.now() / 1000) - 3600, nonce }));
  });

  it('rejects a token whose exp is just past the skew allowance', async () => {
    await expectRejected((nonce) => makeIdToken({ exp: Math.floor(Date.now() / 1000) - 120, nonce }));
  });

  it('rejects a not-yet-valid token (nbf in the future beyond the skew)', async () => {
    await expectRejected((nonce) => makeIdToken({ nbf: Math.floor(Date.now() / 1000) + 600, nonce }));
  });

  it('rejects a token issued in the future (iat beyond the skew) — fabricated, not drift', async () => {
    await expectRejected((nonce) => makeIdToken({ iat: Math.floor(Date.now() / 1000) + 600, nonce }));
  });

  it('rejects an aud array that does not contain our client_id', async () => {
    await expectRejected((nonce) => makeIdToken({ aud: ['someone-else', 'third-party'], nonce }));
  });

  // The point of the azp check: this token is genuinely signed by the portal and DOES
  // list us in `aud` — but it was minted FOR another client. Without azp it would log
  // that provider's other-client user straight into this app.
  it('rejects a multi-audience token minted for a DIFFERENT client (azp mismatch)', async () => {
    await expectRejected((nonce) =>
      makeIdToken({ aud: [PORTAL.clientId, 'other-app'], azp: 'other-app', nonce }));
  });

  it('rejects a multi-audience token with no azp at all', async () => {
    await expectRejected((nonce) => makeIdToken({ aud: [PORTAL.clientId, 'other-app'], nonce }));
  });

  it('rejects a single-aud token whose azp names someone else', async () => {
    await expectRejected((nonce) => makeIdToken({ aud: PORTAL.clientId, azp: 'other-app', nonce }));
  });

  it('rejects a nonce mismatch (token spliced from another flow)', async () => {
    await expectRejected(() => makeIdToken({ nonce: 'a-DIFFERENT-nonce' }));
  });

  it('rejects a verified token with no sub', async () => {
    await expectRejected((nonce) => makeIdToken({ sub: null, nonce }));
  });

  // ── EdDSA / Ed25519 — the signature the REAL CI-Portal issues ──────────────────
  // CI-Portal runs better-auth's jwt() plugin with its default key config (Ed25519), and
  // its live JWKS (https://hub.ci.computer/api/auth/jwks) holds exactly one OKP key. A
  // verifier that only knew RS256 rejected every production login as invalid_id_token
  // while this file stayed green, because the fixture portal signed RS256. These cases
  // pin the EdDSA path AND the key-shape discipline that keeps the two algorithms from
  // being confused for one another.
  it('accepts an EdDSA (Ed25519) token against an OKP JWK — the live CI-Portal shape', async () => {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeIdToken({ nonce, sub: 'eddsa-sub' }, { alg: 'EdDSA' });
    expect(jwks[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    const res = await completeLogin(await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie }));
    expect(res.status).toBe(302);
    expect(res.setCookies.join('')).toContain('cp_session=');
    expect(sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'eddsa-sub'`).get()).toBeTruthy();
  });

  it('accepts an EdDSA token whose JWK omits `alg` and `use` — both are optional, and the live JWKS has no `use`', async () => {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeIdToken({ nonce }, { alg: 'EdDSA', jwkAlg: null, jwkUse: null });
    expect(jwks[0]).not.toHaveProperty('alg');
    expect(jwks[0]).not.toHaveProperty('use');
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    const res = await completeLogin(await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie }));
    expect(res.status).toBe(302);
    expect(res.setCookies.join('')).toContain('cp_session=');
  });

  it('rejects an EdDSA token signed by a rogue Ed25519 key (JWKS holds the real one)', async () => {
    const { privateKey: rogue } = generateKeyPairSync('ed25519');
    await expectRejected((nonce) => makeIdToken({ nonce }, { alg: 'EdDSA', signWith: rogue }));
  });

  it('rejects an EdDSA token when the JWKS holds only an RSA key under that kid (alg confusion)', async () => {
    await expectRejected((nonce) => {
      const eddsa = makeIdToken({ nonce }, { alg: 'EdDSA' });
      const rsa = makeIdToken({ nonce }); // same default kid — only the key SHAPE differs
      return { idToken: eddsa.idToken, jwks: rsa.jwks };
    });
  });

  it('rejects an RS256 header presented against an OKP key (alg confusion, the other way)', async () => {
    // Signed with Ed25519, header claims RS256, served JWK says nothing about alg: the
    // header alone must never be allowed to pick a verification path the key cannot take.
    await expectRejected((nonce) => makeIdToken({ nonce }, { alg: 'EdDSA', headerAlg: 'RS256', jwkAlg: null }));
  });

  it('rejects an OKP key on a curve other than Ed25519 (Ed448 is EdDSA too, and still refused)', async () => {
    await expectRejected((nonce) => makeIdToken({ nonce }, { alg: 'EdDSA', curve: 'ed448' }));
  });

  it("rejects a JWK whose own `alg` contradicts the token header (the JWKS says RS256, the token says EdDSA)", async () => {
    await expectRejected((nonce) => makeIdToken({ nonce }, { alg: 'EdDSA', jwkAlg: 'RS256' }));
  });

  it('rejects a JWK marked for encryption (`use: enc`) even though the signature would verify', async () => {
    await expectRejected((nonce) => makeIdToken({ nonce }, { alg: 'EdDSA', jwkUse: 'enc' }));
  });

  it('rejects ES256 — RS256 and EdDSA are the whole contract', async () => {
    await expectRejected((nonce) => ({ idToken: rawToken('ES256', Buffer.from('ecdsa').toString('base64url'), nonce), jwks: [] }));
  });

  // ── the ACCEPT side of the same rules — over-tightening would lock real users out ──
  async function expectAccepted(extra: TokenPayloadOverrides) {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeIdToken({ nonce, ...extra });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    // The token was accepted iff the callback moved on to the B3 confirmation step
    // (a rejected token 400s before it); completing that step proves the session.
    const res = await completeLogin(await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie }));
    expect(res.status).toBe(302);
    expect(res.setCookies.join('')).toContain('cp_session=');
  }

  it('accepts a spec-legal aud ARRAY containing our client_id (with matching azp)', async () => {
    await expectAccepted({ aud: [PORTAL.clientId, 'other-app'], azp: PORTAL.clientId });
  });

  it('accepts a single-element aud array', async () => {
    await expectAccepted({ aud: [PORTAL.clientId] });
  });

  it('accepts a matching azp alongside a single-string aud', async () => {
    await expectAccepted({ aud: PORTAL.clientId, azp: PORTAL.clientId });
  });

  it('accepts sane iat/nbf in the past', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await expectAccepted({ iat: nowS - 30, nbf: nowS - 30 });
  });

  // The deliberate leeway: a provider clock a few seconds behind ours must not lock a
  // user out. Beyond the allowance it is rejected (see the −120s case above).
  it('accepts a token that expired within the clock-skew allowance', async () => {
    await expectAccepted({ exp: Math.floor(Date.now() / 1000) - 10 });
  });
});

// ── /callback: provisioning + session ───────────────────────────────────────────
describe('GET /api/auth/ciportal/callback — provisioning & session', () => {
  /** The callback alone — what the portal's redirect produces. */
  async function callback(sub = 'portal-sub-1', extra: TokenPayloadOverrides = {}) {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeIdToken({ sub, nonce, ...extra });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    return rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
  }
  /** The whole login, confirmation step included when the sub is new (B3). */
  const login = async (sub = 'portal-sub-1', extra: TokenPayloadOverrides = {}) => completeLogin(await callback(sub, extra));

  /** The install-time local admin (what the Hub seeds from AUTH_DEFAULT_*): with an
   *  operator already present, every portal user is a plain member (Phase AG). */
  const seedLocalOperator = () =>
    provisionOwner({ name: 'Local Admin', username: 'local-admin', passwordHash: 'not-a-real-hash', role: 'operator' });
  const roleOf = (sub: string) =>
    (sqlite.prepare(`SELECT role FROM owners WHERE external_subject = ?`).get(sub) as { role: string } | undefined)?.role;

  it('auto-provisions a FUNCTIONAL owner on first login: session + G-BASETAG seeds', async () => {
    await seedLocalOperator();
    const res = await login('sub-new', { name: 'Ada Portal', email: 'ada@ci.test' });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');

    const joined = res.setCookies.join('\n');
    expect(joined).toMatch(/cp_session=/);
    expect(joined).toMatch(/cp_session\.sig=/);
    expect(res.setCookies.every((c) => /httponly/i.test(c))).toBe(true);

    const owner = sqlite
      .prepare(`SELECT id, name, email, role FROM owners WHERE external_subject = 'sub-new'`)
      .get() as { id: string; name: string; email: string; role: string };
    expect(owner).toBeTruthy();
    expect(owner.name).toBe('Ada Portal');
    expect(owner.email).toBe('ada@ci.test');
    // Phase AG: with an operator already on the instance, an auto-provisioned portal
    // user is a member — the fix for "every SSO tenant is an admin". (The one exception,
    // an instance with NO operator, is the A3 block below.)
    expect(owner.role).toBe('member');

    const tags = sqlite
      .prepare(`SELECT name, kind, is_base FROM tags WHERE owner_id = ? ORDER BY kind, name`)
      .all(owner.id) as { name: string; kind: string; is_base: number }[];
    // 0134: base categories are the six Balance dimensions (ordered by kind, then name).
    expect(tags.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'category:career', 'category:finance', 'category:growth',
      'category:health', 'category:leisure', 'category:relationships',
      'direction:community', 'direction:home', 'direction:work',
    ]);
    expect(tags.every((t) => t.is_base === 1)).toBe(true);
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM tag_prefs WHERE owner_id = ? AND kind='category'`).get(owner.id) as { n: number }).n).toBe(6);
    expect(sqlite.prepare(`SELECT key FROM day_types WHERE owner_id = ? ORDER BY key`).all(owner.id)).toEqual([{ key: 'weekend' }, { key: 'workday' }]);
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM day_of_week_map WHERE owner_id = ?`).get(owner.id) as { n: number }).n).toBe(7);
    const pts = sqlite.prepare(`SELECT name, catch_all FROM pattern_types WHERE owner_id = ? ORDER BY name`).all(owner.id) as { name: string; catch_all: number }[];
    expect(pts.map((p) => p.name)).toEqual(['Community', 'Habit', 'Ritual', 'Routine']);
    expect(pts.find((p) => p.name === 'Community')!.catch_all).toBe(1);
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM scheduling_prefs WHERE owner_id = ?`).get(owner.id)).toEqual({ n: 1 });
  });

  it('the issued session authenticates gated routes; /api/auth/me reports the identity', async () => {
    await seedLocalOperator();
    const res = await login('sub-session', { name: 'Sess Ion', email: 'sess@ci.test' });
    const cookie = cookieHeader(res.setCookies);

    expect((await realFetch(`${srv.url}/api/tasks`, { headers: { Cookie: cookie } })).status).toBe(200);
    // Phase AG: the auto-provisioned member's session carries no admin scope.
    expect((await realFetch(`${srv.url}/api/jobs`, { headers: { Cookie: cookie } })).status).toBe(403);
    const me = await realFetch(`${srv.url}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const identity = (await me.json()) as { name: string; email: string };
    expect(identity.name).toBe('Sess Ion');
    expect(identity.email).toBe('sess@ci.test');
    expect((await realFetch(`${srv.url}/api/auth/me`)).status).toBe(401);
  });

  it('a repeat login with the same sub reuses the owner (no duplicates) and skips the confirmation step', async () => {
    const first = await callback('sub-repeat');
    expectAwaitingConfirmation(first); // B3: the first time asks
    await confirmCreate(first);
    const again = await callback('sub-repeat');
    expect(again.status).toBe(302);
    expect(again.location).toBe('/'); // known sub: straight in, no confirmation
    expect(again.setCookies.join('')).toContain('cp_session=');
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM owners WHERE external_subject = 'sub-repeat'`).get() as { n: number }).n).toBe(1);
  });

  it('403s an unknown sub when auto-provision is off — and the A3 operator claim never bypasses that gate', async () => {
    config.auth.autoProvision = false;
    expect(await operatorCount()).toBe(0); // the most tempting instance to claim
    const res = await login('sub-unknown');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unknown_subject_auto_provision_disabled' });
    expect(res.setCookies.join('')).not.toContain('cp_session=');
    expect(await operatorCount()).toBe(0);
  });

  // ── A3: the first portal login on an operator-less instance claims the operator role ──
  // Companion Memory parity: "the first account on an empty appliance becomes admin".
  // Without this, a portal-only install (no AUTH_DEFAULT_* seeded) has members forever and
  // nobody who can open Settings → Accounts. The claim lives INSIDE provisionOwner's
  // insert statement, so it is atomic against a racing first login.
  it('A3: the FIRST portal login on an instance with no operator claims the operator role', async () => {
    expect(await operatorCount()).toBe(0);
    const res = await login('sub-founder', { name: 'Founder', email: 'founder@ci.test' });
    expect(res.status).toBe(302);
    expect(roleOf('sub-founder')).toBe('operator');
    expect(await operatorCount()).toBe(1);
    const cookie = cookieHeader(res.setCookies);
    // The session carries admin scope straight away — no re-login needed.
    expect((await realFetch(`${srv.url}/api/jobs`, { headers: { Cookie: cookie } })).status).toBe(200);
    const me = (await (await realFetch(`${srv.url}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as { role: string; isOperator: boolean };
    expect(me).toMatchObject({ role: 'operator', isOperator: true });
  });

  it('A3: every later portal user is a member once an operator exists — portal-claimed or local-seeded', async () => {
    await login('sub-founder');
    expect(roleOf('sub-founder')).toBe('operator');
    const second = await login('sub-second');
    expect(second.status).toBe(302);
    expect(roleOf('sub-second')).toBe('member');
    expect((await realFetch(`${srv.url}/api/jobs`, { headers: { Cookie: cookieHeader(second.setCookies) } })).status).toBe(403);
    expect(await operatorCount()).toBe(1);
    // A repeat login by the founder does not re-run the claim or change anything.
    await login('sub-founder');
    expect(roleOf('sub-founder')).toBe('operator');
    expect(await operatorCount()).toBe(1);
  });

  it('A3: the sentinel never counts as an operator for the claim (N-SENTINEL)', async () => {
    const saved = (sqlite.prepare(`SELECT role FROM owners WHERE id = ?`).get(SYSTEM_OWNER_ID) as { role: string }).role;
    sqlite.prepare(`UPDATE owners SET role = 'operator' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      expect(await operatorCount()).toBe(0); // excluded by id
      await login('sub-after-sentinel');
      expect(roleOf('sub-after-sentinel')).toBe('operator');
    } finally {
      sqlite.prepare(`UPDATE owners SET role = ? WHERE id = ?`).run(saved, SYSTEM_OWNER_ID);
    }
  });

  it('A3: two first logins racing each other mint exactly ONE operator', async () => {
    // Two different portal subjects, two flows, two codes; the token endpoint hands each
    // code its own id_token. Both callbacks are in flight at once. Whichever insert runs
    // first wins the role; the other reads "one operator" inside the same statement.
    const a = await startFlow();
    const b = await startFlow();
    const ta = makeIdToken({ sub: 'sub-race-a', nonce: a.nonce }, { kid: 'kid-a' });
    const tb = makeIdToken({ sub: 'sub-race-b', nonce: b.nonce }, { kid: 'kid-b' });
    const byCode: Record<string, string> = { CA: ta.idToken, CB: tb.idToken };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.startsWith(PORTAL.tokenUri)) {
          const code = new URLSearchParams(String(init?.body ?? '')).get('code') ?? '';
          const id_token = byCode[code];
          return new Response(JSON.stringify(id_token ? { access_token: 'A', id_token } : { error: 'invalid_grant' }), {
            status: id_token ? 200 : 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.startsWith(PORTAL.jwksUri)) {
          return new Response(JSON.stringify({ keys: [...ta.jwks, ...tb.jwks] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected fetch in test: ${u}`);
      }),
    );
    const [ca, cb] = await Promise.all([
      rawGet(`/api/auth/ciportal/callback?state=${a.state}&code=CA`, { Cookie: a.cookie }),
      rawGet(`/api/auth/ciportal/callback?state=${b.state}&code=CB`, { Cookie: b.cookie }),
    ]);
    expectAwaitingConfirmation(ca);
    expectAwaitingConfirmation(cb);
    expect(await operatorCount()).toBe(0); // nothing minted until each confirms (B3)
    // Both confirmation pages open; both "Create account" clicks land at once — the
    // race is now between the two POSTs, and the claim inside the insert still holds.
    const [pa, pb] = await Promise.all([openConfirmPage(ca), openConfirmPage(cb)]);
    const [ra, rb] = await Promise.all([
      rawPost(CONFIRM_PATH, { csrf: pa.csrf, decision: 'create' }, { Cookie: pa.cookie }),
      rawPost(CONFIRM_PATH, { csrf: pb.csrf, decision: 'create' }, { Cookie: pb.cookie }),
    ]);
    expect([ra.status, rb.status]).toEqual([302, 302]);
    expect([ra.location, rb.location]).toEqual(['/', '/']);
    expect(await operatorCount()).toBe(1);
    expect([roleOf('sub-race-a'), roleOf('sub-race-b')].sort()).toEqual(['member', 'operator']);
  });

  it('N-SENTINEL: a sub reserved by the sentinel fails closed (403) at the callback, never binds it, never asks', async () => {
    sqlite.prepare(`UPDATE owners SET external_subject = 'sub-sentinel-attack' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      const res = await callback('sub-sentinel-attack');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'subject_unavailable' });
      expect(res.setCookies.join('')).not.toContain('cp_session=');
      expect(res.setCookies.join('')).not.toMatch(new RegExp(`${INTENT_COOKIE}=[^;]+`)); // no confirmation offered
      const holders = sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'sub-sentinel-attack'`).all() as { id: string }[];
      expect(holders).toEqual([{ id: SYSTEM_OWNER_ID }]); // nothing new provisioned
    } finally {
      sqlite.prepare(`UPDATE owners SET external_subject = NULL WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });

  it('N-SENTINEL: a sub the sentinel takes BETWEEN the callback and the confirmation is refused at the POST', async () => {
    const cb = await callback('sub-sentinel-late');
    expectAwaitingConfirmation(cb);
    sqlite.prepare(`UPDATE owners SET external_subject = 'sub-sentinel-late' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      const res = await confirmCreate(cb);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'subject_unavailable' });
      expect(res.setCookies.join('')).not.toContain('cp_session=');
      const holders = sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'sub-sentinel-late'`).all() as { id: string }[];
      expect(holders).toEqual([{ id: SYSTEM_OWNER_ID }]);
    } finally {
      sqlite.prepare(`UPDATE owners SET external_subject = NULL WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });

  it('logout clears the SSO session', async () => {
    const res = await login('sub-logout');
    const cookie = cookieHeader(res.setCookies);
    const out = await realFetch(`${srv.url}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    const cleared = cookieHeader(out.headers.getSetCookie?.() ?? []);
    expect((await realFetch(`${srv.url}/api/tasks`, { headers: { Cookie: cleared } })).status).toBe(401);
  });
});

// ── B3: first-time portal sign-in confirmation ─────────────────────────────────
// Companion Memory parity: before a tenant is created for a Portal identity that has
// never been here, the person is asked. Guards against creating an account from the
// wrong Portal persona (and, on an operator-less instance, accidentally claiming the
// operator role). No JS: a signed 10-minute intent cookie + a plain HTML form whose
// hidden CSRF token must match the cookie's.
describe('B3 — GET/POST /api/auth/ciportal/confirm-account', () => {
  async function callback(sub: string, extra: TokenPayloadOverrides = {}) {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeIdToken({ sub, nonce, ...extra });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    return rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
  }
  const ownerCount = () => (sqlite.prepare('SELECT COUNT(*) n FROM owners').get() as { n: number }).n; // 1 = sentinel only
  const bySub = (sub: string) => sqlite.prepare(`SELECT id, name, email, role FROM owners WHERE external_subject = ?`).get(sub) as
    { id: string; name: string; email: string | null; role: string } | undefined;

  it('the callback parks an unknown sub: signed httpOnly intent cookie, redirect to the page, NO owner, NO session', async () => {
    const cb = await callback('b3-new', { name: 'Nia New', email: 'nia@ci.test' });
    expectAwaitingConfirmation(cb);
    expect(cb.setCookies.filter((c) => c.startsWith(INTENT_COOKIE)).every((c) => /httponly/i.test(c))).toBe(true);
    expect(ownerCount()).toBe(1);
    expect(bySub('b3-new')).toBeUndefined();
  });

  it('the page is self-contained no-JS HTML that names the verified identity and carries the CSRF field', async () => {
    const cb = await callback('b3-page', { name: 'Page Person', email: 'page@ci.test' });
    const { html } = await openConfirmPage(cb);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('Create a Companion Planning account?');
    expect(html).toContain('Page Person');
    expect(html).toContain('page@ci.test');
    expect(html).toContain('Companion Portal');
    expect(html).toMatch(/<form method="post" action="\/api\/auth\/ciportal\/confirm-account">/);
    expect(html).toMatch(/name="decision" value="create"/);
    expect(html).toMatch(/name="decision" value="cancel"/);
    // Reloading the page does not consume the intent.
    expect((await rawGet(CONFIRM_PATH, { Cookie: cookieHeader(cb.setCookies) })).status).toBe(200);
  });

  it('escapes the identity in the page (a hostile Portal display name cannot inject markup)', async () => {
    const cb = await callback('b3-xss', { name: '<img src=x onerror=alert(1)>', email: 'x@ci.test' });
    const { html } = await openConfirmPage(cb);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('Create provisions through the A3 path (first = operator), signs in, and clears the intent', async () => {
    expect(await operatorCount()).toBe(0);
    const cb = await callback('b3-create', { name: 'Cree Ate', email: 'cree@ci.test' });
    const res = await confirmCreate(cb);
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');
    const joined = res.setCookies.join('\n');
    expect(joined).toMatch(/cp_session=[^;]+/);
    expect(joined).toMatch(new RegExp(`${INTENT_COOKIE}=;`)); // cleared
    const owner = bySub('b3-create')!;
    expect(owner).toMatchObject({ name: 'Cree Ate', email: 'cree@ci.test', role: 'operator' });
    // The session works, and the cleared intent cannot be replayed into a second confirmation.
    const session = cookieHeader(res.setCookies);
    expect((await realFetch(`${srv.url}/api/auth/me`, { headers: { Cookie: session } })).status).toBe(200);
    const again = await rawGet(CONFIRM_PATH, { Cookie: session });
    expect(again.status).toBe(302);
    expect(again.location).toBe('/login?sso_error=confirmation_expired');
  });

  it('Cancel provisions nothing, clears the intent, and returns to /login', async () => {
    const cb = await callback('b3-cancel');
    const { cookie, csrf } = await openConfirmPage(cb);
    const res = await rawPost(CONFIRM_PATH, { csrf, decision: 'cancel' }, { Cookie: cookie });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login');
    expect(res.setCookies.join('')).not.toContain('cp_session=');
    expect(res.setCookies.join('\n')).toMatch(new RegExp(`${INTENT_COOKIE}=;`));
    expect(ownerCount()).toBe(1);
    expect(await operatorCount()).toBe(0);
    // The intent is gone: a later "create" with the same cookies is refused.
    const late = await rawPost(CONFIRM_PATH, { csrf, decision: 'create' }, { Cookie: cookieHeader(res.setCookies) });
    expect(late.status).toBe(302);
    expect(late.location).toBe('/login?sso_error=confirmation_expired');
    expect(ownerCount()).toBe(1);
  });

  it('an unrecognised decision is treated as cancel — nothing provisioned', async () => {
    const cb = await callback('b3-odd');
    const { cookie, csrf } = await openConfirmPage(cb);
    const res = await rawPost(CONFIRM_PATH, { csrf, decision: 'yes-please' }, { Cookie: cookie });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login');
    expect(ownerCount()).toBe(1);
  });

  it('the CSRF token is enforced: wrong or missing → 403, nothing provisioned, and the real page still works', async () => {
    const cb = await callback('b3-csrf');
    const { cookie, csrf } = await openConfirmPage(cb);
    const wrong = await rawPost(CONFIRM_PATH, { csrf: 'not-the-token', decision: 'create' }, { Cookie: cookie });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'invalid_csrf_token' });
    const missing = await rawPost(CONFIRM_PATH, { decision: 'create' }, { Cookie: cookie });
    expect(missing.status).toBe(403);
    expect(ownerCount()).toBe(1);
    expect(wrong.setCookies.join('')).not.toContain('cp_session=');
    // The refusal did not burn the intent: the legitimate page can still confirm.
    const ok = await rawPost(CONFIRM_PATH, { csrf, decision: 'create' }, { Cookie: cookie });
    expect(ok.status).toBe(302);
    expect(ok.location).toBe('/');
    expect(bySub('b3-csrf')).toBeTruthy();
  });

  it('the CSRF token is bound to the cookie, not guessable from another flow', async () => {
    const mine = await openConfirmPage(await callback('b3-mine'));
    const theirs = await openConfirmPage(await callback('b3-theirs'));
    // Their token with my cookie — a page the attacker read for their own identity.
    const res = await rawPost(CONFIRM_PATH, { csrf: theirs.csrf, decision: 'create' }, { Cookie: mine.cookie });
    expect(res.status).toBe(403);
    expect(bySub('b3-mine')).toBeUndefined();
  });

  it('an expired intent is refused on GET and POST, provisions nothing, and bounces to /login with a reason', async () => {
    const cb = await callback('b3-expired');
    const { cookie, csrf } = await openConfirmPage(cb);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000); // past the 10-minute window
      const page = await rawGet(CONFIRM_PATH, { Cookie: cookie });
      expect(page.status).toBe(302);
      expect(page.location).toBe('/login?sso_error=confirmation_expired');
      const post = await rawPost(CONFIRM_PATH, { csrf, decision: 'create' }, { Cookie: cookie });
      expect(post.status).toBe(302);
      expect(post.location).toBe('/login?sso_error=confirmation_expired');
      expect(post.setCookies.join('')).not.toContain('cp_session=');
      expect(bySub('b3-expired')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tampered intent (signature no longer matches) is refused — the identity cannot be rewritten client-side', async () => {
    const cb = await callback('b3-tamper', { name: 'Honest', email: 'honest@ci.test' });
    const { cookie, csrf } = await openConfirmPage(cb);
    // Re-encode the payload with a different sub but keep the original `.sig`.
    const parts = Object.fromEntries(cookie.split('; ').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    const payload = JSON.parse(Buffer.from(parts[INTENT_COOKIE], 'base64url').toString('utf8'));
    payload.sub = 'b3-victim';
    parts[INTENT_COOKIE] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const forged = Object.entries(parts).map(([k, v]) => `${k}=${v}`).join('; ');
    const page = await rawGet(CONFIRM_PATH, { Cookie: forged });
    expect(page.status).toBe(302);
    expect(page.location).toBe('/login?sso_error=confirmation_expired');
    const post = await rawPost(CONFIRM_PATH, { csrf, decision: 'create' }, { Cookie: forged });
    expect(post.status).toBe(302);
    expect(post.location).toBe('/login?sso_error=confirmation_expired');
    expect(ownerCount()).toBe(1);
    expect(bySub('b3-victim')).toBeUndefined();
    expect(bySub('b3-tamper')).toBeUndefined();
  });

  it('with no intent cookie at all the page bounces to /login (nothing to confirm)', async () => {
    const res = await rawGet(CONFIRM_PATH);
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login?sso_error=confirmation_expired');
    expect((await rawPost(CONFIRM_PATH, { decision: 'create', csrf: 'x' })).status).toBe(302);
    expect(ownerCount()).toBe(1);
  });

  it('auto-provision switched off between the callback and the click → 403, nothing provisioned', async () => {
    const cb = await callback('b3-policy-flip');
    const { cookie, csrf } = await openConfirmPage(cb);
    config.auth.autoProvision = false;
    const res = await rawPost(CONFIRM_PATH, { csrf, decision: 'create' }, { Cookie: cookie });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unknown_subject_auto_provision_disabled' });
    expect(bySub('b3-policy-flip')).toBeUndefined();
  });

  it('a sub provisioned meanwhile (the same person confirming in two tabs) is reused, not duplicated', async () => {
    const tab1 = await openConfirmPage(await callback('b3-two-tabs'));
    const tab2 = await openConfirmPage(await callback('b3-two-tabs'));
    expect((await rawPost(CONFIRM_PATH, { csrf: tab1.csrf, decision: 'create' }, { Cookie: tab1.cookie })).location).toBe('/');
    const second = await rawPost(CONFIRM_PATH, { csrf: tab2.csrf, decision: 'create' }, { Cookie: tab2.cookie });
    expect(second.status).toBe(302);
    expect(second.location).toBe('/');
    expect(second.setCookies.join('')).toContain('cp_session=');
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM owners WHERE external_subject = 'b3-two-tabs'`).get() as { n: number }).n).toBe(1);
  });

  it('404s when DISABLE_OIDC=true (no portal, no confirmation page)', async () => {
    config.auth.disableOidc = true;
    try {
      expect((await rawGet(CONFIRM_PATH)).status).toBe(404);
      expect((await rawPost(CONFIRM_PATH, { decision: 'create', csrf: 'x' })).status).toBe(404);
    } finally {
      config.auth.disableOidc = false;
    }
  });
});

// ── Discovery-driven endpoints + iss-from-doc (real CI-Portal / better-auth shape) ──
// The tests above set the endpoint overrides (exercising the air-gapped override path,
// which validates `iss` against the configured issuer). These exercise the DEFAULT path:
// endpoints + the canonical `iss` come from <issuer>/.well-known/openid-configuration.
describe('GET /api/auth/ciportal — discovery-driven', () => {
  const DISCOVERY = {
    issuer: 'https://portal.test', // NOTE: bare origin — differs from the …/api/auth discovery URL
    authorization_endpoint: 'https://portal.test/authorize',
    token_endpoint: 'https://portal.test/token',
    jwks_uri: 'https://portal.test/jwks',
  };
  let saved: { a?: string; t?: string; j?: string; iss?: string };

  beforeEach(() => {
    __resetOidcDiscoveryCache();
    saved = {
      a: config.ciportal.authorizeUri, t: config.ciportal.tokenUri,
      j: config.ciportal.jwksUri, iss: config.ciportal.issuer,
    };
    // Discovery mode: clear the endpoint overrides so ciportalEndpoints() discovers.
    config.ciportal.authorizeUri = undefined;
    config.ciportal.tokenUri = undefined;
    config.ciportal.jwksUri = undefined;
    config.ciportal.issuer = 'https://portal.test';
  });
  afterEach(() => {
    Object.assign(config.ciportal, { authorizeUri: saved.a, tokenUri: saved.t, jwksUri: saved.j, issuer: saved.iss });
    __resetOidcDiscoveryCache();
    vi.unstubAllGlobals();
  });

  function stubDisc(opts: { token?: unknown; jwks?: unknown[]; tokenStatus?: number; discoveryStatus?: number; doc?: typeof DISCOVERY } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/.well-known/openid-configuration'))
        return new Response(JSON.stringify(opts.doc ?? DISCOVERY), { status: opts.discoveryStatus ?? 200, headers: { 'Content-Type': 'application/json' } });
      if (u === DISCOVERY.token_endpoint)
        return new Response(JSON.stringify(opts.token ?? {}), { status: opts.tokenStatus ?? 200, headers: { 'Content-Type': 'application/json' } });
      if (u === DISCOVERY.jwks_uri)
        return new Response(JSON.stringify({ keys: opts.jwks ?? [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`unexpected fetch in test: ${u}`);
    }));
  }
  async function startDisc(): Promise<{ state: string; cookie: string; nonce: string; location: string }> {
    stubDisc();
    const res = await realFetch(`${srv.url}/api/auth/ciportal/start`, { redirect: 'manual' });
    const cookie = cookieHeader(res.headers.getSetCookie?.() ?? []);
    const location = res.headers.get('location')!;
    const state = new URL(location).searchParams.get('state')!;
    const row = sqlite.prepare('SELECT nonce FROM auth_states WHERE state = ?').get(state) as { nonce: string };
    return { state, cookie, nonce: row.nonce, location };
  }

  it('/start builds the authorize URL from the DISCOVERED authorization_endpoint', async () => {
    const { location } = await startDisc();
    expect(location.startsWith('https://portal.test/authorize?')).toBe(true); // from the doc, not a config override (unset)
  });

  it('logs in end-to-end via discovery (no endpoint overrides set)', async () => {
    const { state, cookie, nonce } = await startDisc();
    const { idToken, jwks } = makeIdToken({ sub: 'disc-sub', nonce });
    stubDisc({ token: { access_token: 'A', id_token: idToken }, jwks }); // discovery now cached
    const res = await completeLogin(await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie }));
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');
    expect(sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'disc-sub'`).get()).toBeTruthy();
  });

  it('logs in end-to-end via discovery with an EdDSA token — the live portal advertises [RS256, EdDSA] and issues EdDSA', async () => {
    const { state, cookie, nonce } = await startDisc();
    const { idToken, jwks } = makeIdToken({ sub: 'disc-eddsa-sub', nonce }, { alg: 'EdDSA' });
    stubDisc({ token: { access_token: 'A', id_token: idToken }, jwks });
    const res = await completeLogin(await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie }));
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');
    expect(sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'disc-eddsa-sub'`).get()).toBeTruthy();
  });

  it('/start 503s when discovery is unreachable — and mints no state row', async () => {
    stubDisc({ discoveryStatus: 500 });
    const res = await rawGet('/api/auth/ciportal/start');
    expect(res.status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM auth_states').get()).toEqual({ n: 0 });
  });

  // The document is fetched from a configured host but its CONTENTS are provider-supplied,
  // so an off-origin endpoint in it is an open redirect into the middle of the flow: the
  // token_endpoint receives the code + PKCE verifier, and jwks_uri decides which key may
  // sign an identity we then trust. Each is refused, and nothing is cached.
  it.each([
    ['token_endpoint', { ...DISCOVERY, token_endpoint: 'https://evil.test/token' }],
    ['jwks_uri', { ...DISCOVERY, jwks_uri: 'https://evil.test/jwks' }],
    ['authorization_endpoint', { ...DISCOVERY, authorization_endpoint: 'https://evil.test/authorize' }],
    ['issuer', { ...DISCOVERY, issuer: 'https://evil.test' }],
  ])('/start 503s when the discovery doc points %s off-origin', async (_field, doc) => {
    stubDisc({ doc: doc as typeof DISCOVERY });
    const res = await rawGet('/api/auth/ciportal/start');
    expect(res.status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM auth_states').get()).toEqual({ n: 0 });
  });

  it('a rejected discovery doc is NOT cached — a later good doc still works', async () => {
    stubDisc({ doc: { ...DISCOVERY, jwks_uri: 'https://evil.test/jwks' } });
    expect((await rawGet('/api/auth/ciportal/start')).status).toBe(503);
    // Same issuer, now serving a clean document: validation must have skipped the cache
    // write, or this would keep 503ing (or worse, serve the poisoned doc) for the full TTL.
    const { location } = await startDisc();
    expect(location.startsWith('https://portal.test/authorize?')).toBe(true);
  });

  it('accepts endpoints on a deeper PATH of the same origin (the better-auth shape)', async () => {
    // better-auth serves discovery at …/api/auth and its endpoints under …/api/auth/*;
    // the check is per-ORIGIN, so a differing path must not be mistaken for a redirect.
    config.ciportal.issuer = 'https://portal.test/api/auth';
    stubDisc({
      doc: {
        issuer: 'https://portal.test',
        authorization_endpoint: 'https://portal.test/api/auth/authorize',
        token_endpoint: 'https://portal.test/api/auth/token',
        jwks_uri: 'https://portal.test/api/auth/jwks',
      },
    });
    const res = await rawGet('/api/auth/ciportal/start');
    expect(res.status).toBe(302);
  });

  it('validates `iss` against the discovery doc issuer, NOT the configured URL (better-auth quirk)', async () => {
    // Discovery URL is `…/api/auth`, but the doc's issuer (and the token `iss`) is the
    // bare origin. The OLD code validated `iss === config.issuer` (…/api/auth) → would
    // 400. Validating against doc.issuer (bare origin) is what makes real tokens verify.
    config.ciportal.issuer = 'https://portal.test/api/auth';
    __resetOidcDiscoveryCache();
    const { state, cookie, nonce } = await startDisc(); // discovers at …/api/auth; doc.issuer = bare origin
    const { idToken, jwks } = makeIdToken({ sub: 'iss-sub', nonce, iss: 'https://portal.test' });
    stubDisc({ token: { access_token: 'A', id_token: idToken }, jwks });
    const res = await completeLogin(await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie }));
    expect(res.status).toBe(302); // accepted — iss matched doc.issuer, not the …/api/auth config URL
    expect(sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'iss-sub'`).get()).toBeTruthy();
  });
});

// Companion Memory parity: a sign-in brings the person back to the page they asked for.
describe('return to the page the person asked for', () => {
  const ASKED_FOR = '/shared/abc123?tab=notes';
  const ASKED = `?redirect=${encodeURIComponent(ASKED_FOR)}`;

  /** The confirmation POST as a browser sends it: the login's own cookies plus the callback's. */
  async function confirmWithCookies(cb: RawResponse, browserCookie: string): Promise<RawResponse> {
    const cookie = [browserCookie, cookieHeader(cb.setCookies)].join('; ');
    const page = await rawGet(CONFIRM_PATH, { Cookie: cookie });
    const csrf = /name="csrf" value="([^"]+)"/.exec(String(page.body))?.[1];
    expect(csrf).toBeTruthy();
    return rawPost(CONFIRM_PATH, { csrf: csrf!, decision: 'create' }, { Cookie: cookie });
  }

  it('remembers a same-origin page for the login, and forgets an unsafe one', async () => {
    const good = await rawGet(`/api/auth/ciportal/start${ASKED}`);
    expect(good.setCookies.join('\n')).toMatch(new RegExp(`cp_portal_redirect=${encodeURIComponent(ASKED_FOR)}`));

    const bad = await rawGet(`/api/auth/ciportal/start?redirect=${encodeURIComponent('//evil.example')}`);
    expect(bad.setCookies.join('\n')).not.toMatch(/cp_portal_redirect=%2F/);
  });

  it('a new Portal account is sent back to that page once it confirms', async () => {
    const { state, cookie, nonce } = await startFlow(ASKED);
    const { idToken, jwks } = makeIdToken({ nonce, sub: 'return-new', name: 'New Person' });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    const cb = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
    expectAwaitingConfirmation(cb);

    const created = await confirmWithCookies(cb, cookie);
    expect(created.status).toBe(302);
    expect(created.location).toBe(ASKED_FOR);
    expect(created.setCookies.join('')).toContain('cp_session=');
  });

  it('an account that already exists goes straight back to that page, and the memory is cleared', async () => {
    // The first sign-in provisions the account (through the confirmation step), so the second is a plain login.
    const first = await startFlow();
    const a = makeIdToken({ nonce: first.nonce, sub: 'return-known' });
    stubPortal({ access_token: 'A', id_token: a.idToken }, a.jwks);
    await completeLogin(await rawGet(`/api/auth/ciportal/callback?state=${first.state}&code=C`, { Cookie: first.cookie }));

    const { state, cookie, nonce } = await startFlow(ASKED);
    const b = makeIdToken({ nonce, sub: 'return-known' });
    stubPortal({ access_token: 'A', id_token: b.idToken }, b.jwks);
    const cb = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
    expect(cb.status).toBe(302);
    expect(cb.location).toBe(ASKED_FOR);
    expect(cb.setCookies.join('')).toContain('cp_session=');
    expect(cb.setCookies.some((c) => c.startsWith('cp_portal_redirect=;'))).toBe(true);
  });

  it('an unsafe destination is ignored: the person lands on the home page', async () => {
    const { state, cookie, nonce } = await startFlow(`?redirect=${encodeURIComponent('//evil.example')}`);
    const { idToken, jwks } = makeIdToken({ nonce, sub: 'return-unsafe' });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    const cb = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });

    const created = await confirmWithCookies(cb, cookie);
    expect(created.location).toBe('/');
  });
});
