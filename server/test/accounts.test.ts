import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { provisionOwner, listOwners, operatorCount } from '../src/lib/owners.js';
import { hashPassword } from '../src/lib/auth/password.js';
import { roleToScopes } from '../src/lib/auth/scopes.js';
import { SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN } from '../src/lib/auth/types.js';
import { __resetAuthRateLimit } from '../src/routes/auth.js';

/**
 * Phase AG — multi-tenant RBAC (docs/AG-multitenant-rbac.md).
 *
 * Runs the app in LOCAL-LOGIN mode (AUTH_MODE=sso + DISABLE_OIDC) so every assertion
 * exercises the real choke point end-to-end: login mints a session cookie, and
 * verifySession derives the request's scopes from `owners.role` (roleToScopes).
 * Covers: role→scope gating (member/viewer/operator), the operator-gated
 * /api/accounts CRUD, the last-operator + self-delete lockout guards, and the
 * session-epoch bump on role change / password reset.
 */

const PW = 'correct-horse-battery-staple';

let srv: TestServer;
let savedAuth: typeof config.auth;

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function login(username: string, password = PW): Promise<string> {
  const res = await fetch(`${srv.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return cookieHeader(res.headers.getSetCookie?.() ?? []);
}

async function req(
  path: string,
  cookie: string,
  init?: { method?: string; json?: unknown },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${srv.url}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Cookie: cookie,
      ...(init?.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function seedUser(username: string, role: 'operator' | 'member' | 'viewer', password = PW): Promise<string> {
  return provisionOwner({ name: username, username, passwordHash: await hashPassword(password), role });
}

beforeAll(async () => {
  savedAuth = { ...config.auth };
  config.auth.mode = 'sso';
  config.auth.disableOidc = true;
  config.auth.sessionSecret = 'test-session-secret';
  config.auth.rateLimit = { ...config.auth.rateLimit, issueMax: 1000 };
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  Object.assign(config.auth, savedAuth);
});

beforeEach(() => {
  resetDb(); // prunes non-sentinel owners
  __resetAuthRateLimit();
});

describe('roleToScopes — the single role→scope map', () => {
  it('maps the three roles onto the existing scopes', () => {
    expect(roleToScopes('operator')).toEqual([SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN]);
    expect(roleToScopes('member')).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(roleToScopes('viewer')).toEqual([SCOPE_READ]);
  });

  it('fails closed to read-only on anything unrecognized', () => {
    expect(roleToScopes('admin')).toEqual([SCOPE_READ]); // hand-edited row
    expect(roleToScopes(null)).toEqual([SCOPE_READ]);
    expect(roleToScopes(undefined)).toEqual([SCOPE_READ]);
  });
});

describe('AG — session scopes derive from owners.role (the choke point)', () => {
  it('an operator session reaches the admin surfaces', async () => {
    await seedUser('op', 'operator');
    const cookie = await login('op');
    expect((await req('/api/jobs', cookie)).status).toBe(200);
    expect((await req('/api/accounts', cookie)).status).toBe(200);
  });

  it('a member session reads and writes its own data but 403s on every admin surface', async () => {
    await seedUser('mem', 'member');
    const cookie = await login('mem');
    expect((await req('/api/tasks', cookie)).status).toBe(200);
    const created = await req('/api/tasks', cookie, { method: 'POST', json: { title: 'member task' } });
    expect(created.status).toBeLessThan(300);
    expect((await req('/api/jobs', cookie)).status).toBe(403);
    expect((await req('/api/google-config', cookie)).status).toBe(403);
    expect((await req('/api/accounts', cookie)).status).toBe(403);
  });

  it('a viewer session reads but 403s on any write', async () => {
    await seedUser('view', 'viewer');
    const cookie = await login('view');
    expect((await req('/api/tasks', cookie)).status).toBe(200);
    expect((await req('/api/tasks', cookie, { method: 'POST', json: { title: 'nope' } })).status).toBe(403);
    expect((await req('/api/jobs', cookie)).status).toBe(403);
  });

  it('/api/auth/me reports role + isOperator', async () => {
    await seedUser('op', 'operator');
    await seedUser('mem', 'member');
    const opMe = (await req('/api/auth/me', await login('op'))).body;
    expect(opMe.role).toBe('operator');
    expect(opMe.isOperator).toBe(true);
    const memMe = (await req('/api/auth/me', await login('mem'))).body;
    expect(memMe.role).toBe('member');
    expect(memMe.isOperator).toBe(false);
  });
});

describe('AG — provisioning defaults', () => {
  it('provisionOwner defaults to member; an explicit role sticks', async () => {
    const m = provisionOwner({ name: 'plain' });
    const o = provisionOwner({ name: 'boss', role: 'operator' });
    const roleOf = (id: string) =>
      (sqlite.prepare(`SELECT role FROM owners WHERE id = ?`).get(id) as { role: string }).role;
    expect(roleOf(m)).toBe('member');
    expect(roleOf(o)).toBe('operator');
  });

  it('listOwners excludes the sentinel and reports hasPassword; operatorCount ignores the sentinel', async () => {
    await seedUser('op', 'operator');
    provisionOwner({ name: 'oidc-user', externalSubject: 'sub-x' }); // no password
    const accounts = listOwners();
    expect(accounts.some((a) => a.id === SYSTEM_OWNER_ID)).toBe(false);
    expect(accounts.find((a) => a.username === 'op')!.hasPassword).toBe(true);
    expect(accounts.find((a) => a.name === 'oidc-user')!.hasPassword).toBe(false);
    // Force an operator role onto the sentinel: it still must not count (auth-inert).
    sqlite.prepare(`UPDATE owners SET role = 'operator' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      expect(operatorCount()).toBe(1);
    } finally {
      sqlite.prepare(`UPDATE owners SET role = 'member' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });
});

describe('AG — /api/accounts CRUD (operator-gated)', () => {
  let opCookie: string;
  beforeEach(async () => {
    await seedUser('op', 'operator');
    opCookie = await login('op');
  });

  it('creates a member account the new user can immediately log in with (member-scoped)', async () => {
    const r = await req('/api/accounts', opCookie, {
      method: 'POST',
      json: { username: 'newbie', password: 'first-password-1', name: 'New Person' },
    });
    expect(r.status).toBe(201);
    expect(r.body.account).toMatchObject({ username: 'newbie', name: 'New Person', role: 'member', hasPassword: true });

    const cookie = await login('newbie', 'first-password-1');
    expect((await req('/api/tasks', cookie)).status).toBe(200);
    expect((await req('/api/accounts', cookie)).status).toBe(403); // member, not operator
  });

  it('validates input: missing username 400, short password 400, bogus role 400, duplicate username 409', async () => {
    const post = (json: unknown) => req('/api/accounts', opCookie, { method: 'POST', json });
    expect((await post({ password: 'long-enough-pw' })).status).toBe(400);
    expect((await post({ username: 'x', password: 'short' })).status).toBe(400);
    expect((await post({ username: 'x', password: 'long-enough-pw', role: 'admin' })).status).toBe(400);
    expect((await post({ username: 'dup', password: 'long-enough-pw' })).status).toBe(201);
    expect((await post({ username: 'dup', password: 'long-enough-pw' })).status).toBe(409);
  });

  it('changing a role bumps the target session epoch: old cookie dies, next login has the new scopes', async () => {
    const memberId = await seedUser('climber', 'member');
    const oldCookie = await login('climber');
    expect((await req('/api/jobs', oldCookie)).status).toBe(403);

    const r = await req(`/api/accounts/${memberId}`, opCookie, { method: 'PATCH', json: { role: 'operator' } });
    expect(r.status).toBe(200);
    expect(r.body.account.role).toBe('operator');

    expect((await req('/api/tasks', oldCookie)).status).toBe(401); // epoch bump killed the session
    const newCookie = await login('climber');
    expect((await req('/api/jobs', newCookie)).status).toBe(200); // re-derived as operator
  });

  it('refuses to demote the last operator (409) but allows it once another exists', async () => {
    const opId = (sqlite.prepare(`SELECT id FROM owners WHERE username = 'op'`).get() as { id: string }).id;
    const demote = () => req(`/api/accounts/${opId}`, opCookie, { method: 'PATCH', json: { role: 'member' } });
    expect((await demote()).status).toBe(409);

    const secondId = await seedUser('op2', 'operator');
    expect(operatorCount()).toBe(2);
    expect((await demote()).status).toBe(200);
    // …and now op2 is the last one.
    const op2Cookie = await login('op2');
    expect((await req(`/api/accounts/${secondId}`, op2Cookie, { method: 'PATCH', json: { role: 'viewer' } })).status).toBe(409);
  });

  it('PATCH with an unknown id 404s; a no-op body 400s', async () => {
    expect((await req(`/api/accounts/00000000-0000-7000-8000-00000000dead`, opCookie, { method: 'PATCH', json: { role: 'viewer' } })).status).toBe(404);
    const opId = (sqlite.prepare(`SELECT id FROM owners WHERE username = 'op'`).get() as { id: string }).id;
    expect((await req(`/api/accounts/${opId}`, opCookie, { method: 'PATCH', json: {} })).status).toBe(400);
  });

  it('reset-password sets a new hash, signs the target out everywhere, and refuses OIDC-only accounts', async () => {
    const memId = await seedUser('mem', 'member');
    const oldCookie = await login('mem');

    const short = await req(`/api/accounts/${memId}/reset-password`, opCookie, { method: 'POST', json: { password: 'short' } });
    expect(short.status).toBe(400);

    const r = await req(`/api/accounts/${memId}/reset-password`, opCookie, { method: 'POST', json: { password: 'brand-new-pw-9' } });
    expect(r.status).toBe(200);
    expect((await req('/api/tasks', oldCookie)).status).toBe(401); // signed out everywhere

    // Old password no longer works; the new one does.
    const bad = await fetch(`${srv.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mem', password: PW }),
    });
    expect(bad.status).toBe(401);
    expect((await req('/api/tasks', await login('mem', 'brand-new-pw-9'))).status).toBe(200);

    const oidcId = provisionOwner({ name: 'portal', externalSubject: 'sub-p' });
    expect((await req(`/api/accounts/${oidcId}/reset-password`, opCookie, { method: 'POST', json: { password: 'brand-new-pw-9' } })).status).toBe(409);
  });

  it('delete guards: yourself 409, the last operator 409, unknown 404; a member deletes cleanly', async () => {
    const opId = (sqlite.prepare(`SELECT id FROM owners WHERE username = 'op'`).get() as { id: string }).id;
    expect((await req(`/api/accounts/${opId}`, opCookie, { method: 'DELETE' })).status).toBe(409); // self

    const op2Id = await seedUser('op2', 'operator');
    const op2Cookie = await login('op2');
    // op2 deleting op would leave… op2 — allowed. But first: op deleting op2 when op2
    // is not last is fine; the guard only trips when the TARGET is the final operator.
    expect((await req(`/api/accounts/${op2Id}`, opCookie, { method: 'DELETE' })).status).toBe(200);
    expect((await req('/api/tasks', op2Cookie)).status).toBe(401); // deleted owner's session is dead

    const memId = await seedUser('mem', 'member');
    expect((await req(`/api/accounts/${memId}`, opCookie, { method: 'DELETE' })).status).toBe(200);
    expect(sqlite.prepare(`SELECT id FROM owners WHERE id = ?`).get(memId)).toBeUndefined();

    expect((await req(`/api/accounts/00000000-0000-7000-8000-00000000dead`, opCookie, { method: 'DELETE' })).status).toBe(404);
  });

  it('the sentinel is unreachable through the accounts API', async () => {
    expect((await req(`/api/accounts/${SYSTEM_OWNER_ID}`, opCookie, { method: 'PATCH', json: { role: 'viewer' } })).status).toBe(404);
    expect((await req(`/api/accounts/${SYSTEM_OWNER_ID}`, opCookie, { method: 'DELETE' })).status).toBe(404);
  });
});
