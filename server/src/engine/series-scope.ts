import { sqlite } from '../db/index.js';
import { boundRuleBefore } from './recurrence.js';
import { serverTimezone } from '../lib/tz.js';
import { removeEntityTags } from '../services/tags.js';
import { logger } from '../lib/logger.js';

/**
 * "This and all following" on a recurring series, for both time blocks and tasks.
 *
 * The operation is a TRUNCATION of the original series at the clicked occurrence:
 *   1. bound the template's rule to stop the day before that occurrence, and
 *   2. drop the already-materialized instances on/after it.
 *
 * It is deliberately NOT an edit of the template in place. A template edit rewrites the
 * whole series including occurrences BEFORE the one the user clicked — which is what the
 * old `scope=series` path did while calling itself "This & future".
 *
 * Occurrences before the split are left completely untouched, including their status and
 * per-occurrence tags: "following" is a statement about the future, and silently
 * rewriting history would lose work the owner already did.
 */

export type SeriesEntity = 'time_blocks' | 'tasks';

export interface TruncateResult {
  ok: boolean;
  /** Materialized instances removed (on/after the split). */
  removed: number;
  /** True when the split landed on the first occurrence, so the template itself went. */
  templateRemoved: boolean;
  reason?: 'not_found' | 'not_recurring' | 'bad_rule';
}

function ownerTimezone(owner: string): string {
  const row = sqlite
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { timezone: string | null } | undefined;
  return row?.timezone || serverTimezone();
}

/**
 * Truncate `templateId`'s series so nothing occurs on or after `fromLocalDate`.
 *
 * `table` selects the entity; the two schemas carry identical recurrence columns
 * (recurrence_rule / recurrence_dtstart / recurrence_parent_id / occurrence_date), which
 * is why one implementation serves both rather than two that can drift.
 */
export function truncateSeriesFrom(
  owner: string,
  table: SeriesEntity,
  templateId: string,
  fromLocalDate: string,
): TruncateResult {
  const tpl = sqlite
    .prepare(`SELECT id, recurrence_rule FROM ${table} WHERE id = ? AND owner_id = ?`)
    .get(templateId, owner) as { id: string; recurrence_rule: string | null } | undefined;
  if (!tpl) return { ok: false, removed: 0, templateRemoved: false, reason: 'not_found' };
  if (!tpl.recurrence_rule) return { ok: false, removed: 0, templateRemoved: false, reason: 'not_recurring' };

  const bounded = boundRuleBefore(tpl.recurrence_rule, fromLocalDate, ownerTimezone(owner));
  if (!bounded.ok) {
    // Fail CLOSED. Leaving the rule unbounded here would silently convert "this and
    // following" into "nothing changes", and the caller would report success.
    logger.warn('truncateSeriesFrom: could not bound rule', { table, templateId, err: bounded.error });
    return { ok: false, removed: 0, templateRemoved: false, reason: 'bad_rule' };
  }

  // Drop the materialized instances from the split forward. Instances are hard rows and
  // a single occurrence can carry its own tags (CON-3), so clear those first.
  const entityKind = table === 'tasks' ? 'task' : 'time_block';
  const dropped = sqlite
    .prepare(
      `DELETE FROM ${table}
        WHERE owner_id = ? AND recurrence_parent_id = ?
          AND occurrence_date IS NOT NULL AND occurrence_date >= ?
        RETURNING id`,
    )
    .all(owner, templateId, fromLocalDate) as { id: string }[];
  for (const r of dropped) removeEntityTags(entityKind, r.id);

  // Does anything remain before the split? If the split is at//before the first
  // occurrence the bounded rule covers nothing, and a template that can never
  // materialize is just an invisible orphan — remove it outright.
  const survivors = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM ${table}
        WHERE owner_id = ? AND recurrence_parent_id = ?
          AND occurrence_date IS NOT NULL AND occurrence_date < ?`,
    )
    .get(owner, templateId, fromLocalDate) as { n: number };

  const dtstartRow = sqlite
    .prepare(`SELECT recurrence_dtstart FROM ${table} WHERE id = ?`)
    .get(templateId) as { recurrence_dtstart: string | null } | undefined;
  const startsAfterSplit = (dtstartRow?.recurrence_dtstart ?? '').slice(0, 10) >= fromLocalDate;

  if (survivors.n === 0 && startsAfterSplit) {
    sqlite.prepare(`DELETE FROM ${table} WHERE id = ? AND owner_id = ?`).run(templateId, owner);
    removeEntityTags(entityKind, templateId);
    return { ok: true, removed: dropped.length, templateRemoved: true };
  }

  sqlite
    .prepare(`UPDATE ${table} SET recurrence_rule = ? WHERE id = ? AND owner_id = ?`)
    .run(bounded.rule, templateId, owner);

  return { ok: true, removed: dropped.length, templateRemoved: false };
}

export interface ForkResult {
  ok: boolean;
  /** The new template carrying the series from `fromLocalDate` onward. */
  newTemplateId?: string;
  reason?: 'not_found' | 'not_recurring' | 'bad_rule';
}

/**
 * Fork a series at `fromLocalDate` — the edit counterpart of the delete truncation.
 *
 * The original template is bounded to stop the day before and keeps every earlier
 * occurrence; a COPY of it becomes a new, independent template anchored at the split,
 * which the caller then applies the user's edits to. That is what makes "this and all
 * following" mean what it says: the edit lands only on the new half.
 *
 * Columns are copied via PRAGMA rather than a hand-written list. A hand-list silently
 * stops copying anything added later — the new half would quietly lose fields — and this
 * table is wide enough that nobody would notice for a long time.
 */
export function forkSeriesAt(
  owner: string,
  table: SeriesEntity,
  templateId: string,
  fromLocalDate: string,
  newId: string,
): ForkResult {
  const tpl = sqlite
    .prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_id = ?`)
    .get(templateId, owner) as Record<string, unknown> | undefined;
  if (!tpl) return { ok: false, reason: 'not_found' };
  if (!tpl.recurrence_rule) return { ok: false, reason: 'not_recurring' };

  // The forward half keeps the ORIGINAL rule (the user may or may not also be changing
  // it); only its anchor moves to the split day. Validate before mutating anything.
  const rule = String(tpl.recurrence_rule);
  const tz = ownerTimezone(owner);
  if (!boundRuleBefore(rule, fromLocalDate, tz).ok) return { ok: false, reason: 'bad_rule' };

  const cols = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name)
    .filter((c) => c !== 'id');

  // Anchor the new series at the split day, preserving the original wall-clock time.
  const dtstart = String(tpl.recurrence_dtstart ?? tpl.start_at ?? '');
  const timePart = dtstart.slice(10); // 'THH:MM:SS.sssZ'
  const overrides: Record<string, unknown> = {
    recurrence_dtstart: timePart ? `${fromLocalDate}${timePart}` : dtstart,
    recurrence_parent_id: null,
    occurrence_date: null,
    // EXDATEs belong to the old half's calendar; carrying them forward would re-skip
    // days the owner never excluded in the new series.
    recurrence_exdates: null,
  };

  const values = cols.map((c) => (c in overrides ? overrides[c] : (tpl[c] ?? null)));
  sqlite
    .prepare(`INSERT INTO ${table} (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(newId, ...(values as never[]));

  // Only now truncate the original — if the insert above throws, the old series is
  // still intact rather than silently cut short with no replacement.
  const t = truncateSeriesFrom(owner, table, templateId, fromLocalDate);
  if (!t.ok) {
    sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(newId);
    return { ok: false, reason: t.reason ?? 'bad_rule' };
  }

  return { ok: true, newTemplateId: newId };
}
