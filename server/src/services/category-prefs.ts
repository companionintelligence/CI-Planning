import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';

/**
 * Per-(owner × category-tag) display config. A trimmed mirror of services/pattern-prefs.ts:
 * categories carry only a user-pickable `color_token` (also the forward-only stamp source
 * for time_blocks.color_token) and a `default_minutes` (prefills the wizard's new-block
 * length; the scheduler ignores it). Same fetch-merge-upsert shape as pattern-prefs.
 */
export interface CategoryPref {
  color_token: string;     // CI-Hub token key (never hex)
  default_minutes: number; // prefills the wizard's block length when this category is picked
}

const DEFAULT_PREF: CategoryPref = {
  color_token: 'primary',
  default_minutes: 60,
};

type PrefCols = { color_token: string; default_minutes: number };

function rowToPref(r: PrefCols): CategoryPref {
  return {
    color_token: r.color_token ?? 'primary',
    default_minutes: r.default_minutes ?? 60,
  };
}

/**
 * All category_prefs for an owner, keyed by category_tag_id. Missing rows are NOT
 * included — callers fold in defaults via DEFAULT_PREF.
 */
export function getCategoryPrefs(ownerId: string): Record<string, CategoryPref> {
  const rows = sqlite
    .prepare(`SELECT category_tag_id, color_token, default_minutes FROM category_prefs WHERE owner_id = ?`)
    .all(ownerId) as (PrefCols & { category_tag_id: string })[];
  const result: Record<string, CategoryPref> = {};
  for (const r of rows) result[r.category_tag_id] = rowToPref(r);
  return result;
}

/**
 * Upsert a single category_prefs row. Merges `patch` over any existing values
 * (fetch-then-merge), then persists. Returns the final row.
 */
export function setCategoryPref(
  ownerId: string,
  categoryTagId: string,
  patch: Partial<CategoryPref>,
): CategoryPref {
  const existing = sqlite
    .prepare(`SELECT color_token, default_minutes FROM category_prefs WHERE owner_id = ? AND category_tag_id = ?`)
    .get(ownerId, categoryTagId) as PrefCols | undefined;

  const current: CategoryPref = existing ? rowToPref(existing) : { ...DEFAULT_PREF };

  const merged: CategoryPref = {
    color_token: patch.color_token !== undefined ? patch.color_token : current.color_token,
    default_minutes: patch.default_minutes !== undefined ? patch.default_minutes : current.default_minutes,
  };

  sqlite
    .prepare(
      `INSERT INTO category_prefs (id, owner_id, category_tag_id, color_token, default_minutes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, category_tag_id)
       DO UPDATE SET color_token = excluded.color_token, default_minutes = excluded.default_minutes`,
    )
    .run(newId(), ownerId, categoryTagId, merged.color_token, merged.default_minutes);

  return merged;
}
