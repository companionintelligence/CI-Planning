import { store } from '../db/store.js';
import { MOODS, type Mood } from './task-close.js';

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

export interface MoodBreakdown {
  happy: number;
  flat: number;
  frustrated: number;
  stressed: number;
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
  mood: MoodBreakdown;
  /** Completions that carried any mood — the denominator for `mood`. */
  moodSamples: number;
  /** Median minutes between completed_at and reaction_at, over reflected tasks. */
  medianReactionLagMin: number | null;
}

export interface TaskMetrics {
  window: { days: number; since: string };
  directions: AxisMetrics[];
  categories: AxisMetrics[];
  totals: {
    open: number;
    completed: number;
    actualMinutes: number;
    mood: MoodBreakdown;
    moodSamples: number;
  };
}

const emptyMood = (): MoodBreakdown => ({ happy: 0, flat: 0, frustrated: 0, stressed: 0 });

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
  t.completion_mood AS mood,
  t.actual_minutes  AS actual_minutes,
  t.estimated_minutes AS estimated_minutes
`;

// Only real, user-facing work: top-level, non-recurrence-instance. Mirrors the auto-tag
// sweep's eligibility so the two views of "the user's tasks" agree.
const TASK_SCOPE = `
  t.owner_id = ?
  AND t.parent_id IS NULL
  AND t.recurrence_parent_id IS NULL
  AND (
    t.status NOT IN ('done', 'cancelled')
    OR (t.status = 'done' AND t.completed_at >= ?)
  )
`;

// SQL strings at module level, prepared inside taskMetrics(): a module-level
// store().prepare() would call store() at import time and throw when this module
// loads before db/index installs the backend (§5.5).
const SELECT_BY_DIRECTION = `
  SELECT g.name AS axis, ${ROW_COLS}
    FROM tasks t
    JOIN entity_tags e ON e.entity_kind = 'task' AND e.entity_id = t.id AND e.level = 1
    JOIN tags g ON g.id = e.tag_id AND g.kind = 'direction'
   WHERE ${TASK_SCOPE}
`;

const SELECT_BY_CATEGORY = `
  SELECT c.name AS axis, ${ROW_COLS}
    FROM tasks t
    JOIN entity_categories ec ON ec.entity_kind = 'task' AND ec.entity_id = t.id
    JOIN tags c ON c.id = ec.category_tag_id
   WHERE ${TASK_SCOPE}
`;

const SELECT_ALL = `
  SELECT '' AS axis, ${ROW_COLS} FROM tasks t WHERE ${TASK_SCOPE}
`;

interface Row {
  axis: string;
  status: string;
  completed_at: string | null;
  reaction_at: string | null;
  mood: string | null;
  actual_minutes: number;
  estimated_minutes: number | null;
}

/** Fold raw rows into per-axis metrics, name-sorted. */
function rollup(rows: Row[]): AxisMetrics[] {
  const acc = new Map<string, { m: AxisMetrics; ratios: number[]; lags: number[] }>();
  for (const r of rows) {
    let e = acc.get(r.axis);
    if (!e) {
      e = {
        m: {
          name: r.axis, open: 0, completed: 0, actualMinutes: 0, estimateBias: null,
          mood: emptyMood(), moodSamples: 0, medianReactionLagMin: null,
        },
        ratios: [], lags: [],
      };
      acc.set(r.axis, e);
    }
    if (r.status === 'done') {
      e.m.completed++;
      e.m.actualMinutes += r.actual_minutes || 0;
      if (r.estimated_minutes && r.estimated_minutes > 0 && r.actual_minutes > 0) {
        e.ratios.push(r.actual_minutes / r.estimated_minutes);
      }
      if (r.mood && (MOODS as readonly string[]).includes(r.mood)) {
        e.m.mood[r.mood as Mood]++;
        e.m.moodSamples++;
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
  }
  return [...acc.values()].map((e) => e.m).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Metrics for one owner over a rolling window (default 30 days).
 *
 * `days` is clamped to 1..365: the window is a user-supplied query param, and an
 * unbounded value would turn this into a full-history table scan on every page load.
 */
export async function taskMetrics(owner: string, days = 30): Promise<TaskMetrics> {
  const windowDays = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const directions = rollup(await store().prepare(SELECT_BY_DIRECTION).all<Row>(owner, since));
  const categories = rollup(await store().prepare(SELECT_BY_CATEGORY).all<Row>(owner, since));

  // Totals come from the unjoined task set, NOT from summing the axes: a task can carry
  // up to three categories (so it would be counted thrice) or none (never counted).
  const all = rollup(await store().prepare(SELECT_ALL).all<Row>(owner, since))[0];
  const totals = all
    ? { open: all.open, completed: all.completed, actualMinutes: all.actualMinutes, mood: all.mood, moodSamples: all.moodSamples }
    : { open: 0, completed: 0, actualMinutes: 0, mood: emptyMood(), moodSamples: 0 };

  return { window: { days: windowDays, since }, directions, categories, totals };
}
