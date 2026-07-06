import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';

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
 * All category-axis tag_prefs (kind='category') for an owner, keyed by tag id.
 * Missing rows are NOT included — callers fold in defaults via DEFAULT_PREF.
 */
export function getCategoryPrefs(ownerId: string): Record<string, CategoryPref> {
  const rows = sqlite
    .prepare(`SELECT tag_id, color_token, default_minutes FROM tag_prefs WHERE owner_id = ? AND kind = 'category'`)
    .all(ownerId) as (PrefCols & { tag_id: string })[];
  const result: Record<string, CategoryPref> = {};
  for (const r of rows) result[r.tag_id] = rowToPref(r);
  return result;
}

/**
 * Upsert a single category-axis tag_prefs row (kind='category'). Merges `patch`
 * over any existing values (fetch-then-merge), then persists. Returns the final row.
 */
export function setCategoryPref(
  ownerId: string,
  categoryTagId: string,
  patch: Partial<CategoryPref>,
): CategoryPref {
  const existing = sqlite
    .prepare(`SELECT color_token, default_minutes FROM tag_prefs WHERE owner_id = ? AND tag_id = ? AND kind = 'category'`)
    .get(ownerId, categoryTagId) as PrefCols | undefined;

  const current: CategoryPref = existing ? rowToPref(existing) : { ...DEFAULT_PREF };

  const merged: CategoryPref = {
    color_token: patch.color_token !== undefined ? patch.color_token : current.color_token,
    default_minutes: patch.default_minutes !== undefined ? patch.default_minutes : current.default_minutes,
  };

  sqlite
    .prepare(
      // On conflict, normalize the row to the category axis: rewrite kind and NULL
      // the pattern-only columns. Belt-and-suspenders — a tag's kind is immutable at
      // runtime today, so a stale-kind row shouldn't exist, but this keeps a category
      // pref self-consistent (visible to getCategoryPrefs' kind='category' filter, no
      // stale pattern-only values) regardless of how the row got there.
      `INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes)
       VALUES (?, ?, ?, 'category', ?, ?)
       ON CONFLICT(owner_id, tag_id)
       DO UPDATE SET kind = 'category',
                     color_token = excluded.color_token,
                     default_minutes = excluded.default_minutes,
                     auto_fill = NULL, reminder_offsets = NULL, icon_shape = NULL`,
    )
    .run(newId(), ownerId, categoryTagId, merged.color_token, merged.default_minutes);

  return merged;
}

export type SetCategoryPrefResult =
  | { ok: true; pref: CategoryPref }
  | { ok: false; error: 'tag_not_found' | 'not_category' | 'color_token_invalid' | 'default_minutes_invalid' };

/**
 * Validate + upsert a category-axis pref (Phase W · W7, Decision 3): the owner-scoped
 * tag/kind check + field constraints extracted from routes/category-prefs.ts so REST +
 * GraphQL share one implementation. `patch` carries raw (unknown-typed) values.
 */
export function setCategoryPrefChecked(
  ownerId: string,
  tagId: string,
  patch: { color_token?: unknown; default_minutes?: unknown },
): SetCategoryPrefResult {
  const tag = sqlite.prepare(`SELECT kind FROM tags WHERE id = ? AND owner_id = ?`).get(tagId, ownerId) as { kind: string } | undefined;
  if (!tag) return { ok: false, error: 'tag_not_found' };
  if (tag.kind !== 'category') return { ok: false, error: 'not_category' };
  if (patch.color_token !== undefined && (typeof patch.color_token !== 'string' || !patch.color_token)) return { ok: false, error: 'color_token_invalid' };
  if (patch.default_minutes !== undefined && !(Number.isInteger(patch.default_minutes) && (patch.default_minutes as number) > 0)) return { ok: false, error: 'default_minutes_invalid' };
  const pref = setCategoryPref(ownerId, tagId, {
    color_token: patch.color_token as string | undefined,
    default_minutes: patch.default_minutes as number | undefined,
  });
  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `category-prefs:${tagId}` });
  return { ok: true, pref };
}
