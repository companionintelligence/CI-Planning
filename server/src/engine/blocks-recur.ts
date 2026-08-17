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
import { store } from '../db/store.js';
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
  responsible_pinned: number | null;   // 0154: copied so an instance inherits like its template
  beneficiaries_pinned: number | null;
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
export async function excludeBlockOccurrence(owner: string, templateId: string, date: string): Promise<void> {
  // Read-modify-write on a JSON array. Deleting two occurrences of the SAME template
  // concurrently used to be safe for free — better-sqlite3 put no await between the
  // SELECT and the UPDATE. It now does, and a blind UPDATE would let the second writer
  // overwrite the first one's date, resurrecting that occurrence on the next read. So
  // the UPDATE is guarded on the exact value we read (compare-and-swap) and retried
  // against the fresher list when it loses.
  for (let attempt = 0; attempt < 5; attempt++) {
    const tpl = await store()
      .prepare(`SELECT recurrence_exdates FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get<{ recurrence_exdates: string | null }>(templateId, owner);
    if (!tpl) return;
    const ex = parseExdates(tpl.recurrence_exdates);
    if (ex.includes(date)) return; // already excluded (possibly by the writer that beat us)
    ex.push(date);
    ex.sort();
    const res = await store()
      .prepare(
        `UPDATE time_blocks SET recurrence_exdates = ?
          WHERE id = ? AND owner_id = ? AND COALESCE(recurrence_exdates, '') = ?`,
      )
      .run(JSON.stringify(ex), templateId, owner, tpl.recurrence_exdates ?? '');
    if (res.changes > 0) return;
  }
  // Five straight losses means sustained contention on one template, not a transient
  // interleave. Failing loudly beats silently dropping the exclusion — that would
  // resurrect the occurrence the caller just deleted.
  throw new Error(`excludeBlockOccurrence: EXDATE write lost 5 races on template ${templateId}`);
}

/**
 * Materialize every recurring Time-Block template's instances over the local days
 * intersecting [fromUtcISO, toUtcISO]. Returns how many instance rows were created.
 */
export async function ensureRecurringBlocksForRange(owner: string, fromUtcISO: string, toUtcISO: string): Promise<{ blocksCreated: number }> {
  const prefsRow = await store()
    .prepare(`SELECT timezone, recurrence_horizon_days FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ timezone: string | null; recurrence_horizon_days: number | null }>(owner);
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

  const templates = await store()
    .prepare(
      `SELECT id, title, block_kind, tag, block_type, note, start_at, end_at, is_locked, source_kind,
              recurrence_rule, recurrence_dtstart, recurrence_exdates, category_id, color_token,
              responsible_pinned, beneficiaries_pinned
         FROM time_blocks
        WHERE owner_id = ? AND recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL`,
    )
    .all<BlockTemplate>(owner);
  if (templates.length === 0) return { blocksCreated: 0 };

  const ins = store().prepare(
    `INSERT OR IGNORE INTO time_blocks
       (id, owner_id, title, block_kind, tag, block_type, note, start_at, end_at, is_locked, is_auto,
        source_kind, status, recurrence_parent_id, occurrence_date, category_id, color_token)
     VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'planned', ?, ?, ?, ?)
     RETURNING id`,
  );
  // Carry the template's normalized tags (with levels) onto the instance so Phase 5
  // dilution / search see the recurring block's tags too.
  const copyTags = store().prepare(
    `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level)
       SELECT 'time_block', ?, tag_id, level FROM entity_tags
        WHERE entity_kind = 'time_block' AND entity_id = ?`,
  );
  // Phase B (0135): carry the category axis too (position preserved — stripe order),
  // so a recurring category Plan's instances keep filling by category.
  const copyCats = store().prepare(
    `INSERT OR IGNORE INTO entity_categories (entity_kind, entity_id, category_tag_id, position)
       SELECT 'time_block', ?, category_tag_id, position FROM entity_categories
        WHERE entity_kind = 'time_block' AND entity_id = ?`,
  );

  // 0151/0154: carry the people too, and the per-role pins with them. Without this a
  // recurring meeting had attendees on the TEMPLATE and nobody on any occurrence — and
  // since these instances are container blocks with no task_id, the own-else-inherit
  // rule has nothing to fall back to either, so the attendees simply vanished.
  const copyPeople = store().prepare(
    `INSERT OR IGNORE INTO entity_people (entity_kind, entity_id, person_id, role, source, position)
       SELECT 'time_block', ?, person_id, role, source, position FROM entity_people
        WHERE entity_kind = 'time_block' AND entity_id = ?`,
  );
  // The pins are part of the template's answer: an instance of a template that says
  // "nobody" must not quietly start inheriting.
  const copyPins = store().prepare(
    `UPDATE time_blocks SET responsible_pinned = ?, beneficiaries_pinned = ? WHERE id = ?`,
  );

  let blocksCreated = 0;
  await store().transaction(async () => {
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
        const row = await ins.get<{ id: string }>(
          owner, t.title, t.block_kind ?? 'timeblock', t.tag, t.block_type, t.note,
          startISO, endISO, t.is_locked ?? 0, t.source_kind ?? 'manual', t.id, day,
          t.category_id, t.color_token, // 0069: frozen stamp copied verbatim (not re-derived)
        );
        if (row) {
          blocksCreated++;
          await copyTags.run(row.id, t.id);
          await copyCats.run(row.id, t.id);
          await copyPeople.run(row.id, t.id);
          await copyPins.run(t.responsible_pinned ?? 0, t.beneficiaries_pinned ?? 0, row.id);
        }
      }
    }
  });
  return { blocksCreated };
}
