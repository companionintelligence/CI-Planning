/**
 * clear-range — the shared "clear + stop-regeneration" engine (Phase P · P0).
 *
 * Clears planner instances in a date range and suppresses the two lazy recurrence
 * engines (patterns-place.ts + blocks-recur.ts) from repopulating on the next
 * `GET /api/blocks` read. Deleting instances alone never sticks — the next refetch
 * re-materializes them — so a clear MUST also suppress the generators. There are
 * two suppression shapes, chosen by whether the range is bounded:
 *
 *   • open-ended (no `end`)  → cap each generator's recurrence rule with `UNTIL`
 *       (stops it forever from `start`; reversible by dropping the UNTIL).
 *   • bounded (`start..end`) → per-day `recurrence_exdates` (block templates) /
 *       `pattern_day_optouts` (patterns) — skip only that window; the series
 *       resumes after `end`.
 *
 * `suppress:'none'` deletes instances but touches no rules — used by P1's
 * horizon auto-prune, where the standing horizon clamp (not a rule cap) is what
 * prevents re-materialization, so raising the horizon later stays reversible.
 *
 * Recurring *templates* (`recurrence_rule` set, `recurrence_parent_id` NULL) are
 * NEVER deleted — only their tails are trimmed. Every `time_blocks`, `daily_plan`,
 * and `pattern_day_optouts` query here is owner-scoped (T1 multi-tenant).
 *
 * ⚠ `parseRule` (recurrence.ts) uses a fixed year-2000 validation ceiling, so a
 * far-future `UNTIL` (open-ended cap) would be rejected if a capped rule is later
 * re-validated via a UI edit. Reads never re-validate, so a stored UNTIL works at
 * materialization time — but a rule editor must tolerate/refresh it.
 *
 * Pure engine: no snapshot, no console, no process, no `Date.now()` — callers
 * (the CLI script, the P1 prune, the P2 endpoint) own snapshotting + I/O.
 */
import { sqlite } from '../db/index.js';
import { occurrencesBetween, MAX_SPAN_DAYS } from './recurrence.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';

export interface ClearRangeInput {
  /** Owner for `daily_plan`/`pattern_day_optouts` scoping + timezone resolution. */
  owner: string;
  /** Required local `YYYY-MM-DD`; clears blocks on/after this local day. */
  start: string;
  /** Optional inclusive local `YYYY-MM-DD`. Omitted/null ⇒ open-ended (>= start). */
  end?: string | null;
  /** 'auto' (default): open-ended→UNTIL-cap, bounded→exdates/optouts. 'none': delete only. */
  suppress?: 'auto' | 'none';
  /** true ⇒ only delete engine-generated, non-locked blocks (P1 prune). default false. */
  autoOnly?: boolean;
  /**
   * Whether to also delete `daily_plan` rows in range. default true (P2 "clear a
   * range" wants the authored day-plan gone too). The P1 horizon prune passes
   * FALSE: the recurrence-materialization ceiling has no bearing on the Phase-M
   * authored orderings/rationales/outcomes, and deleting them would be silent +
   * unrecoverable-by-raising-the-horizon.
   */
  clearDailyPlan?: boolean;
  /** default true — compute + report, write nothing. */
  dryRun?: boolean;
}

export interface ClearRangeGenerator {
  kind: 'block' | 'pattern';
  id: string;
  label: string;
  action: 'until-cap' | 'exdates' | 'optouts' | 'none';
  /** exdate/optout days added (0 for until-cap / none). */
  daysSuppressed: number;
  oldRule?: string;
  newRule?: string;
}

export interface ClearRangeResult {
  mode: 'open-ended' | 'bounded';
  blocksDeleted: number;
  dailyPlanDeleted: number;
  generators: ClearRangeGenerator[];
}

/** Add `n` days to a `YYYY-MM-DD` string (UTC calendar math; date-only, tz-agnostic). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * `UNTIL` token (`YYYYMMDDTHHMMSSZ`) one second before `cutoffDay`'s local midnight
 * in `tz`. rrule anchors each occurrence at local noon (in UTC), so this instant
 * sits strictly after the (cutoff-1) day's noon anchor and strictly before the
 * cutoff day's — cleanly keeping ≤ (cutoff-1) and dropping ≥ cutoff.
 */
function untilToken(cutoffDay: string, tz: string): string {
  const c = zonedWallTimeToUTC(cutoffDay, '00:00', tz);
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

/** Parse the stored EXDATE JSON (`string[]`), tolerating null/garbage. Mirrors blocks-recur.ts. */
function parseExdates(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function ownerTimezone(owner: string): string {
  return (
    (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as
      | { timezone: string | null }
      | undefined)?.timezone || serverTimezone()
  );
}

interface BlockTemplateRow {
  id: string;
  title: string;
  rule: string;
  dtstart: string | null;
  start_at: string;
  ex: string | null;
}
interface PatternRuleRow {
  id: string;
  name: string;
  rule: string;
  dtstart: string | null;
  type_name: string;
  src: 'pattern' | 'task';
  task_id: string | null;
}

/**
 * Clear planner instances in `[start, end?]` and suppress regeneration. Returns a
 * report (also computed in `dryRun`, where nothing is written). Single transaction:
 * suppress first, then delete, so a template's instance can never race back in.
 */
export function clearPlannerRange(input: ClearRangeInput): ClearRangeResult {
  const { owner, start } = input;
  const end = input.end ?? null;
  const suppress = input.suppress ?? 'auto';
  const autoOnly = input.autoOnly ?? false;
  const clearDailyPlan = input.clearDailyPlan ?? true;
  const dryRun = input.dryRun ?? true;

  // Guardrails: bounded clears can become extremely expensive (occurrence expansion + per-day suppression rows).
  if (end) {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error('clearPlannerRange: start/end must be local YYYY-MM-DD');
    }
    const spanDays = Math.floor((endMs - startMs) / 86_400_000);
    if (spanDays < 0) throw new Error('clearPlannerRange: end must be on/after start');
    if (spanDays > MAX_SPAN_DAYS) {
      throw new Error(`clearPlannerRange: bounded range exceeds ${MAX_SPAN_DAYS} days`);
    }
  }

  const mode: 'open-ended' | 'bounded' = end ? 'bounded' : 'open-ended';

  const tz = ownerTimezone(owner);
  const startUTC = zonedWallTimeToUTC(start, '00:00', tz); // inclusive lower (local midnight, UTC)
  const endExclusiveUTC = end ? zonedWallTimeToUTC(addDays(end, 1), '00:00', tz) : null; // exclusive upper
  // Open-ended "does this rule still fire on/after start?" needs a finite probe.
  // Bounded rules are capped at MAX_SPAN_DAYS at parse time and the lazy engines
  // never backfill, so [start, start+MAX_SPAN_DAYS] is a complete probe window.
  const probeEnd = end ?? addDays(start, MAX_SPAN_DAYS);
  const isBlockTemplate = `recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL`;
  // "engine-generated, non-locked": pattern placements (is_auto=1, source_kind='pattern'),
  // recurring block INSTANCES (recurrence_parent_id set — NB these are is_auto=0, so an
  // is_auto=1-only filter would miss them), and autoplan agent blocks (is_auto=1).
  // User-placed manual blocks (is_auto=0, source_kind='manual', no parent) and locked
  // blocks are preserved.
  const autoPredicate = `is_locked = 0 AND (is_auto = 1 OR recurrence_parent_id IS NOT NULL OR source_kind = 'pattern')`;

  // ---- blocks to delete ------------------------------------------------------
  const blockWhere = [`owner_id = ?`, `start_at >= ?`];
  const blockArgs: unknown[] = [owner, startUTC];
  if (endExclusiveUTC) {
    blockWhere.push(`start_at < ?`);
    blockArgs.push(endExclusiveUTC);
  }
  blockWhere.push(`NOT (${isBlockTemplate})`);
  if (autoOnly) blockWhere.push(`(${autoPredicate})`);
  const blocksToDelete = sqlite
    .prepare(`SELECT id FROM time_blocks WHERE ${blockWhere.join(' AND ')}`)
    .all(...blockArgs) as { id: string }[];

  // ---- daily_plan to delete (owner-scoped) -----------------------------------
  const dpWhere = [`owner_id = ?`, `date >= ?`];
  const dpArgs: unknown[] = [owner, start];
  if (end) {
    dpWhere.push(`date <= ?`);
    dpArgs.push(end);
  }
  const dailyPlanDeleted = clearDailyPlan
    ? (sqlite.prepare(`SELECT COUNT(*) AS n FROM daily_plan WHERE ${dpWhere.join(' AND ')}`).get(...dpArgs) as { n: number }).n
    : 0;

  // ---- enumerate generators + plan suppression ops ---------------------------
  const generators: ClearRangeGenerator[] = [];
  const capOps: { table: 'time_blocks' | 'patterns' | 'tasks'; id: string; rule: string }[] = [];
  const exdateOps: { id: string; merged: string }[] = [];
  const optoutOps: { patternId: string; day: string }[] = [];

  if (suppress === 'auto') {
    // Block templates (owner-scoped, T1).
    const templates = sqlite
      .prepare(
        `SELECT id, title, recurrence_rule AS rule, recurrence_dtstart AS dtstart, start_at, recurrence_exdates AS ex
           FROM time_blocks WHERE owner_id = ? AND ${isBlockTemplate}`,
      )
      .all(owner) as BlockTemplateRow[];
    for (const t of templates) {
      const existing = parseExdates(t.ex);
      let hits: string[] = [];
      try {
        hits = occurrencesBetween(
          { recurrenceRule: t.rule, recurrenceDtstart: t.dtstart ?? t.start_at, taskTime: null, recurrenceExdates: existing, timezone: tz },
          start,
          probeEnd,
        );
      } catch {
        continue; // malformed rule — leave it be
      }
      if (!hits.length) continue;
      if (mode === 'open-ended') {
        const newRule = capRule(t.rule, untilToken(start, tz));
        capOps.push({ table: 'time_blocks', id: t.id, rule: newRule });
        generators.push({ kind: 'block', id: t.id, label: t.title, action: 'until-cap', daysSuppressed: 0, oldRule: t.rule, newRule });
      } else {
        const merged = Array.from(new Set([...existing, ...hits])).sort();
        exdateOps.push({ id: t.id, merged: JSON.stringify(merged) });
        generators.push({ kind: 'block', id: t.id, label: t.title, action: 'exdates', daysSuppressed: hits.length });
      }
    }

    // Patterns (owner-scoped): Routine rule on the pattern row; Habit rule on the member task.
    const patternRows = sqlite
      .prepare(
        `SELECT p.id, p.name, p.recurrence_rule AS rule, p.recurrence_dtstart AS dtstart, pt.name AS type_name, 'pattern' AS src, NULL AS task_id
           FROM patterns p JOIN pattern_types pt ON pt.id = p.type_id
          WHERE p.owner_id = ? AND pt.name IN ('Habit','Routine') AND p.recurrence_rule IS NOT NULL
         UNION ALL
         SELECT p.id, p.name, t.recurrence_rule AS rule, t.recurrence_dtstart AS dtstart, pt.name AS type_name, 'task' AS src, t.id AS task_id
           FROM patterns p JOIN pattern_types pt ON pt.id = p.type_id
           JOIN pattern_tasks ptk ON ptk.pattern_id = p.id
           JOIN tasks t ON t.id = ptk.task_id
          WHERE p.owner_id = ? AND pt.name = 'Habit' AND t.recurrence_rule IS NOT NULL AND t.recurrence_parent_id IS NULL`,
      )
      .all(owner, owner) as PatternRuleRow[];
    // The UNION emits one row per rule-bearing SOURCE, so a Habit with N recurring
    // member tasks yields N rows sharing p.id. Group by pattern and process EVERY
    // rule — capping only the first would leave the others firing, and the pattern
    // (which fires if ANY source hits — see patternsRecurringOnDate) would re-place
    // on/after the cutoff, so the clear would not stick.
    const byPattern = new Map<
      string,
      { name: string; type_name: string; rules: { table: 'patterns' | 'tasks'; id: string; rule: string; dtstart: string }[] }
    >();
    for (const p of patternRows) {
      if (!p.dtstart) continue; // skip malformed (no anchor)
      const entry = byPattern.get(p.id) ?? { name: p.name, type_name: p.type_name, rules: [] };
      entry.rules.push({ table: p.src === 'task' ? 'tasks' : 'patterns', id: p.src === 'task' ? p.task_id! : p.id, rule: p.rule, dtstart: p.dtstart });
      byPattern.set(p.id, entry);
    }
    const cappedTargets = new Set<string>(); // a task shared by >1 pattern is capped once (idempotent)
    for (const [pid, entry] of byPattern) {
      const allHits = new Set<string>(); // union of occurrence days across every rule
      const firing: { table: 'patterns' | 'tasks'; id: string; rule: string }[] = [];
      for (const r of entry.rules) {
        let hits: string[] = [];
        try {
          hits = occurrencesBetween(
            { recurrenceRule: r.rule, recurrenceDtstart: r.dtstart, taskTime: null, recurrenceExdates: [], timezone: tz },
            start,
            probeEnd,
          );
        } catch {
          continue; // malformed rule — leave it be
        }
        if (!hits.length) continue;
        hits.forEach((d) => allHits.add(d));
        firing.push({ table: r.table, id: r.id, rule: r.rule });
      }
      if (!allHits.size) continue; // pattern doesn't fire in the window
      const label = `${entry.name} (${entry.type_name})`;
      if (mode === 'open-ended') {
        for (const rt of firing) {
          const key = `${rt.table}:${rt.id}`;
          if (cappedTargets.has(key)) continue;
          cappedTargets.add(key);
          capOps.push({ table: rt.table, id: rt.id, rule: capRule(rt.rule, untilToken(start, tz)) });
        }
        const first = firing[0];
        generators.push({ kind: 'pattern', id: pid, label, action: 'until-cap', daysSuppressed: 0, oldRule: first.rule, newRule: capRule(first.rule, untilToken(start, tz)) });
      } else {
        const already = new Set(
          (sqlite.prepare(`SELECT date FROM pattern_day_optouts WHERE owner_id = ? AND pattern_id = ?`).all(owner, pid) as { date: string }[]).map((r) => r.date),
        );
        const fresh = [...allHits].filter((d) => !already.has(d)).sort();
        for (const d of fresh) optoutOps.push({ patternId: pid, day: d });
        generators.push({ kind: 'pattern', id: pid, label, action: 'optouts', daysSuppressed: fresh.length });
      }
    }
  }

  const result: ClearRangeResult = { mode, blocksDeleted: blocksToDelete.length, dailyPlanDeleted, generators };
  if (dryRun) return result;

  // ---- write (one atomic transaction: suppress first, then delete) -----------
  const delTags = sqlite.prepare(`DELETE FROM entity_tags WHERE entity_kind = 'time_block' AND entity_id = ?`);
  // Phase B (0134): entity_categories spans tables (no FK to time_blocks) — clean it
  // wherever entity_tags is cleaned, or hard-deleted blocks leave orphan category rows.
  const delCats = sqlite.prepare(`DELETE FROM entity_categories WHERE entity_kind = 'time_block' AND entity_id = ?`);
  const delBlock = sqlite.prepare(`DELETE FROM time_blocks WHERE id = ? AND owner_id = ?`);
  const capTB = sqlite.prepare(`UPDATE time_blocks SET recurrence_rule = ? WHERE id = ? AND owner_id = ?`);
  const capPat = sqlite.prepare(`UPDATE patterns SET recurrence_rule = ? WHERE id = ?`);
  const capTask = sqlite.prepare(`UPDATE tasks SET recurrence_rule = ? WHERE id = ?`);
  const setExdates = sqlite.prepare(`UPDATE time_blocks SET recurrence_exdates = ? WHERE id = ? AND owner_id = ?`);
  const insOptout = sqlite.prepare(`INSERT OR IGNORE INTO pattern_day_optouts (owner_id, pattern_id, date) VALUES (?, ?, ?)`);
  const dpDeleteSql = `DELETE FROM daily_plan WHERE ${dpWhere.join(' AND ')}`;

  const run = sqlite.transaction(() => {
    // time_blocks caps carry owner_id; pattern/task caps (owner-scoped via their reads
    // above) update their own tables by id.
    for (const c of capOps) {
      if (c.table === 'time_blocks') capTB.run(c.rule, c.id, owner);
      else (c.table === 'patterns' ? capPat : capTask).run(c.rule, c.id);
    }
    for (const e of exdateOps) setExdates.run(e.merged, e.id, owner);
    for (const o of optoutOps) insOptout.run(owner, o.patternId, o.day);
    for (const b of blocksToDelete) {
      delTags.run(b.id);
      delCats.run(b.id);
      delBlock.run(b.id, owner);
    }
    if (clearDailyPlan) sqlite.prepare(dpDeleteSql).run(...dpArgs);
  });
  run();
  return result;
}
