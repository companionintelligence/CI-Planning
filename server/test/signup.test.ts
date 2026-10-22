import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { provisionOwner, operatorCount } from '../src/lib/owners.js';
import { hashPassword } from '../src/lib/auth/password.js';
import { issueSignupCode, listSignupCodes, revokeSignupCode, normalizeSignupCode } from '../src/lib/auth/signupCodes.js';
import { __resetAuthRateLimit } from '../src/routes/auth.js';

/**
 * B2 — invite-code local sign-up (docs/PRODUCTION-READINESS-2026-10-21.md, Track B).
 *
 * Runs the app in local-login mode (AUTH_MODE=sso + DISABLE_OIDC) with AUTH_SIGNUP
 * flipped per test. Covers: the public requirements probe, the three policies (invite
 * / open / off), code lifecycle (required, consumed once, expired, revoked, released
 * when the account is never created), input validation, the per-IP limiter, and the
 * A3 role rule — the first account on an operator-less instance is the operator and
 * every later one a member. Codes are minted through the lib here; the operator-facing
 * HTTP surface is covered in accounts.test.ts.
 */

const PW = 'correct-horse-battery-staple';
const VALID = { name: 'Sam Signup', username: 'sam', email: 'sam@test.local', password: PW };

let srv: TestServer;
let savedAuth: typeof config.auth;

const cookieHeader = (setCookies: string[]) => setCookies.map((c) => c.split(';')[0]).join('; ');

async function signup(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, body: text ? JSON.parse(text) : undefined, setCookies, cookie: cookieHeader(setCookies) };
}

async function requirements() {
  const res = await fetch(`${srv.url}/api/auth/signup/requirements`);
  expect(res.status).toBe(200);
  return res.json();
}

/** Mint a code the way the operator route does (created by the sentinel here — any owner id will do). */
const mint = (note?: string) => issueSignupCode({ createdBy: SYSTEM_OWNER_ID, note });
const codeStatus = async (id: string) => (await listSignupCodes()).find((c) => c.id === id)!.status;
const ownerByUsername = (username: string) =>
  sqlite.prepare(`SELECT id, name, email, role, password_hash FROM owners WHERE username = ?`).get(username) as
    { id: string; name: string; email: string | null; role: string; password_hash: string | null } | undefined;
const ownerCount = () => (sqlite.prepare('SELECT COUNT(*) n FROM owners').get() as { n: number }).n; // 1 = sentinel only

beforeAll(async () => {
  savedAuth = { ...config.auth };
  config.auth.mode = 'sso';
  config.auth.disableOidc = true;
  config.auth.sessionSecret = 'test-session-secret';
  config.auth.rateLimit = { ...config.auth.rateLimit, issueMax: 1000 };
  config.auth.signup = 'invite';
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  Object.assign(config.auth, savedAuth);
});

beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM signup_codes;');
  __resetAuthRateLimit();
  config.auth.signup = 'invite';
  config.auth.disableOidc = true;
});

describe('B2 — GET /api/auth/signup/requirements (public)', () => {
  it('invite: enabled + code required', async () => {
    expect(await requirements()).toEqual({ enabled: true, codeRequired: true });
  });
  it('open: enabled, no code', async () => {
    config.auth.signup = 'open';
    expect(await requirements()).toEqual({ enabled: true, codeRequired: false });
  });
  it('off: disabled', async () => {
    config.auth.signup = 'off';
    expect(await requirements()).toEqual({ enabled: false, codeRequired: false });
  });
  it('is served under Companion Portal login too (local login is on in both sub-modes)', async () => {
    config.auth.disableOidc = false;
    expect(await requirements()).toEqual({ enabled: true, codeRequired: true });
    // …while the login screen's affordance is the portal (A4/B1).
    expect(await (await fetch(`${srv.url}/api/auth/config`)).json()).toMatchObject({ portal: true, local: true, signup: 'portal' });
  });
});

describe('B2 — POST /api/auth/signup: policy', () => {
  it('off → 404, nothing created, even with a valid code', async () => {
    config.auth.signup = 'off';
    const { code } = await mint();
    const r = await signup({ ...VALID, code });
    expect(r.status).toBe(404);
    expect(ownerCount()).toBe(1);
  });

  it('invite: a code is required', async () => {
    const r = await signup(VALID);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invite code is required/i);
    expect(ownerCount()).toBe(1);
  });

  it('invite: a valid code creates the account, consumes the code, and signs the person in', async () => {
    const { code, record } = await mint('for Sam');
    const r = await signup({ ...VALID, code });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, role: 'operator' }); // first account, no operator yet (A3)
    expect(r.setCookies.join('\n')).toMatch(/cp_session=[^;]+/);
    expect(r.setCookies.every((c) => /httponly/i.test(c))).toBe(true);

    const owner = ownerByUsername('sam')!;
    expect(owner).toMatchObject({ name: 'Sam Signup', email: 'sam@test.local', role: 'operator' });
    expect(owner.password_hash).toMatch(/^\$argon2id\$/);

    const codes = await listSignupCodes();
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ id: record.id, note: 'for Sam', status: 'used', usedByName: 'Sam Signup' });
    expect(codes[0].usedAt).toBeTruthy();

    // The session is real: /api/auth/me reports the identity with admin scope.
    const me = await fetch(`${srv.url}/api/auth/me`, { headers: { Cookie: r.cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ username: 'sam', role: 'operator', isOperator: true });
    expect((await fetch(`${srv.url}/api/accounts`, { headers: { Cookie: r.cookie } })).status).toBe(200);
  });

  it('invite: a code is single-use — the second sign-up with it is refused', async () => {
    const { code } = await mint();
    expect((await signup({ ...VALID, code })).status).toBe(201);
    const again = await signup({ ...VALID, username: 'sam2', email: 'sam2@test.local', code });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/invalid, already used, or has expired/i);
    expect(ownerByUsername('sam2')).toBeUndefined();
  });

  it('invite: an expired code is refused', async () => {
    const { code, record } = await mint();
    sqlite.prepare(`UPDATE signup_codes SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), record.id);
    expect(await codeStatus(record.id)).toBe('expired');
    const r = await signup({ ...VALID, code });
    expect(r.status).toBe(400);
    expect(ownerCount()).toBe(1);
  });

  it('invite: a revoked code is refused', async () => {
    const { code, record } = await mint();
    expect(await revokeSignupCode(record.id)).toBe(true);
    expect(await codeStatus(record.id)).toBe('revoked');
    const r = await signup({ ...VALID, code });
    expect(r.status).toBe(400);
    expect(ownerCount()).toBe(1);
    expect(await revokeSignupCode('00000000-0000-7000-8000-00000000dead')).toBe(false);
  });

  it('invite: an unknown code gets the SAME refusal as a spent one (codes cannot be probed)', async () => {
    const { code } = await mint();
    await signup({ ...VALID, code }); // spend it
    const spent = await signup({ ...VALID, username: 'x1', email: 'x1@test.local', code });
    const unknown = await signup({ ...VALID, username: 'x2', email: 'x2@test.local', code: 'ZZZZ-ZZZZ-ZZZZ' });
    expect([spent.status, unknown.status]).toEqual([400, 400]);
    expect(spent.body).toEqual(unknown.body);
  });

  it('invite: codes are normalised — lower-case, spaces and missing dashes still match', async () => {
    const { code } = await mint();
    const sloppy = ` ${code.toLowerCase().replace(/-/g, ' ')} `;
    expect(normalizeSignupCode(sloppy)).toBe(normalizeSignupCode(code));
    expect((await signup({ ...VALID, code: sloppy })).status).toBe(201);
  });

  it('invite: a code claimed by a sign-up that then FAILS (username taken) is released, not burned', async () => {
    await provisionOwner({ name: 'Taken', username: 'sam', passwordHash: await hashPassword(PW), role: 'operator' });
    const { code, record } = await mint();
    const r = await signup({ ...VALID, code }); // username 'sam' already exists
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'that username is not available' });
    expect(await codeStatus(record.id)).toBe('active'); // released
    // …and it still admits a sign-up with a free username.
    expect((await signup({ ...VALID, username: 'sam-b', email: 'samb@test.local', code })).status).toBe(201);
    expect(await codeStatus(record.id)).toBe('used');
  });

  it('open: no code needed; a supplied code is ignored', async () => {
    config.auth.signup = 'open';
    const r = await signup(VALID);
    expect(r.status).toBe(201);
    expect(ownerByUsername('sam')).toBeTruthy();
    const { record } = await mint();
    expect((await signup({ ...VALID, username: 'sam2', email: 'sam2@test.local', code: 'whatever' })).status).toBe(201);
    expect(await codeStatus(record.id)).toBe('active');
  });

  it('works under Companion Portal login too (the operator can hand out a code to someone without a Portal account)', async () => {
    config.auth.disableOidc = false;
    const { code } = await mint();
    const r = await signup({ ...VALID, code });
    expect(r.status).toBe(201);
    expect(r.setCookies.join('')).toContain('cp_session=');
  });
});

describe('B2 — POST /api/auth/signup: roles (A3 parity)', () => {
  it('the first account on an operator-less instance is the OPERATOR; the second is a member', async () => {
    expect(await operatorCount()).toBe(0);
    const a = await signup({ ...VALID, code: (await mint()).code });
    expect(a.body.role).toBe('operator');
    expect(await operatorCount()).toBe(1);
    const b = await signup({ ...VALID, username: 'second', email: 'second@test.local', code: (await mint()).code });
    expect(b.status).toBe(201);
    expect(b.body.role).toBe('member');
    expect(await operatorCount()).toBe(1);
    expect((await fetch(`${srv.url}/api/accounts`, { headers: { Cookie: b.cookie } })).status).toBe(403);
  });

  it('with an operator already present (the install-time admin), a sign-up is a member', async () => {
    await provisionOwner({ name: 'Local Admin', username: 'admin', passwordHash: await hashPassword(PW), role: 'operator' });
    const r = await signup({ ...VALID, code: (await mint()).code });
    expect(r.body.role).toBe('member');
    expect(await operatorCount()).toBe(1);
  });

  it('the sentinel never counts as an operator for the claim (N-SENTINEL)', async () => {
    sqlite.prepare(`UPDATE owners SET role = 'operator' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      const r = await signup({ ...VALID, code: (await mint()).code });
      expect(r.body.role).toBe('operator');
    } finally {
      sqlite.prepare(`UPDATE owners SET role = 'member' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });

  it('two sign-ups racing on an empty instance mint exactly ONE operator', async () => {
    const [c1, c2] = [await mint(), await mint()];
    const [a, b] = await Promise.all([
      signup({ ...VALID, username: 'race-a', email: 'a@test.local', code: c1.code }),
      signup({ ...VALID, username: 'race-b', email: 'b@test.local', code: c2.code }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.role, b.body.role].sort()).toEqual(['member', 'operator']);
    expect(await operatorCount()).toBe(1);
  });
});

describe('B2 — POST /api/auth/signup: validation + abuse', () => {
  it('rejects bad input with 400 and never spends the code', async () => {
    const { code, record } = await mint();
    const post = (patch: Record<string, unknown>) => signup({ ...VALID, code, ...patch });
    expect((await post({ name: '' })).status).toBe(400);
    expect((await post({ name: 'x'.repeat(121) })).status).toBe(400);
    expect((await post({ username: '' })).status).toBe(400);
    expect((await post({ username: 'has space' })).status).toBe(400);
    expect((await post({ username: 'u'.repeat(65) })).status).toBe(400);
    expect((await post({ email: 'not-an-email' })).status).toBe(400);
    expect((await post({ email: '' })).status).toBe(400);
    expect((await post({ password: 'short' })).status).toBe(400);
    expect((await post({ password: 42 })).status).toBe(400);
    expect(ownerCount()).toBe(1);
    expect(await codeStatus(record.id)).toBe('active');
  });

  it('a malformed body is 400, not 500', async () => {
    const res = await fetch(`${srv.url}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('is rate-limited per IP with the login limiter (429 past issueMax)', async () => {
    const saved = config.auth.rateLimit;
    config.auth.rateLimit = { windowMs: 60_000, max: 60, issueMax: 2 };
    __resetAuthRateLimit();
    try {
      // Two attempts (both 400 — no code) are counted; the third is refused outright.
      expect((await signup(VALID)).status).toBe(400);
      expect((await signup(VALID)).status).toBe(400);
      const third = await signup({ ...VALID, code: (await mint()).code });
      expect(third.status).toBe(429);
      expect(ownerCount()).toBe(1);
    } finally {
      config.auth.rateLimit = saved;
    }
  });

  it('is public: reachable with no credential (and in test mode the route is simply absent → 404)', async () => {
    const saved = { ...config.auth };
    config.auth.mode = 'test';
    try {
      expect((await signup({ ...VALID, code: 'x' })).status).toBe(404);
    } finally {
      Object.assign(config.auth, saved);
    }
  });
});
