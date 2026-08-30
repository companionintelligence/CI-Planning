import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { placeFlightPlan } from '../src/engine/autoplan.js';
import { pickGap, MAX_FRAGMENT_COST_MS, MS_PER_MIN, type Gap } from '../src/engine/scheduler.js';
import { placementScorer, BAND_FALLOFF_HOURS } from '../src/services/placement-learning.js';

/**
 * Placement-learning wave, ticket 5 — the apply stage. `pickGap` gains an optional
 * pure `score` parameter (this file's first half, a plain unit-test table with no DB),
 * and `placementScorer` builds that closure from a `placement_preferences` row (the
 * second half, through the real engine via `placeFlightPlan`).
 */

// ── pickGap: unit-level, no DB ──────────────────────────────────────────────────

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const min = (n: number) => n * MS_PER_MIN;
/** A Gap `n` minutes after T0, `endMin` minutes wide, cursor defaulting to `start`. */
function gap(startMin: number, endMin: number, cursorMin = startMin): Gap {
  return { start: T0 + min(startMin), end: T0 + min(endMin), cursor: T0 + min(cursorMin) };
}

interface Case {
  label: string;
  gaps: Gap[];
  wantMin: number;
  expected: { gap: Gap; lenMin: number } | null;
}

// Every case is a table of gaps already in day order (buildGaps' own invariant), so
// the tie-break's `a.start` comparison in the scored path agrees with the unscored
// loop's "first occurrence wins" without needing a scrambled fixture.
const cases: Case[] = (() => {
  const single = gap(0, 60);
  const snug = gap(0, 40);
  const loose = gap(100, 300);
  const tieA = gap(0, 40);
  const tieB = gap(200, 240);
  const tooSmallButLargest = gap(50, 80); // free 30min >= MIN_SESSION_MS(15min)
  const wayTooSmall = gap(0, 10);
  const tinyLargest = gap(0, 5); // free 5min < MIN_SESSION_MS(15min)
  return [
    { label: 'single fitting gap', gaps: [single], wantMin: 30, expected: { gap: single, lenMin: 30 } },
    { label: 'best fit (least leftover) over a larger gap', gaps: [snug, loose], wantMin: 30, expected: { gap: snug, lenMin: 30 } },
    { label: 'tied leftover: earliest (first in day order) wins', gaps: [tieA, tieB], wantMin: 30, expected: { gap: tieA, lenMin: 30 } },
    {
      label: 'no gap fits: falls back to the largest, truncated',
      gaps: [wayTooSmall, tooSmallButLargest],
      wantMin: 45,
      expected: { gap: tooSmallButLargest, lenMin: 30 },
    },
    { label: 'no gap fits and the largest is sub-minimum: null', gaps: [tinyLargest], wantMin: 45, expected: null },
    { label: 'no gaps at all: null', gaps: [], wantMin: 30, expected: null },
  ];
})();

function expectPick(pick: { gap: Gap; len: number } | null, expected: Case['expected']): void {
  if (expected === null) {
    expect(pick).toBeNull();
    return;
  }
  expect(pick).not.toBeNull();
  expect(pick!.gap).toBe(expected.gap);
  expect(pick!.len).toBe(min(expected.lenMin));
}

describe('pickGap — two-argument call, no scorer', () => {
  for (const c of cases) {
    it(c.label, () => {
      expectPick(pickGap(c.gaps, min(c.wantMin)), c.expected);
    });
  }
});

describe('pickGap — a neutral scorer changes nothing', () => {
  const neutral = () => 1;
  for (const c of cases) {
    it(c.label, () => {
      expectPick(pickGap(c.gaps, min(c.wantMin), neutral), c.expected);
    });
  }
});

describe('pickGap — biasing within the fragmentation budget', () => {
  it('a higher-scoring gap costing 30 extra minutes of leftover wins', () => {
    const cheap = gap(0, 40); // leftover 10min for a 30min want
    const preferred = gap(100, 170); // leftover 40min — 30min more than `cheap`
    const score = (s: number) => (s === preferred.cursor ? 1 : 0);
    const pick = pickGap([cheap, preferred], min(30), score);
    expect(pick!.gap).toBe(preferred);
    expect(pick!.len).toBe(min(30));
  });

  it('a higher-scoring gap costing 90 extra minutes of leftover loses to the budget', () => {
    const cheap = gap(0, 40); // leftover 10min for a 30min want
    const tooExpensive = gap(100, 230); // leftover 100min — 90min more than `cheap`
    expect(min(90)).toBeGreaterThan(MAX_FRAGMENT_COST_MS); // sanity: 90min is really over budget
    const score = (s: number) => (s === tooExpensive.cursor ? 1 : 0);
    const pick = pickGap([cheap, tooExpensive], min(30), score);
    expect(pick!.gap).toBe(cheap);
    expect(pick!.len).toBe(min(30));
  });

  it('no gap fits: the truncating fallback is never biased, scorer or not', () => {
    const onlyGap = gap(0, 20); // free 20min >= MIN_SESSION_MS, but < the 45min want
    const score = () => 1;
    const unbiased = pickGap([onlyGap], min(45));
    const scored = pickGap([onlyGap], min(45), score);
    expect(scored).toEqual(unbiased);
    expect(scored!.gap).toBe(onlyGap);
    expect(scored!.len).toBe(min(20));
  });

  it('equal scores and equal leftover: the earliest gap, matching today', () => {
    const early = gap(0, 40);
    const late = gap(100, 140);
    const tiedScore = () => 0.5;
    const pick = pickGap([early, late], min(30), tiedScore);
    expect(pick!.gap).toBe(early);
  });
});

// ── placementScorer: band edges and falloff, no engine involved ────────────────

const OWNER = SYSTEM_OWNER;

function seedBand(ownerId: string, slotKey: string, p25: number, p75: number): void {
  sqlite
    .prepare(
      `INSERT INTO placement_preferences
         (owner_id, slot_key, p25_hour, p75_hour, corrections, sample_count, computed_date)
       VALUES (?, ?, ?, ?, 10, 20, '2026-01-01')`,
    )
    .run(ownerId, slotKey, p25, p75);
}
const atUTC = (hh: number, mm = 0) => Date.parse(`2026-06-22T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`);

describe('placementScorer — score shape', () => {
  beforeEach(() => resetDb());

  it('returns null when the owner/key has no row', async () => {
    expect(await placementScorer(OWNER, 'work')).toBeNull();
  });

  it('scores both band edges 1', async () => {
    seedBand(OWNER, 'work', 17, 20);
    const scorer = await placementScorer(OWNER, 'work');
    expect(scorer).not.toBeNull();
    expect(scorer!(atUTC(17))).toBe(1);
    expect(scorer!(atUTC(20))).toBe(1);
  });

  it('falls off continuously outside the band', async () => {
    expect(BAND_FALLOFF_HOURS).toBe(3);
    seedBand(OWNER, 'work', 17, 20);
    const scorer = await placementScorer(OWNER, 'work');
    // 3 hours past p75 (20:00) → 0
    expect(scorer!(atUTC(23))).toBe(0);
    // 1.5 hours past p75 (20:00) → 0.5
    expect(scorer!(atUTC(21, 30))).toBeCloseTo(0.5, 10);
  });

  it('one owner\'s band never affects another owner\'s score', async () => {
    createOwner(SECOND_OWNER_ID, 'Owner B', 'UTC');
    seedBand(OWNER, 'work', 17, 20); // owner A: evening
    seedBand(SECOND_OWNER_ID, 'work', 6, 8); // owner B: morning

    const scorerA = await placementScorer(OWNER, 'work');
    const scorerB = await placementScorer(SECOND_OWNER_ID, 'work');
    expect(scorerA).not.toBeNull();
    expect(scorerB).not.toBeNull();

    // Owner B's own morning band scores 1 in the morning — unmoved by owner A's row.
    expect(scorerB!(atUTC(7))).toBe(1);
    // The same evening hour that maxes out owner A's score is outside owner B's band.
    expect(scorerA!(atUTC(18))).toBe(1);
    expect(scorerB!(atUTC(18))).toBeLessThan(1);

    // No row at all for owner B under a key owner A never wrote either.
    expect(await placementScorer(SECOND_OWNER_ID, 'home')).toBeNull();
  });
});

// ── End to end: the real Auto placement loop, through placeFlightPlan ──────────

const DAY = '2026-06-22'; // a Monday → 'workday' by the UTC-weekend default

function insertTask(title: string, est = 30): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`)
      .get(title, OWNER, est) as { id: string }
  ).id;
}
function stage(taskId: string, ownerId: string = OWNER): void {
  sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(ownerId, taskId);
}
function directionTagId(name: string, ownerId: string = OWNER): string {
  const existing = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`).get(ownerId, name) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  return (
    sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'direction') RETURNING id`).get(ownerId, name) as {
      id: string;
    }
  ).id;
}
/** One `pattern_blocks` window for the 'work' direction on the day's resolved type
 *  ('workday' for `DAY`) — deliberately a single row spanning the whole test window, so
 *  an in-window obstacle is what fragments it into candidate gaps, not a second row
 *  (Pass 2a tries same-direction ranges in start-time order and stops at the first one
 *  that places the task, so two separate rows could never demonstrate a real choice).
 */
function seedWorkWindow(start: string, end: string, ownerId: string = OWNER): void {
  const tagId = directionTagId('work', ownerId);
  sqlite
    .prepare(`INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time) VALUES (uuid7(), ?, ?, 'workday', ?, ?)`)
    .run(ownerId, tagId, start, end);
}
function insertMeeting(start: string, end: string, ownerId: string = OWNER): void {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, source_kind, source_ref, status, owner_id)
       VALUES (uuid7(), 'Meeting', 'meeting', ?, ?, 0, 'gcal', 'evt', 'planned', ?)`,
    )
    .run(start, end, ownerId);
}
function insertLockedBlock(start: string, end: string, ownerId: string = OWNER): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, is_locked, status, owner_id)
         VALUES (uuid7(), 'Locked hold', 'task', ?, ?, 0, 1, 'planned', ?) RETURNING id`,
      )
      .get(start, end, ownerId) as { id: string }
  ).id;
}
function blockFor(taskId: string): { id: string; start_at: string; end_at: string } | undefined {
  return sqlite.prepare(`SELECT id, start_at, end_at FROM time_blocks WHERE task_id = ? AND block_kind = 'task'`).get(taskId) as
    | { id: string; start_at: string; end_at: string }
    | undefined;
}
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

describe('placement bias — through the real Auto placement loop', () => {
  beforeEach(() => {
    resetDb();
  });

  it('lands an evening-banded task in the evening, and reverts to the morning once the band is deleted', async () => {
    // A single 09:00-19:00 'work' window with a 10:00-17:00 meeting carved out of the
    // middle: two candidate gaps, morning (09:00-10:00, 60min free) and evening
    // (17:10-19:00, 110min free — break-adjusted). Unbiased, the 30min task's least
    // leftover is the morning gap (30min vs 80min) — well within the 60min
    // fragmentation budget of each other, so the evening band can flip the choice.
    seedWorkWindow('09:00', '19:00');
    insertMeeting(at('10:00'), at('17:00'));
    seedBand(OWNER, '(none)', 17, 20); // untagged task → slot_key '(none)' (ticket 2)

    const task1 = insertTask('Evening-banded task');
    stage(task1);
    await placeFlightPlan(OWNER, { date: DAY });

    const block1 = blockFor(task1);
    expect(block1).toBeDefined();
    expect(new Date(block1!.start_at).getUTCHours()).toBe(17);
    expect(Date.parse(block1!.start_at)).toBeGreaterThanOrEqual(Date.parse(at('17:00')));
    expect(Date.parse(block1!.end_at)).toBeLessThanOrEqual(Date.parse(at('19:00')));

    // Delete the preference row — the same day, the same window — and placement
    // reverts to the unbiased least-leftover choice: the morning.
    sqlite.prepare(`DELETE FROM placement_preferences WHERE owner_id = ? AND slot_key = ?`).run(OWNER, '(none)');

    const task2 = insertTask('No-band task');
    stage(task2);
    await placeFlightPlan(OWNER, { date: DAY });

    const block2 = blockFor(task2);
    expect(block2).toBeDefined();
    expect(new Date(block2!.start_at).getUTCHours()).toBe(9);
  });

  it('never lets a band pull a placement onto a meeting — the block goes elsewhere', async () => {
    // The meeting now covers the whole rest of the window (10:00 through the window's
    // 19:00 end), so there is no evening gap left at all — only the morning one.
    seedWorkWindow('09:00', '19:00');
    insertMeeting(at('10:00'), at('19:00'));
    seedBand(OWNER, '(none)', 17, 20);

    const task = insertTask('Would-be evening task');
    stage(task);
    await placeFlightPlan(OWNER, { date: DAY });

    const block = blockFor(task);
    expect(block).toBeDefined();
    // Lands in the only gap that exists — the morning — never inside the meeting.
    expect(Date.parse(block!.end_at)).toBeLessThanOrEqual(Date.parse(at('10:00')));
    expect(Date.parse(block!.start_at) < Date.parse(at('19:00')) && Date.parse(block!.end_at) > Date.parse(at('10:00'))).toBe(false);
  });

  it('never displaces a locked block sitting in the preferred window', async () => {
    seedWorkWindow('09:00', '19:00');
    const lockedId = insertLockedBlock(at('17:00'), at('19:00'));
    seedBand(OWNER, '(none)', 17, 20);

    const task = insertTask('Would-be evening task');
    stage(task);
    await placeFlightPlan(OWNER, { date: DAY });

    // The lock is untouched.
    const locked = sqlite.prepare(`SELECT start_at, end_at, is_locked FROM time_blocks WHERE id = ?`).get(lockedId) as {
      start_at: string;
      end_at: string;
      is_locked: number;
    };
    expect(locked.start_at).toBe(at('17:00'));
    expect(locked.end_at).toBe(at('19:00'));
    expect(locked.is_locked).toBe(1);

    // The new block does not overlap it.
    const block = blockFor(task);
    expect(block).toBeDefined();
    const overlaps = Date.parse(block!.start_at) < Date.parse(locked.end_at) && Date.parse(block!.end_at) > Date.parse(locked.start_at);
    expect(overlaps).toBe(false);
  });
});
