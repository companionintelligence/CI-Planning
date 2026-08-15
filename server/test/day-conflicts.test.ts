import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  strandedBlocks, compareDropOrder, hhmmToMin, detectDayConflicts,
  type ConflictCandidate, type WindowsByDirection,
} from '../src/engine/day-conflicts.js';
import { proposeDayReflow, applyDayReflow } from '../src/engine/day-reflow.js';
import { resetDb } from './helpers.js';

/**
 * Focus × Time Blocks, Phase 7 — day-type change strands tasks; the owner confirms
 * a reflow. The plan's test list, plus the invariants the feature actually rests on:
 * nothing mutates without the explicit apply, and unscheduled work is never dropped.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22'; // a Monday
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

beforeEach(() => { resetDb(); });

// ─── the pure rule ───────────────────────────────────────────────────────────

const cand = (over: Partial<ConflictCandidate> = {}): ConflictCandidate => ({
  id: 'b1', startMin: 600, endMin: 660, directions: ['work'], nested: false, external: false, ...over,
});
const WORK_9_5: WindowsByDirection = { work: [{ startMin: 540, endMin: 1020 }] };

describe('strandedBlocks — the L01 rule', () => {
  it('a task inside its direction’s window is fine', () => {
    expect(strandedBlocks([cand()], WORK_9_5)).toEqual([]);
  });

  it('a task outside its direction’s window is stranded', () => {
    expect(strandedBlocks([cand({ startMin: 1200, endMin: 1260 })], WORK_9_5)).toEqual(['b1']);
  });

  it('containment, not overlap — half in is still half out', () => {
    expect(strandedBlocks([cand({ startMin: 960, endMin: 1080 })], WORK_9_5)).toEqual(['b1']);
  });

  it('a direction with no windows strands it — while OTHER directions still have some', () => {
    // The Light-day case: home hours exist, work hours do not.
    const lightDay: WindowsByDirection = { work: [], home: [{ startMin: 1080, endMin: 1320 }] };
    expect(strandedBlocks([cand()], lightDay)).toEqual(['b1']);
  });

  it('an entirely UNCONFIGURED L01 strands nothing — a rule nobody set cannot be broken', () => {
    // A fresh install, or a day type nobody has given windows. Without this, the
    // banner would greet a new owner by declaring every task on the day misplaced.
    expect(strandedBlocks([cand()], {})).toEqual([]);
    expect(strandedBlocks([cand()], { work: [], home: [] })).toEqual([]);
  });

  it('a Time Block member is exempt — L02 overrides L01', () => {
    expect(strandedBlocks([cand({ startMin: 1200, endMin: 1260, nested: true })], WORK_9_5)).toEqual([]);
  });

  it('an L00 synced event is exempt — it answers to no window', () => {
    expect(strandedBlocks([cand({ startMin: 1200, endMin: 1260, external: true })], WORK_9_5)).toEqual([]);
  });

  it('an undirected task is exempt — no direction, no window rule', () => {
    expect(strandedBlocks([cand({ startMin: 1200, endMin: 1260, directions: [] })], WORK_9_5)).toEqual([]);
  });

  it('a multi-direction task needs only ONE direction to accommodate it', () => {
    const w: WindowsByDirection = { work: [{ startMin: 540, endMin: 600 }], home: [{ startMin: 1080, endMin: 1320 }] };
    expect(strandedBlocks([cand({ startMin: 1200, endMin: 1260, directions: ['work', 'home'] })], w)).toEqual([]);
  });

  it('matches direction names case-insensitively', () => {
    expect(strandedBlocks([cand({ directions: ['WORK'] })], WORK_9_5)).toEqual([]);
  });
});

describe('compareDropOrder — decision 5', () => {
  const p = (priority: number | null, dueAt: string | null = null, est: number | null = null) =>
    ({ priority, dueAt, estimatedMinutes: est });

  it('drops the lowest priority first: P3 before P2 before P1', () => {
    const order = [p(1), p(3), p(2)].sort(compareDropOrder);
    expect(order.map((x) => x.priority)).toEqual([3, 2, 1]);
  });

  it('within a band, no due date is dropped before one with a due date', () => {
    const order = [p(2, '2026-06-30'), p(2, null)].sort(compareDropOrder);
    expect(order.map((x) => x.dueAt)).toEqual([null, '2026-06-30']);
  });

  it('then shortest estimate first', () => {
    const order = [p(2, null, 90), p(2, null, 30)].sort(compareDropOrder);
    expect(order.map((x) => x.estimatedMinutes)).toEqual([30, 90]);
  });

  it('an unprioritised task is dropped before an explicit P3', () => {
    const order = [p(3), p(null)].sort(compareDropOrder);
    expect(order.map((x) => x.priority)).toEqual([null, 3]);
  });
});

describe('hhmmToMin', () => {
  it('parses, and rejects nonsense as NaN rather than silently 0', () => {
    expect(hhmmToMin('09:30')).toBe(570);
    expect(Number.isNaN(hhmmToMin('nope'))).toBe(true);
    expect(Number.isNaN(hhmmToMin('99:99'))).toBe(true);
  });
});

// ─── against the database ────────────────────────────────────────────────────

function tag(name: string, kind: 'direction' | 'category'): string {
  return (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(OWNER, name, kind) as { id: string }).id;
}

function dayType(key: string, name = key): void {
  sqlite.prepare(`INSERT OR IGNORE INTO day_types (id, owner_id, key, name) VALUES (uuid7(), ?, ?, ?)`).run(OWNER, key, name);
}

function assignDay(key: string): void {
  sqlite.prepare(`INSERT OR REPLACE INTO day_assignments (owner_id, date, day_type_key) VALUES (?, ?, ?)`).run(OWNER, DAY, key);
}

function window_(dirTagId: string, key: string, start: string, end: string): void {
  sqlite.prepare(
    `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
     VALUES (uuid7(), ?, ?, ?, ?, ?)`,
  ).run(OWNER, dirTagId, key, start, end);
}

function task(title: string, over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = { owner_id: OWNER, title, status: 'open', ...over };
  const keys = Object.keys(row);
  return (sqlite.prepare(
    `INSERT INTO tasks (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`,
  ).get(...keys.map((k) => row[k])) as { id: string }).id;
}

function block(over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    owner_id: OWNER, title: 'B', block_kind: 'task', tag: 'work',
    start_at: at('10:00'), end_at: at('11:00'),
    is_auto: 0, is_locked: 0, source_kind: 'manual', status: 'planned', ...over,
  };
  const keys = Object.keys(row);
  return (sqlite.prepare(
    `INSERT INTO time_blocks (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`,
  ).get(...keys.map((k) => row[k])) as { id: string }).id;
}

/** A Workday with 09:00–17:00 work hours, and a Light day with none.
 *
 *  The owner's timezone is pinned to UTC so `at('10:00')` means 10:00 on the day the
 *  windows describe. Without it these fixtures silently mean "03:00 local" on a
 *  Pacific dev box, and every test reads as stranded for the wrong reason. */
function seedDayTypes(): void {
  // scheduling_prefs keys on `id`, not owner_id — so upsert by hand.
  const prefs = sqlite.prepare(`SELECT id FROM scheduling_prefs WHERE owner_id = ?`).get(OWNER);
  if (prefs) sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
  else sqlite.prepare(`INSERT INTO scheduling_prefs (id, owner_id, timezone) VALUES (uuid7(), ?, 'UTC')`).run(OWNER);
  const work = tag('work', 'direction');
  const home = tag('home', 'direction');
  dayType('workday'); dayType('light');
  window_(work, 'workday', '09:00', '17:00');
  window_(home, 'workday', '18:00', '22:00');
  // A Light day has home hours but NO work window — that is the stranding case, and
  // it must stay distinguishable from a day type nobody has configured at all (which
  // strands nothing). Giving 'light' a home window is what makes it a real Light day
  // rather than an empty one.
  window_(home, 'light', '08:00', '22:00');
  assignDay('workday');
}

const rowOf = (id: string) =>
  sqlite.prepare(`SELECT * FROM time_blocks WHERE id = ?`).get(id) as any;
const staged = () =>
  (sqlite.prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ?`).all(OWNER) as { task_id: string }[])
    .map((r) => r.task_id);

describe('detectDayConflicts', () => {
  beforeEach(seedDayTypes);

  it('finds nothing while the day type still has the windows', async () => {
    block({ start_at: at('10:00'), end_at: at('11:00') });
    expect((await detectDayConflicts(OWNER, DAY)).conflicts).toEqual([]);
  });

  it('strands work tasks when the day flips to a type with no work windows', async () => {
    const b = block({ title: 'Write spec' });
    assignDay('light');
    const report = await detectDayConflicts(OWNER, DAY);
    expect(report.day_type).toBe('light');
    expect(report.conflicts.map((c) => c.block_id)).toEqual([b]);
  });

  it('exempts a Time Block member', async () => {
    const container = block({ block_kind: 'timeblock', start_at: at('18:00'), end_at: at('20:00') });
    block({ parent_block_id: container, start_at: at('18:15'), end_at: at('19:00') });
    assignDay('light');
    expect((await detectDayConflicts(OWNER, DAY)).conflicts).toEqual([]);
  });

  it('exempts an L00 mirror even though it carries a direction', async () => {
    // A task block that IS mapped inbound — the exemption is resolved from
    // external_events, not assumed from block_kind.
    const b = block({ title: 'Mirrored' });
    sqlite.prepare(
      `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id, direction, last_synced_at)
       VALUES (uuid7(), ?, 'google', 'work', 'evt-1', ?, 'inbound', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(OWNER, b);
    assignDay('light');
    expect((await detectDayConflicts(OWNER, DAY)).conflicts).toEqual([]);
  });

  it('flags a LOCKED stranded block — shown red, but marked so it is never moved', async () => {
    block({ is_locked: 1 });
    assignDay('light');
    const report = await detectDayConflicts(OWNER, DAY);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].is_locked).toBe(true);
  });

  it('takes the direction from the linked task when the block carries no tag', async () => {
    const dirId = (sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = 'work'`).get(OWNER) as { id: string }).id;
    const t = task('Tagged via task');
    sqlite.prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(t, dirId);
    const b = block({ tag: null, task_id: t });
    assignDay('light');
    expect((await detectDayConflicts(OWNER, DAY)).conflicts.map((c) => c.block_id)).toEqual([b]);
  });
});

describe('proposeDayReflow — same-day first, nothing written', () => {
  beforeEach(seedDayTypes);

  it('moves a stranded task back inside the new windows', async () => {
    // Shrink the day to a morning-only work window; a 4pm task no longer fits it.
    dayType('short');
    const work = (sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = 'work'`).get(OWNER) as { id: string }).id;
    window_(work, 'short', '09:00', '12:00');
    const b = block({ title: 'Write spec', start_at: at('16:00'), end_at: at('17:00') });
    assignDay('short');

    const p = await proposeDayReflow(OWNER, DAY);
    expect(p.moves).toHaveLength(1);
    expect(p.unschedule).toEqual([]);
    expect(p.moves[0].block_id).toBe(b);
    expect(p.moves[0].to.start_at >= at('09:00')).toBe(true);
    expect(p.moves[0].to.end_at <= at('12:00')).toBe(true);
    // A preview writes NOTHING.
    expect(rowOf(b).start_at).toBe(at('16:00'));
  });

  it('proposes unscheduling what cannot fit anywhere', async () => {
    const b = block({ title: 'Write spec' });
    assignDay('light'); // no work windows at all
    const p = await proposeDayReflow(OWNER, DAY);
    expect(p.moves).toEqual([]);
    expect(p.unschedule.map((u) => u.block_id)).toEqual([b]);
    expect(rowOf(b)).toBeTruthy(); // still there — nothing applied
  });

  it('never moves a locked block; it is reported as kept', async () => {
    const locked = block({ title: 'Pinned', is_locked: 1 });
    assignDay('light');
    const p = await proposeDayReflow(OWNER, DAY);
    expect(p.moves).toEqual([]);
    expect(p.unschedule).toEqual([]);
    expect(p.kept_locked.map((c) => c.block_id)).toEqual([locked]);
  });

  it('when only some fit, the LOWEST priority is the one dropped (decision 5)', async () => {
    dayType('onehour');
    const work = (sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = 'work'`).get(OWNER) as { id: string }).id;
    window_(work, 'onehour', '09:00', '10:00'); // room for exactly one 60-minute task
    const hi = task('High', { priority: 1 });
    const lo = task('Low', { priority: 3 });
    const bHi = block({ title: 'High', task_id: hi, start_at: at('16:00'), end_at: at('17:00') });
    const bLo = block({ title: 'Low', task_id: lo, start_at: at('17:00'), end_at: at('18:00') });
    assignDay('onehour');

    const p = await proposeDayReflow(OWNER, DAY);
    expect(p.moves.map((m) => m.block_id)).toEqual([bHi]);
    expect(p.unschedule.map((u) => u.block_id)).toEqual([bLo]);
  });
});

describe('applyDayReflow — the confirmation', () => {
  beforeEach(seedDayTypes);

  it('re-places what fits', async () => {
    dayType('short');
    const work = (sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = 'work'`).get(OWNER) as { id: string }).id;
    window_(work, 'short', '09:00', '12:00');
    const b = block({ start_at: at('16:00'), end_at: at('17:00') });
    assignDay('short');

    const res = await applyDayReflow(OWNER, DAY);
    expect(res.moved).toBe(1);
    expect(rowOf(b).start_at >= at('09:00')).toBe(true);
    expect(rowOf(b).start_at < at('12:00')).toBe(true);
  });

  it('re-stages what does not fit instead of dropping the work', async () => {
    const t = task('Write spec');
    const b = block({ task_id: t });
    assignDay('light');

    const res = await applyDayReflow(OWNER, DAY);
    expect(res.unscheduled).toBe(1);
    expect(res.restaged).toBe(1);
    expect(rowOf(b)).toBeUndefined();      // block gone
    expect(staged()).toContain(t);         // task back in the flight-plan
  });

  it('leaves a locked block exactly where the owner put it', async () => {
    const locked = block({ is_locked: 1, start_at: at('16:00'), end_at: at('17:00') });
    assignDay('light');
    const res = await applyDayReflow(OWNER, DAY);
    expect(res.moved).toBe(0);
    expect(res.unscheduled).toBe(0);
    expect(rowOf(locked).start_at).toBe(at('16:00'));
  });

  it('is a no-op when the day has no conflicts', async () => {
    const b = block();
    const before = rowOf(b).start_at;
    expect(await applyDayReflow(OWNER, DAY)).toEqual({ moved: 0, unscheduled: 0, restaged: 0 });
    expect(rowOf(b).start_at).toBe(before);
  });
});
