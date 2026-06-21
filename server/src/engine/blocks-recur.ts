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
import { serverTimezone, zonedWallTimeToUTC, utcToZonedWallTime } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';
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
}

/**
 * Materialize every recurring Time-Block template's instances over the local days
 * intersecting [fromUtcISO, toUtcISO]. Returns how many instance rows were created.
 */
export function ensureRecurringBlocksForRange(owner: string, fromUtcISO: string, toUtcISO: string): { blocksCreated: number } {
  const tz =
    (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { timezone: string | null } | undefined)
      ?.timezone || serverTimezone();
  const today = localISODate();
  const days = localDaysInRange(fromUtcISO, toUtcISO, tz).filter((d) => d >= today); // no backfill
  if (days.length === 0) return { blocksCreated: 0 };
  const wanted = new Set(days);
  const fromDay = days[0];
  const toDay = days[days.length - 1];

  const templates = sqlite
    .prepare(
      `SELECT id, title, block_kind, tag, block_type, note, start_at, end_at, is_locked, source_kind,
              recurrence_rule, recurrence_dtstart
         FROM time_blocks
        WHERE recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL`,
    )
    .all() as BlockTemplate[];
  if (templates.length === 0) return { blocksCreated: 0 };

  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO time_blocks
       (id, title, block_kind, tag, block_type, note, start_at, end_at, is_locked, is_auto,
        source_kind, status, recurrence_parent_id, occurrence_date)
     VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'planned', ?, ?)
     RETURNING id`,
  );
  // Carry the template's normalized tags (with levels) onto the instance so Phase 5
  // dilution / search see the recurring block's tags too.
  const copyTags = sqlite.prepare(
    `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level)
       SELECT 'time_block', ?, tag_id, level FROM entity_tags
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
          { recurrenceRule: t.recurrence_rule, recurrenceDtstart: dtstart, taskTime: wall, recurrenceExdates: [], timezone: tz },
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
          t.title, t.block_kind ?? 'timeblock', t.tag, t.block_type, t.note,
          startISO, endISO, t.is_locked ?? 0, t.source_kind ?? 'manual', t.id, day,
        ) as { id: string } | undefined;
        if (row) {
          blocksCreated++;
          copyTags.run(row.id, t.id);
        }
      }
    }
  });
  run();
  return { blocksCreated };
}
