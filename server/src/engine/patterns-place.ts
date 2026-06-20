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
import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';
import { buildGaps, pickGap, splitIntoSessions, MS_PER_MIN } from './scheduler.js';

const DEFAULT_EST_MIN = 30;
const MIN_SESSION_MS = 15 * MS_PER_MIN;

export interface PlacePatternResult {
  patternId: number;
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
  task_id: number;
  title: string;
  estimated_minutes: number | null;
}

function tagsOf(taskId: number): string[] {
  return (
    sqlite
      .prepare(`SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = ?`)
      .all(taskId) as { name: string }[]
  ).map((r) => r.name);
}

/**
 * Resolve a pattern's member tasks to *placeable* tasks for a given day:
 * recurrence templates redirect to today's materialized instance when one
 * exists; completed/skipped/cancelled tasks are dropped.
 */
function resolveMembers(patternId: number, date: string): MemberTask[] {
  const members = sqlite
    .prepare(
      `SELECT t.id AS task_id, t.title, t.estimated_minutes, t.status,
              t.recurrence_rule, t.recurrence_parent_id
         FROM pattern_tasks pt JOIN tasks t ON t.id = pt.task_id
        WHERE pt.pattern_id = ?
        ORDER BY pt.position, pt.task_id`
    )
    .all(patternId) as {
      task_id: number;
      title: string;
      estimated_minutes: number | null;
      status: string;
      recurrence_rule: string | null;
      recurrence_parent_id: number | null;
    }[];

  const out: MemberTask[] = [];
  for (const m of members) {
    if (['completed', 'skipped', 'cancelled', 'missed'].includes(m.status)) continue;
    // Recurrence template? Prefer today's instance if it exists; else the template stays.
    if (m.recurrence_rule && m.recurrence_parent_id == null) {
      const inst = sqlite
        .prepare(`SELECT id, title, estimated_minutes FROM tasks WHERE recurrence_parent_id = ? AND occurrence_date = ?`)
        .get(m.task_id, date) as { id: number; title: string; estimated_minutes: number | null } | undefined;
      if (inst) {
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
export function placePatternOnDay(
  owner: number,
  patternId: number,
  opts: { date?: string; blockId?: number | null } = {}
): PlacePatternResult {
  const date = opts.date ?? localISODate();

  return sqlite.transaction((): PlacePatternResult => {
    const prefs = sqlite
      .prepare(`SELECT timezone, workday_start, workday_end, min_break_minutes, max_focus_block_minutes FROM scheduling_prefs WHERE owner_id = ?`)
      .get(owner) as PrefsRow | undefined;
    const tz = prefs?.timezone || serverTimezone();

    // Window (block's range or the workday).
    let windowStartMs: number;
    let windowEndMs: number;
    let blockTag: string | null = null;
    let parentBlockId: number | null = opts.blockId ?? null;
    if (parentBlockId != null) {
      const block = sqlite.prepare(`SELECT start_at, end_at, tag FROM time_blocks WHERE id = ?`).get(parentBlockId) as
        | { start_at: string; end_at: string; tag: string | null }
        | undefined;
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
    const marker = sqlite
      .prepare(
        `SELECT 1 FROM time_blocks
          WHERE source_kind = 'pattern' AND source_ref = ?
            AND start_at >= ? AND start_at < ?
          LIMIT 1`
      )
      .get(String(patternId), dayStartISO, dayEndISO);
    if (marker) {
      broadcast(owner, 'pattern:place_skipped', { patternId, date });
      return { patternId, date, blocksCreated: 0, placed: 0, unplaced: 0, skippedAlreadyPlaced: true };
    }

    // Members → placeable tasks.
    let toPlace = resolveMembers(patternId, date);
    if (blockTag) toPlace = toPlace.filter((t) => tagsOf(t.task_id).includes(blockTag!));
    if (toPlace.length === 0) {
      return { patternId, date, blocksCreated: 0, placed: 0, unplaced: 0, skippedAlreadyPlaced: false };
    }

    // Fixed obstacles inside the window (locked blocks + meetings, like Auto).
    const windowStartISO = new Date(windowStartMs).toISOString();
    const windowEndISO = new Date(windowEndMs).toISOString();
    const fixed = (
      sqlite
        .prepare(
          `SELECT start_at, end_at FROM time_blocks
            WHERE (is_locked = 1 OR block_kind = 'meeting') AND start_at < ? AND end_at > ?`
        )
        .all(windowEndISO, windowStartISO) as { start_at: string; end_at: string }[]
    ).map((b) => ({ start: Date.parse(b.start_at), end: Date.parse(b.end_at) }));

    const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;
    const maxFocusMs = Math.max((prefs?.max_focus_block_minutes ?? 90) * MS_PER_MIN, MIN_SESSION_MS);
    const gaps = buildGaps(windowStartMs, windowEndMs, fixed, breakMs);

    const ins = sqlite.prepare(
      `INSERT INTO time_blocks (task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, source_ref, status, parent_block_id)
       VALUES (?, ?, 'task', ?, ?, 0, 1, 'pattern', ?, 'planned', ?)`
    );
    let blocksCreated = 0;
    let placed = 0;
    let unplaced = 0;
    for (const t of toPlace) {
      const sessions = splitIntoSessions((t.estimated_minutes ?? DEFAULT_EST_MIN) * MS_PER_MIN, maxFocusMs);
      let placedSessions = 0;
      for (const want of sessions) {
        const pick = pickGap(gaps, want);
        if (!pick) break;
        const startMs = pick.gap.cursor;
        const endMs = startMs + pick.len;
        ins.run(t.task_id, t.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), String(patternId), parentBlockId);
        pick.gap.cursor = endMs + breakMs;
        blocksCreated++;
        placedSessions++;
      }
      placedSessions > 0 ? placed++ : unplaced++;
    }
    broadcast(owner, 'pattern:placed', { patternId, date, blocksCreated, placed, unplaced });
    return { patternId, date, blocksCreated, placed, unplaced, skippedAlreadyPlaced: false };
  })();
}
