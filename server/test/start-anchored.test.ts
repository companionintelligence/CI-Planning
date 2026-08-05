import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { placeStartAnchoredTask, fillFlightPlanCandidates } from '../src/engine/autoplan.js';
import { upsertPossible } from '../src/agents/ingest.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Phase AB · AB1 — start-anchored placement. `scheduled_for` (+ optional `task_time`)
 * is the START intent that picks a block's DAY (and time); `due_at` stays a deadline
 * that never selects the placement day. Covers: exact-time placement on a future
 * date; occupied slot → nearest open gap the SAME day; no-time → the date's
 * direction window, else workday gap; day-full → unplaced marker; the flight-plan
 * fill excluding future-scheduled tasks; promote placing start-anchored tasks in ANY
 * trust mode while start-less promotes keep the TM-5 trust gate; and the opt-in
 * POST /api/tasks auto_place flag.
 *
 * Prefs baseline (resetDb): timezone UTC, workday 09:00–18:00, min_break 10,
 * trust_mode balanced — so expected instants are plain UTC wall times.
 */

const OWNER = SYSTEM_OWNER;
const run = <T,>(fn: () => T | Promise<T>) => runWithOwner(OWNER, ALL_SCOPES, fn);

let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
});

beforeEach(() => {
  resetDb();
});

/** UTC calendar date n days ahead. */
const dPlus = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** First UTC WEEKDAY at least n days ahead — resolveDayType's default heuristic maps it to 'workday'. */
const futureWeekday = (n: number): string => {
  for (let i = n; ; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
  }
};

async function createTask(body: Record<string, unknown>): Promise<string> {
  const r = await api(srv.url, '/api/tasks', { method: 'POST', json: { title: 'Anchored task', ...body } });
  expect(r.status).toBe(201);
  return r.body.task.id as string;
}

function blocksOf(taskId: string): { start_at: string; end_at: string; is_auto: number }[] {
  return sqlite
    .prepare(`SELECT start_at, end_at, is_auto FROM time_blocks WHERE task_id = ? AND block_kind = 'task' ORDER BY start_at`)
    .all(taskId) as { start_at: string; end_at: string; is_auto: number }[];
}

function insertBlock(startISO: string, endISO: string, opts: { kind?: string; locked?: number } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
       VALUES (uuid7(), 'Fixture block', ?, ?, ?, ?, 0, 'manual', 'planned', ?)`,
    )
    .run(opts.kind ?? 'meeting', startISO, endISO, opts.locked ?? 0, OWNER);
}

describe('placeStartAnchoredTask — exact time', () => {
  it('places one block exactly at (scheduled_for, task_time) on a FUTURE date; user-intent block, not auto-clearable', async () => {
    const date = dPlus(3);
    const id = await createTask({ scheduled_for: date, task_time: '14:00', estimated_minutes: 60 });

    const res = await placeStartAnchoredTask(OWNER, id);
    expect(res).toMatchObject({ placed: true, startAt: `${date}T14:00:00.000Z`, endAt: `${date}T15:00:00.000Z` });

    const blocks = blocksOf(id);
    expect(blocks.length).toBe(1);
    expect(blocks[0].start_at).toBe(`${date}T14:00:00.000Z`);
    // is_auto = 0: clearPriorAuto (every Auto run) must never wipe a stated start time.
    expect(blocks[0].is_auto).toBe(0);
  });

  it('falls back to the default_time_block_minutes duration (60) when the task has no estimate', async () => {
    const date = dPlus(3);
    const id = await createTask({ scheduled_for: date, task_time: '08:30' });
    const res = await placeStartAnchoredTask(OWNER, id);
    expect(res).toMatchObject({ placed: true, startAt: `${date}T08:30:00.000Z`, endAt: `${date}T09:30:00.000Z` });
  });

  it('occupied slot → the open gap NEAREST the requested time on the SAME day', async () => {
    const date = dPlus(3);
    // A meeting sits exactly on the requested 14:00–15:00 span.
    insertBlock(`${date}T14:00:00.000Z`, `${date}T15:00:00.000Z`);
    const id = await createTask({ scheduled_for: date, task_time: '14:00', estimated_minutes: 60 });

    const res = await placeStartAnchoredTask(OWNER, id);
    // Nearest fit: 13:00–14:00 right before the meeting (60m away) beats 15:10 after
    // the 10-min break (70m away). Same local day, no overlap.
    expect(res).toMatchObject({ placed: true, startAt: `${date}T13:00:00.000Z`, endAt: `${date}T14:00:00.000Z` });
    expect(blocksOf(id).length).toBe(1);
  });

  it('a fully occupied day → { placed: false, day_full } and no block', async () => {
    const date = dPlus(3);
    insertBlock(`${date}T00:00:00.000Z`, `${dPlus(4)}T00:00:00.000Z`, { locked: 1 });
    const id = await createTask({ scheduled_for: date, task_time: '14:00', estimated_minutes: 60 });

    const res = await placeStartAnchoredTask(OWNER, id);
    expect(res).toEqual({ placed: false, reason: 'day_full' });
    expect(blocksOf(id).length).toBe(0);
  });

  it('is idempotent — a second call reuses the existing block, never duplicating (is_auto=0 blocks are not swept by clearPriorAuto)', async () => {
    const date = dPlus(3);
    const id = await createTask({ scheduled_for: date, task_time: '14:00', estimated_minutes: 60 });

    const first = await placeStartAnchoredTask(OWNER, id);
    const second = await placeStartAnchoredTask(OWNER, id);
    expect(first).toMatchObject({ placed: true });
    expect(second).toMatchObject({ placed: true, blockId: (first as { blockId: string }).blockId });
    expect(blocksOf(id).length).toBe(1); // no duplicate
  });
});

describe('placeStartAnchoredTask — no task_time (engine picks the time on THAT date)', () => {
  it("uses the date's direction window (day-type pattern blocks) when the task carries a direction tag", async () => {
    const date = futureWeekday(3); // 'workday' via the default day-type heuristic
    const { id: dirId } = sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, 'deep', 'direction') RETURNING id`)
      .get(OWNER) as { id: string };
    sqlite
      .prepare(
        `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
         VALUES (uuid7(), ?, ?, 'workday', '10:00', '12:00')`,
      )
      .run(OWNER, dirId);

    const id = await createTask({ scheduled_for: date, estimated_minutes: 60 });
    sqlite
      .prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
      .run(id, dirId);

    const res = await placeStartAnchoredTask(OWNER, id);
    expect(res).toMatchObject({ placed: true, startAt: `${date}T10:00:00.000Z`, endAt: `${date}T11:00:00.000Z` });
  });

  it('no direction window → earliest workday gap on that date', async () => {
    const date = dPlus(3);
    const id = await createTask({ scheduled_for: date, estimated_minutes: 45 });
    const res = await placeStartAnchoredTask(OWNER, id);
    expect(res).toMatchObject({ placed: true, startAt: `${date}T09:00:00.000Z`, endAt: `${date}T09:45:00.000Z` });
  });
});

describe('fillFlightPlanCandidates — scheduled_for exclusion (AB1)', () => {
  it('future-scheduled tasks never leak into the fill; same-date tasks stage only while block-less', async () => {
    // Owner tz is UTC in tests (see baseline), and fillFlightPlanCandidates keys on the
    // owner-tz "today" — so build `today` in UTC, not the machine's local tz, or this
    // flakes when the runner isn't UTC (server-local date ≠ UTC date near midnight).
    const today = dPlus(0);
    const future = await createTask({ title: 'Future-scheduled', scheduled_for: dPlus(3) });
    const todayNoBlock = await createTask({ title: 'Today, no block', scheduled_for: today });
    const todayWithBlock = await createTask({ title: 'Today, has block', scheduled_for: today });
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, task_id, title, block_kind, start_at, end_at, is_auto, source_kind, status, owner_id)
         VALUES (uuid7(), ?, 'Today, has block', 'task', ?, ?, 0, 'agent', 'planned', ?)`,
      )
      .run(todayWithBlock, `${today}T10:00:00.000Z`, `${today}T11:00:00.000Z`, OWNER);
    const startless = await createTask({ title: 'Start-less backlog' });

    const added = await fillFlightPlanCandidates(OWNER);
    expect(added).toBe(2);
    const staged = new Set(
      (sqlite.prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`).all(OWNER) as { task_id: string }[]).map((r) => r.task_id),
    );
    expect(staged.has(todayNoBlock)).toBe(true);
    expect(staged.has(startless)).toBe(true);
    expect(staged.has(future)).toBe(false); // scheduled_for ≠ fill date → excluded
    expect(staged.has(todayWithBlock)).toBe(false); // already start-anchored-blocked → excluded
  });
});

describe('promote — start intent is honored in ANY trust mode; start-less keeps the trust gate', () => {
  it('a start-anchored possible promoted under CAUTIOUS still gets its block at the stated time on its day', async () => {
    const date = dPlus(2);
    await run(() =>
      upsertPossible(
        {
          title: 'Team offsite',
          priority: 3,
          tags: [],
          confidence: 0.9,
          dueAt: `${date}T14:00:00.000Z`,
          scheduledFor: date,
          taskTime: '14:00',
          estimatedMinutes: 90,
        },
        'memory',
        'ci:offsite-1',
        {},
      ),
    );
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { trust_mode: 'cautious' } });

    const { id: possibleId } = sqlite
      .prepare(`SELECT id FROM possible_tasks WHERE proposed_owner_id = ? AND source_ref = 'ci:offsite-1'`)
      .get(OWNER) as { id: string };
    const promoted = await api(srv.url, `/api/possible-tasks/${possibleId}/promote`, { method: 'POST' });
    expect(promoted.status).toBe(201);

    // The proposed_* start intent rode onto the task…
    expect(promoted.body.task.scheduled_for).toBe(date);
    expect(promoted.body.task.task_time).toBe('14:00');
    // …and the block landed at exactly that instant, despite trust_mode=cautious.
    const blocks = blocksOf(promoted.body.task.id as string);
    expect(blocks.length).toBe(1);
    expect(blocks[0].start_at).toBe(`${date}T14:00:00.000Z`);
    expect(blocks[0].end_at).toBe(`${date}T15:30:00.000Z`); // 90m estimate
  });

  it('a START-LESS possible promoted under CAUTIOUS places nothing (TM-5 gating retained)', async () => {
    await run(() =>
      upsertPossible(
        { title: 'Some backlog item', priority: 3, tags: [], confidence: 0.9, estimatedMinutes: 30 },
        'memory',
        'ci:startless-1',
        {},
      ),
    );
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { trust_mode: 'cautious' } });

    const { id: possibleId } = sqlite
      .prepare(`SELECT id FROM possible_tasks WHERE proposed_owner_id = ? AND source_ref = 'ci:startless-1'`)
      .get(OWNER) as { id: string };
    const promoted = await api(srv.url, `/api/possible-tasks/${possibleId}/promote`, { method: 'POST' });
    expect(promoted.status).toBe(201);
    expect(blocksOf(promoted.body.task.id as string).length).toBe(0);
  });
});

describe('POST /api/tasks auto_place flag', () => {
  it('auto_place: true → the same start-anchored placement; response reports it', async () => {
    const date = dPlus(3);
    const r = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'API-created', scheduled_for: date, task_time: '11:00', estimated_minutes: 30, auto_place: true },
    });
    expect(r.status).toBe(201);
    expect(r.body.placement).toMatchObject({ placed: true, startAt: `${date}T11:00:00.000Z` });
    const blocks = blocksOf(r.body.task.id as string);
    expect(blocks.length).toBe(1);
    expect(blocks[0].start_at).toBe(`${date}T11:00:00.000Z`);
  });

  it('default (no flag) → no placement — the wizard client creates its own block', async () => {
    const date = dPlus(3);
    const r = await api(srv.url, '/api/tasks', {
      method: 'POST',
      json: { title: 'API-created, unplaced', scheduled_for: date, task_time: '11:00', estimated_minutes: 30 },
    });
    expect(r.status).toBe(201);
    expect(r.body.placement).toBeUndefined();
    expect(blocksOf(r.body.task.id as string).length).toBe(0);
  });
});
