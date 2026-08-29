import { store } from '../db/store.js';
import { DECLINED_SCORE, isRating } from './task-close.js';

/**
 * Task metrics across the two axes the Balance view cares about (owner request
 * 2026-07-28): DIRECTION (Work / Home / Community — `entity_tags` level 1) and CATEGORY
 * (the six life priorities — `entity_categories`, the Phase B picker).
 *
 * Server-side because the numbers need DONE tasks, and the client's `tasks()` store only
 * holds the active set — the completed rows live in the archive and are fetched on
 * demand. A client-side join would either be wrong or would require pulling the whole
 * history into the browser.
 *
 * Everything is scoped to a rolling window on `completed_at` for completions, while open
 * counts are current-state (an open task has no date to window on). That asymmetry is
 * intentional and is spelled out in the payload so the UI can label it honestly.
 */

/**
 * How the completions felt, as the ordered 1-5 scale the three-face picker produces
 * (0161). `counts` is indexed 1-5; `declined` counts the DECLINED sentinel separately
 * because a dismissal is not a rating — folding it in as a 3 would drag `mean` toward
 * neutral with data nobody entered.
 */
export interface ScoreDistribution {
  counts: Record<1 | 2 | 3 | 4 | 5, number>;
  /** Mean of the real ratings, 1 decimal place. null below 1 sample. */
  mean: number | null;
  /** Completions that carried a real 1-5 rating — the denominator for `counts`/`mean`. */
  samples: number;
  /** Completions where the sheet was shown and explicitly skipped. */
  declined: number;
}

export interface AxisMetrics {
  /** Tag/category name — the axis value. */
  name: string;
  /** Currently open (not done/cancelled) top-level tasks carrying this axis value. */
  open: number;
  /** Completed inside the window. */
  completed: number;
  /** Minutes actually tracked on those completions (0 when nothing was timed). */
  actualMinutes: number;
  /** Median actual/estimated over completions that carry both — null below 3 samples. */
  estimateBias: number | null;
  /** How the completions felt. Only tasks closed with the ritual appear here. */
  score: ScoreDistribution;
  /** Median minutes between completed_at and reaction_at, over reflected tasks. */
  medianReactionLagMin: number | null;
}

export interface MetricsGroup {
  directions: AxisMetrics[];
  categories: AxisMetrics[];
  totals: {
    open: number;
    completed: number;
    actualMinutes: number;
    score: ScoreDistribution;
  };
}

export interface TaskMetrics extends MetricsGroup {
  window: { days: number; since: string };
  /**
   * Habits, rolled up identically but over a DISJOINT population (owner request
   * 2026-08-29): habit ratings belong on the Metrics tab, but not blended into task
   * counts. The split is `subtype = 'habit'`, matching the Tasks / Habits tabs in
   * AllTasks — so what the two screens each call "a habit" is the same set.
   *
   * The task-side numbers above are therefore unchanged by 0161: a habit was never in
   * them (habit occurrences carry `recurrence_parent_id`, which TASK_SCOPE excludes) and
   * still isn't.
   */
  habits: MetricsGroup;
}

const emptyScore = (): ScoreDistribution => ({
  counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  mean: null,
  samples: 0,
  declined: 0,
});

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * One row per (axis value, task) for the tasks in scope. Direction rows come from
 * entity_tags level 1 joined to direction-kind tags; category rows from
 * entity_categories. Both are LEFT-ish in spirit — a task with no axis value simply
 * contributes to no row, which is why `totals` is computed separately rather than by
 * summing the axes (a task can carry 0 or 3 categories, so the axes do not partition).
 */
const ROW_COLS = `
  t.id            AS task_id,
  t.status        AS status,
  t.completed_at  AS completed_at,
  t.reaction_at   AS reaction_at,
  t.completion_score AS score,
  t.actual_minutes  AS actual_minutes,
  t.estimated_minutes AS estimated_minutes
`;

// The rolling-window clause both populations share. Open counts are current-state (an
// open task has no date to window on); completions are windowed on completed_at.
const WINDOW = `
  t.owner_id = ?
  AND (
    t.status NOT IN ('done', 'cancelled')
    OR (t.status = 'done' AND t.completed_at >= ?)
  )
`;

// Only real, user-facing work: top-level, non-recurrence-instance. Mirrors the auto-tag
// sweep's eligibility so the two views of "the user's tasks" agree.
//
// `subtype != 'habit'` (0161) excludes the habit TEMPLATE, which this scope used to sweep
// up: a template is top-level with no recurrence_parent_id, and its permanent 'recurring'
// status made it count as a forever-open task. Its occurrences were never here (they
// carry recurrence_parent_id), so removing the template is the whole of the change and it
// only ever reduces `open`.
const TASK_SCOPE = `
  ${WINDOW}
  AND t.parent_id IS NULL
  AND t.recurrence_parent_id IS NULL
  AND t.subtype != 'habit'
`;

// Habits: the disjoint counterpart. The OCCURRENCES are what get completed and rated, so
// they — not the template — are the population. Deliberately no `parent_id IS NULL` /
// `recurrence_parent_id IS NULL` filter: every occurrence has a parent by construction,
// and filtering them out is exactly the bug that made a rated habit show 0 samples.
const HABIT_SCOPE = `
  ${WINDOW}
  AND t.subtype = 'habit'
  AND t.recurrence_parent_id IS NOT NULL
`;

// SQL strings at module level, prepared inside taskMetrics(): a module-level
// store().prepare() would call store() at import time and throw when this module
// loads before db/index installs the backend (§5.5).
const selectByDirection = (scope: string) => `
  SELECT g.name AS axis, ${ROW_COLS}
    FROM tasks t
    JOIN entity_tags e ON e.entity_kind = 'task' AND e.entity_id = t.id AND e.level = 1
    JOIN tags g ON g.id = e.tag_id AND g.kind = 'direction'
   WHERE ${scope}
`;

const selectByCategory = (scope: string) => `
  SELECT c.name AS axis, ${ROW_COLS}
    FROM tasks t
    JOIN entity_categories ec ON ec.entity_kind = 'task' AND ec.entity_id = t.id
    JOIN tags c ON c.id = ec.category_tag_id
   WHERE ${scope}
`;

const selectAll = (scope: string) => `
  SELECT '' AS axis, ${ROW_COLS} FROM tasks t WHERE ${scope}
`;

interface Row {
  axis: string;
  status: string;
  completed_at: string | null;
  reaction_at: string | null;
  score: number | null;
  actual_minutes: number;
  estimated_minutes: number | null;
}

/** Fold raw rows into per-axis metrics, name-sorted. */
function rollup(rows: Row[]): AxisMetrics[] {
  const acc = new Map<string, { m: AxisMetrics; ratios: number[]; lags: number[]; scores: number[] }>();
  for (const r of rows) {
    let e = acc.get(r.axis);
    if (!e) {
      e = {
        m: {
          name: r.axis, open: 0, completed: 0, actualMinutes: 0, estimateBias: null,
          score: emptyScore(), medianReactionLagMin: null,
        },
        ratios: [], lags: [], scores: [],
      };
      acc.set(r.axis, e);
    }
    if (r.status === 'done') {
      e.m.completed++;
      e.m.actualMinutes += r.actual_minutes || 0;
      if (r.estimated_minutes && r.estimated_minutes > 0 && r.actual_minutes > 0) {
        e.ratios.push(r.actual_minutes / r.estimated_minutes);
      }
      // A real 1-5 rating feeds the distribution; DECLINED is tallied on its own. Any
      // other value (out-of-range junk from a pre-0161 row or a bad write) is dropped
      // rather than bucketed, so a corrupt number cannot invent a rating.
      if (isRating(r.score)) {
        e.m.score.counts[r.score as 1 | 2 | 3 | 4 | 5]++;
        e.m.score.samples++;
        e.scores.push(r.score);
      } else if (r.score === DECLINED_SCORE) {
        e.m.score.declined++;
      }
      // Reaction lag: how long after finishing the reflection was written. Negative
      // values are impossible by construction (closeTask stamps reaction_at at or after
      // completed_at) but are dropped defensively rather than skewing a median.
      if (r.reaction_at && r.completed_at) {
        const lag = (Date.parse(r.reaction_at) - Date.parse(r.completed_at)) / 60000;
        if (Number.isFinite(lag) && lag >= 0) e.lags.push(lag);
      }
    } else {
      e.m.open++;
    }
  }
  for (const e of acc.values()) {
    // 3-sample floor: a single long task should not be presented as "your bias".
    e.m.estimateBias = e.ratios.length >= 3 ? Math.round((median(e.ratios) ?? 0) * 100) / 100 : null;
    const lag = median(e.lags);
    e.m.medianReactionLagMin = lag === null ? null : Math.round(lag);
    // No sample floor on the mean, unlike estimateBias: one rating IS one honest reading
    // of one task, where one duration ratio is not yet a personal bias.
    e.m.score.mean = e.scores.length
      ? Math.round((e.scores.reduce((a, b) => a + b, 0) / e.scores.length) * 10) / 10
      : null;
  }
  return [...acc.values()].map((e) => e.m).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Metrics for one owner over a rolling window (default 30 days).
 *
 * `days` is clamped to 1..365: the window is a user-supplied query param, and an
 * unbounded value would turn this into a full-history table scan on every page load.
 */
async function group(owner: string, since: string, scope: string): Promise<MetricsGroup> {
  const directions = rollup(await store().prepare(selectByDirection(scope)).all<Row>(owner, since));
  const categories = rollup(await store().prepare(selectByCategory(scope)).all<Row>(owner, since));

  // Totals come from the unjoined task set, NOT from summing the axes: a task can carry
  // up to three categories (so it would be counted thrice) or none (never counted).
  const all = rollup(await store().prepare(selectAll(scope)).all<Row>(owner, since))[0];
  const totals = all
    ? { open: all.open, completed: all.completed, actualMinutes: all.actualMinutes, score: all.score }
    : { open: 0, completed: 0, actualMinutes: 0, score: emptyScore() };

  return { directions, categories, totals };
}

export async function taskMetrics(owner: string, days = 30): Promise<TaskMetrics> {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // Two disjoint populations, same rollup. Run concurrently — they share no state.
  const [tasksGroup, habitsGroup] = await Promise.all([
    group(owner, since, TASK_SCOPE),
    group(owner, since, HABIT_SCOPE),
  ]);

  return { window: { days: windowDays, since }, ...tasksGroup, habits: habitsGroup };
}
