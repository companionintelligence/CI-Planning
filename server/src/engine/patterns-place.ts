/**
 * Pattern → board placement (PR-C+, Phase C). The user-visible primitive replacing
 * the old "stage pattern into the flight-plan" gesture: a pattern's member tasks
 * are auto-placed *directly* into today's free gaps as task blocks.
 *
 * Idempotency rides on a **marker** on the placed time_blocks: rows from this
 * engine carry `source_kind='pattern'` + `source_ref=String(patternId)`. A
 * second call for the same (pattern, day) sees the marker and short-circuits —
 * which means the user can delete the placed blocks and re-run to "place again
 * from scratch" with no state living anywhere else.
 *
 * Reuses the same `buildGaps` / `pickGap` / `splitIntoSessions` math the
 * flight-plan's Auto step-2 uses (see `engine/autoplan.ts:84-164`). Window
 * setup mirrors `placeFlightPlan`: a block's range when `blockId` is given,
 * otherwise the workday from `scheduling_prefs`.
 */
import { store } from '../db/store.js';
import { broadcast } from '../routes/sse.js';
import { serverTimezone, zonedWallTimeToUTC, localDateInTZ } from '../lib/tz.js';
import { localISODate, addDays } from '../lib/dates.js';
import { buildGaps, pickGap, splitIntoSessions, dayObstacles, MS_PER_MIN } from './scheduler.js';
import { occurrencesBetween, parseRule } from './recurrence.js';
import { taskTagNames, routineDerivedTags, syncLeveledEntityTags } from '../services/tags.js';
import { syncTaskFromBlock, applyTaskPlacementStatus } from '../services/block-task-sync.js';

const DEFAULT_EST_MIN = 30;
const MIN_SESSION_MS = 15 * MS_PER_MIN;

export interface PlacePatternResult {
  patternId: string;
  date: string;                // local YYYY-MM-DD the placement targeted
  blocksCreated: number;       // task_blocks rows inserted
  placed: number;              // tasks with >= 1 session placed
  unplaced: number;            // tasks with no fit
  skippedAlreadyPlaced: boolean; // marker query short-circuited
}

interface PrefsRow {
  timezone: string | null;
  workday_start: string | null;
  workday_end: string | null;
  min_break_minutes: number | null;
  max_focus_block_minutes: number | null;
}

interface MemberTask {
  task_id: string;
  title: string;
  estimated_minutes: number | null;
}

function tagsOf(taskId: string): string[] {
  return taskTagNames(taskId);
}

/**
 * Resolve a pattern's member tasks to *placeable* tasks for a given day:
 * recurrence templates redirect to today's materialized instance when one
 * exists; completed/skipped/cancelled tasks are dropped.
 */
async function resolveMembers(owner: string, patternId: string, date: string): Promise<MemberTask[]> {
  // Owner-scope the membership join: even if a stray pattern_tasks row references
  // another owner's task, its title/estimate must never surface on this owner's planner.
  const members = await store()
    .prepare(
      `SELECT t.id AS task_id, t.title, t.estimated_minutes, t.status,
              t.recurrence_rule, t.recurrence_parent_id
         FROM pattern_tasks pt JOIN tasks t ON t.id = pt.task_id
        WHERE pt.pattern_id = ? AND t.owner_id = ?
        ORDER BY pt.position, pt.task_id`
    )
    .all<{
      task_id: string;
      title: string;
      estimated_minutes: number | null;
      status: string;
      recurrence_rule: string | null;
      recurrence_parent_id: string | null;
    }>(patternId, owner);

  const out: MemberTask[] = [];
  for (const m of members) {
    if (['completed', 'skipped', 'cancelled', 'missed'].includes(m.status)) continue;
    // Recurrence template? Prefer this day's instance if it exists; else the template
    // stays (placed for the day). Skip an instance already resolved (done/skipped/
    // cancelled) so a completed occurrence isn't re-placed.
    if (m.recurrence_rule && m.recurrence_parent_id == null) {
      const inst = await store()
        .prepare(`SELECT id, title, estimated_minutes, status FROM tasks WHERE recurrence_parent_id = ? AND occurrence_date = ? AND owner_id = ?`)
        .get<{ id: string; title: string; estimated_minutes: number | null; status: string }>(m.task_id, date, owner);
      if (inst) {
        if (['completed', 'done', 'skipped', 'cancelled', 'missed'].includes(inst.status)) continue;
        out.push({ task_id: inst.id, title: inst.title, estimated_minutes: inst.estimated_minutes });
        continue;
      }
    }
    out.push({ task_id: m.task_id, title: m.title, estimated_minutes: m.estimated_minutes });
  }
  return out;
}

/**
 * Place a single pattern's member tasks into the day's free gaps. Idempotent
 * via the (source_kind='pattern', source_ref=patternId, day-bounds) marker;
 * concurrent callers serialize via a SQLite transaction.
 *
 * `blockId` (optional) scopes placement to a Plan's window and inherits its
 * parent_block_id on the placed blocks (so the new tasks join that Plan's
 * grouped-movement group — see PR-C).
 */
export async function placePatternOnDay(
  owner: string,
  patternId: string,
  opts: { date?: string; blockId?: string | null } = {}
): Promise<PlacePatternResult> {
  const date = opts.date ?? localISODate();

  return await store().transaction(async (): Promise<PlacePatternResult> => {
    // Per-day opt-out (0074): a user who deletes a lazily-placed container removes
    // that (pattern, day) — honour it so the block doesn't regenerate on the next
    // read. Only the free/auto path checks this; an explicit "place into this Plan"
    // (blockId given) is deliberate and overrides the opt-out.
    if (opts.blockId == null) {
      const optedOut = await store()
        .prepare(`SELECT 1 FROM pattern_day_optouts WHERE owner_id = ? AND pattern_id = ? AND date = ? LIMIT 1`)
        .get(owner, String(patternId), date);
      if (optedOut) {
        return { patternId, date, blocksCreated: 0, placed: 0, unplaced: 0, skippedAlreadyPlaced: true };
      }
    }

    const prefs = await store()
      .prepare(`SELECT timezone, workday_start, workday_end, min_break_minutes, max_focus_block_minutes FROM scheduling_prefs WHERE owner_id = ?`)
      .get<PrefsRow>(owner);
    const tz = prefs?.timezone || serverTimezone();

    // Window (block's range or the workday).
    let windowStartMs: number;
    let windowEndMs: number;
    let blockTag: string | null = null;
    let parentBlockId: string | null = opts.blockId ?? null;
    if (parentBlockId != null) {
      const block = await store()
        .prepare(`SELECT start_at, end_at, tag FROM time_blocks WHERE id = ? AND owner_id = ?`)
        .get<{ start_at: string; end_at: string; tag: string | null }>(parentBlockId, owner);
      if (!block) {
        return { patternId, date, blocksCreated: 0, placed: 0, unplaced: 0, skippedAlreadyPlaced: false };
      }
      windowStartMs = Date.parse(block.start_at);
      windowEndMs = Date.parse(block.end_at);
      blockTag = block.tag;
    } else {
      windowStartMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_start ?? '09:00', tz));
      windowEndMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_end ?? '18:00', tz));
    }
    if (windowEndMs <= windowStartMs) {
      return { patternId, date, blocksCreated: 0, placed: 0, unplaced: 0, skippedAlreadyPlaced: false };
    }

    // Marker: any pattern-owned blocks inside today's local day window already?
    // Use the local day's UTC bounds so the check is independent of the placement
    // window (a user re-running for the same day after deleting must succeed).
    const dayStartISO = zonedWallTimeToUTC(date, '00:00', tz);
    const dayEndMs = Date.parse(dayStartISO) + 24 * 60 * 60_000;
    const dayEndISO = new Date(dayEndMs).toISOString();
    const marker = await store()
      .prepare(
        `SELECT 1 FROM time_blocks
          WHERE owner_id = ? AND source_kind = 'pattern' AND source_ref = ?
            AND start_at >= ? AND start_at < ?
          LIMIT 1`
      )
      .get(owner, String(patternId), dayStartISO, dayEndISO);
    if (marker) {
      broadcast(owner, 'pattern:place_skipped', { patternId, date });
      return { patternId, date, blocksCreated: 0, placed: 0, unplaced: 0, skippedAlreadyPlaced: true };
    }

    // Members → placeable tasks.
    let toPlace = await resolveMembers(owner, patternId, date);
    if (blockTag) toPlace = toPlace.filter((t) => tagsOf(t.task_id).includes(blockTag!));
    if (toPlace.length === 0) {
      return { patternId, date, blocksCreated: 0, placed: 0, unplaced: 0, skippedAlreadyPlaced: false };
    }

    // Shared obstacle set: locked + meetings + every non-completed task block,
    // so a pattern never stacks on existing work (manual or auto). When scoped
    // to a Plan we exclude that Plan from its own obstacle set (it's the target).
    const fixed = dayObstacles(owner, windowStartMs, windowEndMs, { excludeBlockId: parentBlockId });

    const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;
    const maxFocusMs = Math.max((prefs?.max_focus_block_minutes ?? 90) * MS_PER_MIN, MIN_SESSION_MS);
    const gaps = buildGaps(windowStartMs, windowEndMs, fixed, breakMs);

    // `prepare` is synchronous on the facade (only get/all/run are async), so this stays
    // a plain reused statement — the conformance suite pins that reusability.
    const ins = store().prepare(
      `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, source_ref, status, parent_block_id)
       VALUES (uuid7(), ?, ?, ?, 'task', ?, ?, 0, 1, 'pattern', ?, 'planned', ?) RETURNING id`
    );
    // A placed routine member IS scheduled: mirror the placement onto the task's
    // scheduling-intent fields (so its calendar icon has a date) and flip open →
    // scheduled. syncTaskFromBlock self-guards to the earliest placement, so calling
    // it per-session is correct; applyTaskPlacementStatus is idempotent after the flip.
    const syncPlacedMember = (blockId: string, taskId: string) => {
      syncTaskFromBlock(blockId, owner);
      applyTaskPlacementStatus(taskId, owner);
    };
    let blocksCreated = 0;
    let placed = 0;
    let unplaced = 0;

    if (parentBlockId != null) {
      // Scoped to an existing Plan: scatter the member tasks into the Plan's free gaps.
      // They inherit the Plan's parent_block_id, so they already move with that group.
      for (const t of toPlace) {
        const sessions = splitIntoSessions((t.estimated_minutes ?? DEFAULT_EST_MIN) * MS_PER_MIN, maxFocusMs);
        let placedSessions = 0;
        for (const want of sessions) {
          const pick = pickGap(gaps, want);
          if (!pick) break;
          const startMs = pick.gap.cursor;
          const endMs = startMs + pick.len;
          const { id: bid } = (await ins.get<{ id: string }>(t.task_id, owner, t.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), String(patternId), parentBlockId))!;
          syncPlacedMember(bid, t.task_id);
          pick.gap.cursor = endMs + breakMs;
          blocksCreated++;
          placedSessions++;
        }
        placedSessions > 0 ? placed++ : unplaced++;
      }
    } else {
      // Free placement: lay the routine out CONTIGUOUSLY in a single gap and wrap it in a
      // Plan container (block_kind='timeblock'), parenting each task block to it. The
      // existing move-group then moves the whole routine together — "a container like a
      // time-block". The container shares the pattern marker so it's idempotent, survives
      // clear-day (source_kind='pattern'), and cascades on delete.
      const meta = await store().prepare(`SELECT name FROM patterns WHERE id = ?`).get<{ name: string }>(patternId);
      // AF-11: the container stamp comes from the routine's DERIVED direction union
      // (patterns.tag is authored-no-more and NULL after 0120). The stamp is cosmetic
      // (§7b — placement never reads it), but downstream single-tag readers exist
      // (inheritContainerDirection, `#tag` chips), so we do NOT comma-join: the FIRST
      // derived direction lands in the `tag` column (+ entity_tags level 1, matching
      // API-created blocks) and the REST become level-2 secondary tags — same shape
      // applyBlockTagLevels writes. No derived direction → no stamp.
      const derivedDirs = routineDerivedTags(patternId).directions;
      const containerTag = derivedDirs[0] ?? null;
      const seq: { task: MemberTask; lenMs: number }[] = [];
      for (const t of toPlace) {
        for (const lenMs of splitIntoSessions((t.estimated_minutes ?? DEFAULT_EST_MIN) * MS_PER_MIN, maxFocusMs)) {
          seq.push({ task: t, lenMs });
        }
      }
      const totalMs = seq.reduce((s, x) => s + x.lenMs, 0) + Math.max(0, seq.length - 1) * breakMs;
      const pick = pickGap(gaps, totalMs); // a gap that fits the whole routine, else the largest (truncated)
      if (pick) {
        const limit = pick.gap.cursor + pick.len;
        let cursor = pick.gap.cursor;
        const layout: { task: MemberTask; startMs: number; endMs: number }[] = [];
        for (const s of seq) {
          if (cursor + s.lenMs > limit) break; // routine overflows this gap → the rest is unplaced
          layout.push({ task: s.task, startMs: cursor, endMs: cursor + s.lenMs });
          cursor = cursor + s.lenMs + breakMs;
        }
        if (layout.length > 0) {
          // Container first (so the FK parent exists before its children).
          const containerEndMs = layout[layout.length - 1].endMs;
          // Parens around the whole await: `await f(…).id` would read `.id` off the
          // PENDING promise and silently yield undefined.
          const containerId = (await store()
            .prepare(
              `INSERT INTO time_blocks (id, owner_id, title, block_kind, block_type, tag, start_at, end_at, is_locked, is_auto, source_kind, source_ref, status)
               VALUES (uuid7(), ?, ?, 'timeblock', 'scheduled', ?, ?, ?, 0, 1, 'pattern', ?, 'planned') RETURNING id`,
            )
            .get<{ id: string }>(owner, meta?.name ?? 'Routine', containerTag, new Date(pick.gap.cursor).toISOString(), new Date(containerEndMs).toISOString(), String(patternId)))!.id;
          if (derivedDirs.length > 0) {
            syncLeveledEntityTags('time_block', containerId, [
              { level: 1, names: [derivedDirs[0]] },
              { level: 2, names: derivedDirs.slice(1) },
            ], owner);
          }
          const placedTaskIds = new Set<string>();
          for (const l of layout) {
            const { id: bid } = (await ins.get<{ id: string }>(l.task.task_id, owner, l.task.title, new Date(l.startMs).toISOString(), new Date(l.endMs).toISOString(), String(patternId), containerId))!;
            syncPlacedMember(bid, l.task.task_id);
            blocksCreated++;
            placedTaskIds.add(l.task.task_id);
          }
          placed = placedTaskIds.size;
        }
        unplaced = toPlace.length - placed;
      } else {
        unplaced = toPlace.length;
      }
    }
    broadcast(owner, 'pattern:placed', { patternId, date, blocksCreated, placed, unplaced });
    return { patternId, date, blocksCreated, placed, unplaced, skippedAlreadyPlaced: false };
  });
}

// ── Pattern recurrence + nightly auto-place (Phase D) ──────────────────────────

interface RecurringPattern {
  id: string;
  name: string;
  type_name: string;
}

/**
 * Owner's patterns whose recurrence rule fires on the given local YYYY-MM-DD.
 * Ritual rows are excluded — the type is hidden behind a flag in V1. Patterns
 * with no rule are ignored.
 */
export async function patternsRecurringOnDate(owner: string, today: string): Promise<RecurringPattern[]> {
  const tz = (await store().prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get<{ timezone: string | null }>(owner))?.timezone || serverTimezone();
  // Routine patterns carry the recurrence on the PATTERN row. Habit patterns carry
  // it on the member habit TASK (`tasks.is_habit` + recurrence on the task template) —
  // `ensureHabitPattern` never copies a rule onto the pattern — so we read the habit's
  // rule from its member task. Union both sources.
  const rows = await store()
    .prepare(
      `SELECT p.id, p.name, p.recurrence_rule AS rule, p.recurrence_dtstart AS dtstart, pt.name AS type_name
         FROM patterns p
         JOIN pattern_types pt ON pt.id = p.type_id
        WHERE p.owner_id = ? AND pt.name IN ('Habit', 'Routine') AND p.recurrence_rule IS NOT NULL
       UNION ALL
       SELECT p.id, p.name, t.recurrence_rule AS rule, t.recurrence_dtstart AS dtstart, pt.name AS type_name
         FROM patterns p
         JOIN pattern_types pt ON pt.id = p.type_id
         JOIN pattern_tasks ptk ON ptk.pattern_id = p.id
         JOIN tasks t ON t.id = ptk.task_id
        WHERE p.owner_id = ? AND pt.name = 'Habit'
          AND t.recurrence_rule IS NOT NULL AND t.recurrence_parent_id IS NULL`
    )
    .all<{ id: string; name: string; rule: string; dtstart: string | null; type_name: string }>(owner, owner);

  const out: RecurringPattern[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id) || !r.dtstart) continue; // already matched, or malformed → skip
    try {
      const hits = occurrencesBetween(
        { recurrenceRule: r.rule, recurrenceDtstart: r.dtstart, taskTime: null, recurrenceExdates: [], timezone: tz },
        today,
        today,
      );
      if (hits.length > 0) { seen.add(r.id); out.push({ id: r.id, name: r.name, type_name: r.type_name }); }
    } catch {
      // a malformed rule shouldn't take down the job — skip the pattern
    }
  }
  return out;
}

/**
 * Lazy placement triggered by the day-view read (GET /api/blocks). For each
 * future-or-today local day intersecting [fromUtcISO, toUtcISO], place every
 * recurring pattern that fires that day. Idempotent — the marker on time_blocks
 * makes repeat calls a no-op, so the read endpoint can call this every time.
 *
 * Past days are skipped (no backfill). A recurring Routine the user creates
 * mid-day appears on the board the moment that day is next read, without any
 * cron in the loop.
 */
export async function ensurePatternsForRange(owner: string, fromUtcISO: string, toUtcISO: string): Promise<{ placed: number; blocksCreated: number }> {
  const prefsRow = await store()
    .prepare(`SELECT timezone, enable_routines, recurrence_horizon_days FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ timezone: string | null; enable_routines: number | null; recurrence_horizon_days: number | null }>(owner);
  const tz = prefsRow?.timezone || serverTimezone();
  // Routines are gated behind a feature flag (0073, default OFF). When disabled,
  // recurring Routine patterns must NOT auto-place: otherwise a user-deleted
  // Routine container regenerates on the very next read (the refetch fired right
  // after the delete), making it impossible to remove. Habits are unaffected.
  const routinesEnabled = !!prefsRow?.enable_routines;
  // "Today" in the OWNER's timezone (not the server's) so it lines up with the
  // prefs-tz day set from localDaysInRange — otherwise the horizon boundary could
  // drop/keep the wrong edge day when server TZ ≠ prefs TZ.
  const today = localDateInTZ(new Date().toISOString(), tz);
  // Phase P (0091): materialize at most `recurrence_horizon_days` days from today
  // (inclusive), so navigating far into the future never auto-fills the planner.
  const horizonDays = prefsRow?.recurrence_horizon_days ?? 7;
  const horizonEnd = addDays(today, horizonDays - 1);
  const days = localDaysInRange(fromUtcISO, toUtcISO, tz).filter((d) => d >= today && d <= horizonEnd);
  let placed = 0;
  let blocksCreated = 0;
  for (const day of days) {
    // Sequential on purpose: each placement reads the marker rows the previous one
    // wrote, so running the days (or the patterns within a day) concurrently would
    // let two placements both miss the marker and double-place.
    for (const p of await patternsRecurringOnDate(owner, day)) {
      if (p.type_name === 'Routine' && !routinesEnabled) continue;
      const r = await placePatternOnDay(owner, p.id, { date: day });
      if (!r.skippedAlreadyPlaced && r.blocksCreated > 0) placed++;
      blocksCreated += r.blocksCreated;
    }
  }
  return { placed, blocksCreated };
}

/**
 * Local YYYY-MM-DD calendar days that intersect [fromUtcISO, toUtcISO] in `tz`,
 * inclusive. The boundary edge cases (a window of width 0 or sub-day) collapse
 * to a single day. We step in 24h chunks anchored at the start instant — this
 * is correct because we only need the *set* of local days the range touches,
 * not the count of seconds per day. DST adds/drops up to one hour from a day,
 * which never moves a hit's derived local date when sampled at noon.
 */
export function localDaysInRange(fromUtcISO: string, toUtcISO: string, tz: string): string[] {
  const startMs = Date.parse(fromUtcISO);
  const endMs = Math.max(Date.parse(toUtcISO), startMs);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localOf = (ms: number) => {
    const parts = fmt.formatToParts(new Date(ms));
    const p: Record<string, string> = {};
    for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day}`;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  // Step every 12h so a DST short day still gets sampled inside its local window.
  const step = 12 * 60 * 60_000;
  for (let ms = startMs; ms <= endMs + step; ms += step) {
    const d = localOf(Math.min(ms, endMs));
    if (!seen.has(d)) { seen.add(d); out.push(d); }
    if (ms >= endMs) break;
  }
  return out.sort();
}

/** Validate that an RRULE is acceptable on a pattern — reuses `parseRule`. */
export function validatePatternRule(rule: string): { ok: true; rule: string } | { ok: false; error: string } {
  return parseRule(rule);
}

