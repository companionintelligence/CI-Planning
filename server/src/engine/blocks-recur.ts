/**
 * CON-4 — recurring Time Blocks (lazy materialization).
 *
 * The block-side mirror of `patterns-place.ts`'s `ensurePatternsForRange`, sharing
 * the SAME recurrence expander (`recurrence.ts`, rrule.js). A recurring Time Block
 * is a *template* (`recurrence_rule` set, `recurrence_parent_id` null) that is never
 * rendered directly; on each day-view read we materialize one *instance* per
 * occurrence in the requested range. Idempotent + concurrency-safe by construction:
 * `INSERT OR IGNORE` against the partial unique index `ux_block_occurrence`
 * (`recurrence_parent_id, occurrence_date`) collapses any duplicate/raced insert to
 * a single row, so the read endpoint can call this on every GET.
 *
 * No backfill: only today-or-future local days are materialized (a template the user
 * creates appears the moment its day is next read, like recurring Routines).
 */
import { sqlite } from '../db/index.js';
import { serverTimezone, zonedWallTimeToUTC, utcToZonedWallTime, localDateInTZ } from '../lib/tz.js';
import { addDays } from '../lib/dates.js';
import { occurrencesBetween } from './recurrence.js';
import { localDaysInRange } from './patterns-place.js';

interface BlockTemplate {
  id: string;
  title: string;
  block_kind: string | null;
  tag: string | null;
  block_type: string | null;
  note: string | null;
  start_at: string;
  end_at: string;
  is_locked: number;
  source_kind: string | null;
  recurrence_rule: string;
  recurrence_dtstart: string | null;
  recurrence_exdates: string | null; // JSON string[] of skipped local YYYY-MM-DD
  category_id: string | null;  // 0069: propagated to instances
  color_token: string | null;  // 0069: the FROZEN category stamp, copied verbatim
}

/** Parse the stored EXDATE JSON (`string[]`), tolerating null/garbage. Mirrors recurrence-ops.ts. */
function parseExdates(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Exclude one occurrence of a recurring Time-Block template: append `date`
 * (local YYYY-MM-DD) to the template's EXDATE so the lazy materializer
 * (`ensureRecurringBlocksForRange`) won't resurrect it on the next read. Mirrors
 * the task `skipInstance` EXDATE behavior. Idempotent. The DELETE route calls
 * this when removing a materialized instance, so deleting an occurrence sticks.
 */
export function excludeBlockOccurrence(owner: string, templateId: string, date: string): void {
  const tpl = sqlite
    .prepare(`SELECT recurrence_exdates FROM time_blocks WHERE id = ? AND owner_id = ?`)
    .get(templateId, owner) as { recurrence_exdates: string | null } | undefined;
  if (!tpl) return;
  const ex = parseExdates(tpl.recurrence_exdates);
  if (ex.includes(date)) return;
  ex.push(date);
  ex.sort();
  sqlite.prepare(`UPDATE time_blocks SET recurrence_exdates = ? WHERE id = ? AND owner_id = ?`).run(JSON.stringify(ex), templateId, owner);
}

/**
 * Materialize every recurring Time-Block template's instances over the local days
 * intersecting [fromUtcISO, toUtcISO]. Returns how many instance rows were created.
 */
export function ensureRecurringBlocksForRange(owner: string, fromUtcISO: string, toUtcISO: string): { blocksCreated: number } {
  const prefsRow = sqlite
    .prepare(`SELECT timezone, recurrence_horizon_days FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { timezone: string | null; recurrence_horizon_days: number | null } | undefined;
  const tz = prefsRow?.timezone || serverTimezone();
  // "Today" in the OWNER's timezone (matches the prefs-tz day set from
  // localDaysInRange); server-local would misplace the boundary when TZ differs.
  const today = localDateInTZ(new Date().toISOString(), tz);
  // Phase P (0091): materialize at most `recurrence_horizon_days` days from today
  // (inclusive) — same clamp as ensurePatternsForRange, so both engines agree.
  const horizonDays = prefsRow?.recurrence_horizon_days ?? 7;
  const horizonEnd = addDays(today, horizonDays - 1);
  const days = localDaysInRange(fromUtcISO, toUtcISO, tz).filter((d) => d >= today && d <= horizonEnd); // no backfill / no far-future
  if (days.length === 0) return { blocksCreated: 0 };
  const wanted = new Set(days);
  const fromDay = days[0];
  const toDay = days[days.length - 1];

  const templates = sqlite
    .prepare(
      `SELECT id, title, block_kind, tag, block_type, note, start_at, end_at, is_locked, source_kind,
              recurrence_rule, recurrence_dtstart, recurrence_exdates, category_id, color_token
         FROM time_blocks
        WHERE owner_id = ? AND recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL`,
    )
    .all(owner) as BlockTemplate[];
  if (templates.length === 0) return { blocksCreated: 0 };

  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO time_blocks
       (id, owner_id, title, block_kind, tag, block_type, note, start_at, end_at, is_locked, is_auto,
        source_kind, status, recurrence_parent_id, occurrence_date, category_id, color_token)
     VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'planned', ?, ?, ?, ?)
     RETURNING id`,
  );
  // Carry the template's normalized tags (with levels) onto the instance so Phase 5
  // dilution / search see the recurring block's tags too.
  const copyTags = sqlite.prepare(
    `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level)
       SELECT 'time_block', ?, tag_id, level FROM entity_tags
        WHERE entity_kind = 'time_block' AND entity_id = ?`,
  );
  // Phase B (0135): carry the category axis too (position preserved — stripe order),
  // so a recurring category Plan's instances keep filling by category.
  const copyCats = sqlite.prepare(
    `INSERT OR IGNORE INTO entity_categories (entity_kind, entity_id, category_tag_id, position)
       SELECT 'time_block', ?, category_tag_id, position FROM entity_categories
        WHERE entity_kind = 'time_block' AND entity_id = ?`,
  );

  let blocksCreated = 0;
  const run = sqlite.transaction(() => {
    for (const t of templates) {
      const wall = utcToZonedWallTime(t.start_at, tz); // HH:MM in tz
      const durationMs = Math.max(Date.parse(t.end_at) - Date.parse(t.start_at), 0);
      const dtstart = t.recurrence_dtstart ?? t.start_at;
      let hits: string[];
      try {
        hits = occurrencesBetween(
          { recurrenceRule: t.recurrence_rule, recurrenceDtstart: dtstart, taskTime: wall, recurrenceExdates: parseExdates(t.recurrence_exdates), timezone: tz },
          fromDay,
          toDay,
        );
      } catch {
        continue; // a malformed rule shouldn't take down the read
      }
      for (const day of hits) {
        if (!wanted.has(day)) continue;
        const startISO = zonedWallTimeToUTC(day, wall, tz);
        const endISO = new Date(Date.parse(startISO) + durationMs).toISOString();
        const row = ins.get(
          owner, t.title, t.block_kind ?? 'timeblock', t.tag, t.block_type, t.note,
          startISO, endISO, t.is_locked ?? 0, t.source_kind ?? 'manual', t.id, day,
          t.category_id, t.color_token, // 0069: frozen stamp copied verbatim (not re-derived)
        ) as { id: string } | undefined;
        if (row) {
          blocksCreated++;
          copyTags.run(row.id, t.id);
          copyCats.run(row.id, t.id);
        }
      }
    }
  });
  run();
  return { blocksCreated };
}
