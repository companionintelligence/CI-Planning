import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { newId, SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { __resetAuthRateLimit } from '../src/routes/auth.js';
import { __resetOidcDiscoveryCache } from '../src/lib/auth/oidcDiscovery.js';

/**
 * U1 — CI-Portal SSO (OAuth 2.1 + PKCE Relying-Party login).
 *
 * Endpoints are exercised against a STUBBED portal (vi.stubGlobal fetch for the
 * token + JWKS endpoints, real RS256 keypairs — the pattern oauth.test.ts proved for
 * Google). No real network. Every callback test drives /start first (via startFlow)
 * so it carries the real login-state cookie — this both exercises the whole flow and
 * satisfies the login-CSRF binding (the callback rejects a `state` not bound to the
 * browser that started the login). Negative matrix: no code, unbound/unknown/replayed/
 * expired state, alg:none, HS256-forged, tampered signature, wrong iss/aud, expired
 * token, nonce mismatch, missing sub. Plus provisioning + session + logout.
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

/** Drive /start: returns the login-state cookie, the issued state, and its row nonce. */
async function startFlow(): Promise<{ state: string; cookie: string; nonce: string }> {
  const res = await realFetch(`${srv.url}/api/auth/ciportal/start`, { redirect: 'manual' });
  const cookie = cookieHeader(res.headers.getSetCookie?.() ?? []);
  const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
  const row = sqlite.prepare('SELECT nonce FROM auth_states WHERE state = ?').get(state) as { nonce: string };
  return { state, cookie, nonce: row.nonce };
}

interface TokenPayloadOverrides {
  iss?: string; aud?: string; sub?: string | null; exp?: number; nonce?: string; name?: string; email?: string;
}

/** Mint a keypair + RS256-sign an id_token; return it plus the public JWK to serve. */
function makeIdToken(overrides: TokenPayloadOverrides, opts?: { alg?: string; signWith?: KeyObject; kid?: string }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = opts?.kid ?? 'kid-test';
  const header = Buffer.from(JSON.stringify({ alg: opts?.alg ?? 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: overrides.iss ?? PORTAL.issuer,
      aud: overrides.aud ?? PORTAL.clientId,
      ...(overrides.sub === null ? {} : { sub: overrides.sub ?? 'portal-sub-1' }),
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 300,
      nonce: overrides.nonce,
      name: overrides.name ?? 'Portal User',
      email: overrides.email ?? 'portal.user@ci.test',
    }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(opts?.signWith ?? privateKey).toString('base64url');
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { idToken: `${header}.${payload}.${signature}`, jwks: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
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
    expect(url.searchParams.get('redirect_uri')).toBe(config.ciportal.redirectUri); // verbatim from config
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

  it('rejects an expired token', async () => {
    await expectRejected((nonce) => makeIdToken({ exp: Math.floor(Date.now() / 1000) - 10, nonce }));
  });

  it('rejects a nonce mismatch (token spliced from another flow)', async () => {
    await expectRejected(() => makeIdToken({ nonce: 'a-DIFFERENT-nonce' }));
  });

  it('rejects a verified token with no sub', async () => {
    await expectRejected((nonce) => makeIdToken({ sub: null, nonce }));
  });
});

// ── /callback: provisioning + session ───────────────────────────────────────────
describe('GET /api/auth/ciportal/callback — provisioning & session', () => {
  async function login(sub = 'portal-sub-1', extra: TokenPayloadOverrides = {}) {
    const { state, cookie, nonce } = await startFlow();
    const { idToken, jwks } = makeIdToken({ sub, nonce, ...extra });
    stubPortal({ access_token: 'A', id_token: idToken }, jwks);
    return rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
  }

  it('auto-provisions a FUNCTIONAL owner on first login: session + G-BASETAG seeds', async () => {
    const res = await login('sub-new', { name: 'Ada Portal', email: 'ada@ci.test' });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');

    const joined = res.setCookies.join('\n');
    expect(joined).toMatch(/cp_session=/);
    expect(joined).toMatch(/cp_session\.sig=/);
    expect(res.setCookies.every((c) => /httponly/i.test(c))).toBe(true);

    const owner = sqlite
      .prepare(`SELECT id, name, email FROM owners WHERE external_subject = 'sub-new'`)
      .get() as { id: string; name: string; email: string };
    expect(owner).toBeTruthy();
    expect(owner.name).toBe('Ada Portal');
    expect(owner.email).toBe('ada@ci.test');

    const tags = sqlite
      .prepare(`SELECT name, kind, is_base FROM tags WHERE owner_id = ? ORDER BY kind, name`)
      .all(owner.id) as { name: string; kind: string; is_base: number }[];
    expect(tags.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'category:family', 'category:me', 'category:social',
      'direction:community', 'direction:home', 'direction:work',
    ]);
    expect(tags.every((t) => t.is_base === 1)).toBe(true);
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM tag_prefs WHERE owner_id = ? AND kind='category'`).get(owner.id) as { n: number }).n).toBe(3);
    expect(sqlite.prepare(`SELECT key FROM day_types WHERE owner_id = ? ORDER BY key`).all(owner.id)).toEqual([{ key: 'weekend' }, { key: 'workday' }]);
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM day_of_week_map WHERE owner_id = ?`).get(owner.id) as { n: number }).n).toBe(7);
    const pts = sqlite.prepare(`SELECT name, catch_all FROM pattern_types WHERE owner_id = ? ORDER BY name`).all(owner.id) as { name: string; catch_all: number }[];
    expect(pts.map((p) => p.name)).toEqual(['Community', 'Habit', 'Ritual', 'Routine']);
    expect(pts.find((p) => p.name === 'Community')!.catch_all).toBe(1);
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM scheduling_prefs WHERE owner_id = ?`).get(owner.id)).toEqual({ n: 1 });
  });

  it('the issued session authenticates gated routes; /api/auth/me reports the identity', async () => {
    const res = await login('sub-session', { name: 'Sess Ion', email: 'sess@ci.test' });
    const cookie = cookieHeader(res.setCookies);

    expect((await realFetch(`${srv.url}/api/tasks`, { headers: { Cookie: cookie } })).status).toBe(200);
    const me = await realFetch(`${srv.url}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const identity = (await me.json()) as { name: string; email: string };
    expect(identity.name).toBe('Sess Ion');
    expect(identity.email).toBe('sess@ci.test');
    expect((await realFetch(`${srv.url}/api/auth/me`)).status).toBe(401);
  });

  it('a repeat login with the same sub reuses the owner (no duplicates)', async () => {
    await login('sub-repeat');
    await login('sub-repeat');
    expect((sqlite.prepare(`SELECT COUNT(*) n FROM owners WHERE external_subject = 'sub-repeat'`).get() as { n: number }).n).toBe(1);
  });

  it('403s an unknown sub when auto-provision is off', async () => {
    config.auth.autoProvision = false;
    const res = await login('sub-unknown');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'unknown_subject_auto_provision_disabled' });
    expect(res.setCookies.join('')).not.toContain('cp_session=');
  });

  it('N-SENTINEL: a sub reserved by the sentinel fails closed (403), never binds it', async () => {
    sqlite.prepare(`UPDATE owners SET external_subject = 'sub-sentinel-attack' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      const res = await login('sub-sentinel-attack');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'subject_unavailable' });
      expect(res.setCookies.join('')).not.toContain('cp_session=');
      const holders = sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'sub-sentinel-attack'`).all() as { id: string }[];
      expect(holders).toEqual([{ id: SYSTEM_OWNER_ID }]); // nothing new provisioned
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
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');
    expect(sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'disc-sub'`).get()).toBeTruthy();
  });

  it('/start 503s when discovery is unreachable — and mints no state row', async () => {
    stubDisc({ discoveryStatus: 500 });
    const res = await rawGet('/api/auth/ciportal/start');
    expect(res.status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM auth_states').get()).toEqual({ n: 0 });
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
    const res = await rawGet(`/api/auth/ciportal/callback?state=${state}&code=C`, { Cookie: cookie });
    expect(res.status).toBe(302); // accepted — iss matched doc.issuer, not the …/api/auth config URL
    expect(sqlite.prepare(`SELECT id FROM owners WHERE external_subject = 'iss-sub'`).get()).toBeTruthy();
  });
});
