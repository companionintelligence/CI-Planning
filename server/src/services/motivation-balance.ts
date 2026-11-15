import { store } from '../db/store.js';
import { weekBoundsFor } from './balance-budget.js';
import { entryMinutes } from './triality-vector.js';

/**
 * services/motivation-balance.ts — the weekly recap's me / us / them block (0176 flag).
 *
 * For one ISO week, how the owner's TIMED minutes split between work for themselves (`me`),
 * for the people they do it with (`us`) and for others (`them`), per Balance category. It
 * answers a different question from the balance-targets wave: those compare a category's
 * scheduled hours to its target, this says who the hours in a category were for.
 *
 * Basis: finished `time_entries` whose `started_at` falls in the week (the same filter and the
 * same category join as `SQL_CATEGORY_ENTRIES` and `timedMinutesByDimension`, so a number here
 * agrees with the Balance numbers for the same week), labeled by the entry's task's CURRENT
 * `tasks.motivation`. Not scheduled blocks: the recap looks back at what happened.
 *
 * Rules a reader must know:
 *  - A task carries several categories, and its minutes count in EACH of them, exactly as the
 *    existing per-category numbers do. So category rows do not add up to the week; `overall` is
 *    computed once per entry (and includes entries with no category), and is the number to quote
 *    for the week as a whole.
 *  - `unlabeled` is time on tasks with no motivation. It is shown, never folded into `us`: NULL is
 *    not `us` (the rule triality-vector.ts uses for the same axis).
 *  - Read-only, no LLM, no learning, never written anywhere.
 */

export interface MotivationMinutes {
  me: number;
  us: number;
  them: number;
  /** Time on tasks with no me / us / them label. */
  unlabeled: number;
  /** me + us + them + unlabeled, of the rounded cells, so the row always adds up on screen. */
  total: number;
}

export interface MotivationBalanceCategory extends MotivationMinutes {
  category: string;
}

export interface MotivationBalance {
  /** Monday of the week the numbers describe (YYYY-MM-DD). */
  week_start: string;
  /** Always 'timed': finished time entries, not scheduled blocks. */
  basis: 'timed';
  /** One row per category with timed minutes that week, most minutes first (name breaks ties). */
  categories: MotivationBalanceCategory[];
  /** The week as a whole, once per entry, categorized or not. */
  overall: MotivationMinutes;
}

type Bucket = 'me' | 'us' | 'them' | 'unlabeled';

function bucketOf(m: string | null): Bucket {
  return m === 'me' || m === 'us' || m === 'them' ? m : 'unlabeled';
}

const SQL_CATEGORISED = `
  SELECT g.name AS cat, t.motivation AS motivation, e.started_at, e.ended_at
    FROM time_entries e
    JOIN tasks t ON t.id = e.task_id AND t.owner_id = e.owner_id
    JOIN entity_categories ec ON ec.entity_kind = 'task' AND ec.entity_id = e.task_id
    JOIN tags g ON g.id = ec.category_tag_id AND g.kind = 'category' AND g.is_base = 1 AND g.owner_id = ?
   WHERE e.owner_id = ? AND e.ended_at IS NOT NULL
     AND e.started_at >= ? AND e.started_at <= ?
`;

const SQL_ALL_ENTRIES = `
  SELECT t.motivation AS motivation, e.started_at, e.ended_at
    FROM time_entries e
    JOIN tasks t ON t.id = e.task_id AND t.owner_id = e.owner_id
   WHERE e.owner_id = ? AND e.ended_at IS NOT NULL
     AND e.started_at >= ? AND e.started_at <= ?
`;

function empty(): Record<Bucket, number> {
  return { me: 0, us: 0, them: 0, unlabeled: 0 };
}

function finish(raw: Record<Bucket, number>): MotivationMinutes {
  const me = Math.round(raw.me);
  const us = Math.round(raw.us);
  const them = Math.round(raw.them);
  const unlabeled = Math.round(raw.unlabeled);
  return { me, us, them, unlabeled, total: me + us + them + unlabeled };
}

/**
 * The me / us / them split for the ISO week containing `anchor` (a YYYY-MM-DD, any day of it).
 * Week bounds are `weekBoundsFor`'s, the same (UTC-edged) ones `weeklyReview` and the balance
 * snapshot use.
 */
export async function motivationBalanceForWeek(ownerId: string, anchor: string): Promise<MotivationBalance> {
  const { weekStart, startUtc, endUtc } = weekBoundsFor(anchor);

  const [catRows, allRows] = await Promise.all([
    store()
      .prepare(SQL_CATEGORISED)
      .all<{ cat: string; motivation: string | null; started_at: string; ended_at: string }>(ownerId, ownerId, startUtc, endUtc),
    store()
      .prepare(SQL_ALL_ENTRIES)
      .all<{ motivation: string | null; started_at: string; ended_at: string }>(ownerId, startUtc, endUtc),
  ]);

  const byCategory = new Map<string, Record<Bucket, number>>();
  for (const r of catRows) {
    const minutes = entryMinutes(r.started_at, r.ended_at);
    if (!(minutes > 0)) continue;
    const row = byCategory.get(r.cat) ?? empty();
    row[bucketOf(r.motivation)] += minutes;
    byCategory.set(r.cat, row);
  }

  const overall = empty();
  for (const r of allRows) {
    const minutes = entryMinutes(r.started_at, r.ended_at);
    if (!(minutes > 0)) continue;
    overall[bucketOf(r.motivation)] += minutes;
  }

  const categories = [...byCategory.entries()]
    .map(([category, raw]) => ({ category, ...finish(raw) }))
    .filter((c) => c.total > 0) // a few seconds of timer noise rounds to 0 minutes: no empty row
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  return { week_start: weekStart, basis: 'timed', categories, overall: finish(overall) };
}
