/**
 * One-off: clear the PLANNER of every instance from a cutoff local date forward,
 * and STOP the two lazy regeneration engines from repopulating on the next
 * `GET /api/blocks` read. Recurring definitions (block templates + Habit/Routine
 * patterns) are KEPT — their recurrence rules are just CAPPED with an `UNTIL` so
 * they stop producing occurrences on/after the cutoff. This is permanent (no
 * horizon leak) and tiny (one edited field per generator), unlike per-day
 * exdates/opt-outs which would need thousands of rows for an indefinite rule.
 *
 * Why capping is required: GET /api/blocks lazily re-materializes recurring
 * blocks/patterns on every read (engine/blocks-recur.ts + engine/patterns-place.ts).
 * Deleting the instances alone brings them straight back on the next refetch.
 * `occurrencesBetween` honours UNTIL, so a capped rule can never resurrect a day
 * on/after the cutoff. See migrations 0025/0034.
 *
 * Scope: `time_blocks` (the calendar) + `daily_plan` (frozen per-day order). Tasks
 * are intentionally left untouched — they are the backlog/definitions.
 *
 * DRY-RUN BY DEFAULT. Prints what it would do and writes nothing. Pass `--apply`
 * to snapshot the DB and execute.
 *
 * Usage:
 *   tsx src/scripts/clear-planner-from.ts [YYYY-MM-DD] [--apply]
 *   (default cutoff: 2026-07-03)
 */
import { join } from 'node:path';
import { sqlite } from '../db/index.js';
import { occurrencesBetween, MAX_SPAN_DAYS } from '../engine/recurrence.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { snapshot, backupDir } from '../lib/backup.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const cutoff = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? '2026-07-03';

/** Add `n` days to a YYYY-MM-DD string (UTC calendar math; date-only, tz-agnostic). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Suppression only needs to check "does this rule still fire on/after cutoff?".
// Bounded rules are capped at MAX_SPAN_DAYS at the parse boundary; the lazy engines
// never backfill past days — so [cutoff, cutoff+MAX_SPAN_DAYS] is a complete probe.
const horizonEnd = addDays(cutoff, MAX_SPAN_DAYS);

const tz =
  (sqlite.prepare(`SELECT timezone FROM scheduling_prefs LIMIT 1`).get() as { timezone: string | null } | undefined)
    ?.timezone || serverTimezone();
const cutoffUTC = zonedWallTimeToUTC(cutoff, '00:00', tz); // local midnight of the cutoff, in UTC

/**
 * UNTIL token (`YYYYMMDDTHHMMSSZ`) one second before the cutoff's local midnight,
 * in the generator's timezone. rrule anchors each occurrence at local noon (in
 * UTC), so this instant sits strictly after the (cutoff-1) day's noon anchor and
 * strictly before the cutoff day's — cleanly keeping ≤ (cutoff-1), dropping ≥ cutoff.
 */
function untilToken(tzForOwner: string): string {
  const c = zonedWallTimeToUTC(cutoff, '00:00', tzForOwner);
  return new Date(Date.parse(c) - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Strip any existing UNTIL/COUNT (mutually exclusive with our UNTIL) and append the cap. */
function capRule(rule: string, until: string): string {
  const kept = rule
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^UNTIL=/i.test(p) && !/^COUNT=/i.test(p));
  kept.push(`UNTIL=${until}`);
  return kept.join(';');
}

console.log(`\n=== clear-planner-from (UNTIL-cap mode) ===`);
console.log(`cutoff        : ${cutoff} (>= this local day is cleared)`);
console.log(`timezone      : ${tz}`);
console.log(`cutoff (UTC)  : ${cutoffUTC}`);
console.log(`mode          : ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}\n`);

// A recurring *template* is never rendered directly; keep it (just cap its rule).
const isBlockTemplate = `recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL`;

// ---- 1. What would be DELETED ---------------------------------------------
const blocksToDelete = sqlite
  .prepare(`SELECT id FROM time_blocks WHERE start_at >= ? AND NOT (${isBlockTemplate})`)
  .all(cutoffUTC) as { id: string }[];
const dailyPlanToDelete = (
  sqlite.prepare(`SELECT COUNT(*) AS n FROM daily_plan WHERE date >= ?`).get(cutoff) as { n: number }
).n;

// ---- 2. Recurring GENERATORS to CAP (only those still firing on/after cutoff) ----
interface Cap { kind: 'block' | 'pattern'; id: string; label: string; owner_id?: string; oldRule: string; newRule: string }
const caps: Cap[] = [];

const blockTemplates = sqlite
  .prepare(`SELECT id, title, recurrence_rule AS rule, recurrence_dtstart AS dtstart, start_at
              FROM time_blocks WHERE ${isBlockTemplate}`)
  .all() as { id: string; title: string; rule: string; dtstart: string | null; start_at: string }[];
for (const t of blockTemplates) {
  try {
    const hits = occurrencesBetween(
      { recurrenceRule: t.rule, recurrenceDtstart: t.dtstart ?? t.start_at, taskTime: null, recurrenceExdates: [], timezone: tz },
      cutoff,
      horizonEnd,
    );
    if (hits.length) caps.push({ kind: 'block', id: t.id, label: t.title, oldRule: t.rule, newRule: capRule(t.rule, untilToken(tz)) });
  } catch {
    console.warn(`  ! block template ${t.id}: malformed rule — skipped`);
  }
}

// Habit rule lives on the member task; Routine rule on the pattern row. Union both.
interface PatternRow { owner_id: string; id: string; name: string; rule: string; dtstart: string | null; type_name: string; src: 'pattern' | 'task'; task_id: string | null }
const patternRows = sqlite
  .prepare(
    `SELECT p.owner_id, p.id, p.name, p.recurrence_rule AS rule, p.recurrence_dtstart AS dtstart, pt.name AS type_name, 'pattern' AS src, NULL AS task_id
       FROM patterns p JOIN pattern_types pt ON pt.id = p.type_id
      WHERE pt.name IN ('Habit','Routine') AND p.recurrence_rule IS NOT NULL
     UNION ALL
     SELECT p.owner_id, p.id, p.name, t.recurrence_rule AS rule, t.recurrence_dtstart AS dtstart, pt.name AS type_name, 'task' AS src, t.id AS task_id
       FROM patterns p JOIN pattern_types pt ON pt.id = p.type_id
       JOIN pattern_tasks ptk ON ptk.pattern_id = p.id
       JOIN tasks t ON t.id = ptk.task_id
      WHERE pt.name = 'Habit' AND t.recurrence_rule IS NOT NULL AND t.recurrence_parent_id IS NULL`,
  )
  .all() as PatternRow[];

const tzByOwner = new Map<string, string>();
const ownerTz = (owner: string): string => {
  let z = tzByOwner.get(owner);
  if (!z) {
    z = (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { timezone: string | null } | undefined)?.timezone || serverTimezone();
    tzByOwner.set(owner, z);
  }
  return z;
};

// Track which underlying row (pattern.rule vs task.rule) to update.
interface PatternCap extends Cap { src: 'pattern' | 'task'; task_id: string | null }
const patternCaps: PatternCap[] = [];
const seenPattern = new Set<string>();
for (const p of patternRows) {
  if (seenPattern.has(p.id) || !p.dtstart) continue; // one rule per pattern; skip malformed
  seenPattern.add(p.id);
  const ptz = ownerTz(p.owner_id);
  try {
    const hits = occurrencesBetween(
      { recurrenceRule: p.rule, recurrenceDtstart: p.dtstart, taskTime: null, recurrenceExdates: [], timezone: ptz },
      cutoff,
      horizonEnd,
    );
    if (hits.length) {
      patternCaps.push({
        kind: 'pattern', id: p.id, label: `${p.name} (${p.type_name})`, owner_id: p.owner_id,
        oldRule: p.rule, newRule: capRule(p.rule, untilToken(ptz)), src: p.src, task_id: p.task_id,
      });
    }
  } catch {
    console.warn(`  ! pattern ${p.id} (${p.type_name}): malformed rule — skipped`);
  }
}

// ---- 3. Report -------------------------------------------------------------
console.log(`DELETE`);
console.log(`  time_blocks (instances + non-recurring, on/after cutoff): ${blocksToDelete.length}`);
console.log(`  daily_plan rows (date >= cutoff)                        : ${dailyPlanToDelete}\n`);
console.log(`CAP recurrence rules with UNTIL (templates kept, rule trimmed to < cutoff)`);
for (const c of caps) console.log(`  block   ${c.label}\n            ${c.oldRule}  ->  ${c.newRule}`);
for (const c of patternCaps) console.log(`  ${c.src === 'task' ? 'habit ' : 'rtn   '} ${c.label}\n            ${c.oldRule}  ->  ${c.newRule}`);
console.log(`  (${caps.length} block templates + ${patternCaps.length} patterns)\n`);

if (!APPLY) {
  console.log(`DRY-RUN complete — nothing written. Re-run with --apply to execute.\n`);
  process.exit(0);
}

// ---- 4. APPLY: snapshot first, then one atomic transaction -----------------
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dest = join(backupDir, `companion-preclear-${ts}.db`);
await snapshot(dest);
console.log(`Snapshot written to ${dest}`);

const delTags = sqlite.prepare(`DELETE FROM entity_tags WHERE entity_kind = 'time_block' AND entity_id = ?`);
const delBlock = sqlite.prepare(`DELETE FROM time_blocks WHERE id = ?`);
const capBlockRule = sqlite.prepare(`UPDATE time_blocks SET recurrence_rule = ? WHERE id = ?`);
const capPatternRule = sqlite.prepare(`UPDATE patterns SET recurrence_rule = ? WHERE id = ?`);
const capTaskRule = sqlite.prepare(`UPDATE tasks SET recurrence_rule = ? WHERE id = ?`);

const run = sqlite.transaction(() => {
  // Cap BEFORE deleting so a template's instances can never race back in.
  for (const c of caps) capBlockRule.run(c.newRule, c.id);
  for (const c of patternCaps) {
    if (c.src === 'task' && c.task_id) capTaskRule.run(c.newRule, c.task_id);
    else capPatternRule.run(c.newRule, c.id);
  }
  // Delete instances + non-recurring blocks (external_events cascade on block FK;
  // daily_plan.block_id SET NULL — the rows themselves are removed next).
  for (const b of blocksToDelete) {
    delTags.run(b.id);
    delBlock.run(b.id);
  }
  sqlite.prepare(`DELETE FROM daily_plan WHERE date >= ?`).run(cutoff);
});
run();

console.log(`\nAPPLIED:`);
console.log(`  deleted ${blocksToDelete.length} time_blocks, ${dailyPlanToDelete} daily_plan rows`);
console.log(`  capped  ${caps.length} block templates + ${patternCaps.length} patterns to < ${cutoff}`);
console.log(`  backup: ${dest}\n`);
process.exit(0);
