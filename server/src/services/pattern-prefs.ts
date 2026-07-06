import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';

export interface PatternPref {
  auto_fill: boolean;
  reminder_offsets: number[];
  icon_shape: string;     // circle | square | triangle — pattern-block display
  color_token: string;    // CI-Hub token key (never hex)
  default_minutes: number; // fallback estimate when a task has no intention tag
}

const DEFAULT_PREF: PatternPref = {
  auto_fill: true,
  reminder_offsets: [],
  icon_shape: 'circle',
  color_token: 'primary',
  default_minutes: 60,
};

type RawRow = {
  id: string;
  owner_id: string;
  tag_id: string;
  auto_fill: number;
  reminder_offsets: string;
  icon_shape: string;
  color_token: string;
  default_minutes: number;
};

type PrefCols = Pick<RawRow, 'auto_fill' | 'reminder_offsets' | 'icon_shape' | 'color_token' | 'default_minutes'>;

function rowToPref(r: PrefCols): PatternPref {
  return {
    auto_fill: r.auto_fill !== 0,
    reminder_offsets: JSON.parse(r.reminder_offsets ?? '[]') as number[],
    icon_shape: r.icon_shape ?? 'circle',
    color_token: r.color_token ?? 'primary',
    default_minutes: r.default_minutes ?? 60,
  };
}

/**
 * Returns all direction-axis tag_prefs for an owner, keyed by tag id.
 * Missing rows are NOT included — callers fold in defaults via DEFAULT_PREF.
 * (Since 0097 the direction + category prefs share one `tag_prefs` table,
 * partitioned by `kind`; this reads only the 'direction' rows.)
 */
export function getPatternPrefs(ownerId: string): Record<string, PatternPref> {
  const rows = sqlite
    .prepare(
      `SELECT id, owner_id, tag_id, auto_fill, reminder_offsets, icon_shape, color_token, default_minutes
         FROM tag_prefs
        WHERE owner_id = ? AND kind = 'direction'`
    )
    .all(ownerId) as RawRow[];

  const result: Record<string, PatternPref> = {};
  for (const r of rows) result[r.tag_id] = rowToPref(r);
  return result;
}

/**
 * Upsert a single direction-axis tag_prefs row (kind='direction'). Merges `patch` on
 * top of any existing values (fetch-then-merge), then persists. Returns the final row.
 */
export function setPatternPref(
  ownerId: string,
  patternTagId: string,
  patch: Partial<PatternPref>
): PatternPref {
  const existing = sqlite
    .prepare(
      `SELECT auto_fill, reminder_offsets, icon_shape, color_token, default_minutes
         FROM tag_prefs WHERE owner_id = ? AND tag_id = ? AND kind = 'direction'`
    )
    .get(ownerId, patternTagId) as PrefCols | undefined;

  const current: PatternPref = existing ? rowToPref(existing) : { ...DEFAULT_PREF };

  const merged: PatternPref = {
    auto_fill: patch.auto_fill !== undefined ? patch.auto_fill : current.auto_fill,
    reminder_offsets:
      patch.reminder_offsets !== undefined ? patch.reminder_offsets : current.reminder_offsets,
    icon_shape: patch.icon_shape !== undefined ? patch.icon_shape : current.icon_shape,
    color_token: patch.color_token !== undefined ? patch.color_token : current.color_token,
    default_minutes:
      patch.default_minutes !== undefined ? patch.default_minutes : current.default_minutes,
  };

  sqlite
    .prepare(
      `INSERT INTO tag_prefs (id, owner_id, tag_id, kind, auto_fill, reminder_offsets, icon_shape, color_token, default_minutes)
       VALUES (?, ?, ?, 'direction', ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, tag_id)
       DO UPDATE SET kind = 'direction',
                     auto_fill = excluded.auto_fill,
                     reminder_offsets = excluded.reminder_offsets,
                     icon_shape = excluded.icon_shape,
                     color_token = excluded.color_token,
                     default_minutes = excluded.default_minutes`
    )
    .run(
      newId(),
      ownerId,
      patternTagId,
      merged.auto_fill ? 1 : 0,
      JSON.stringify(merged.reminder_offsets),
      merged.icon_shape,
      merged.color_token,
      merged.default_minutes,
    );

  return merged;
}

export type SetPrefResult =
  | { ok: true; pref: PatternPref }
  | { ok: false; error: 'tag_not_found' | 'not_direction' | 'auto_fill_type' | 'reminder_offsets_invalid' | 'icon_shape_invalid' | 'color_token_invalid' | 'default_minutes_invalid' };

/**
 * Validate + upsert a direction-axis pref (Phase W · W6b, Decision 3): the owner-scoped
 * tag/kind check + the field constraints extracted from routes/pattern-prefs.ts so REST +
 * GraphQL share one implementation. `patch` carries raw (unknown-typed) values so the
 * type checks (REST body hygiene) live here too; on success delegates to setPatternPref.
 */
export function setPatternPrefChecked(
  ownerId: string,
  tagId: string,
  patch: { auto_fill?: unknown; reminder_offsets?: unknown; icon_shape?: unknown; color_token?: unknown; default_minutes?: unknown },
): SetPrefResult {
  const tag = sqlite.prepare(`SELECT kind FROM tags WHERE id = ? AND owner_id = ?`).get(tagId, ownerId) as { kind: string } | undefined;
  if (!tag) return { ok: false, error: 'tag_not_found' };
  if (tag.kind !== 'direction') return { ok: false, error: 'not_direction' };
  if (patch.auto_fill !== undefined && typeof patch.auto_fill !== 'boolean') return { ok: false, error: 'auto_fill_type' };
  if (
    patch.reminder_offsets !== undefined &&
    (!Array.isArray(patch.reminder_offsets) || !patch.reminder_offsets.every((v) => Number.isInteger(v) && (v as number) >= 0))
  ) {
    return { ok: false, error: 'reminder_offsets_invalid' };
  }
  if (patch.icon_shape !== undefined && !['circle', 'square', 'triangle'].includes(patch.icon_shape as string)) return { ok: false, error: 'icon_shape_invalid' };
  if (patch.color_token !== undefined && (typeof patch.color_token !== 'string' || !patch.color_token)) return { ok: false, error: 'color_token_invalid' };
  if (patch.default_minutes !== undefined && !(Number.isInteger(patch.default_minutes) && (patch.default_minutes as number) > 0)) return { ok: false, error: 'default_minutes_invalid' };

  const pref = setPatternPref(ownerId, tagId, {
    auto_fill: patch.auto_fill as boolean | undefined,
    reminder_offsets: patch.reminder_offsets as number[] | undefined,
    icon_shape: patch.icon_shape as string | undefined,
    color_token: patch.color_token as string | undefined,
    default_minutes: patch.default_minutes as number | undefined,
  });
  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `pattern-prefs:${tagId}` });
  return { ok: true, pref };
}
