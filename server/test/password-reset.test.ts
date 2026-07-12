import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, type TestServer } from './helpers.js';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER_ID } from '../src/lib/ids.js';
import { provisionOwner } from '../src/lib/owners.js';
import { hashPassword, findOwnerByUsername } from '../src/lib/auth/password.js';
import { issueResetToken, consumeResetToken } from '../src/lib/auth/resetToken.js';
import { __getLastConsoleMail, __resetLastConsoleMail } from '../src/lib/mail/index.js';
import { __resetAuthRateLimit } from '../src/routes/auth.js';

/**
 * V — password reset for local sign-in (AUTH_MODE=sso + DISABLE_OIDC=true). Covers the
 * token service (single-use / expiry / hashed-at-rest), the enumeration-neutral
 * reset-request, the reset completion + session-epoch invalidation (D5 = all sessions),
 * rate limiting, the backup-email endpoint, and the console mail transport.
 */

const USER = 'admin';
const EMAIL = 'admin@example.com';
const PW = 'correct-horse-battery-staple';
const NEW_PW = 'brand-new-passphrase-9';

let srv: TestServer;
let savedAuth: typeof config.auth;
const savedTrustProxy = config.trustProxy;

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, setCookies: res.headers.getSetCookie?.() ?? [] };
}
async function login(username: string, password: string) {
  const res = await fetch(`${srv.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, cookie: cookieHeader(res.headers.getSetCookie?.() ?? []) };
}

beforeAll(async () => {
  savedAuth = { ...config.auth };
  config.auth.mode = 'sso';
  config.auth.disableOidc = true;
  config.auth.sessionSecret = 'test-session-secret';
  config.auth.rateLimit = { ...config.auth.rateLimit, issueMax: 1000 };
  config.trustProxy = true;
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  Object.assign(config.auth, savedAuth);
  config.trustProxy = savedTrustProxy;
});

beforeEach(() => {
  resetDb();
  __resetAuthRateLimit();
  __resetLastConsoleMail();
});

/** Seed a local owner with a real hash + email; returns the owner id. */
async function seedUser(email: string | undefined = EMAIL): Promise<string> {
  return provisionOwner({ name: USER, username: USER, email, passwordHash: await hashPassword(PW) });
}

// ── Token service ──────────────────────────────────────────────────────────────

describe('V — reset-token service', () => {
  it('issues a raw token, stores only its sha256 hash, and consumes it once', async () => {
    const ownerId = await seedUser();
    const raw = issueResetToken(ownerId);
    // Raw token is never stored — the row holds a 64-hex sha256, not the raw value.
    const row = sqlite.prepare(`SELECT token_hash FROM password_reset_tokens WHERE owner_id = ?`).get(ownerId) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(raw);

    expect(consumeResetToken(raw)).toBe(ownerId);
    // Single-use: a second consume fails.
    expect(consumeResetToken(raw)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const ownerId = await seedUser();
    const raw = issueResetToken(ownerId);
    // Force the row to be already expired.
    sqlite.prepare(`UPDATE password_reset_tokens SET expires_at = ? WHERE owner_id = ?`).run(new Date(Date.now() - 1000).toISOString(), ownerId);
    expect(consumeResetToken(raw)).toBeNull();
  });

  it('a fresh issue supersedes the owner\'s prior tokens', async () => {
    const ownerId = await seedUser();
    const first = issueResetToken(ownerId);
    const second = issueResetToken(ownerId);
    expect(consumeResetToken(first)).toBeNull(); // superseded
    expect(consumeResetToken(second)).toBe(ownerId);
  });

  it('returns null for an unknown token', () => {
    expect(consumeResetToken('not-a-real-token')).toBeNull();
  });
});

// ── reset-request (enumeration-neutral) ─────────────────────────────────────────

describe('V — POST /api/auth/reset-request', () => {
  it('returns the same neutral 200 for an existing account and a non-existent one', async () => {
    await seedUser();
    const exists = await post('/api/auth/reset-request', { identifier: USER });
    const ghost = await post('/api/auth/reset-request', { identifier: 'nobody' });
    expect(exists.status).toBe(200);
    expect(ghost.status).toBe(200);
    expect(exists.body).toEqual(ghost.body); // byte-identical body → no enumeration
  });

  it('is honest when SMTP is unconfigured: delivery "log" + says the link went to the server log', async () => {
    // The test env has no SMTP_HOST — exactly the deployment the honesty gap hit: the
    // old response promised "a reset link is on its way" while the link only went to
    // the console. The message is config-derived (never account-derived), so it stays
    // enumeration-neutral (the byte-identical test above covers that).
    await seedUser();
    const r = await post('/api/auth/reset-request', { identifier: USER });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, delivery: 'log' });
    expect(r.body.message).toContain('no outgoing email');
    // With SMTP configured, the classic email promise returns. Ghost identifier only —
    // nothing resolves, so this test never attempts a real SMTP send.
    const savedHost = config.mail.host;
    config.mail.host = 'smtp.example.com';
    try {
      const g = await post('/api/auth/reset-request', { identifier: 'nobody-here' });
      expect(g.body).toMatchObject({ ok: true, delivery: 'email' });
      expect(g.body.message).toContain('on its way');
    } finally {
      config.mail.host = savedHost;
    }
  });

  it('resolves by username OR email and emails a usable reset link', async () => {
    await seedUser();
    const r = await post('/api/auth/reset-request', { identifier: EMAIL });
    expect(r.status).toBe(200);
    // Console transport captured the message; the link carries a token that completes a reset.
    const mail = __getLastConsoleMail();
    expect(mail?.to).toBe(EMAIL);
    const token = new URL(mail!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token');
    expect(token).toBeTruthy();
    const done = await post('/api/auth/reset', { token, newPassword: NEW_PW });
    expect(done.status).toBe(200);
  });

  it('does NOT email an account with no email and no backup_email — still neutral 200', async () => {
    // Local owner seeded with just a username (the AUTH_DEFAULT bootstrap shape).
    await provisionOwner({ name: USER, username: USER, passwordHash: await hashPassword(PW) });
    const r = await post('/api/auth/reset-request', { identifier: USER });
    expect(r.status).toBe(200);
    expect(__getLastConsoleMail()).toBeNull(); // nothing sent
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM password_reset_tokens`).get()).toEqual({ n: 0 });
  });

  it('falls back to backup_email when the primary email is absent', async () => {
    const ownerId = await provisionOwner({ name: USER, username: USER, passwordHash: await hashPassword(PW) });
    sqlite.prepare(`UPDATE owners SET backup_email = ? WHERE id = ?`).run('backup@example.com', ownerId);
    const r = await post('/api/auth/reset-request', { identifier: USER });
    expect(r.status).toBe(200);
    expect(__getLastConsoleMail()?.to).toBe('backup@example.com');
  });

  it('an email-looking identifier matches ONLY on email — a colliding username can\'t shadow it', async () => {
    // Owner A's USERNAME equals owner B's EMAIL. A reset for that string must reach B
    // (the email owner), never A — the username/email disambiguation (looks-like-email
    // ⇒ email lookup) prevents the LIMIT 1 cross-account shadowing Copilot flagged.
    const shared = 'shared@example.com';
    await provisionOwner({ name: 'A', username: shared, passwordHash: await hashPassword(PW) });
    await provisionOwner({ name: 'B', username: 'owner-b', email: shared, passwordHash: await hashPassword(PW) });
    const r = await post('/api/auth/reset-request', { identifier: shared });
    expect(r.status).toBe(200);
    expect(__getLastConsoleMail()?.to).toBe(shared); // delivered to B's email, not A
    const tokens = sqlite.prepare(`SELECT owner_id FROM password_reset_tokens`).all() as { owner_id: string }[];
    const bId = findOwnerByUsername('owner-b')!.id;
    expect(tokens).toEqual([{ owner_id: bId }]); // token issued for B only
  });

  it('never targets the sentinel owner', async () => {
    // Even if the sentinel is forced to carry a username, reset-request must not resolve it.
    sqlite.prepare(`UPDATE owners SET username = 'root' WHERE id = ?`).run(SYSTEM_OWNER_ID);
    try {
      const r = await post('/api/auth/reset-request', { identifier: 'root' });
      expect(r.status).toBe(200);
      expect(__getLastConsoleMail()).toBeNull();
    } finally {
      sqlite.prepare(`UPDATE owners SET username = NULL WHERE id = ?`).run(SYSTEM_OWNER_ID);
    }
  });

  it('400s a missing identifier', async () => {
    const r = await post('/api/auth/reset-request', {});
    expect(r.status).toBe(400);
  });

  it('rate-limits per account (issueMax) then 429s', async () => {
    await seedUser();
    const saved = config.auth.rateLimit;
    config.auth.rateLimit = { windowMs: 60_000, max: 60, issueMax: 3 };
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await post('/api/auth/reset-request', { identifier: USER })).status);
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes[3]).toBe(429);
    } finally {
      config.auth.rateLimit = saved;
    }
  });
});

// ── reset completion + session invalidation ─────────────────────────────────────

describe('V — POST /api/auth/reset', () => {
  it('sets the new password (old no longer works, new does)', async () => {
    const ownerId = await seedUser();
    const raw = issueResetToken(ownerId);
    const r = await post('/api/auth/reset', { token: raw, newPassword: NEW_PW });
    expect(r.status).toBe(200);
    expect((await login(USER, PW)).status).toBe(401);      // old password rejected
    expect((await login(USER, NEW_PW)).status).toBe(200);  // new password accepted
  });

  it('invalidates ALL existing sessions (D5 — session epoch bump)', async () => {
    await seedUser();
    const { cookie } = await login(USER, PW);
    // The pre-reset session authenticates.
    expect((await fetch(`${srv.url}/api/tasks`, { headers: { Cookie: cookie } })).status).toBe(200);

    const ownerId = findOwnerByUsername(USER)!.id;
    await post('/api/auth/reset', { token: issueResetToken(ownerId), newPassword: NEW_PW });

    // After the reset bumps the epoch, the old cookie no longer authenticates.
    expect((await fetch(`${srv.url}/api/tasks`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('rejects an invalid/expired token with 400', async () => {
    const r = await post('/api/auth/reset', { token: 'bogus', newPassword: NEW_PW });
    expect(r.status).toBe(400);
  });

  it('rejects a too-short password with 400 (and does not consume the token)', async () => {
    const ownerId = await seedUser();
    const raw = issueResetToken(ownerId);
    const r = await post('/api/auth/reset', { token: raw, newPassword: 'short' });
    expect(r.status).toBe(400);
    // Token was not consumed — a valid password still completes the reset.
    expect((await post('/api/auth/reset', { token: raw, newPassword: NEW_PW })).status).toBe(200);
  });

  it('a reset token is single-use over HTTP', async () => {
    const ownerId = await seedUser();
    const raw = issueResetToken(ownerId);
    expect((await post('/api/auth/reset', { token: raw, newPassword: NEW_PW })).status).toBe(200);
    expect((await post('/api/auth/reset', { token: raw, newPassword: 'another-good-one-1' })).status).toBe(400);
  });
});

// ── mode gating ──────────────────────────────────────────────────────────────────

describe('V — reset routes are gated to local mode', () => {
  it('404s reset-request and reset when not in local mode', async () => {
    const saved = { ...config.auth };
    config.auth.disableOidc = false; // sso + OIDC — local reset is off
    try {
      expect((await post('/api/auth/reset-request', { identifier: USER })).status).toBe(404);
      expect((await post('/api/auth/reset', { token: 'x', newPassword: NEW_PW })).status).toBe(404);
    } finally {
      Object.assign(config.auth, saved);
    }
  });
});

// ── backup-email endpoint ─────────────────────────────────────────────────────────

describe('V — PATCH /api/owner/backup-email', () => {
  it('sets a valid backup email for the authenticated owner', async () => {
    await seedUser();
    const { cookie } = await login(USER, PW);
    const res = await fetch(`${srv.url}/api/owner/backup-email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ backup_email: 'backup@example.com' }),
    });
    expect(res.status).toBe(200);
    const ownerId = findOwnerByUsername(USER)!.id;
    const row = sqlite.prepare(`SELECT backup_email FROM owners WHERE id = ?`).get(ownerId) as { backup_email: string };
    expect(row.backup_email).toBe('backup@example.com');
  });

  it('rejects a malformed email with 400', async () => {
    await seedUser();
    const { cookie } = await login(USER, PW);
    const res = await fetch(`${srv.url}/api/owner/backup-email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ backup_email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires authentication (401 without a session)', async () => {
    const res = await fetch(`${srv.url}/api/owner/backup-email`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup_email: 'x@example.com' }),
    });
    expect(res.status).toBe(401);
  });
});
