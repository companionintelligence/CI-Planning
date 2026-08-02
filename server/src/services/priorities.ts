import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';
import { currentOwnerId } from '../lib/context.js';

/**
 * services/priorities.ts — owner-scoped CRUD for the `life_priorities` table
 * (0127). Ported from the single-user life-priorities-wizard route and made
 * multi-tenant: every read/write filters by `currentOwnerId()`, and the upsert
 * keys on (owner_id, category). Raw better-sqlite3, mirroring services/reflections.ts.
 */

/** A stored life-priority row (snake_case, as the API returns it). */
export interface LifePriorityRow {
  id: string;
  owner_id: string;
  category: string;
  satisfaction: number;
  importance: number;
  target_hours_per_week: number;
  created_at: string;
  updated_at: string;
}

/** Incoming upsert item from the Priorities Wizard (snake_case API shape). */
export interface PriorityInput {
  category: string;
  satisfaction?: number;
  importance?: number;
  target_hours_per_week?: number;
}

// SQL at module level, prepared inside the functions — a module-level store() call
// would throw when this module loads before db/index installs the backend (§5.5).
const LIST_SQL = `SELECT * FROM life_priorities WHERE owner_id = ? ORDER BY category`;
const GET_SQL = `SELECT * FROM life_priorities WHERE owner_id = ? AND category = ?`;
const UPSERT_SQL =
  `INSERT INTO life_priorities (id, owner_id, category, satisfaction, importance, target_hours_per_week)
   VALUES (@id, @owner_id, @category, @satisfaction, @importance, @target_hours_per_week)
   ON CONFLICT(owner_id, category) DO UPDATE SET
     satisfaction          = excluded.satisfaction,
     importance            = excluded.importance,
     target_hours_per_week = excluded.target_hours_per_week,
     updated_at            = CURRENT_TIMESTAMP`;

const clampScore = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(10, n));
};
const clampHours = (v: unknown, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(168, n));
};

/** All of the current owner's life priorities, category-ordered. */
export async function listPriorities(): Promise<LifePriorityRow[]> {
  return store().prepare(LIST_SQL).all<LifePriorityRow>(currentOwnerId());
}

/**
 * Upsert a batch of priorities for the current owner (keyed by category). Items with
 * a blank category are skipped. Scores clamp to 1–10, hours to 0–168; absent fields
 * keep the existing row's value (or the column default on insert). Returns the full
 * current list so the client can replace its store in one shot.
 */
export async function upsertPriorities(items: unknown[]): Promise<LifePriorityRow[]> {
  const owner = currentOwnerId();
  const rows = Array.isArray(items) ? items : [];
  await store().transaction(async () => {
    for (const raw of rows) {
      // Defend against malformed elements (null / non-object) so a bad payload skips
      // the row rather than throwing a 500.
      if (raw == null || typeof raw !== 'object') continue;
      const p = raw as PriorityInput;
      const category = typeof p.category === 'string' ? p.category.trim() : '';
      if (!category) continue;
      const existing = await store().prepare(GET_SQL).get<LifePriorityRow>(owner, category);
      await store().prepare(UPSERT_SQL).run({
        id: existing?.id ?? newId(),
        owner_id: owner,
        category,
        satisfaction: clampScore(p.satisfaction, existing?.satisfaction ?? 5),
        importance: clampScore(p.importance, existing?.importance ?? 5),
        target_hours_per_week: clampHours(p.target_hours_per_week, existing?.target_hours_per_week ?? 0),
      });
    }
  });
  return listPriorities();
}
