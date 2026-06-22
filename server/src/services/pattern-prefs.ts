import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';

export interface PatternPref {
  auto_fill: boolean;
  reminder_offsets: number[];
  icon_shape: string;   // circle | square | triangle — pattern-block display
  color_token: string;  // CI-Hub token key (never hex)
}

const DEFAULT_PREF: PatternPref = {
  auto_fill: true,
  reminder_offsets: [],
  icon_shape: 'circle',
  color_token: 'primary',
};

type RawRow = {
  id: string;
  owner_id: string;
  pattern_tag_id: string;
  auto_fill: number;
  reminder_offsets: string;
  icon_shape: string;
  color_token: string;
};

function rowToPref(r: Pick<RawRow, 'auto_fill' | 'reminder_offsets' | 'icon_shape' | 'color_token'>): PatternPref {
  return {
    auto_fill: r.auto_fill !== 0,
    reminder_offsets: JSON.parse(r.reminder_offsets ?? '[]') as number[],
    icon_shape: r.icon_shape ?? 'circle',
    color_token: r.color_token ?? 'primary',
  };
}

/**
 * Returns all pattern_prefs for an owner, keyed by pattern_tag_id.
 * Missing rows are NOT included — callers fold in defaults via:
 *   prefs[tagId] ?? { auto_fill: true, reminder_offsets: [], icon_shape: 'circle', color_token: 'primary' }
 */
export function getPatternPrefs(ownerId: string): Record<string, PatternPref> {
  const rows = sqlite
    .prepare(
      `SELECT id, owner_id, pattern_tag_id, auto_fill, reminder_offsets, icon_shape, color_token
         FROM pattern_prefs
        WHERE owner_id = ?`
    )
    .all(ownerId) as RawRow[];

  const result: Record<string, PatternPref> = {};
  for (const r of rows) result[r.pattern_tag_id] = rowToPref(r);
  return result;
}

/**
 * Upsert a single pattern_prefs row. Merges `patch` on top of any existing
 * values (fetch-then-merge), then persists. Returns the final row.
 */
export function setPatternPref(
  ownerId: string,
  patternTagId: string,
  patch: Partial<PatternPref>
): PatternPref {
  const existing = sqlite
    .prepare(
      `SELECT auto_fill, reminder_offsets, icon_shape, color_token
         FROM pattern_prefs WHERE owner_id = ? AND pattern_tag_id = ?`
    )
    .get(ownerId, patternTagId) as
    | Pick<RawRow, 'auto_fill' | 'reminder_offsets' | 'icon_shape' | 'color_token'>
    | undefined;

  const current: PatternPref = existing ? rowToPref(existing) : { ...DEFAULT_PREF };

  const merged: PatternPref = {
    auto_fill: patch.auto_fill !== undefined ? patch.auto_fill : current.auto_fill,
    reminder_offsets:
      patch.reminder_offsets !== undefined ? patch.reminder_offsets : current.reminder_offsets,
    icon_shape: patch.icon_shape !== undefined ? patch.icon_shape : current.icon_shape,
    color_token: patch.color_token !== undefined ? patch.color_token : current.color_token,
  };

  sqlite
    .prepare(
      `INSERT INTO pattern_prefs (id, owner_id, pattern_tag_id, auto_fill, reminder_offsets, icon_shape, color_token)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, pattern_tag_id)
       DO UPDATE SET auto_fill = excluded.auto_fill,
                     reminder_offsets = excluded.reminder_offsets,
                     icon_shape = excluded.icon_shape,
                     color_token = excluded.color_token`
    )
    .run(
      newId(),
      ownerId,
      patternTagId,
      merged.auto_fill ? 1 : 0,
      JSON.stringify(merged.reminder_offsets),
      merged.icon_shape,
      merged.color_token,
    );

  return merged;
}
