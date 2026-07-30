import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';
import {
  buildSituationVector, DIM_REGISTRY, CAT_KEYS,
  type DimContext, type DimName,
} from '../src/services/triality-vector.js';

/**
 * Triality T2 — situation vector (design §3). One test per table row per state; the
 * no-data → 0 case is mandatory per dim (the honest-zero contract). No wall clock:
 * every timestamp is computed relative to a fixed `now`, so nothing here rots.
 */

const OWNER = SYSTEM_OWNER;

// Wednesday 12:00Z — a heuristic workday, inside the 09:00–18:00 UTC work hours that
// resetDb pins on the system owner's prefs (timezone forced to UTC there too).
const NOW = new Date('2026-03-04T12:00:00.000Z');
const NOW_DATE = '2026-03-04';
const SATURDAY = new Date('2026-03-07T12:00:00.000Z'); // heuristic weekend
const EVENING = new Date('2026-03-04T20:00:00.000Z');  // same Wednesday, outside work hours

const MIN = 60_000;
const DAY_MIN = 1440;

/** ISO instant `minutes` from `base` (default NOW). Negative = the past. */
const iso = (minutes: number, base: Date = NOW): string => new Date(base.getTime() + minutes * MIN).toISOString();

// ── fixtures ──────────────────────────────────────────────────────────────────────

function insertTask(o: { status?: string; completedAt?: string | null; mood?: string | null; reactionAt?: string | null } = {}): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, completed_at, completion_mood, reaction_at)
         VALUES (uuid7(), 'fixture', ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(OWNER, o.status ?? 'open', o.completedAt ?? null, o.mood ?? null, o.reactionAt ?? null) as { id: string }
  ).id;
}

function insertEntry(taskId: string, startedAt: string, endedAt: string | null): void {
  sqlite
    .prepare(`INSERT INTO time_entries (id, task_id, owner_id, started_at, ended_at) VALUES (uuid7(), ?, ?, ?, ?)`)
    .run(taskId, OWNER, startedAt, endedAt);
}

function insertBlock(startAt: string, endAt: string, o: { locked?: boolean; kind?: string } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_locked)
       VALUES (uuid7(), ?, 'fixture', ?, ?, ?, ?)`,
    )
    .run(OWNER, o.kind ?? 'task', startAt, endAt, o.locked ? 1 : 0);
}

/** resetDb wipes tags, so each test seeds the base categories it needs (0134 shape). */
function seedCategory(name: string): string {
  return (
    sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'category', 1) RETURNING id`)
      .get(OWNER, name) as { id: string }
  ).id;
}

function categorize(taskId: string, categoryTagId: string): void {
  sqlite
    .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, 0)`)
    .run(taskId, categoryTagId);
}

function setPriority(category: string, importance: number, satisfaction: number, targetHours: number): void {
  sqlite
    .prepare(
      `INSERT INTO life_priorities (id, owner_id, category, importance, satisfaction, target_hours_per_week)
       VALUES (uuid7(), ?, ?, ?, ?, ?)`,
    )
    .run(OWNER, category, importance, satisfaction, targetHours);
}

function assignDay(date: string, key: string): void {
  sqlite.prepare(`INSERT INTO day_assignments (owner_id, date, day_type_key) VALUES (?, ?, ?)`).run(OWNER, date, key);
}

const hasMotivationColumn = (): boolean =>
  (sqlite.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).some((c) => c.name === 'motivation');

/** Simulate T2b having landed: its 0141 column is a plain additive nullable TEXT. */
function ensureMotivationColumn(): void {
  if (!hasMotivationColumn()) sqlite.exec(`ALTER TABLE tasks ADD COLUMN motivation TEXT`);
}

/** A finished, motivation-labeled timed entry: `startMin` relative to NOW, `durMin` long. */
function timedTask(motivation: string | null, startMin: number, durMin: number): void {
  const id = insertTask({ status: 'done', completedAt: iso(startMin + durMin) });
  if (motivation !== null) sqlite.prepare(`UPDATE tasks SET motivation = ? WHERE id = ?`).run(motivation, id);
  insertEntry(id, iso(startMin), iso(startMin + durMin));
}

const dim = (name: DimName) => DIM_REGISTRY.find((d) => d.name === name)!;

/** Synthetic context for direct encoder-branch tests. */
function mkCtx(overrides: Partial<DimContext> = {}): DimContext {
  return {
    nowMs: NOW.getTime(),
    workHours: null,
    recentMood: null,
    freeGapMinutes: null,
    dayTypeKey: 'workday',
    timerRunning: false,
    lastCompletionMs: null,
    lastActivityMs: null,
    memoryPullEnabled: false,
    motivation: null,
    catDeficits: Object.fromEntries(CAT_KEYS.map((c) => [c, { stated: 0, measured: 0 }])) as DimContext['catDeficits'],
    ...overrides,
  };
}

beforeEach(() => resetDb());

// ── tasks.motivation guard ─────────────────────────────────────────────────────────
// MUST stay the first describe in this file: the service latches a POSITIVE column
// check forever, so the absence path is only reachable before any call has seen the
// column. (T2b's 0141 adds it as a plain unindexed nullable TEXT, which is what makes
// the temporary DROP below legal SQLite.)

describe('motivation_balance — tasks.motivation column guard', () => {
  it('column absent → 0, not active, and buildSituationVector does not throw', () => {
    const hadColumn = hasMotivationColumn();
    if (hadColumn) sqlite.exec(`ALTER TABLE tasks DROP COLUMN motivation`);
    try {
      const v = buildSituationVector(OWNER, NOW);
      expect(v.dims.motivation_balance).toBe(0);
      expect(v.meta.active).not.toContain('motivation_balance');
    } finally {
      // Put the sibling ticket's column back exactly as 0141 defines it — INCLUDING
      // its position. A bare ADD COLUMN appends at the last cid, which silently
      // reorders PRAGMA table_info for every later file on the shared sequential DB
      // and made the baseline characterization snapshot order-dependent (flaky).
      // DROP + re-ADD of the column BEHIND it restores 0141's true order.
      if (hadColumn && !hasMotivationColumn()) {
        sqlite.exec(`ALTER TABLE tasks DROP COLUMN motivation_source`);
        sqlite.exec(`ALTER TABLE tasks ADD COLUMN motivation TEXT`);
        sqlite.exec(`ALTER TABLE tasks ADD COLUMN motivation_source TEXT`);
      }
    }
  });

  it('encoder fallback branch: a null motivation context → 0 and inactive', () => {
    const entry = dim('motivation_balance');
    expect(entry.encode(mkCtx({ motivation: null }))).toBe(0);
    expect(entry.active!(mkCtx({ motivation: null }))).toBe(false);
  });
});

// ── §3 row 1: in_work_hours ────────────────────────────────────────────────────────

describe('in_work_hours (§3: inside → +1 · outside → −1 · hours unknown → 0)', () => {
  it('+1 inside the prefs work hours', () => {
    expect(buildSituationVector(OWNER, NOW).dims.in_work_hours).toBe(1);
  });

  it('−1 outside the prefs work hours', () => {
    expect(buildSituationVector(OWNER, EVENING).dims.in_work_hours).toBe(-1);
  });

  it('0 and inactive when the owner has no scheduling_prefs row (no data)', () => {
    const bare = (
      sqlite
        .prepare(`INSERT INTO owners (id, name, email) VALUES (uuid7(), 'Bare', 'bare-owner@test.local') RETURNING id`)
        .get() as { id: string }
    ).id;
    const v = buildSituationVector(bare, NOW);
    expect(v.dims.in_work_hours).toBe(0);
    expect(v.meta.active).not.toContain('in_work_hours');
    // No prefs row also means the memory pull flag cannot be on.
    expect(v.meta.active).not.toContain('memory_context');
  });
});

// ── §3 row 2: day_energy ───────────────────────────────────────────────────────────

describe('day_energy (§3: happy → +1 · flat/no recent reading → 0 · frustrated/stressed → −1)', () => {
  it('+1 for a happy reflection within 3h', () => {
    insertTask({ status: 'done', completedAt: iso(-60), mood: 'happy', reactionAt: iso(-60) });
    expect(buildSituationVector(OWNER, NOW).dims.day_energy).toBe(1);
  });

  it('0 for a flat reflection within 3h — and the dim stays active (honest zero ≠ unsensed)', () => {
    insertTask({ status: 'done', completedAt: iso(-60), mood: 'flat', reactionAt: iso(-60) });
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.day_energy).toBe(0);
    expect(v.meta.active).toContain('day_energy');
  });

  it('−1 for a frustrated reflection within 3h', () => {
    insertTask({ status: 'done', completedAt: iso(-45), mood: 'frustrated', reactionAt: iso(-45) });
    expect(buildSituationVector(OWNER, NOW).dims.day_energy).toBe(-1);
  });

  it('the LATEST reading wins: stressed after happy → −1', () => {
    insertTask({ status: 'done', completedAt: iso(-120), mood: 'happy', reactionAt: iso(-120) });
    insertTask({ status: 'done', completedAt: iso(-20), mood: 'stressed', reactionAt: iso(-20) });
    expect(buildSituationVector(OWNER, NOW).dims.day_energy).toBe(-1);
  });

  it('0 with no reflection at all (no data)', () => {
    expect(buildSituationVector(OWNER, NOW).dims.day_energy).toBe(0);
  });

  it('0 when the only reading is 4h old (outside the 3h recency window)', () => {
    insertTask({ status: 'done', completedAt: iso(-240), mood: 'happy', reactionAt: iso(-240) });
    expect(buildSituationVector(OWNER, NOW).dims.day_energy).toBe(0);
  });

  it('windows on reaction_at, not completed_at: an old completion reflected on 1h ago counts', () => {
    insertTask({ status: 'done', completedAt: iso(-10 * DAY_MIN), mood: 'happy', reactionAt: iso(-60) });
    expect(buildSituationVector(OWNER, NOW).dims.day_energy).toBe(1);
  });

  it('windows on reaction_at, not completed_at: a fresh completion with a 4h-old reaction is stale', () => {
    // If the encoder windowed on completed_at (−10m) this would read +1.
    insertTask({ status: 'done', completedAt: iso(-10), mood: 'happy', reactionAt: iso(-240) });
    expect(buildSituationVector(OWNER, NOW).dims.day_energy).toBe(0);
  });
});

// ── §3 row 3: free_gap ─────────────────────────────────────────────────────────────

describe('free_gap (§3: ≥45m → +1 · 15–45m → 0 · <15m → −1 · no calendar data → 0)', () => {
  it('+1 when the next locked block is 60m away', () => {
    insertBlock(iso(60), iso(120), { locked: true });
    expect(buildSituationVector(OWNER, NOW).dims.free_gap).toBe(1);
  });

  it('0 when the next fixed block is a meeting 30m away (15–45m band; kind counts, not just locks)', () => {
    insertBlock(iso(30), iso(90), { kind: 'meeting' });
    expect(buildSituationVector(OWNER, NOW).dims.free_gap).toBe(0);
  });

  it('−1 when the NEAREST locked block is 10m away (a later one does not widen the gap)', () => {
    insertBlock(iso(10), iso(40), { locked: true });
    insertBlock(iso(90), iso(150), { locked: true });
    expect(buildSituationVector(OWNER, NOW).dims.free_gap).toBe(-1);
  });

  it('0 with no fixed block today — soft blocks and tomorrow’s meetings are not calendar data for today', () => {
    expect(buildSituationVector(OWNER, NOW).dims.free_gap).toBe(0); // nothing at all
    insertBlock(iso(10), iso(40), { kind: 'task', locked: false }); // soft/auto block: reflows, doesn't bound
    insertBlock(iso(21 * 60), iso(22 * 60), { locked: true });      // tomorrow 09:00Z: outside today
    expect(buildSituationVector(OWNER, NOW).dims.free_gap).toBe(0);
  });
});

// ── §3 row 4: day_type ─────────────────────────────────────────────────────────────

describe('day_type (§3: work-typed → +1 · unset/unknown → 0 · rest-typed → −1)', () => {
  it('+1 on a heuristic workday (Wednesday, no assignment rows)', () => {
    expect(buildSituationVector(OWNER, NOW).dims.day_type).toBe(1);
  });

  it('−1 on a heuristic weekend, and for a clearly-rest custom key', () => {
    expect(buildSituationVector(OWNER, SATURDAY).dims.day_type).toBe(-1);
    assignDay(NOW_DATE, 'vacation');
    expect(buildSituationVector(OWNER, NOW).dims.day_type).toBe(-1);
  });

  it('0 for a custom key that is neither clearly work nor rest (unknown, not guessed)', () => {
    assignDay(NOW_DATE, 'conference');
    expect(buildSituationVector(OWNER, NOW).dims.day_type).toBe(0);
  });
});

// ── §3 row 5: momentum ─────────────────────────────────────────────────────────────

describe('momentum (§3: running timer / ≤30m completion → +1 · no signal → 0 · idle >3h in work hours → −1)', () => {
  it('+1 with a running timer (ended_at IS NULL)', () => {
    insertEntry(insertTask(), iso(-50), null);
    expect(buildSituationVector(OWNER, NOW).dims.momentum).toBe(1);
  });

  it('+1 with a completion 10m ago', () => {
    insertTask({ status: 'done', completedAt: iso(-10) });
    expect(buildSituationVector(OWNER, NOW).dims.momentum).toBe(1);
  });

  it('−1 when the last tracked signal is 5h old during work hours', () => {
    insertTask({ status: 'done', completedAt: iso(-300) });
    expect(buildSituationVector(OWNER, NOW).dims.momentum).toBe(-1);
  });

  it('0 with no tracked history at all — an unsensed owner is not "idle" (no data)', () => {
    expect(buildSituationVector(OWNER, NOW).dims.momentum).toBe(0);
  });

  it('0 with a 5h-old signal OUTSIDE work hours (idleness only reads during the workday)', () => {
    insertTask({ status: 'done', completedAt: iso(-300, EVENING) });
    expect(buildSituationVector(OWNER, EVENING).dims.momentum).toBe(0);
  });

  it('0 for a completion between the 30m momentum window and the 3h idle horizon', () => {
    insertTask({ status: 'done', completedAt: iso(-60) });
    expect(buildSituationVector(OWNER, NOW).dims.momentum).toBe(0);
  });
});

// ── §3 row 6: memory_context ───────────────────────────────────────────────────────

describe('memory_context (§3: only when memory_pull_enabled; off/nothing related → 0)', () => {
  // The service module has no import of connectors/memory.ts, so with the flag off the
  // connector is statically unreachable — no mock needed for "must not be hit".
  it('flag off (the resetDb default) → 0 and inactive, without touching the connector', () => {
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.memory_context).toBe(0);
    expect(v.meta.active).not.toContain('memory_context');
  });

  it('flag ON → still 0, and STILL INACTIVE: an unsensed dim never claims to be sensed', () => {
    // This assertion was inverted until v2.1. `active` means "computable in
    // principle this call", and the encoder consults no source in either flag
    // state — so reporting active-when-enabled made this the one dim where
    // meta.active lied. It is load-bearing rather than cosmetic: v2's confidence
    // score divides non-zero dims by ACTIVE dims, so an inert-but-active dim
    // would understate coverage permanently and invisibly (it always reads 0).
    // When the v2.4 connector probe lands, `active` and `encode` must regain
    // their memory_pull_enabled behavior in the SAME commit.
    sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.memory_context).toBe(0);
    expect(v.meta.active).not.toContain('memory_context');
  });

  it('no dim reports active while encoding a constant — meta.active is literally true', () => {
    // A guard against the general shape of the bug, not just this instance: every
    // dim the vector calls active must have a source it actually reads.
    sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    const v = buildSituationVector(OWNER, NOW);
    for (const name of v.meta.active) {
      const entry = DIM_REGISTRY.find((d) => d.name === name)!;
      expect(entry.encode.length, `${name} is active but its encoder ignores its context`).toBeGreaterThan(0);
    }
  });
});

// ── §3b: motivation_balance drift ──────────────────────────────────────────────────

describe('motivation_balance (§3b: them-drift → +1 · in-band/floor → 0 · me-drift → −1)', () => {
  beforeAll(() => ensureMotivationColumn());

  it('+1 when the 30d window is far more them-directed than the 90d baseline', () => {
    timedTask('them', -10 * DAY_MIN, 120); // recent share 0
    timedTask('me', -60 * DAY_MIN, 300);   // baseline share 300/420 ≈ 0.71
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.motivation_balance).toBe(1);
    expect(v.meta.active).toContain('motivation_balance');
  });

  it('−1 when the 30d window is far more me-directed than the 90d baseline', () => {
    timedTask('me', -10 * DAY_MIN, 120);    // recent share 1
    timedTask('them', -60 * DAY_MIN, 300);  // baseline share 120/420 ≈ 0.29
    expect(buildSituationVector(OWNER, NOW).dims.motivation_balance).toBe(-1);
  });

  it('0 when the recent share sits within ±0.15 of the baseline', () => {
    timedTask('me', -10 * DAY_MIN, 60);
    timedTask('them', -10 * DAY_MIN, 60);   // recent share 0.5
    timedTask('me', -60 * DAY_MIN, 150);
    timedTask('them', -60 * DAY_MIN, 150);  // baseline share 0.5
    expect(buildSituationVector(OWNER, NOW).dims.motivation_balance).toBe(0);
  });

  it('0 below the 60-labeled-minute floor, however extreme the drift (no data)', () => {
    timedTask('them', -10 * DAY_MIN, 30);  // only 30 labeled recent minutes
    timedTask('me', -60 * DAY_MIN, 300);
    expect(buildSituationVector(OWNER, NOW).dims.motivation_balance).toBe(0);
  });

  it('excludes NULL-motivation minutes from numerator AND denominator', () => {
    // Recent labeled: me 90 / them 30 → share 0.75; baseline (350+90)/(400+120) ≈ 0.85 → in band → 0.
    // If the 500 unlabeled minutes entered the recent denominator the share would crash
    // to ≈0.15 and this would read +1.
    timedTask('me', -10 * DAY_MIN, 90);
    timedTask('them', -9 * DAY_MIN, 30);
    timedTask(null, -8 * DAY_MIN, 500);
    timedTask('me', -60 * DAY_MIN, 350);
    timedTask('them', -59 * DAY_MIN, 50);
    expect(buildSituationVector(OWNER, NOW).dims.motivation_balance).toBe(0);
  });

  it("counts 'us' minutes in the denominator (labeled, neutral — unlike NULL)", () => {
    // Recent me 30 / us 90 → share 0.25; baseline 240/420 ≈ 0.57 → drifted them-ward → +1.
    // If 'us' were excluded like NULL the recent share would be 1.0 and this would read −1.
    timedTask('me', -10 * DAY_MIN, 30);
    timedTask('us', -9 * DAY_MIN, 90);
    timedTask('me', -60 * DAY_MIN, 210);
    timedTask('us', -59 * DAY_MIN, 90);
    expect(buildSituationVector(OWNER, NOW).dims.motivation_balance).toBe(1);
  });
});

// ── §3 row 7 / §6: cat_deficit[c] ──────────────────────────────────────────────────

describe('cat_deficit (§6: under-served → +1 · on-target/no self-audit → 0 · over-served → −1)', () => {
  it('+1 from the stated half alone (importance ≫ satisfaction), other categories honest 0', () => {
    setPriority('health', 10, 1, 0); // stated 1 → blend 0.5
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.cat_deficit_health).toBe(1);
    expect(v.dims.cat_deficit_career).toBe(0); // no self-audit row → no pull
    expect(v.dims.cat_deficit_leisure).toBe(0);
  });

  it('−1 from the stated half alone (satisfaction ≫ importance)', () => {
    setPriority('health', 1, 10, 0);
    expect(buildSituationVector(OWNER, NOW).dims.cat_deficit_health).toBe(-1);
  });

  it('0 when stated is on-target and the timed window is empty (targets alone exert no measured pull)', () => {
    setPriority('health', 5, 5, 10);
    expect(buildSituationVector(OWNER, NOW).dims.cat_deficit_health).toBe(0);
  });

  it('no self-audit at all → all six 0, even with timed minutes on record', () => {
    const health = seedCategory('health');
    const t = insertTask();
    categorize(t, health);
    insertEntry(t, iso(-DAY_MIN), iso(-DAY_MIN + 120)); // 120 timed minutes, no targets to compare against
    const v = buildSituationVector(OWNER, NOW);
    for (const cat of CAT_KEYS) expect(v.dims[`cat_deficit_${cat}`]).toBe(0);
  });

  it('measured half: equal targets, minutes all on career → health under-served, career over-served', () => {
    setPriority('health', 5, 5, 10); // stated 0
    setPriority('career', 5, 5, 10); // stated 0; target shares 0.5 / 0.5
    seedCategory('health');
    const career = seedCategory('career');
    const t = insertTask();
    categorize(t, career);
    insertEntry(t, iso(-DAY_MIN), iso(-DAY_MIN + 120)); // timed shares: health 0, career 1
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.cat_deficit_health).toBe(1);  // 0.5·(0.5 − 0) = +0.25
    expect(v.dims.cat_deficit_career).toBe(-1); // 0.5·(0.5 − 1) = −0.25
    expect(v.dims.cat_deficit_growth).toBe(0);  // no row, no minutes
  });

  it('clamps stated to ±9 before normalizing (defensive against out-of-range raw rows)', () => {
    // The service layer clamps 1–10, but a raw row must not blow past ±1 stated.
    setPriority('health', 25, 1, 0);  // diff 24 → clamp 9 → stated 1 → +1
    setPriority('finance', 1, 25, 0); // diff −24 → clamp −9 → stated −1 → −1
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.cat_deficit_health).toBe(1);
    expect(v.dims.cat_deficit_finance).toBe(-1);
  });

  it('ternarizes at ±0.15: an importance−satisfaction gap of 2 stays 0, a gap of 3 fires', () => {
    setPriority('health', 7, 5, 0); // blend 0.5·(2/9) ≈ 0.11 → inside the band
    setPriority('career', 8, 5, 0); // blend 0.5·(3/9) ≈ 0.17 → beyond the band
    const v = buildSituationVector(OWNER, NOW);
    expect(v.dims.cat_deficit_health).toBe(0);
    expect(v.dims.cat_deficit_career).toBe(1);
  });
});

// ── shape + determinism ────────────────────────────────────────────────────────────

describe('vector shape and determinism', () => {
  beforeAll(() => ensureMotivationColumn());

  const EXPECTED: DimName[] = [
    'in_work_hours', 'day_energy', 'free_gap', 'day_type', 'momentum',
    'memory_context', 'motivation_balance',
    ...CAT_KEYS.map((c) => `cat_deficit_${c}` as DimName),
  ];

  it('always returns every registry dim with a balanced-ternary value; active ⊆ dims', () => {
    expect(DIM_REGISTRY.map((d) => d.name).sort()).toEqual([...EXPECTED].sort());
    const v = buildSituationVector(OWNER, NOW);
    expect(Object.keys(v.dims).sort()).toEqual([...EXPECTED].sort());
    for (const value of Object.values(v.dims)) expect([-1, 0, 1]).toContain(value);
    for (const name of v.meta.active) expect(EXPECTED).toContain(name);
  });

  it('same DB + same now → deep-equal vectors (no wall clock, no randomness)', () => {
    // A busy fixture touching every source.
    insertTask({ status: 'done', completedAt: iso(-60), mood: 'happy', reactionAt: iso(-55) });
    insertBlock(iso(20), iso(80), { locked: true });
    insertEntry(insertTask(), iso(-40), null); // running timer
    setPriority('health', 9, 3, 10);
    setPriority('career', 5, 5, 10);
    const health = seedCategory('health');
    const t = insertTask();
    categorize(t, health);
    insertEntry(t, iso(-2 * DAY_MIN), iso(-2 * DAY_MIN + 90));
    timedTask('me', -10 * DAY_MIN, 120);
    timedTask('them', -60 * DAY_MIN, 300);

    const first = buildSituationVector(OWNER, NOW);
    const second = buildSituationVector(OWNER, NOW);
    expect(second).toEqual(first);
    // Spot-check the fixture actually energized the vector (guards against a
    // trivially-all-zero determinism pass).
    expect(first.dims.momentum).toBe(1);
    expect(first.dims.free_gap).toBe(0);
    expect(first.meta.active).toContain('motivation_balance');
  });
});
