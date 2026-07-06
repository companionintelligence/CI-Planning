import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W8b — ReflectionType end-to-end over HTTP. Proves the `reflections` bundle
 * query + note-dates query, each mutation (setTodayGoal / setWeeklyGoal / setDayNote /
 * toggleReflectionDone / deleteReflection) reusing the SAME services the REST routes use
 * (cross-checked via a REST GET), the empty-body-deletes rule, the category/colorToken
 * field resolvers, validation error mapping, and cross-owner isolation.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

// Pinned dates (TZ=UTC in CI): 2026-06-15 is Monday of ISO week 2026-W25.
const DAY = '2026-06-15';
const WEEK_KEY = '2026-W25';
const NEXT_DAY = '2026-06-16';

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
  return { status: res.status, body };
}

const makeCategory = (name: string, owner = OWNER): string =>
  (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`).get(owner, name) as { id: string }).id;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('W8b — reflections query + goal mutations', () => {
  it('reflections bundle is empty by default; setTodayGoal fills it, visible via REST', async () => {
    const empty = await gql(`{ reflections(period: "${DAY}") { period today { id } weekly { id } note { id } } }`);
    expect(empty.body.errors).toBeUndefined();
    expect(empty.body.data.reflections).toEqual({ period: DAY, today: null, weekly: [], note: null });

    const m = await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "Ship W8b" }) { success deleted reflection { id kind periodKey position body sourceKind } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.setTodayGoal).toEqual({
      success: true, deleted: false,
      reflection: { id: `today_goal:${DAY}:0`, kind: 'today_goal', periodKey: DAY, position: 0, body: 'Ship W8b', sourceKind: 'manual' },
    });

    // Cross-check via the REST GET (same service underneath).
    const rest = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(rest.body.today.body).toBe('Ship W8b');

    const q = await gql(`{ reflections(period: "${DAY}") { today { body } } }`);
    expect(q.body.data.reflections.today.body).toBe('Ship W8b');
  });

  it('setTodayGoal with an empty body deletes the slot (deleted:true, reflection:null)', async () => {
    await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "temp" }) { success } }`);
    const del = await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "   " }) { success deleted reflection { id } } }`);
    expect(del.body.data.setTodayGoal).toEqual({ success: true, deleted: true, reflection: null });
    const q = await gql(`{ reflections(period: "${DAY}") { today { id } } }`);
    expect(q.body.data.reflections.today).toBeNull();
  });

  it('setWeeklyGoal fills the three slots keyed by ISO week; position order preserved', async () => {
    for (const pos of [0, 1, 2]) {
      const m = await gql(`mutation { setWeeklyGoal(input: { periodKey: "${WEEK_KEY}", position: ${pos}, body: "goal ${pos}" }) { success reflection { position periodKey } } }`);
      expect(m.body.data.setWeeklyGoal.reflection).toEqual({ position: pos, periodKey: WEEK_KEY });
    }
    // Any day in that week returns all three, in position order.
    const q = await gql(`{ reflections(period: "${DAY}") { weekly { position body } } }`);
    expect(q.body.data.reflections.weekly).toEqual([
      { position: 0, body: 'goal 0' }, { position: 1, body: 'goal 1' }, { position: 2, body: 'goal 2' },
    ]);
  });

  it('setWeeklyGoal rejects an out-of-range position', async () => {
    const bad = await gql(`mutation { setWeeklyGoal(input: { periodKey: "${WEEK_KEY}", position: 3, body: "x" }) { success } }`);
    expect(bad.body.errors?.[0]?.message).toMatch(/0, 1, or 2/i);
  });

  it('setDayNote upserts + reflectionNoteDates reports noted days; empty body deletes', async () => {
    await gql(`mutation { setDayNote(input: { periodKey: "${DAY}", body: "Good day" }) { success } }`);
    await gql(`mutation { setDayNote(input: { periodKey: "${NEXT_DAY}", body: "Better day" }) { success } }`);

    const q = await gql(`{ reflections(period: "${DAY}") { note { kind body } } }`);
    expect(q.body.data.reflections.note).toEqual({ kind: 'day_note', body: 'Good day' });

    const dates = await gql(`{ reflectionNoteDates(from: "${DAY}", to: "${NEXT_DAY}") }`);
    expect(dates.body.data.reflectionNoteDates).toEqual([DAY, NEXT_DAY]);

    const del = await gql(`mutation { setDayNote(input: { periodKey: "${DAY}", body: "" }) { deleted } }`);
    expect(del.body.data.setDayNote.deleted).toBe(true);
    const rest = await api(srv.url, `/api/reflections?period=${DAY}`);
    expect(rest.body.note).toBeNull();
  });

  it('setDayNote rejects a malformed periodKey', async () => {
    const bad = await gql(`mutation { setDayNote(input: { periodKey: "not-a-date", body: "x" }) { success } }`);
    expect(bad.body.errors?.[0]?.message).toMatch(/YYYY-MM-DD/i);
  });
});

describe('W8b — done toggle + delete', () => {
  it('toggleReflectionDone stamps + clears done_at on a today goal', async () => {
    await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "Focus" }) { success } }`);
    const on = await gql(`mutation { toggleReflectionDone(input: { kind: "today_goal", periodKey: "${DAY}", position: 0, done: true }) { success reflection { doneAt } } }`);
    expect(on.body.data.toggleReflectionDone.reflection.doneAt).not.toBeNull();
    const off = await gql(`mutation { toggleReflectionDone(input: { kind: "today_goal", periodKey: "${DAY}", position: 0, done: false }) { reflection { doneAt } } }`);
    expect(off.body.data.toggleReflectionDone.reflection.doneAt).toBeNull();
  });

  it('toggleReflectionDone is NOT_FOUND when the row is missing; rejects a non-goal kind', async () => {
    const missing = await gql(`mutation { toggleReflectionDone(input: { kind: "today_goal", periodKey: "${DAY}", position: 0, done: true }) { success } }`);
    expect(missing.body.errors?.[0]?.message).toMatch(/not found/i);
    const badKind = await gql(`mutation { toggleReflectionDone(input: { kind: "day_note", periodKey: "${DAY}", position: 0, done: true }) { success } }`);
    expect(badKind.body.errors?.[0]?.message).toMatch(/today_goal or weekly_goal/i);
  });

  it('deleteReflection removes a goal (idempotent); rejects a non-goal kind', async () => {
    await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "Delete me" }) { success } }`);
    const d = await gql(`mutation { deleteReflection(input: { kind: "today_goal", periodKey: "${DAY}", position: 0 }) { success deleted } }`);
    expect(d.body.data.deleteReflection).toEqual({ success: true, deleted: true });
    const q = await gql(`{ reflections(period: "${DAY}") { today { id } } }`);
    expect(q.body.data.reflections.today).toBeNull();
    // Idempotent — a second delete still succeeds.
    expect((await gql(`mutation { deleteReflection(input: { kind: "today_goal", periodKey: "${DAY}", position: 0 }) { success } }`)).body.data.deleteReflection.success).toBe(true);
    // Non-goal kind rejected.
    expect((await gql(`mutation { deleteReflection(input: { kind: "day_note", periodKey: "${DAY}", position: 0 }) { success } }`)).body.errors?.[0]?.message).toMatch(/invalid kind/i);
  });
});

describe('W8b — category + source link resolvers', () => {
  it('category + colorToken resolve from the assigned category tag', async () => {
    const cat = makeCategory('Family');
    sqlite.prepare(`INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token) VALUES (uuid7(), ?, ?, 'category', 'chart-3')`).run(OWNER, cat);
    const m = await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "Family time", categoryId: "${cat}" }) { reflection { category { id label } colorToken } } }`);
    expect(m.body.errors).toBeUndefined();
    expect(m.body.data.setTodayGoal.reflection).toEqual({ category: { id: cat, label: 'Family' }, colorToken: 'chart-3' });
  });

  it('a task source link round-trips as sourceKind/sourceRef', async () => {
    const taskId = (sqlite.prepare(`INSERT INTO tasks (id, title, status, owner_id) VALUES (uuid7(), 'The one thing', 'open', ?) RETURNING id`).get(OWNER) as { id: string }).id;
    const m = await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "The one thing", sourceKind: "task", sourceRef: "${taskId}" }) { reflection { sourceKind sourceRef } } }`);
    expect(m.body.data.setTodayGoal.reflection).toEqual({ sourceKind: 'task', sourceRef: taskId });
    // An unknown source kind collapses to manual (service normalization).
    const manual = await gql(`mutation { setWeeklyGoal(input: { periodKey: "${WEEK_KEY}", position: 0, body: "x", sourceKind: "nonsense", sourceRef: "y" }) { reflection { sourceKind sourceRef } } }`);
    expect(manual.body.data.setWeeklyGoal.reflection).toEqual({ sourceKind: 'manual', sourceRef: null });
  });
});

describe('W8b — owner scoping', () => {
  it("another owner cannot see or delete this owner's reflections", async () => {
    createOwner(OTHER);
    await gql(`mutation { setTodayGoal(input: { periodKey: "${DAY}", body: "Mine" }) { success } }`);

    // B sees an empty bundle for the same day.
    const bView = await gql(`{ reflections(period: "${DAY}") { today { body } } }`, { 'x-test-owner': OTHER });
    expect(bView.body.data.reflections.today).toBeNull();

    // B's delete is idempotent-succeed but touches nothing owned by A.
    await gql(`mutation { deleteReflection(input: { kind: "today_goal", periodKey: "${DAY}", position: 0 }) { success } }`, { 'x-test-owner': OTHER });
    const aStill = await gql(`{ reflections(period: "${DAY}") { today { body } } }`);
    expect(aStill.body.data.reflections.today.body).toBe('Mine');
  });
});
