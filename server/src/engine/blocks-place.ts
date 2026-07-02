/**
 * Place existing tasks INTO a Time-Block container (the "add tasks to a time block"
 * primitive behind `POST /api/blocks/:id/add-tasks`).
 *
 * The block-side counterpart of `patterns-place.ts`'s scoped routine placement: it
 * scatters a user-chosen set of tasks into a scheduled container's free time as child
 * task blocks (`parent_block_id = container`, so they move with the group). It reuses
 * the SAME gap math the scheduler/routine paths use — `dayObstacles` (existing children
 * + other fixed blocks in the window become obstacles, so new tasks never stack on what
 * is already there), `buildGaps`, `pickGap`, `splitIntoSessions`.
 *
 * Unlike the routine path these are `source_kind='manual'`, `is_auto=0` — they're
 * deliberate user placements, not agent/pattern output (so clear-day / pattern opt-outs
 * never touch them). Tasks already attached to this block, missing, or done are skipped.
 */
import { sqlite } from '../db/index.js';
import { broadcast } from '../routes/sse.js';
import { buildGaps, pickGap, splitIntoSessions, dayObstacles, MS_PER_MIN } from './scheduler.js';
import { applyTaskPlacementStatus, syncTaskFromBlock } from '../services/block-task-sync.js';

const DEFAULT_EST_MIN = 30;
const MIN_SESSION_MS = 15 * MS_PER_MIN;
const DONE_STATUSES = ['completed', 'done', 'skipped', 'cancelled', 'missed'];

export interface PlaceTasksResult {
  blockId: string;
  blocksCreated: number; // child block rows inserted (one per placed focus session)
  placed: number;        // tasks with >= 1 session placed
  unplaced: number;      // eligible tasks that found no gap
  skipped: number;       // ids dropped: missing / done / already a child / duplicate
}

interface PrefsRow { min_break_minutes: number | null; max_focus_block_minutes: number | null }
interface BlockRow { start_at: string; end_at: string; block_kind: string | null }
interface TaskRow { id: string; title: string; estimated_minutes: number | null; status: string }

/**
 * Scatter `taskIds` into the scheduled Time-Block `blockId`'s free gaps as child task
 * blocks. No-op (returns zeroes) for a non-container, a someday/zero-length block, or
 * an empty/all-ineligible id list. Concurrency-safe via a single SQLite transaction.
 */
export function placeTasksInBlock(owner: string, blockId: string, taskIds: string[]): PlaceTasksResult {
  return sqlite.transaction((): PlaceTasksResult => {
    const empty: PlaceTasksResult = { blockId, blocksCreated: 0, placed: 0, unplaced: 0, skipped: 0 };

    const block = sqlite
      .prepare(`SELECT start_at, end_at, block_kind FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get(blockId, owner) as BlockRow | undefined;
    if (!block || block.block_kind !== 'timeblock') return empty;
    const windowStartMs = Date.parse(block.start_at);
    const windowEndMs = Date.parse(block.end_at);
    if (!(windowEndMs > windowStartMs)) return empty; // someday / zero-length → no window to fill

    const prefs = sqlite
      .prepare(`SELECT min_break_minutes, max_focus_block_minutes FROM scheduling_prefs WHERE owner_id = ?`)
      .get(owner) as PrefsRow | undefined;
    const breakMs = (prefs?.min_break_minutes ?? 10) * MS_PER_MIN;
    const maxFocusMs = Math.max((prefs?.max_focus_block_minutes ?? 90) * MS_PER_MIN, MIN_SESSION_MS);

    // Tasks already inside this block — never double-add the same task.
    const already = new Set(
      (sqlite.prepare(`SELECT task_id FROM time_blocks WHERE parent_block_id = ? AND owner_id = ? AND task_id IS NOT NULL`).all(blockId, owner) as { task_id: string }[])
        .map((r) => r.task_id),
    );

    // Resolve + dedupe the requested ids, dropping ineligible ones.
    const seen = new Set<string>();
    const toPlace: TaskRow[] = [];
    let skipped = 0;
    for (const id of taskIds) {
      if (seen.has(id) || already.has(id)) { skipped++; continue; }
      seen.add(id);
      const t = sqlite
        .prepare(`SELECT id, title, estimated_minutes, status FROM tasks WHERE id = ? AND owner_id = ?`)
        .get(id, owner) as TaskRow | undefined;
      if (!t || DONE_STATUSES.includes(t.status)) { skipped++; continue; }
      toPlace.push(t);
    }
    if (toPlace.length === 0) return { ...empty, skipped };

    // Obstacles = the container's existing children + other fixed blocks overlapping the
    // window (the container itself is excluded; default !includePlans drops it anyway).
    const fixed = dayObstacles(owner, windowStartMs, windowEndMs, { excludeBlockId: blockId });
    const gaps = buildGaps(windowStartMs, windowEndMs, fixed, breakMs);

    const ins = sqlite.prepare(
      `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, status, parent_block_id)
       VALUES (uuid7(), ?, ?, ?, 'task', ?, ?, 0, 0, 'manual', 'planned', ?) RETURNING id`,
    );
    let blocksCreated = 0;
    let placed = 0;
    let unplaced = 0;
    for (const t of toPlace) {
      const sessions = splitIntoSessions((t.estimated_minutes ?? DEFAULT_EST_MIN) * MS_PER_MIN, maxFocusMs);
      let placedSessions = 0;
      let firstBlockId: string | undefined;
      for (const want of sessions) {
        const pick = pickGap(gaps, want);
        if (!pick) break;
        const startMs = pick.gap.cursor;
        const endMs = startMs + pick.len;
        const { id: bid } = ins.get(t.id, owner, t.title, new Date(startMs).toISOString(), new Date(endMs).toISOString(), blockId) as { id: string };
        firstBlockId ??= bid;
        pick.gap.cursor = endMs + breakMs;
        blocksCreated++;
        placedSessions++;
      }
      if (placedSessions > 0) {
        placed++;
        // A placed task IS scheduled: mirror the placement onto its scheduling-intent
        // fields (so its calendar label has a date/time even out of the loaded blocks
        // range) and flip open → scheduled — matching the other placement paths.
        if (firstBlockId) syncTaskFromBlock(firstBlockId, owner);
        applyTaskPlacementStatus(t.id, owner);
      } else unplaced++;
    }
    if (blocksCreated > 0) broadcast(owner, 'block:created', { parentBlockId: blockId, count: blocksCreated });
    return { blockId, blocksCreated, placed, unplaced, skipped };
  })();
}
