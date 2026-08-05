import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connectionHealth } from '../src/lib/connections.js';
import { seal } from '../src/lib/crypto/index.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { newId } from '../src/lib/ids.js';
import { resetDb } from './helpers.js';

// A real 32-byte AES-256 KEK for sealing test tokens.
const KEY_B64 = randomBytes(32).toString('base64');
const SAVED_KEK = process.env.CP_KEK_B64;

/** Seal `{ expiresAt }` (+ a fake refresh/access token to exercise the no-leak guard). */
function seedToken(opts: {
  account: string;
  status?: string;
  expiresAt?: string | null;
  corrupt?: boolean;
}): void {
  const payload = JSON.stringify({
    accessToken: 'ya29.SECRET-ACCESS-TOKEN',
    refreshToken: '1//SECRET-REFRESH-TOKEN',
    expiresAt: opts.expiresAt ?? null,
  });
  const sealed = seal(payload, Buffer.from(KEY_B64, 'base64'));
  const ciphertext = opts.corrupt ? 'deadbeef' + sealed.ciphertext.slice(8) : sealed.ciphertext;
  sqlite
    .prepare(
      `INSERT INTO connection_tokens (id, owner_id, provider, account, iv, auth_tag, ciphertext, key_version, status)
       VALUES (?, ?, 'google', ?, ?, ?, ?, 1, ?)`,
    )
    .run(newId(), SYSTEM_OWNER, opts.account, sealed.iv, sealed.authTag, ciphertext, opts.status ?? 'active');
}

/** Insert an external_events row mapped to (SYSTEM_OWNER, 'google', account). */
function seedEvent(account: string): void {
  sqlite
    .prepare(
      `INSERT INTO external_events (id, owner_id, provider, account, external_id, direction)
       VALUES (?, ?, 'google', ?, ?, 'inbound')`,
    )
    .run(newId(), SYSTEM_OWNER, account, newId());
}

/** The seeded sync_calendar scheduled_jobs id (migration 0056; survives resetDb). */
function syncJobId(): string {
  const row = sqlite
    .prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'sync_calendar' LIMIT 1`)
    .get() as { id: string };
  return row.id;
}

/** Insert a job_runs row for the sync_calendar job. */
function seedRun(opts: { startedAt: string; finishedAt?: string | null; status: string; log?: string | null }): void {
  sqlite
    .prepare(
      `INSERT INTO job_runs (id, job_id, started_at, finished_at, status, log)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), syncJobId(), opts.startedAt, opts.finishedAt ?? null, opts.status, opts.log ?? null);
}

beforeEach(() => {
  resetDb();
  process.env.CP_KEK_B64 = KEY_B64;
});
afterEach(() => {
  if (SAVED_KEK === undefined) delete process.env.CP_KEK_B64;
  else process.env.CP_KEK_B64 = SAVED_KEK;
});

describe('connectionHealth', () => {
  it('returns [] (not null) when the owner has no tokens', async () => {
    const result = await connectionHealth(SYSTEM_OWNER);
    expect(result).toEqual([]);
  });

  it('active row + future expiresAt → connected, with expiresAt + mappedEventCount', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    seedToken({ account: 'a@x.io', expiresAt: future });
    seedEvent('a@x.io');
    seedEvent('a@x.io');

    const result = await connectionHealth(SYSTEM_OWNER);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: 'google',
      account: 'a@x.io',
      status: 'connected',
      expiresAt: future,
      mappedEventCount: 2,
      lastSyncAt: null,
      lastError: null,
    });
  });

  it('active row + past expiresAt → expired', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    seedToken({ account: 'old@x.io', expiresAt: past });

    const result = await connectionHealth(SYSTEM_OWNER);
    expect(result[0].status).toBe('expired');
    expect(result[0].expiresAt).toBe(past);
  });

  it("status='revoked' → inactive, expiresAt null (never decrypts)", async () => {
    seedToken({ account: 'gone@x.io', status: 'revoked', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

    const result = await connectionHealth(SYSTEM_OWNER);
    expect(result[0].status).toBe('inactive');
    expect(result[0].expiresAt).toBeNull();
  });

  it('corrupt ciphertext → inactive, does NOT throw', async () => {
    seedToken({ account: 'bad@x.io', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), corrupt: true });

    // A rejected promise fails the test, which is the async form of "does NOT throw".
    const result = await connectionHealth(SYSTEM_OWNER);
    expect(result[0].status).toBe('inactive');
    expect(result[0].expiresAt).toBeNull();
  });

  it('lastError is populated from an errored sync_calendar run, null when done', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();

    // Errored run.
    seedToken({ account: 'err@x.io', expiresAt: future });
    seedRun({ startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString(), status: 'error', log: 'token refresh failed' });
    let result = await connectionHealth(SYSTEM_OWNER);
    expect(result[0].lastError).toBe('token refresh failed');
    expect(result[0].lastSyncAt).not.toBeNull();

    // Replace with a 'done' run → lastError clears (most recent wins).
    sqlite.exec('DELETE FROM job_runs');
    seedRun({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'done', log: 'ok' });
    result = await connectionHealth(SYSTEM_OWNER);
    expect(result[0].lastError).toBeNull();
    expect(result[0].lastSyncAt).not.toBeNull();
  });

  it('lastSyncAt falls back to started_at when finished_at is null (still-running run)', async () => {
    const started = new Date().toISOString();
    seedToken({ account: 'run@x.io', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    seedRun({ startedAt: started, finishedAt: null, status: 'running' });

    const result = await connectionHealth(SYSTEM_OWNER);
    expect(result[0].lastSyncAt).toBe(started);
    expect(result[0].lastError).toBeNull();
  });

  it('NO-LEAK GUARD: serialized result contains no token material', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    seedToken({ account: 'leak-check@x.io', expiresAt: future });
    seedToken({ account: 'revoked@x.io', status: 'revoked' });
    seedEvent('leak-check@x.io');

    const json = JSON.stringify(await connectionHealth(SYSTEM_OWNER));
    for (const forbidden of ['ciphertext', 'authTag', 'auth_tag', 'accessToken', 'refreshToken']) {
      expect(json).not.toContain(forbidden);
    }
    // `iv` is checked as a JSON KEY (`"iv":`) not a bare substring — a bare "iv"
    // collides with the legitimate status value "inactive" (inact·iv·e).
    expect(json).not.toContain('"iv"');
    // And the actual sealed IV hex never appears in the output.
    const ivHex = (sqlite.prepare(`SELECT iv FROM connection_tokens WHERE account = 'leak-check@x.io'`).get() as { iv: string }).iv;
    expect(json).not.toContain(ivHex);
  });
});
