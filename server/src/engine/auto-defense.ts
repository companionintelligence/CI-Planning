/**
 * B1 — Reactive reflow core (Phase M Workstream B).
 *
 * `reflow(owner, date)` re-places only the movable auto blocks for the day,
 * deterministically, from the frozen `daily_plan` order. It never calls the LLM.
 *
 * Anti-thrash rules (in priority order):
 *   1. In-progress blocks are never moved.
 *   2. Recently-moved blocks (last_moved_at within STABILITY_WINDOW_MS) are frozen.
 *   3. All other auto blocks are cleared and re-placed from daily_plan order.
 *
 * The "freeze as locked → placeFlightPlan → unfreeze" pattern reuses the existing
 * obstacle machinery in placeFlightPlan without touching its internals:
 *   - freezeAsLocked sets is_locked = 1 on protected blocks so clearPriorAuto skips
 *     them and dayObstacles treats them as fixed obstacles.
 *   - unfreeze (in finally) always restores the original is_locked value, even on throw.
 */
import { sqlite } from '../db/index.js';
import { placeFlightPlan } from './autoplan.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { localISODate } from '../lib/dates.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';

const STABILITY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 1500; // B2: per-owner trailing debounce — collapse a burst of triggers to one reflow

// ─── Public types ────────────────────────────────────────────────────────────

export interface BlockMove {
  block_id: string;
  task_id: string;
  before: { start_at: string; end_at: string };
  after: { start_at: string; end_at: string };
}

export interface ReflowDiff {
  moved: BlockMove[];
  removed: { block_id: string; task_id: string }[];
  added: { block_id: string; task_id: string }[];
  unplaced: string[]; // task_ids in daily_plan that couldn't be placed
}

// ─── Private types ───────────────────────────────────────────────────────────

interface BlockSnapshot {
  id: string;
  task_id: string;
  start_at: string;
  end_at: string;
  is_locked: number;
  status: string;
  last_moved_at: string | null;
}

type TaskTimeMap = Map<string, { block_id: string; start_at: string; end_at: string }>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function snapshotAutoBlocks(dayStartISO: string, dayEndISO: string): BlockSnapshot[] {
  return sqlite
    .prepare(
      `SELECT id, task_id, start_at, end_at, is_locked, status, last_moved_at
         FROM time_blocks
        WHERE task_id IS NOT NULL
          AND is_auto = 1 AND block_kind = 'task' AND source_kind = 'agent'
          AND start_at < ? AND end_at > ?
          AND status NOT IN ('completed', 'skipped', 'cancelled')`
    )
    .all(dayEndISO, dayStartISO) as BlockSnapshot[];
}

/** Build a task_id-keyed map from a snapshot, keeping the earliest block per task. */
function toTaskMap(snapshot: BlockSnapshot[]): TaskTimeMap {
  const m: TaskTimeMap = new Map();
  for (const b of snapshot) {
    const existing = m.get(b.task_id);
    if (!existing || b.start_at < existing.start_at) {
      m.set(b.task_id, { block_id: b.id, start_at: b.start_at, end_at: b.end_at });
    }
  }
  return m;
}

function computeProtected(snapshot: BlockSnapshot[], nowMs: number): Set<string> {
  const ids = new Set<string>();
  for (const b of snapshot) {
    if (b.status === 'in_progress') { ids.add(b.id); continue; }
    if (b.last_moved_at && nowMs - Date.parse(b.last_moved_at) < STABILITY_WINDOW_MS) {
      ids.add(b.id);
    }
  }
  return ids;
}

function freezeAsLocked(blockIds: string[]): Map<string, number> {
  const original = new Map<string, number>();
  const stmt = sqlite.prepare(`SELECT is_locked FROM time_blocks WHERE id = ?`);
  const upd = sqlite.prepare(`UPDATE time_blocks SET is_locked = 1 WHERE id = ?`);
  for (const id of blockIds) {
    const row = stmt.get(id) as { is_locked: number } | undefined;
    if (row !== undefined) {
      original.set(id, row.is_locked);
      upd.run(id);
    }
  }
  return original;
}

function unfreeze(original: Map<string, number>): void {
  const upd = sqlite.prepare(`UPDATE time_blocks SET is_locked = ? WHERE id = ?`);
  for (const [id, wasLocked] of original) {
    upd.run(wasLocked, id);
  }
}

function restageFromDailyPlan(owner: string, date: string, protectedTaskIds: Set<string>): Set<string> {
  const rows = sqlite
    .prepare(
      `SELECT dp.task_id, dp.position
         FROM daily_plan dp
         JOIN tasks t ON t.id = dp.task_id
        WHERE dp.owner_id = ? AND dp.date = ? AND t.status = 'open'
        ORDER BY dp.position`
    )
    .all(owner, date) as { task_id: string; position: number }[];

  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`
  );
  const staged = new Set<string>();
  for (const row of rows) {
    if (protectedTaskIds.has(row.task_id)) continue;
    ins.run(owner, row.task_id, row.position);
    staged.add(row.task_id);
  }
  return staged;
}

function diffBlocks(before: TaskTimeMap, after: TaskTimeMap): Omit<ReflowDiff, 'unplaced'> {
  const moved: BlockMove[] = [];
  const removed: { block_id: string; task_id: string }[] = [];
  const added: { block_id: string; task_id: string }[] = [];

  for (const [taskId, bBefore] of before) {
    const bAfter = after.get(taskId);
    if (!bAfter) {
      removed.push({ block_id: bBefore.block_id, task_id: taskId });
    } else if (bBefore.start_at !== bAfter.start_at || bBefore.end_at !== bAfter.end_at) {
      moved.push({
        block_id: bAfter.block_id,
        task_id: taskId,
        before: { start_at: bBefore.start_at, end_at: bBefore.end_at },
        after: { start_at: bAfter.start_at, end_at: bAfter.end_at },
      });
    }
  }

  for (const [taskId, bAfter] of after) {
    if (!before.has(taskId)) {
      added.push({ block_id: bAfter.block_id, task_id: taskId });
    }
  }

  return { moved, removed, added };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Re-place all movable auto blocks for `date` deterministically from the frozen
 * `daily_plan` order. Protected blocks (in-progress, recently moved) are frozen
 * as locked so `placeFlightPlan` routes around them as fixed obstacles.
 *
 * Never calls the LLM. Returns a diff of what moved, was removed, or was added.
 */
export function reflow(
  owner: string = currentOwnerId(),
  date?: string,
  _reason?: string
): ReflowDiff {
  const prefs = sqlite
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { timezone: string | null } | undefined;
  const tz = prefs?.timezone || serverTimezone();
  const d = date ?? localISODate();

  const dayStartISO = zonedWallTimeToUTC(d, '00:00', tz);
  const dayEndISO = new Date(Date.parse(dayStartISO) + 24 * 60 * 60_000).toISOString();

  // 1. Snapshot auto blocks before any changes.
  const snapshot = snapshotAutoBlocks(dayStartISO, dayEndISO);
  const beforeMap = toTaskMap(snapshot);

  // 2. Which blocks are protected (in-progress or recently moved)?
  const nowMs = Date.now();
  const protectedIds = computeProtected(snapshot, nowMs);
  const protectedTaskIds = new Set(
    [...protectedIds]
      .map((id) => snapshot.find((b) => b.id === id)?.task_id)
      .filter((t): t is string => t != null)
  );

  // 3. Freeze protected blocks so clearPriorAuto and dayObstacles skip them.
  const originalLocks = freezeAsLocked([...protectedIds]);

  try {
    // 4. Re-stage movable tasks from daily_plan into flight_plan.
    const stagedTaskIds = restageFromDailyPlan(owner, d, protectedTaskIds);

    // 5. Place: clearPriorAuto removes non-locked auto blocks; placeFlightPlan
    //    re-places staged tasks around the now-locked protected blocks.
    placeFlightPlan(owner, { date: d });

    // 6. Snapshot after and compute the diff.
    const afterSnapshot = snapshotAutoBlocks(dayStartISO, dayEndISO);
    const afterMap = toTaskMap(afterSnapshot);
    const { moved, removed, added } = diffBlocks(beforeMap, afterMap);

    // 7. Stamp last_moved_at on blocks that actually changed time.
    const nowISO = new Date(nowMs).toISOString();
    const stamp = sqlite.prepare(`UPDATE time_blocks SET last_moved_at = ? WHERE id = ?`);
    for (const m of moved) stamp.run(nowISO, m.block_id);

    // 8. Unplaced = tasks we re-staged but that didn't end up with a block.
    const unplaced = [...stagedTaskIds].filter((id) => !afterMap.has(id));

    return { moved, removed, added, unplaced };
  } finally {
    // Always restore is_locked, even if placeFlightPlan threw.
    unfreeze(originalLocks);
  }
}

// ─── B2: triggers + debounce ───────────────────────────────────────────────────

const pendingReplans = new Map<string, ReturnType<typeof setTimeout>>(); // owner → trailing timer
const reflowing = new Set<string>(); // owner currently inside a reflow (re-entrancy guard)

/** Reflow is gated per owner by scheduling_prefs.auto_defense_enabled (default on). */
function autoDefenseEnabled(owner: string): boolean {
  const row = sqlite
    .prepare(`SELECT auto_defense_enabled FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { auto_defense_enabled: number } | undefined;
  return (row?.auto_defense_enabled ?? 1) === 1;
}

/** Run one reflow now and broadcast the diff. Swallows errors — never throws to a timer. */
function fireReplan(owner: string, date: string | undefined, reason: string): void {
  if (reflowing.has(owner)) return; // re-entrancy: a reflow's own writes must not re-trigger
  reflowing.add(owner);
  try {
    const diff = reflow(owner, date, reason);
    broadcast(owner, 'schedule:done', { reason, ...diff });
  } catch (err) {
    logger.warn('reflow failed (requestReplan)', { owner, reason, err: String(err) });
  } finally {
    reflowing.delete(owner);
  }
}

/**
 * B2 — request a reactive reflow. A burst of calls for one owner within DEBOUNCE_MS
 * collapses to a single trailing reflow. Gated by `auto_defense_enabled`; a re-entrancy
 * guard stops a reflow from triggering itself; never throws into a caller's handler.
 */
export function requestReplan(reason: string, owner: string = currentOwnerId(), date?: string): void {
  try {
    if (!autoDefenseEnabled(owner)) return;
    if (reflowing.has(owner)) return; // ignore triggers raised during an in-flight reflow
    const existing = pendingReplans.get(owner);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingReplans.delete(owner);
      fireReplan(owner, date, reason);
    }, DEBOUNCE_MS);
    // A pending debounce must never keep the process (or a test runner) alive.
    if (typeof timer.unref === 'function') timer.unref();
    pendingReplans.set(owner, timer);
  } catch {
    // requestReplan is called from request/sync handlers — it must never throw.
  }
}

/**
 * B2 — missed-block sweep. Auto task blocks whose planned end is in the past but were
 * never started/completed are marked 'skipped' (missed) and their task re-staged into
 * flight_plan, so the next reflow re-places the work into the remaining day. Returns
 * counts; does not itself reflow (the caller decides — the cron pairs it with requestReplan).
 */
export function sweepMissedBlocks(
  owner: string = currentOwnerId(),
  date?: string,
  now: number = Date.now(),
): { skipped: number; requeued: number } {
  const prefs = sqlite
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as { timezone: string | null } | undefined;
  const tz = prefs?.timezone || serverTimezone();
  const d = date ?? localISODate();
  const dayStartISO = zonedWallTimeToUTC(d, '00:00', tz);
  const dayEndISO = new Date(Date.parse(dayStartISO) + 24 * 60 * 60_000).toISOString();
  const nowISO = new Date(now).toISOString();

  const missed = sqlite
    .prepare(
      `SELECT id, task_id FROM time_blocks
        WHERE task_id IS NOT NULL
          AND is_auto = 1 AND block_kind = 'task' AND source_kind = 'agent'
          AND status = 'planned'
          AND end_at <= ?
          AND start_at < ? AND end_at > ?`
    )
    .all(nowISO, dayEndISO, dayStartISO) as { id: string; task_id: string }[];

  if (missed.length === 0) return { skipped: 0, requeued: 0 };

  const markSkipped = sqlite.prepare(`UPDATE time_blocks SET status = 'skipped' WHERE id = ?`);
  const restage = sqlite.prepare(
    `INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`
  );
  let requeued = 0;
  sqlite.transaction(() => {
    for (const blk of missed) {
      markSkipped.run(blk.id);
      // Only re-queue tasks that are still open (a completed task's stale block isn't work).
      const open = sqlite.prepare(`SELECT 1 FROM tasks WHERE id = ? AND status = 'open'`).get(blk.task_id);
      if (open) { restage.run(owner, blk.task_id); requeued++; }
    }
  })();

  broadcast(owner, 'blocks:missed', { count: missed.length });
  return { skipped: missed.length, requeued };
}

/** Test-only: clear pending debounce timers + the re-entrancy guard between tests. */
export function _resetReplanState(): void {
  for (const t of pendingReplans.values()) clearTimeout(t);
  pendingReplans.clear();
  reflowing.clear();
}
