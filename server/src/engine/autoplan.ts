/**
 * Two-step Auto over the flight-plan (Phase G, ticket G4 / the A′ reframe).
 *
 * Auto **never** schedules anything outside the flight-plan:
 *  - **Step 1** (no SELECTED staged items) → propose open-task candidates *into*
 *    the flight-plan (unselected); schedule nothing.
 *  - **Step 2** (some selected) → **place** them into free gaps, scoped to a
 *    Time-Block's window + tag filter when `blockId` is given, reusing the Phase-A
 *    scheduler's gap math (`buildGaps`/`pickGap`/`splitIntoSessions`).
 *
 * The old nightly "pack the whole backlog" job is retired; the only thing it may do
 * now is `fillFlightPlanCandidates` (propose).
 */
import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { localISODate } from '../lib/dates.js';
import { buildGaps, pickGap, splitIntoSessions, MS_PER_MIN } from './scheduler.js';

const DEFAULT_EST_MIN = 30;
const MIN_SESSION_MS = 15 * MS_PER_MIN;
const CANDIDATE_LIMIT = 20;

export interface AutoResult {
  step: 'fill' | 'place';
  candidatesAdded?: number;
  blocksCreated?: number;
  placed?: number;
  unplaced?: number;
}

interface StagedTask {
  task_id: number;
  title: string;
  estimated_minutes: number | null;
}
interface PrefsRow {
  timezone: string | null;
  workday_start: string | null;
  workday_end: string | null;
  min_break_minutes: number | null;
  max_focus_block_minutes: number | null;
}

function selectedStaged(owner: number): StagedTask[] {
  return sqlite
    .prepare(
      `SELECT fp.task_id, t.title, t.estimated_minutes
         FROM flight_plan fp JOIN tasks t ON t.id = fp.task_id
        WHERE fp.owner_id = ? AND fp.selected = 1
        ORDER BY fp.position, t.priority, fp.task_id`
    )
    .all(owner) as StagedTask[];
}

function tagsOf(taskId: number): string[] {
  return (
    sqlite
      .prepare(`SELECT tags.name FROM tags JOIN task_tags ON tags.id = task_tags.tag_id WHERE task_tags.task_id = ?`)
      .all(taskId) as { name: string }[]
  ).map((r) => r.name);
}

/** STEP 1: propose open-task candidates (not already staged) into the flight-plan. */
export function fillFlightPlanCandidates(owner: number = currentOwnerId()): number {
  const candidates = sqlite
    .prepare(
      `SELECT id FROM tasks
        WHERE owner_id = ? AND status = 'open'
          AND id NOT IN (SELECT task_id FROM flight_plan WHERE owner_id = ?)
        ORDER BY priority, COALESCE(due_at, '9999-12-31'), id
        LIMIT ?`
    )
    .all(owner, owner, CANDIDATE_LIMIT) as { id: number }[];
  const { m } = sqlite.prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get(owner) as { m: number };
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 0, ?)`);
  let pos = m + 1;
  let added = 0;
  for (const c of candidates) if (ins.run(owner, c.id, pos++).changes > 0) added++;
  return added;
}

/** STEP 2: place the SELECTED staged tasks into free gaps (block-scoped if blockId). */
export function placeFlightPlan(owner: number = currentOwnerId(), opts: { date?: string; blockId?: number } = {}): AutoResult {
  const date = opts.date ?? localISODate();
  const prefs = sqlite
    .prepare(`SELECT timezone, workday_start, workday_end, min_break_minutes, max_focus_block_minutes FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as PrefsRow | undefined;
  const tz = prefs?.timezone || serverTimezone();

  // Window: a selected Time-Block's range, else the workday for `date`.
  let windowStartMs: number;
  let windowEndMs: number;
  let blockTag: string | null = null;
  if (opts.blockId != null) {
    const block = sqlite.prepare(`SELECT start_at, end_at, tag FROM time_blocks WHERE id = ?`).get(opts.blockId) as
      | { start_at: string; end_at: string; tag: string | null }
      | undefined;
    if (!block) return { step: 'place', blocksCreated: 0, placed: 0, unplaced: selectedStaged(owner).length };
    windowStartMs = Date.parse(block.start_at);
    windowEndMs = Date.parse(block.end_at);
    blockTag = block.tag;
  } else {
    windowStartMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_start ?? '09:00', tz));
    windowEndMs = Date.parse(zonedWallTimeToUTC(date, prefs?.workday_end ?? '18:00', tz));
  }
  if (windowEndMs <= windowStartMs) return { step: 'place', blocksCreated: 0, placed: 0, unplaced: 0 };
  const windowStartISO = new Date(windowStartMs).toISOString();
  const windowEndISO = new Date(windowEndMs).toISOString();

  // Which staged tasks to place: selected, filtered to the block's tag if any.
  let toPlace = selectedStaged(owner);
  if (blockTag) toPlace = toPlace.filter((t) => tagsOf(t.task_id).includes(blockTag!));

  // Re-place idempotently: clear our own prior auto, unlocked, un-actioned task
  // blocks inside the window first (containers/meetings/locked are preserved).
  sqlite
    .prepare(
      `DELETE FROM time_blocks
        WHERE is_auto = 1 AND is_locked = 0 AND block_kind = 'task'
          AND status NOT IN ('completed','skipped')
          AND start_at < ? AND end_at > ?`
    )
    .run(windowEndISO, windowStartISO);

  // Fixed obstacles overlapping the window: locked blocks + meetings.
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

  // When placing into a Plan (blockId given), every task block we create is a
  // formal member of that Plan (parent_block_id) so it moves with the group (PR-C).
  const parentBlockId = opts.blockId ?? null;
  const ins = sqlite.prepare(
    `INSERT INTO time_blocks (task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, parent_block_id)
     VALUES (?, ?, 'task', ?, ?, 0, 1, 'agent', 'planned', ?)`
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
      ins.run(t.task_id, t.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), parentBlockId);
      pick.gap.cursor = endMs + breakMs;
      blocksCreated++;
      placedSessions++;
    }
    placedSessions > 0 ? placed++ : unplaced++;
  }
  broadcast(owner, 'auto:placed', { blocksCreated, placed, unplaced });
  return { step: 'place', blocksCreated, placed, unplaced };
}

/**
 * The two-step Auto entry point. No selected staged items → propose candidates;
 * some selected → place them. Never touches anything outside the flight-plan.
 */
export function runAuto(opts: { date?: string; blockId?: number } = {}): AutoResult {
  const owner = currentOwnerId();
  if (selectedStaged(owner).length === 0) {
    const added = fillFlightPlanCandidates(owner);
    broadcast(owner, 'flight_plan:filled', { added });
    return { step: 'fill', candidatesAdded: added };
  }
  return placeFlightPlan(owner, opts);
}
