import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { localISODate } from '../src/lib/dates.js';

/**
 * Phase W · W9 — REST /api/possible-tasks owner-scoping lock. The route now delegates to
 * services/possibles.ts, which scopes every read/write by `proposed_owner_id` (the table's
 * owner key, T4) — closing the pre-extraction cross-tenant read-leak/IDOR. This test locks
 * the new behavior: GET returns only the caller's possibles; promote/dismiss of another
 * owner's id → 404. The legit-owner path (201 promote, {ok:true} dismiss) is unchanged.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

function insertPossible(rawTitle: string, owner = OWNER, status = 'pending'): string {
  return (sqlite
    .prepare(`INSERT INTO possible_tasks (id, raw_title, status, proposed_owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(rawTitle, status, owner) as { id: string }).id;
}
function possibleStatus(id: string): string | undefined {
  return (sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(id) as { status: string } | undefined)?.status;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('possibles REST — owner scoping', () => {
  it('GET /api/possible-tasks returns only the caller\'s possibles', async () => {
    createOwner(OTHER);
    insertPossible('Mine', OWNER);
    insertPossible('Theirs', OTHER);

    const mine = await api(srv.url, '/api/possible-tasks');
    expect(mine.body.possibles.map((p: any) => p.raw_title)).toEqual(['Mine']);

    const theirs = await api(srv.url, '/api/possible-tasks', { headers: { 'x-test-owner': OTHER } });
    expect(theirs.body.possibles.map((p: any) => p.raw_title)).toEqual(['Theirs']);
  });

  it('promote of the caller\'s own possible succeeds (201) and flips status', async () => {
    const id = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${id}/promote`, { method: 'POST', json: {} });
    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({ title: 'Mine', status: 'open' });
    expect(possibleStatus(id)).toBe('promoted');
  });

  it('promote of another owner\'s possible → 404, item untouched', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${mine}/promote`, {
      method: 'POST', json: {}, headers: { 'x-test-owner': OTHER },
    });
    expect(res.status).toBe(404);
    expect(possibleStatus(mine)).toBe('pending');
  });

  it('dismiss of the caller\'s own possible succeeds and flips status', async () => {
    const id = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${id}/dismiss`, { method: 'POST', json: {} });
    expect(res.body).toEqual({ ok: true });
    expect(possibleStatus(id)).toBe('dismissed');
  });

  it('dismiss of another owner\'s possible → 404, item untouched', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${mine}/dismiss`, {
      method: 'POST', json: {}, headers: { 'x-test-owner': OTHER },
    });
    expect(res.status).toBe(404);
    expect(possibleStatus(mine)).toBe('pending');
  });
});

describe('possibles REST — promote broadcast ordering (regression)', () => {
  it('broadcasts possible:promoted before any auto-schedule placement the promote triggers', async () => {
    // Hands-off trust mode auto-blocks estimate-bearing work on ingest (TM-5); every
    // promote runs a best-effort autoScheduleOnIngest afterward. This locks that the
    // route still broadcasts 'possible:promoted' BEFORE any 'auto:placed'/
    // 'flight_plan:updated' that run triggers — an ordering the W9 extraction briefly
    // inverted by moving the auto-schedule call inside the shared service (it now runs
    // in the route, after the broadcast, matching the pre-extraction handler).
    sqlite.prepare(`UPDATE scheduling_prefs SET trust_mode = 'hands_off' WHERE owner_id = ?`).run(OWNER);
    const today = localISODate();
    // A tag-matched Plan window spanning the whole day, so placement doesn't depend on
    // time-of-day (CI runs TZ=UTC).
    sqlite.prepare(
      `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status, owner_id)
       VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', 'errands', ?, ?, 0, 'manual', 'planned', ?)`,
    ).run(`${today}T00:00:00.000Z`, `${today}T23:59:00.000Z`, OWNER);
    // An unrelated, already-open, estimate-bearing task for autoScheduleOnIngest to
    // place — it doesn't have to be the just-promoted task; the call sweeps the whole
    // backlog every time it runs.
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), 'Buy stamps', ?, 'open', 30, 3) RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const tag = (sqlite
      .prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'errands', 'pattern', ?) RETURNING id`)
      .get(OWNER) as { id: string });
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(taskId, tag.id);

    const possibleId = insertPossible('Inbox item', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${possibleId}/promote`, { method: 'POST', json: {} });
    expect(res.status).toBe(201);

    const events = sqlite
      .prepare(`SELECT seq, event FROM sync_events WHERE owner_id = ? ORDER BY seq ASC`)
      .all(OWNER) as { seq: number; event: string }[];
    const promotedSeq = events.find((e) => e.event === 'possible:promoted')?.seq;
    const placementSeqs = events.filter((e) => e.event === 'auto:placed' || e.event === 'flight_plan:updated').map((e) => e.seq);
    expect(promotedSeq).toBeDefined();
    // Sanity check the fixture actually triggered a placement — otherwise this proves
    // nothing about ordering.
    expect(placementSeqs.length).toBeGreaterThan(0);
    for (const s of placementSeqs) expect(promotedSeq!).toBeLessThan(s);
  });
});
