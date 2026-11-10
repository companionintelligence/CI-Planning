import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { trialityNext, logShown, motivationStamp } from '../src/services/triality.js';
import { attachConfidence, serializeConfidence } from '../src/services/triality-confidence.js';
import { motivationBalanceForWeek } from '../src/services/motivation-balance.js';
import type { PlanWeekReview } from '../src/services/plan-week-review.js';

/**
 * Two things ship together:
 *  - migration 0175: `triality_log.motivation` freezes the me / us / them label a Triality
 *    suggestion carried when it was shown ('none' = no label, NULL = shown before the stamp);
 *  - migration 0176 + services/motivation-balance.ts: an OPT-IN (default off) block in the weekly
 *    recap that splits the week's timed minutes into me / us / them per category.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

beforeEach(() => resetDb());

// ── seeding ───────────────────────────────────────────────────────────────────

function insertTask(title: string, o: { status?: string; motivation?: string | null; owner?: string } = {}): string {
  return (sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_score, reaction_at, priority, motivation)
     VALUES (uuid7(), ?, ?, ?, 30, ?, ?, ?, 3, ?) RETURNING id`,
  ).get(
    title, o.owner ?? OWNER, o.status ?? 'open',
    o.status === 'done' ? daysAgo(2) : null, o.status === 'done' ? 3 : null, o.status === 'done' ? daysAgo(2) : null,
    o.motivation ?? null,
  ) as { id: string }).id;
}

function seedHistory(): void {
  for (let i = 0; i < 12; i++) {
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_score, reaction_at, priority)
       VALUES (uuid7(), ?, ?, 'done', 30, ?, 3, ?, 3)`,
    ).run(`done-${i}`, OWNER, daysAgo(1 + (i % 30)), daysAgo(1 + (i % 30)));
  }
}

function seedCategory(name: string, o: { base?: boolean; owner?: string } = {}): string {
  return (sqlite
    .prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'category', ?) RETURNING id`)
    .get(o.owner ?? OWNER, name, o.base === false ? 0 : 1) as { id: string }).id;
}

function categorize(taskId: string, ...tagIds: string[]): void {
  tagIds.forEach((tag, position) =>
    sqlite.prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, ?)`).run(taskId, tag, position));
}

function entry(taskId: string, startedAt: string, endedAt: string | null, owner: string = OWNER): void {
  sqlite.prepare(`INSERT INTO time_entries (id, owner_id, task_id, started_at, ended_at) VALUES (uuid7(), ?, ?, ?, ?)`).run(owner, taskId, startedAt, endedAt);
}

/** An entry of `minutes` that starts at `startedAt`. */
const mins = (taskId: string, startedAt: string, minutes: number, owner: string = OWNER) =>
  entry(taskId, startedAt, new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), owner);

// ── 0175: the stamp ───────────────────────────────────────────────────────────

describe('motivationStamp', () => {
  it('passes me / us / them through and calls everything else none', () => {
    expect(motivationStamp('me')).toBe('me');
    expect(motivationStamp('us')).toBe('us');
    expect(motivationStamp('them')).toBe('them');
    for (const v of [null, undefined, '', 'ME', 'them ', 'other', 'none']) expect(motivationStamp(v as never)).toBe('none');
  });
});

describe('triality_log.motivation (0175)', () => {
  it('is nullable with no default, so a row shown before the stamp reads NULL', () => {
    const col = (sqlite.prepare(`PRAGMA table_info(triality_log)`).all() as { name: string; notnull: number; dflt_value: unknown }[])
      .find((c) => c.name === 'motivation');
    expect(col).toBeDefined();
    expect(col).toMatchObject({ notnull: 0, dflt_value: null });
  });

  const runAndLog = async () => {
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error(`refused: ${res.refused}`);
    await logShown(OWNER, NOW, res.picks, attachConfidence(res.picks, res.vector).map(serializeConfidence));
    return res.picks.filter((p): p is NonNullable<typeof p> => !!p);
  };
  const logged = () =>
    sqlite.prepare(`SELECT action_ref, motivation FROM triality_log WHERE owner_id = ? ORDER BY rowid`).all(OWNER) as { action_ref: string; motivation: string | null }[];

  it('stamps each shown pick with the label its task carried', async () => {
    seedHistory();
    const byRef: Record<string, string> = {
      [insertTask('for-me', { motivation: 'me' })]: 'me',
      [insertTask('for-us', { motivation: 'us' })]: 'us',
      [insertTask('for-them', { motivation: 'them' })]: 'them',
    };
    const picks = await runAndLog();
    expect(picks).toHaveLength(3);
    const rows = logged();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.motivation).toBe(byRef[r.action_ref]);
    expect(new Set(rows.map((r) => r.motivation))).toEqual(new Set(['me', 'us', 'them']));
  });

  it('an unlabeled task is stamped none, not left NULL', async () => {
    seedHistory();
    insertTask('no label');
    await runAndLog();
    expect(logged()).toEqual([expect.objectContaining({ motivation: 'none' })]);
  });

  it('keeps what the suggestion carried when it was shown, not the task\'s later label', async () => {
    seedHistory();
    const id = insertTask('relabelled', { motivation: 'them' });
    await runAndLog();
    sqlite.prepare(`UPDATE tasks SET motivation = 'me' WHERE id = ?`).run(id);
    expect(logged()).toEqual([{ action_ref: id, motivation: 'them' }]);
  });

  it('does not change which suggestions are made or how they score', async () => {
    seedHistory();
    insertTask('a', { motivation: 'me' });
    insertTask('b', { motivation: 'them' });
    insertTask('c');
    const first = await trialityNext(OWNER, NOW, { embedFn: null });
    // logging (and so stamping) between the two calls must not move the result
    await logShown(OWNER, NOW, first.refused ? [] : first.picks, []);
    const second = await trialityNext(OWNER, NOW, { embedFn: null });
    const shape = (r: typeof first) => (r.refused ? r : r.picks.map((p) => p && { ref: p.ref, slot: p.slot, total: p.scores.total }));
    expect(shape(second)).toEqual(shape(first));
  });
});

// ── 0176 + service: the per-category split ────────────────────────────────────

const WEEK = '2026-07-06'; // a Monday; the week is 07-06 → 07-12
const IN = (day: number, hour = 10) => `2026-07-${String(6 + day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

describe('motivationBalanceForWeek', () => {
  it('splits timed minutes per category into me / us / them / unlabeled', async () => {
    const health = seedCategory('health');
    const work = seedCategory('work');
    const misc = seedCategory('misc', { base: false });

    const a = insertTask('A', { motivation: 'me' });     categorize(a, health);
    const b = insertTask('B', { motivation: 'them' });   categorize(b, work, health); // two categories
    const c = insertTask('C', { motivation: 'us' });     categorize(c, work);
    const d = insertTask('D', { motivation: null });     categorize(d, work);
    const e = insertTask('E', { motivation: 'me' });                                  // no category
    const f = insertTask('F', { motivation: 'them' });   categorize(f, misc);         // not a base category

    mins(a, IN(1), 60);
    mins(b, IN(2), 30);
    mins(c, IN(3), 45);
    mins(d, IN(4), 15);
    mins(e, IN(5), 20);
    mins(f, IN(6), 10);

    const r = await motivationBalanceForWeek(OWNER, WEEK);
    expect(r.week_start).toBe(WEEK);
    expect(r.basis).toBe('timed');
    expect(r.categories).toEqual([
      { category: 'health', me: 60, us: 0, them: 30, unlabeled: 0, total: 90 },
      { category: 'work', me: 0, us: 45, them: 30, unlabeled: 15, total: 90 }, // tie on total: by name
    ]);
    // B's 30 minutes sit in BOTH of its categories, so the rows add to more than the week;
    // overall counts each entry once, and includes uncategorized and non-base-category time.
    expect(r.overall).toEqual({ me: 80, us: 45, them: 40, unlabeled: 15, total: 180 });
  });

  it('any day of the week anchors the same week', async () => {
    const cat = seedCategory('health');
    const t = insertTask('T', { motivation: 'me' }); categorize(t, cat);
    mins(t, IN(0), 10);
    const mon = await motivationBalanceForWeek(OWNER, '2026-07-06');
    const sun = await motivationBalanceForWeek(OWNER, '2026-07-12');
    expect(sun).toEqual(mon);
    expect(mon.week_start).toBe('2026-07-06');
  });

  it('leaves out entries outside the week, still-running entries and other owners', async () => {
    const cat = seedCategory('health');
    const t = insertTask('T', { motivation: 'me' }); categorize(t, cat);
    mins(t, IN(1), 10);                                  // counted
    mins(t, '2026-07-05T23:00:00.000Z', 30);             // Sunday before
    mins(t, '2026-07-13T00:30:00.000Z', 30);             // Monday after
    entry(t, IN(2), null);                               // still running
    createOwner(SECOND_OWNER_ID);
    const theirs = insertTask('theirs', { motivation: 'them', owner: SECOND_OWNER_ID });
    const theirCat = seedCategory('health', { owner: SECOND_OWNER_ID });
    categorize(theirs, theirCat);
    mins(theirs, IN(1), 99, SECOND_OWNER_ID);

    const r = await motivationBalanceForWeek(OWNER, WEEK);
    expect(r.categories).toEqual([{ category: 'health', me: 10, us: 0, them: 0, unlabeled: 0, total: 10 }]);
    expect(r.overall.total).toBe(10);
    const other = await motivationBalanceForWeek(SECOND_OWNER_ID, WEEK);
    expect(other.overall).toEqual({ me: 0, us: 0, them: 99, unlabeled: 0, total: 99 });
  });

  it('keeps an unlabeled task apart from us', async () => {
    const cat = seedCategory('home');
    const t = insertTask('T', { motivation: null }); categorize(t, cat);
    mins(t, IN(1), 40);
    const r = await motivationBalanceForWeek(OWNER, WEEK);
    expect(r.categories[0]).toMatchObject({ us: 0, unlabeled: 40 });
    // an unexpected stored value is unlabeled too, never us
    sqlite.prepare(`UPDATE tasks SET motivation = 'everyone' WHERE id = ?`).run(t);
    expect((await motivationBalanceForWeek(OWNER, WEEK)).categories[0]).toMatchObject({ us: 0, unlabeled: 40 });
  });

  it('rounds each cell and makes the row total the sum of the shown cells', async () => {
    const cat = seedCategory('home');
    const t1 = insertTask('t1', { motivation: 'me' });   categorize(t1, cat);
    const t2 = insertTask('t2', { motivation: 'us' });   categorize(t2, cat);
    const t3 = insertTask('t3', { motivation: 'them' }); categorize(t3, cat);
    mins(t1, IN(1), 10.4);
    mins(t2, IN(2), 10.4);
    mins(t3, IN(3), 10.4);
    const [row] = (await motivationBalanceForWeek(OWNER, WEEK)).categories;
    expect(row).toEqual({ category: 'home', me: 10, us: 10, them: 10, unlabeled: 0, total: 30 });
  });

  it('drops a category whose minutes round to nothing', async () => {
    const cat = seedCategory('home');
    const t = insertTask('t', { motivation: 'me' }); categorize(t, cat);
    entry(t, IN(1), new Date(Date.parse(IN(1)) + 20_000).toISOString()); // 20 seconds
    const r = await motivationBalanceForWeek(OWNER, WEEK);
    expect(r.categories).toEqual([]);
    expect(r.overall.total).toBe(0);
  });

  it('a week with no timed time is an empty block, not an error', async () => {
    expect(await motivationBalanceForWeek(OWNER, WEEK)).toEqual({
      week_start: WEEK, basis: 'timed', categories: [],
      overall: { me: 0, us: 0, them: 0, unlabeled: 0, total: 0 },
    });
  });

  it('orders categories by minutes, most first', async () => {
    const small = seedCategory('aaa-small');
    const big = seedCategory('zzz-big');
    const s = insertTask('s', { motivation: 'me' }); categorize(s, small);
    const g = insertTask('g', { motivation: 'me' }); categorize(g, big);
    mins(s, IN(1), 5);
    mins(g, IN(1), 50);
    expect((await motivationBalanceForWeek(OWNER, WEEK)).categories.map((c) => c.category)).toEqual(['zzz-big', 'aaa-small']);
  });
});

// ── the flag and the recap route ──────────────────────────────────────────────

describe('motivation_recap_enabled and GET /api/plan-week/review', () => {
  let server: TestServer;
  beforeAll(async () => { server = await startTestServer(); });
  afterAll(() => server.close());

  const review = (headers?: Record<string, string>) =>
    api<PlanWeekReview>(server.url, `/api/plan-week/review?anchor=${WEEK}`, headers ? { headers } : undefined);
  const setFlag = (on: boolean, owner: string = OWNER) =>
    sqlite.prepare(`UPDATE scheduling_prefs SET motivation_recap_enabled = ? WHERE owner_id = ?`).run(on ? 1 : 0, owner);

  function seedWeek(): void {
    const cat = seedCategory('health');
    const t = insertTask('T', { motivation: 'me' }); categorize(t, cat);
    mins(t, IN(1), 30);
  }

  it('is off by default, as a NOT NULL 0 column', () => {
    const col = (sqlite.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string; notnull: number; dflt_value: unknown }[])
      .find((c) => c.name === 'motivation_recap_enabled');
    expect(col).toMatchObject({ notnull: 1, dflt_value: '0' });
  });

  it('reads false through GET /api/prefs, and PATCH turns it on and back off', async () => {
    expect((await api(server.url, '/api/prefs')).body.prefs.motivation_recap_enabled).toBe(false);
    const on = await api(server.url, '/api/prefs', { method: 'PATCH', json: { motivation_recap_enabled: true } });
    expect(on.status).toBe(200);
    expect(on.body.prefs.motivation_recap_enabled).toBe(true);
    expect((await api(server.url, '/api/prefs')).body.prefs.motivation_recap_enabled).toBe(true);
    const off = await api(server.url, '/api/prefs', { method: 'PATCH', json: { motivation_recap_enabled: false } });
    expect(off.body.prefs.motivation_recap_enabled).toBe(false);
  });

  it('off: the recap carries no motivation_balance key at all', async () => {
    seedWeek();
    const r = (await review()).body;
    expect('motivation_balance' in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['anchor', 'calibration', 'note_dates', 'sessions', 'stars', 'week']);
  });

  it('off: the block\'s query never runs', async () => {
    seedWeek();
    const seen: string[] = [];
    const orig = sqlite.prepare.bind(sqlite);
    (sqlite as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => { seen.push(s); return orig(s); };
    try { await review(); } finally { (sqlite as unknown as { prepare: unknown }).prepare = orig; }
    expect(seen.some((s) => /FROM time_entries e\s+JOIN tasks t/.test(s))).toBe(false);
  });

  it('on: the block is there, for the week the recap describes', async () => {
    seedWeek();
    setFlag(true);
    const r = (await review()).body;
    expect(r.motivation_balance).toEqual({
      week_start: WEEK, basis: 'timed',
      categories: [{ category: 'health', me: 30, us: 0, them: 0, unlabeled: 0, total: 30 }],
      overall: { me: 30, us: 0, them: 0, unlabeled: 0, total: 30 },
    });
    expect(r.week.days[0]).toBe(r.motivation_balance!.week_start);
  });

  it('on with nothing timed: an empty block, still present', async () => {
    setFlag(true);
    expect((await review()).body.motivation_balance).toMatchObject({ categories: [], overall: { total: 0 } });
  });

  it('is per owner: one owner turning it on changes nothing for another', async () => {
    seedWeek();
    createOwner(SECOND_OWNER_ID);
    setFlag(true, SECOND_OWNER_ID);
    expect('motivation_balance' in (await review()).body).toBe(false);
    const theirs = (await review({ 'x-test-owner': SECOND_OWNER_ID })).body;
    expect(theirs.motivation_balance).toMatchObject({ categories: [] }); // theirs, and theirs is empty
  });
});
