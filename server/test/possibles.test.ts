import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { localISODate } from '../src/lib/dates.js';
import { promoteAllPending } from '../src/services/possibles.js';

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
      .prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'errands', 'direction', ?) RETURNING id`)
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

// ─── AF-3 · promoteAllPending — the hands-off ingestion batch path ─────────────

// 'Buy milk' ≈ 'Buy milk please' (cosine ≈ 0.995 ≥ 0.92); 'File taxes' orthogonal.
// Same deterministic embedFn idiom as dedupe.test.ts (no module mock — shared process).
const embedFn = async (text: string): Promise<number[]> =>
  text.includes('milk') ? (text.includes('please') ? [0.99, 0.1, 0] : [1, 0, 0]) : [0, 1, 0];

const statusOf = (id: string): string =>
  (sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(id) as { status: string }).status;
const pendingCount = (): number =>
  (sqlite.prepare(`SELECT COUNT(*) c FROM possible_tasks WHERE status = 'pending'`).get() as { c: number }).c;

describe('promoteAllPending (AF-3)', () => {
  it('a batch with near-duplicates → one promoted task + one duplicate, zero pending', async () => {
    const a = insertPossible('Buy milk');
    const dup = insertPossible('Buy milk please');
    const t = insertPossible('File taxes');

    const r = await promoteAllPending(OWNER, { embedFn });

    expect(r.dedupeAvailable).toBe(true);
    expect(r.duplicates).toBe(1);
    expect(r.promoted).toBe(2);
    expect(r.failed).toBe(0);
    expect(pendingCount()).toBe(0);
    // Exactly one of the two milk rows is the duplicate (uuid7 same-ms order isn't
    // strict — assert the invariant, not WHICH one, matching dedupe.test.ts).
    expect([statusOf(a), statusOf(dup)].sort()).toEqual(['duplicate', 'promoted']);
    expect(statusOf(t)).toBe('promoted');
    const titles = (sqlite.prepare(`SELECT title FROM tasks ORDER BY title`).all() as { title: string }[]).map((x) => x.title);
    expect(titles.length).toBe(2);
    expect(titles).toContain('File taxes');
    // The duplicate row never became a task and has no promoted_task_id.
    const dupRow = sqlite
      .prepare(`SELECT promoted_task_id FROM possible_tasks WHERE status = 'duplicate'`)
      .get() as { promoted_task_id: string | null };
    expect(dupRow.promoted_task_id).toBeNull();
  });

  it('embeddings unavailable → dedupe skips gracefully, EVERYTHING promotes, none stuck pending', async () => {
    insertPossible('Buy milk');
    insertPossible('Buy milk please');

    const r = await promoteAllPending(OWNER, {
      embedFn: async () => {
        throw new Error('ollama down');
      },
    });

    expect(r.dedupeAvailable).toBe(false);
    expect(r.duplicates).toBe(0);
    expect(r.promoted).toBe(2);
    expect(pendingCount()).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(2);
  });

  it('a poison row is COUNTED as failed and left pending — not silently invisible (AF-CU1)', async () => {
    // An existing task already claims (gmail, poison#0) — the 0027 partial
    // UNIQUE(source_kind, source_ref) on tasks makes that row's promote throw.
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, source_kind, source_ref) VALUES (uuid7(), 'Claimed', ?, 'open', 'gcal', 'poison#0')`)
      .run(OWNER);
    const healthy = insertPossible('Healthy item');
    const poison = (sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, status, proposed_owner_id)
         VALUES (uuid7(), 'Poison item', 'gcal', 'poison#0', 'pending', ?) RETURNING id`,
      )
      .get(OWNER) as { id: string }).id;

    const r = await promoteAllPending(OWNER, { embedFn: async () => { throw new Error('no embeddings'); } });

    expect(r.promoted).toBe(1);
    expect(r.failed).toBe(1); // the poison row shows up in the result, not just a log line
    expect(r.duplicates).toBe(0);
    expect(statusOf(healthy)).toBe('promoted');
    expect(statusOf(poison)).toBe('pending'); // left for the nightly sweeper / triage
  });

  it('promoted tasks carry proposed fields + suggestion tags exactly as manual promotion did, and audit rows are written', async () => {
    const pid = (sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, raw_summary, proposed_due_at, proposed_priority,
                                     proposed_estimated_minutes, proposed_scheduled_for, proposed_task_time,
                                     source_kind, source_ref, status, proposed_owner_id)
         VALUES (uuid7(), 'Review contract', 'From legal', '2026-08-01T12:00:00.000Z', 2, 45, '2026-07-20', '09:30',
                 'gcal', 'm9#0', 'pending', ?) RETURNING id`,
      )
      .get(OWNER) as { id: string }).id;
    const dirTag = (sqlite
      .prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'work', 'direction', ?) RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const contentTag = (sqlite
      .prepare(`INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), 'legal', ?) RETURNING id`)
      .get(OWNER) as { id: string }).id;
    sqlite.prepare(`INSERT INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?), (?, ?)`).run(pid, dirTag, pid, contentTag);

    const r = await promoteAllPending(OWNER);
    expect(r.promoted).toBe(1);

    const task = sqlite
      .prepare(`SELECT * FROM tasks WHERE title = 'Review contract'`)
      .get() as Record<string, unknown> & { id: string };
    expect(task).toMatchObject({
      description: 'From legal',
      due_at: '2026-08-01T12:00:00.000Z',
      priority: 2,
      estimated_minutes: 45,
      scheduled_for: '2026-07-20',
      task_time: '09:30',
      owner_id: OWNER,
      source_kind: 'gcal',
      source_ref: 'm9#0',
    });
    // Tag carry-over levels: direction → 1 (placement-relevant), content → 2.
    const tags = sqlite
      .prepare(`SELECT tag_id, level FROM entity_tags WHERE entity_kind = 'task' AND entity_id = ? ORDER BY level`)
      .all(task.id) as { tag_id: string; level: number }[];
    expect(tags).toEqual([
      { tag_id: dirTag, level: 1 },
      { tag_id: contentTag, level: 2 },
    ]);
    expect(possibleStatus(pid)).toBe('promoted');
    // The per-item audit row still fires (inside promotePossible).
    await flushAudits();
    const audits = (sqlite
      .prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'promote' AND entity = ?`)
      .get(`possible:${pid}`) as { c: number }).c;
    expect(audits).toBe(1);
  });

  it('broadcasts every possible:promoted BEFORE any placement broadcast (batch SSE-order contract)', async () => {
    // Same hands-off fixture as the route-ordering test above: a whole-day Plan window
    // plus an unrelated estimate-bearing tag-matched open task the post-batch
    // autoScheduleOnIngest sweep will place.
    sqlite.prepare(`UPDATE scheduling_prefs SET trust_mode = 'hands_off' WHERE owner_id = ?`).run(OWNER);
    const today = localISODate();
    sqlite.prepare(
      `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status, owner_id)
       VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', 'errands', ?, ?, 0, 'manual', 'planned', ?)`,
    ).run(`${today}T00:00:00.000Z`, `${today}T23:59:00.000Z`, OWNER);
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), 'Buy stamps', ?, 'open', 30, 3) RETURNING id`)
      .get(OWNER) as { id: string }).id;
    const tag = (sqlite
      .prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), 'errands', 'direction', ?) RETURNING id`)
      .get(OWNER) as { id: string });
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(taskId, tag.id);

    const p1 = insertPossible('Inbox item one');
    const p2 = insertPossible('Inbox item two');
    const r = await promoteAllPending(OWNER, { embedFn: async () => { throw new Error('no embeddings'); } });
    expect(r.promoted).toBe(2);

    const events = sqlite
      .prepare(`SELECT seq, event FROM sync_events WHERE owner_id = ? ORDER BY seq ASC`)
      .all(OWNER) as { seq: number; event: string }[];
    const promotedSeqs = events.filter((e) => e.event === 'possible:promoted').map((e) => e.seq);
    const placementSeqs = events.filter((e) => e.event === 'auto:placed' || e.event === 'flight_plan:updated').map((e) => e.seq);
    expect(promotedSeqs.length).toBe(2);
    expect(placementSeqs.length).toBeGreaterThan(0); // fixture really triggered placement
    for (const p of promotedSeqs) for (const s of placementSeqs) expect(p).toBeLessThan(s);
    expect([possibleStatus(p1), possibleStatus(p2)]).toEqual(['promoted', 'promoted']);
  });
});
