import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  calibratePlacement, placementOutcome,
  CORRECTION_FLOOR, MAX_BAND_HOURS, MAX_PREFERENCE_KEYS, PLACEMENT_WINDOW_DAYS, SURVIVAL_PERIOD_DAYS,
  type PlacementLogRow,
} from '../src/services/placement-learning.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * Placement-learning wave, ticket 4 — the deterministic BATCH pass. Modelled on
 * classification-learning.test.ts: raw sqlite fixtures, a frozen `NOW`, every timestamp
 * derived from it, and the owner pinned to UTC (resetDb's baseline) so a fixture's
 * wall-clock hour is always its UTC hour.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-08-14T14:00:00.000Z');

/** `NOW` minus `days` days, at UTC hour `hh`. */
function at(days: number, hh: number): Date {
  const d = new Date(NOW.getTime() - days * 86_400_000);
  d.setUTCHours(hh, 0, 0, 0);
  return d;
}

function insertBlock(id: string, ownerId: string, startAt: string, endAt: string): void {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_auto, status)
       VALUES (?, ?, 'Auto block', 'task', ?, ?, 1, 'planned')`,
    )
    .run(id, ownerId, startAt, endAt);
}

let seq = 0;

/**
 * Insert one `placement_log` row directly — the raw-sqlite-fixture idiom
 * classification-learning.test.ts uses via `evidence()` — bypassing `logPlacement` /
 * `recordPlacementMove` so a test gets full control over age, fit, and the moved half.
 * A matching `time_blocks` row is created unless `blockGone` is set, so "not moved, in
 * the past" reads as `accepted` by default.
 */
function placement(opts: {
  owner?: string;
  slotKey: string;
  fit?: 0 | 1;
  chosenAt: Date;
  movedAt?: Date | null;
  blockGone?: boolean;
}): { blockId: string } {
  const owner = opts.owner ?? OWNER;
  const blockId = `block-${seq++}`;
  const chosenStart = opts.chosenAt.toISOString();
  const chosenEnd = new Date(opts.chosenAt.getTime() + 30 * 60_000).toISOString();
  if (!opts.blockGone) insertBlock(blockId, owner, chosenStart, chosenEnd);
  const movedStart = opts.movedAt ? opts.movedAt.toISOString() : null;
  const movedEnd = opts.movedAt ? new Date(opts.movedAt.getTime() + 30 * 60_000).toISOString() : null;
  const movedHour = opts.movedAt ? opts.movedAt.getUTCHours() : null;
  const localDate = chosenStart.slice(0, 10);
  sqlite
    .prepare(
      `INSERT INTO placement_log
         (id, owner_id, block_id, task_id, slot_key, auto_run_id,
          chosen_start_at, chosen_end_at, chosen_hour, fit, candidates,
          moved_start_at, moved_end_at, moved_hour, placed_at, moved_at, local_date)
       VALUES (uuid7(), ?, ?, NULL, ?, NULL, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      owner, blockId, opts.slotKey, chosenStart, chosenEnd, opts.chosenAt.getUTCHours(), opts.fit ?? 1,
      movedStart, movedEnd, movedHour, chosenStart, opts.movedAt ? opts.movedAt.toISOString() : null, localDate,
    );
  return { blockId };
}

const preferenceRows = (owner = OWNER) =>
  sqlite
    .prepare(`SELECT * FROM placement_preferences WHERE owner_id = ? ORDER BY slot_key`)
    .all(owner) as {
      slot_key: string; p25_hour: number; p75_hour: number;
      corrections: number; sample_count: number; computed_date: string;
    }[];

const survivalRow = (owner = OWNER, date?: string) =>
  sqlite
    .prepare(`SELECT * FROM placement_survival WHERE owner_id = ?${date ? ' AND computed_date = ?' : ''}`)
    .get(...(date ? [owner, date] : [owner])) as {
      computed_date: string; period_days: number; decided: number; accepted: number;
      corrected: number; survival_rate: number | null; keys_learned: number; biased: number;
    } | undefined;

beforeEach(() => {
  resetDb();
  seq = 0;
});

// ── The grading rule ─────────────────────────────────────────────────────────

describe('placementOutcome — the six-row table', () => {
  const row = (over: Partial<PlacementLogRow> = {}): PlacementLogRow => ({
    fit: 1, moved_at: null, moved_hour: null, chosen_hour: 9,
    chosen_start_at: at(1, 9).toISOString(), ...over,
  });

  it('fit = 0 is a truncated fallback, not a choice', () => {
    expect(placementOutcome(row({ fit: 0 }), NOW, true)).toBeNull();
  });

  it('moved to a different hour is a correction', () => {
    expect(placementOutcome(row({ moved_at: NOW.toISOString(), moved_hour: 19, chosen_hour: 9 }), NOW, true)).toBe('corrected');
  });

  it('moved within the same hour is an acceptance', () => {
    expect(placementOutcome(row({ moved_at: NOW.toISOString(), moved_hour: 9, chosen_hour: 9 }), NOW, true)).toBe('accepted');
  });

  it('untouched and the block is gone is pending forever, not accepted', () => {
    expect(placementOutcome(row(), NOW, false)).toBeNull();
  });

  it('untouched and the slot has not arrived is undecided', () => {
    expect(placementOutcome(row({ chosen_start_at: new Date(NOW.getTime() + 3_600_000).toISOString() }), NOW, true)).toBeNull();
  });

  it('untouched and the slot has passed is accepted', () => {
    expect(placementOutcome(row({ chosen_start_at: at(1, 9).toISOString() }), NOW, true)).toBe('accepted');
  });
});

// ── The batch pass ───────────────────────────────────────────────────────────

describe('calibratePlacement', () => {
  it('the reflow-churn guard: a block deleted after placement and never moved is excluded from the batch', async () => {
    // The ghost row: never moved, block gone. If it graded `accepted` instead of
    // `null` it would silently count toward this key's decided total below.
    placement({ slotKey: 'work', chosenAt: at(5, 9), blockGone: true });
    // Enough OTHER evidence that the key would otherwise clear the floor and let the
    // ghost row's absence (or presence) show up in `decided`.
    for (let i = 0; i < CORRECTION_FLOOR; i++) {
      placement({ slotKey: 'work', chosenAt: at(4, 9), movedAt: at(4, 19) });
    }
    const r = await calibratePlacement(OWNER, NOW);
    const work = r.keys.find((k) => k.slotKey === 'work')!;
    expect(work.decided).toBe(CORRECTION_FLOOR); // the ghost row did not count
    expect(preferenceRows().find((p) => p.slot_key === 'work')).toBeDefined();
  });

  it('teaches nothing below the floor, and deletes a stale row for that key', async () => {
    // A stale row from a prior run — must be gone, not left behind.
    sqlite
      .prepare(
        `INSERT INTO placement_preferences (owner_id, slot_key, p25_hour, p75_hour, corrections, sample_count, computed_date)
         VALUES (?, 'home', 18, 20, 6, 6, '2026-08-01')`,
      )
      .run(OWNER);

    for (let i = 0; i < CORRECTION_FLOOR - 1; i++) {
      placement({ slotKey: 'home', chosenAt: at(2, 9), movedAt: at(2, 19) });
    }
    const r = await calibratePlacement(OWNER, NOW);
    const home = r.keys.find((k) => k.slotKey === 'home')!;
    expect(home.corrections).toBe(CORRECTION_FLOOR - 1);
    expect(home.written).toBe(false);
    expect(preferenceRows().find((p) => p.slot_key === 'home')).toBeUndefined();
  });

  it('at the floor, writes a row whose band edges are the resting-hour quantiles', async () => {
    const movedHours = [8, 9, 10, 11, 12];
    expect(movedHours).toHaveLength(CORRECTION_FLOOR);
    for (const h of movedHours) {
      placement({ slotKey: 'work', chosenAt: at(3, 7), movedAt: at(3, h) });
    }
    await calibratePlacement(OWNER, NOW);
    const row = preferenceRows().find((p) => p.slot_key === 'work')!;
    expect(row).toBeDefined();
    expect(row.sample_count).toBe(CORRECTION_FLOOR);
    expect(row.p25_hour).toBe(9);  // the same index-quantile Phase N used (0083)
    expect(row.p75_hour).toBe(11); // — not an interpolated median, an actual resting hour
  });

  it('resting-hour rule: 20 accepted at 09 + 5 corrected to 19 bands near 09, not 19', async () => {
    for (let i = 1; i <= 20; i++) {
      placement({ slotKey: 'work', chosenAt: at(i, 9) }); // untouched, in the past → accepted at 09
    }
    for (let i = 21; i <= 25; i++) {
      placement({ slotKey: 'work', chosenAt: at(i, 9), movedAt: at(i, 19) }); // corrected to 19
    }
    await calibratePlacement(OWNER, NOW);
    const row = preferenceRows().find((p) => p.slot_key === 'work')!;
    expect(row.sample_count).toBe(25);
    expect(row.corrections).toBe(5);
    // Five corrections outvoted by two hundred (here twenty) untouched acceptances must
    // not drag the band to the evening.
    expect(row.p25_hour).toBe(9);
  });

  it('a spread wider than MAX_BAND_HOURS writes no row', async () => {
    for (let i = 0; i < CORRECTION_FLOOR; i++) placement({ slotKey: 'work', chosenAt: at(2, 6), movedAt: at(2, 2) });
    for (let i = 0; i < CORRECTION_FLOOR; i++) placement({ slotKey: 'work', chosenAt: at(2, 20) }); // accepted at 20
    const r = await calibratePlacement(OWNER, NOW);
    const work = r.keys.find((k) => k.slotKey === 'work')!;
    expect(work.p75 - work.p25).toBeGreaterThan(MAX_BAND_HOURS);
    expect(work.written).toBe(false);
    expect(preferenceRows()).toHaveLength(0);
  });

  it('caps preference keys at MAX_PREFERENCE_KEYS, keeping the highest sample_count', async () => {
    // 50 keys with sample_count 10 (floor-clearing corrections + matching accepteds,
    // all resting at the same hour so the band stays narrow) and one key with the bare
    // floor's sample_count of 5 — strictly the lowest of the 51 eligible keys.
    for (let i = 0; i < 50; i++) {
      const key = `k${String(i).padStart(2, '0')}`;
      for (let c = 0; c < CORRECTION_FLOOR; c++) placement({ slotKey: key, chosenAt: at(2, 8), movedAt: at(2, 10) });
      for (let a = 0; a < 5; a++) placement({ slotKey: key, chosenAt: at(3, 10) }); // accepted at 10 too
    }
    for (let c = 0; c < CORRECTION_FLOOR; c++) placement({ slotKey: 'low', chosenAt: at(2, 8), movedAt: at(2, 10) });

    const result = await calibratePlacement(OWNER, NOW);
    const rows = preferenceRows();
    expect(rows).toHaveLength(MAX_PREFERENCE_KEYS);
    expect(rows.find((p) => p.slot_key === 'low')).toBeUndefined(); // lowest sample_count, dropped
    expect(rows.every((p) => p.sample_count === 10)).toBe(true);

    // The dropped key cleared the floor and its band is well inside MAX_BAND_HOURS —
    // it was excluded ONLY by the rank cap, not because it was actually ineligible.
    // Its own reason must say so, not "band too wide" (the report-only bug found in
    // code review: jobs/index.ts used to re-derive the reason from `written` +
    // `corrections < floor` alone, which can't tell "capped" apart from "too wide").
    const low = result.keys.find((k) => k.slotKey === 'low')!;
    expect(low.written).toBe(false);
    expect(low.corrections).toBeGreaterThanOrEqual(CORRECTION_FLOOR);
    expect(low.p75 - low.p25).toBeLessThanOrEqual(MAX_BAND_HOURS);
    expect(low.reason).toBe('capped');

    const kept = result.keys.find((k) => k.slotKey === 'k00')!;
    expect(kept.written).toBe(true);
    expect(kept.reason).toBe('written');
  });

  it('ignores rows older than PLACEMENT_WINDOW_DAYS, and a key that ages out entirely loses its row', async () => {
    for (let i = 0; i < CORRECTION_FLOOR; i++) {
      placement({ slotKey: 'work', chosenAt: at(10, 8), movedAt: at(10, 19) });
    }
    await calibratePlacement(OWNER, NOW);
    expect(preferenceRows().find((p) => p.slot_key === 'work')).toBeDefined();

    // Re-run far enough in the future that every row for this key fell out of the
    // 90-day window; the row must disappear, not linger stale.
    const later = new Date(NOW.getTime() + (PLACEMENT_WINDOW_DAYS + 5) * 86_400_000);
    await calibratePlacement(OWNER, later);
    expect(preferenceRows().find((p) => p.slot_key === 'work')).toBeUndefined();
  });

  it('never pools one owner’s evidence into another’s bands', async () => {
    createOwner(SECOND_OWNER_ID);
    for (let i = 0; i < CORRECTION_FLOOR; i++) placement({ slotKey: 'work', chosenAt: at(2, 8), movedAt: at(2, 9) });
    for (let i = 0; i < CORRECTION_FLOOR; i++) {
      placement({ owner: SECOND_OWNER_ID, slotKey: 'work', chosenAt: at(2, 8), movedAt: at(2, 20) });
    }
    await calibratePlacement(OWNER, NOW);
    await calibratePlacement(SECOND_OWNER_ID, NOW);
    expect(preferenceRows(OWNER)[0].p25_hour).toBe(9);
    expect(preferenceRows(SECOND_OWNER_ID)[0].p25_hour).toBe(20);
  });

  it('is idempotent — same rows, same clock, same output, one survival row', async () => {
    for (let i = 0; i < CORRECTION_FLOOR; i++) placement({ slotKey: 'work', chosenAt: at(2, 8), movedAt: at(2, 19) });
    await calibratePlacement(OWNER, NOW);
    const first = preferenceRows();
    await calibratePlacement(OWNER, NOW);
    expect(preferenceRows()).toEqual(first);
    const survivalCount = (sqlite.prepare(`SELECT COUNT(*) AS n FROM placement_survival WHERE owner_id = ?`).get(OWNER) as { n: number }).n;
    expect(survivalCount).toBe(1);
  });

  it('survival_rate is NULL for an owner with no decided rows', async () => {
    const r = await calibratePlacement(OWNER, NOW);
    expect(r.survival.decided).toBe(0);
    expect(r.survival.survivalRate).toBeNull();
    const row = survivalRow()!;
    expect(row.decided).toBe(0);
    expect(row.survival_rate).toBeNull();
    expect(row.period_days).toBe(SURVIVAL_PERIOD_DAYS);
  });

  it('biased is 0 on the first ever run and 1 on the second', async () => {
    for (let i = 0; i < CORRECTION_FLOOR; i++) placement({ slotKey: 'work', chosenAt: at(2, 8), movedAt: at(2, 19) });
    const first = await calibratePlacement(OWNER, NOW);
    expect(first.survival.biased).toBe(0);
    expect(preferenceRows().length).toBeGreaterThan(0); // sanity: a row exists to be biased BY

    const second = await calibratePlacement(OWNER, NOW);
    expect(second.survival.biased).toBe(1);
  });

  it('never writes time_blocks or tasks', async () => {
    for (let i = 0; i < CORRECTION_FLOOR; i++) placement({ slotKey: 'work', chosenAt: at(2, 8), movedAt: at(2, 19) });
    const blocksBefore = sqlite.prepare(`SELECT * FROM time_blocks ORDER BY id`).all();
    const tasksBefore = sqlite.prepare(`SELECT * FROM tasks ORDER BY id`).all();
    await calibratePlacement(OWNER, NOW);
    expect(sqlite.prepare(`SELECT * FROM time_blocks ORDER BY id`).all()).toEqual(blocksBefore);
    expect(sqlite.prepare(`SELECT * FROM tasks ORDER BY id`).all()).toEqual(tasksBefore);
  });
});
