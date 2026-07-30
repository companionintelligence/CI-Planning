import type { Statement } from 'better-sqlite3';
import { sqlite } from '../db/index.js';
import { MOODS, type Mood } from './task-close.js';
import { resolveDayType } from './day-types.js';
import { localDateInTZ, serverTimezone, utcDayBounds, zonedWallTimeToUTC } from '../lib/tz.js';

/**
 * Triality T2 — the balanced-ternary situation vector `s` (docs/triality-design.md §3).
 *
 * Every dimension is owner-scoped, computed from the injected `now` (never the wall
 * clock — determinism is what makes the scoring engine testable and resumable), and
 * obeys the honest-zero rule: **0 whenever the dimension's source has no data**. A
 * dimension is never guessed; an unsensed part of the boundary says so (§2b).
 *
 * `meta.active` lists the dims that were computable **in principle** for this call —
 * source present/enabled (a prefs row with work hours, the memory-pull flag on, the
 * motivation column migrated) — as opposed to merely empty (no mood in the window, no
 * blocks today), which keeps a dim active with an honest 0. T3 consumes the active set
 * for F normalization.
 *
 * Reads are raw sqlite (task-metrics.ts style): the vector sits on the deterministic
 * scoring hot path, and one synchronous pass over local rows keeps the whole builder
 * sync — no drizzle/getPrefs await for a handful of scalar columns.
 *
 * No LLM, no network, no imports from connectors/* — the memory dim stays 0 until its
 * connector wiring lands (see the TODO on its encoder).
 */

export type Ternary = -1 | 0 | 1;

/**
 * The six Balance categories — `life_priorities.category`'s fixed keys, mirrored by the
 * base `kind='category'` tags 0134 seeds (fixed vocabulary while the add/remove flag
 * ships OFF). Minute ATTRIBUTION is name-keyed through the owner's tag rows — nothing
 * here assumes stripe/hue order or tag ids.
 */
export const CAT_KEYS = ['health', 'career', 'relationships', 'growth', 'leisure', 'finance'] as const;
export type CatKey = (typeof CAT_KEYS)[number];

export type DimName =
  | 'in_work_hours'
  | 'day_energy'
  | 'free_gap'
  | 'day_type'
  | 'momentum'
  | 'memory_context'
  | 'motivation_balance'
  | `cat_deficit_${CatKey}`;

export interface SituationVector {
  dims: Record<DimName, Ternary>;
  meta: {
    /** Dims whose source was present/enabled this call (see module doc). Registry order. */
    active: DimName[];
  };
}

// ── thresholds (design §3/§3b/§6 — constants, not prefs) ─────────────────────────
const MOOD_WINDOW_MS = 3 * 3_600_000;        // day_energy recency: a reading older than 3h is stale
const GAP_COMFORT_MIN = 45;                  // free_gap ≥ 45m → room to start something
const GAP_TIGHT_MIN = 15;                    // free_gap < 15m → too tight
const COMPLETION_MOMENTUM_MS = 30 * 60_000;  // a completion this recent still carries momentum
const IDLE_MS = 3 * 3_600_000;               // no tracked activity for 3h during work hours = stalled
const RECENT_WINDOW_MS = 30 * 86_400_000;    // motivation drift + measured deficit window
const BASELINE_WINDOW_MS = 90 * 86_400_000;  // the owner's own motivation baseline
const LABELED_FLOOR_MINUTES = 60;            // below this, a motivation share is noise, not signal
const TERNARY_BAND = 0.15;                   // |x| must EXCEED the band to leave 0

/** Balanced-ternary quantizer: strictly beyond ±band or it stays an honest 0. */
function ternarize(x: number): Ternary {
  if (x > TERNARY_BAND) return 1;
  if (x < -TERNARY_BAND) return -1;
  return 0;
}

/**
 * Day-type keys are free-form slugs (0068 seeds only workday/weekend; owners add their
 * own). Only clearly work/rest keys map off 0 — an unrecognized custom type ("travel",
 * "conference") is unknown, and unknown is 0 by the honest-zero rule.
 */
const WORK_TYPED_KEYS = new Set(['workday']);
const REST_TYPED_KEYS = new Set(['weekend', 'rest', 'off', 'vacation', 'holiday']);

/**
 * Everything the encoders need, gathered in ONE owner-scoped read pass so each encoder
 * is a pure function of this context (and directly unit-testable). Adding a dim (§2b's
 * blanket-widening point) = a field here + one registry entry + its tests.
 */
export interface DimContext {
  nowMs: number;
  /** Today's workday bounds as UTC ms; null when the prefs row / hours are missing. */
  workHours: { startMs: number; endMs: number } | null;
  /** Latest close-ritual mood whose reaction_at falls within 3h of now; null = no recent reading. */
  recentMood: Mood | null;
  /** Minutes from now to the next locked/meeting block today; null = no such block (no calendar data). */
  freeGapMinutes: number | null;
  /** resolveDayType key for the owner-tz date of `now`. */
  dayTypeKey: string;
  /** A time_entries row with ended_at IS NULL exists. */
  timerRunning: boolean;
  /** Latest tasks.completed_at at/before now, as UTC ms; null = none. */
  lastCompletionMs: number | null;
  /** Latest tracked signal (completion or entry start/end) at/before now; null = never. */
  lastActivityMs: number | null;
  memoryPullEnabled: boolean;
  /**
   * Motivation drift inputs (§3b), or null when tasks.motivation doesn't exist yet
   * (T2b's migration lands separately on this branch — the guard, not an error).
   * Shares are me-minutes / labeled-minutes; NULL-motivation minutes are excluded from
   * numerator AND denominator (unlabeled work is unsensed, not shared).
   */
  motivation: {
    recentShare: number | null;
    baselineShare: number | null;
    recentLabeledMinutes: number;
    baselineLabeledMinutes: number;
  } | null;
  /**
   * Per category, the two §6 halves — each already 0 when its own source has no data
   * (no self-audit row → stated 0; no targets or an empty timed window → measured 0).
   */
  catDeficits: Record<CatKey, { stated: number; measured: number }>;
}

export interface DimEntry {
  name: DimName;
  /** Balanced-ternary encoding from the prepared context. */
  encode: (ctx: DimContext) => Ternary;
  /** Source present/enabled this call (meta.active). Omitted = structurally always-on. */
  active?: (ctx: DimContext) => boolean;
}

// ── owner-scoped reads (module-scope prepares, task-metrics.ts style) ────────────

const selectPrefs = sqlite.prepare(`
  SELECT workday_start, workday_end, timezone, memory_pull_enabled
    FROM scheduling_prefs WHERE owner_id = ?
`);

// Latest reflected mood by reaction_at — NOT completed_at: reacting later is normal, and
// the reaction is the reading's timestamp (0137). Window bounds are passed in, not now().
const selectRecentMood = sqlite.prepare(`
  SELECT completion_mood AS mood
    FROM tasks
   WHERE owner_id = ? AND completion_mood IS NOT NULL
     AND reaction_at IS NOT NULL AND reaction_at >= ? AND reaction_at <= ?
   ORDER BY reaction_at DESC
   LIMIT 1
`);

// "Fixed" = locked or a meeting; soft/auto blocks reflow around the owner and don't
// bound the gap. Today-scoped in the owner's timezone by the caller-supplied bounds.
const selectNextFixedBlock = sqlite.prepare(`
  SELECT start_at FROM time_blocks
   WHERE owner_id = ? AND (is_locked = 1 OR block_kind = 'meeting')
     AND start_at > ? AND start_at < ?
   ORDER BY start_at ASC
   LIMIT 1
`);

const selectTimerRunning = sqlite.prepare(`
  SELECT 1 AS running FROM time_entries WHERE owner_id = ? AND ended_at IS NULL LIMIT 1
`);

const selectLastCompletion = sqlite.prepare(`
  SELECT MAX(completed_at) AS last FROM tasks
   WHERE owner_id = ? AND completed_at IS NOT NULL AND completed_at <= ?
`);

// Any tracked signal counts against idleness — a timer started/finished or a task
// completed. ISO text compares lexicographically = chronologically (one format app-wide).
const selectLastActivity = sqlite.prepare(`
  SELECT MAX(t) AS last FROM (
    SELECT MAX(completed_at) AS t FROM tasks
      WHERE owner_id = ? AND completed_at IS NOT NULL AND completed_at <= ?
    UNION ALL
    SELECT MAX(started_at) FROM time_entries WHERE owner_id = ? AND started_at <= ?
    UNION ALL
    SELECT MAX(ended_at) FROM time_entries
      WHERE owner_id = ? AND ended_at IS NOT NULL AND ended_at <= ?
  )
`);

const selectPriorities = sqlite.prepare(`
  SELECT category, satisfaction, importance, target_hours_per_week AS target
    FROM life_priorities WHERE owner_id = ?
`);

// Finished entries only (a running entry has no duration yet), attributed through the
// TASK's categories. g.owner_id is re-checked even though the entry scope implies it —
// owner-scoped SQL always filters owner_id, no exceptions.
const selectCategoryEntries = sqlite.prepare(`
  SELECT g.name AS cat, e.started_at, e.ended_at
    FROM time_entries e
    JOIN entity_categories ec ON ec.entity_kind = 'task' AND ec.entity_id = e.task_id
    JOIN tags g ON g.id = ec.category_tag_id AND g.kind = 'category' AND g.is_base = 1 AND g.owner_id = ?
   WHERE e.owner_id = ? AND e.ended_at IS NOT NULL
     AND e.started_at >= ? AND e.started_at <= ?
`);

// ── tasks.motivation guard (T2b lands its migration separately on this branch) ───

// Latches only the POSITIVE result: a migrated column never disappears, so once seen it
// is never re-checked; while absent the (cheap) PRAGMA runs per call, so the dim starts
// working the moment the sibling migration applies — no process restart, no stale cache.
let motivationColumnSeen = false;
function motivationColumnExists(): boolean {
  if (!motivationColumnSeen) {
    motivationColumnSeen = (sqlite.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[])
      .some((c) => c.name === 'motivation');
  }
  return motivationColumnSeen;
}

// Prepared lazily — preparing at module scope would throw while the column is absent.
let selectMotivationEntries: Statement<unknown[]> | null = null;

const MOTIVATIONS = new Set(['me', 'us', 'them']);

/** Finished-entry minutes; a malformed pair (end before start) contributes nothing. */
function entryMinutes(startedAt: string, endedAt: string): number {
  const mins = (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000;
  return Number.isFinite(mins) && mins > 0 ? mins : 0;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ── context assembly (one pass, all sync) ────────────────────────────────────────

function buildDimContext(ownerId: string, now: Date): DimContext {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const prefs = selectPrefs.get(ownerId) as
    | { workday_start: string | null; workday_end: string | null; timezone: string | null; memory_pull_enabled: number | null }
    | undefined;
  const tz = prefs?.timezone || serverTimezone();
  const localDate = localDateInTZ(nowIso, tz);

  // Work hours are wall-clock prefs; today's concrete bounds go through the same
  // DST-correct mapping the engines use. No prefs row (or no hours) → unknown, not 9–6.
  let workHours: DimContext['workHours'] = null;
  if (prefs?.workday_start && prefs.workday_end) {
    workHours = {
      startMs: Date.parse(zonedWallTimeToUTC(localDate, prefs.workday_start, tz)),
      endMs: Date.parse(zonedWallTimeToUTC(localDate, prefs.workday_end, tz)),
    };
  }

  const moodRow = selectRecentMood.get(ownerId, new Date(nowMs - MOOD_WINDOW_MS).toISOString(), nowIso) as
    | { mood: string }
    | undefined;
  const recentMood = moodRow && (MOODS as readonly string[]).includes(moodRow.mood) ? (moodRow.mood as Mood) : null;

  const dayEnd = utcDayBounds(localDate, tz).end;
  const nextFixed = selectNextFixedBlock.get(ownerId, nowIso, dayEnd) as { start_at: string } | undefined;
  const freeGapMinutes = nextFixed ? (Date.parse(nextFixed.start_at) - nowMs) / 60_000 : null;

  const timerRunning = !!selectTimerRunning.get(ownerId);
  const lastCompletion = (selectLastCompletion.get(ownerId, nowIso) as { last: string | null }).last;
  const lastActivity = (selectLastActivity.get(ownerId, nowIso, ownerId, nowIso, ownerId, nowIso) as { last: string | null }).last;

  // ── motivation drift (§3b) — only once T2b's column exists ──
  let motivation: DimContext['motivation'] = null;
  if (motivationColumnExists()) {
    if (!selectMotivationEntries) {
      selectMotivationEntries = sqlite.prepare(`
        SELECT e.started_at, e.ended_at, t.motivation AS motivation
          FROM time_entries e
          JOIN tasks t ON t.id = e.task_id AND t.owner_id = e.owner_id
         WHERE e.owner_id = ? AND e.ended_at IS NOT NULL
           AND e.started_at >= ? AND e.started_at <= ?
      `);
    }
    const rows = selectMotivationEntries.all(
      ownerId,
      new Date(nowMs - BASELINE_WINDOW_MS).toISOString(),
      nowIso,
    ) as { started_at: string; ended_at: string; motivation: string | null }[];
    const recentCutMs = nowMs - RECENT_WINDOW_MS;
    let meRecent = 0, labeledRecent = 0, meBaseline = 0, labeledBaseline = 0;
    for (const r of rows) {
      // Unlabeled minutes are unsensed on this axis: excluded from numerator AND
      // denominator (NULL ≠ 'us' — 'us' is labeled and dilutes the me-share).
      if (r.motivation === null || !MOTIVATIONS.has(r.motivation)) continue;
      const mins = entryMinutes(r.started_at, r.ended_at);
      labeledBaseline += mins;
      if (r.motivation === 'me') meBaseline += mins;
      if (Date.parse(r.started_at) >= recentCutMs) {
        labeledRecent += mins;
        if (r.motivation === 'me') meRecent += mins;
      }
    }
    motivation = {
      recentShare: labeledRecent > 0 ? meRecent / labeledRecent : null,
      baselineShare: labeledBaseline > 0 ? meBaseline / labeledBaseline : null,
      recentLabeledMinutes: labeledRecent,
      baselineLabeledMinutes: labeledBaseline,
    };
  }

  // ── Balance deficits (§6): stated from the self-audit, measured from timed minutes ──
  const prioRows = selectPriorities.all(ownerId) as
    { category: string; satisfaction: number; importance: number; target: number }[];
  const prioByCat = new Map(prioRows.filter((r) => (CAT_KEYS as readonly string[]).includes(r.category)).map((r) => [r.category as CatKey, r]));
  const totalTarget = [...prioByCat.values()].reduce((s, r) => s + Math.max(0, r.target), 0);

  const catRows = selectCategoryEntries.all(
    ownerId,
    ownerId,
    new Date(nowMs - RECENT_WINDOW_MS).toISOString(),
    nowIso,
  ) as { cat: string; started_at: string; ended_at: string }[];
  const minutesByCat = new Map<CatKey, number>();
  let totalMinutes = 0;
  for (const r of catRows) {
    if (!(CAT_KEYS as readonly string[]).includes(r.cat)) continue;
    const mins = entryMinutes(r.started_at, r.ended_at);
    minutesByCat.set(r.cat as CatKey, (minutesByCat.get(r.cat as CatKey) ?? 0) + mins);
    totalMinutes += mins; // shares are normalized over category-attributed minutes, so they sum to 1
  }

  const catDeficits = {} as DimContext['catDeficits'];
  for (const cat of CAT_KEYS) {
    const p = prioByCat.get(cat);
    // Half missing → that half is 0 and its pull disappears (§6/§10): no self-audit row
    // → stated 0; no stated targets at all or an empty timed window → measured 0.
    const stated = p ? clamp(p.importance - p.satisfaction, -9, 9) / 9 : 0;
    const measured =
      totalTarget > 0 && totalMinutes > 0
        ? Math.max(0, prioByCat.get(cat)?.target ?? 0) / totalTarget - (minutesByCat.get(cat) ?? 0) / totalMinutes
        : 0;
    catDeficits[cat] = { stated, measured };
  }

  return {
    nowMs,
    workHours,
    recentMood,
    freeGapMinutes,
    dayTypeKey: resolveDayType(ownerId, localDate),
    timerRunning,
    lastCompletionMs: lastCompletion ? Date.parse(lastCompletion) : null,
    lastActivityMs: lastActivity ? Date.parse(lastActivity) : null,
    memoryPullEnabled: !!prefs?.memory_pull_enabled,
    motivation,
    catDeficits,
  };
}

// ── the dim registry (design §2b: THE blanket-widening point) ─────────────────────
// One entry per dimension, encodings exactly per the §3 table. When learning plateaus,
// the pinned v2 response is a new entry here — never a hotter learning rate.

const inWorkHours = (ctx: DimContext): boolean =>
  ctx.workHours !== null && ctx.workHours.startMs <= ctx.nowMs && ctx.nowMs < ctx.workHours.endMs;

export const DIM_REGISTRY: readonly DimEntry[] = [
  {
    // §3: inside → +1, outside → −1; there is no data-bearing 0 — the 0 is "hours unknown".
    name: 'in_work_hours',
    encode: (ctx) => (ctx.workHours === null ? 0 : inWorkHours(ctx) ? 1 : -1),
    active: (ctx) => ctx.workHours !== null,
  },
  {
    // §3: happy → +1, flat → 0, frustrated/stressed → −1, no reading within 3h → 0.
    name: 'day_energy',
    encode: (ctx) => {
      if (ctx.recentMood === null) return 0;
      if (ctx.recentMood === 'happy') return 1;
      if (ctx.recentMood === 'flat') return 0;
      return -1; // frustrated | stressed
    },
  },
  {
    // §3: ≥45m → +1, 15–45m → 0, <15m → −1, no fixed block today (no calendar data) → 0.
    name: 'free_gap',
    encode: (ctx) => {
      if (ctx.freeGapMinutes === null) return 0;
      if (ctx.freeGapMinutes >= GAP_COMFORT_MIN) return 1;
      if (ctx.freeGapMinutes >= GAP_TIGHT_MIN) return 0;
      return -1;
    },
  },
  {
    // §3: work-typed → +1, rest-typed → −1, unknown/custom key → 0 (map honestly).
    name: 'day_type',
    encode: (ctx) => {
      if (WORK_TYPED_KEYS.has(ctx.dayTypeKey)) return 1;
      if (REST_TYPED_KEYS.has(ctx.dayTypeKey)) return -1;
      return 0;
    },
  },
  {
    // §3: running timer or a ≤30m-old completion → +1; >3h without any tracked signal
    // DURING work hours → −1 (an owner with no tracked history is unsensed → 0, and
    // outside work hours idleness is not a signal).
    name: 'momentum',
    encode: (ctx) => {
      if (ctx.timerRunning) return 1;
      if (ctx.lastCompletionMs !== null && ctx.nowMs - ctx.lastCompletionMs <= COMPLETION_MOMENTUM_MS && ctx.nowMs >= ctx.lastCompletionMs) return 1;
      if (inWorkHours(ctx) && ctx.lastActivityMs !== null && ctx.nowMs - ctx.lastActivityMs > IDLE_MS) return -1;
      return 0;
    },
  },
  {
    // §3: only meaningful when memory_pull_enabled. v1 encodes 0 in BOTH states —
    // TODO(triality): when the memory wiring ships, probe the Phase AA connector
    // (connectors/memory.ts graphData(owner, { from: now, to: now+48h })) for a related
    // upcoming event → +1. Flag off must never touch the connector, so this module
    // deliberately does not import it.
    name: 'memory_context',
    encode: () => 0,
    active: (ctx) => ctx.memoryPullEnabled,
  },
  {
    // §3b, homeostatic against the owner's own norm: recent window drifted them-ward
    // vs baseline → +1 (pull toward me); me-ward → −1 (pull toward them); in-band or a
    // labeled-minutes floor miss → 0. Column not migrated yet → 0 and inactive (guard).
    name: 'motivation_balance',
    encode: (ctx) => {
      const m = ctx.motivation;
      if (m === null) return 0; // tasks.motivation absent — T2b not landed yet
      if (m.recentLabeledMinutes < LABELED_FLOOR_MINUTES || m.baselineLabeledMinutes < LABELED_FLOOR_MINUTES) return 0;
      if (m.recentShare === null || m.baselineShare === null) return 0; // defensive: floor implies non-null
      if (m.recentShare < m.baselineShare - TERNARY_BAND) return 1;
      if (m.recentShare > m.baselineShare + TERNARY_BAND) return -1;
      return 0;
    },
    active: (ctx) => ctx.motivation !== null,
  },
  // §6: deficit_c = ternarize(0.5·stated + 0.5·measured); under-served → +1,
  // over-served → −1. Each half is already honest-zeroed in the context.
  ...CAT_KEYS.map(
    (cat): DimEntry => ({
      name: `cat_deficit_${cat}`,
      encode: (ctx) => ternarize(0.5 * ctx.catDeficits[cat].stated + 0.5 * ctx.catDeficits[cat].measured),
    }),
  ),
];

/**
 * Build the owner's situation vector at `now` (the only time input — callers inject it).
 * Deterministic: same DB state + same `now` ⇒ the same vector, bit for bit.
 */
export function buildSituationVector(ownerId: string, now: Date): SituationVector {
  const ctx = buildDimContext(ownerId, now);
  const dims = {} as Record<DimName, Ternary>;
  const active: DimName[] = [];
  for (const dim of DIM_REGISTRY) {
    dims[dim.name] = dim.encode(ctx); // the registry covers every DimName by construction
    if (!dim.active || dim.active(ctx)) active.push(dim.name);
  }
  return { dims, meta: { active } };
}
