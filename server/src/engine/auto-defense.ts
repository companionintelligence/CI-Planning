/**
 * B1 — Reactive reflow core (Phase M Workstream B).
 *
 * `reflow(owner, date)` re-places only the movable auto blocks for the day,
 * deterministically, from the frozen `daily_plan` order. It never calls the LLM.
 *
 * Gap-close: reflow re-places ONLY the tasks already holding an auto block on the day
 * (never the whole daily_plan), so a freed slot compacts and no un-placed backlog is
 * pulled onto the board. Intake is exclusively the explicit Auto/Schedule path.
 *
 * Anti-thrash rules (in priority order):
 *   1. In-progress blocks are never moved.
 *   2. Manually-locked auto blocks are held (slot AND task) — never moved or duplicated.
 *   3. Recently-moved blocks (last_moved_at within STABILITY_WINDOW_MS) are held.
 *   4. All other auto blocks are cleared and re-placed from daily_plan order.
 *
 * Protected blocks (1–3) are passed to placeFlightPlan as an in-memory `protectIds`
 * set: clearPriorAuto skips them and dayObstacles already routes placement around any
 * live task block. Nothing is ever written to is_locked, so an interrupted reflow can
 * never leave a block stuck "locked".
 */
import { sqlite } from '../db/index.js';
import { placeFlightPlan } from './autoplan.js';
import { serverTimezone, zonedWallTimeToUTC, utcDayBounds } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { localISODate } from '../lib/dates.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { sendPush } from '../lib/push.js';
import { subsFor } from './reminders.js';

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
    // A user-pinned (locked) auto block holds its slot AND its task — never move it,
    // never re-place its task (which would otherwise leave a duplicate beside the pin).
    if (b.is_locked) { ids.add(b.id); continue; }
    if (b.last_moved_at && nowMs - Date.parse(b.last_moved_at) < STABILITY_WINDOW_MS) {
      ids.add(b.id);
    }
  }
  return ids;
}

/**
 * Re-stage the day's MOVABLE-AND-ALREADY-PLACED tasks for re-placement (gap-close).
 * Only tasks that currently hold an auto block (`placedTaskIds`) and aren't protected
 * are staged — so a reactive reflow re-packs what's already on the day and never pulls
 * un-placed backlog onto the board. Returns the set that was staged.
 */
function restageFromDailyPlan(
  owner: string,
  date: string,
  protectedTaskIds: Set<string>,
  placedTaskIds: Set<string>,
): Set<string> {
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
    if (!placedTaskIds.has(row.task_id)) continue; // gap-close: never intake un-placed work
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

  // Use the SAME day window as clearPriorAuto/dayPlans (utcDayBounds — DST-aware, end is
  // next-day midnight, not start+24h). The snapshot defines the gap-close re-stage set, so
  // it must match the clear window exactly or a DST-day block could be dropped/duplicated.
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(d, tz);

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

  // 3. Re-stage the day's already-placed, movable tasks (gap-close: never the whole
  //    daily_plan, so a delete frees a slot and the rest compact — nothing new appears).
  const stagedTaskIds = restageFromDailyPlan(owner, d, protectedTaskIds, new Set(beforeMap.keys()));

  // 4. Place. `protectIds` keeps the protected blocks out of clearPriorAuto's DELETE
  //    (in memory — never written to is_locked), and dayObstacles already routes
  //    placement around them. `onlyTaskIds` scopes placement to the re-staged set.
  placeFlightPlan(owner, { date: d, onlyTaskIds: stagedTaskIds, protectIds: protectedIds });

  // 5. Snapshot after and compute the diff.
  const afterSnapshot = snapshotAutoBlocks(dayStartISO, dayEndISO);
  const afterMap = toTaskMap(afterSnapshot);
  const { moved, removed, added } = diffBlocks(beforeMap, afterMap);

  // 6. Stamp last_moved_at on blocks that actually changed time.
  const nowISO = new Date(nowMs).toISOString();
  const stamp = sqlite.prepare(`UPDATE time_blocks SET last_moved_at = ? WHERE id = ?`);
  for (const m of moved) stamp.run(nowISO, m.block_id);

  // 7. Unplaced = tasks we re-staged but that didn't end up with a block.
  const unplaced = [...stagedTaskIds].filter((id) => !afterMap.has(id));

  return { moved, removed, added, unplaced };
}

/**
 * One-time startup recovery: clear `is_locked` left on our OWN auto blocks by a reflow
 * that was interrupted before the pre-fix `unfreeze` could run. Genuine user/calendar
 * locks live on manual or meeting blocks (is_auto=0) and are never touched. Idempotent —
 * a no-op once clean. (Post-fix, reflow no longer writes is_locked at all, so no new
 * residue is ever produced; this only heals databases written by the old code.)
 */
export function recoverStaleFreezeLocks(): number {
  return sqlite
    .prepare(
      `UPDATE time_blocks SET is_locked = 0
        WHERE is_locked = 1 AND is_auto = 1 AND source_kind = 'agent' AND block_kind = 'task'
          AND status = 'planned'`
    )
    .run().changes;
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
  const d = date ?? localISODate();
  try {
    const diff = reflow(owner, d, reason);
    broadcast(owner, 'schedule:done', { reason, ...diff });
    // B4: on a BIG disruption (a high-priority task can't fit), escalate by surfacing
    // ONE actionable nudge — never re-author here. The LLM only runs on explicit accept
    // (POST /api/plan/reauthor). This is the reactive path; the accept route calls
    // reflow() directly, so an accepted re-author can never re-trigger a suggestion.
    const sug = maybeSuggestReauthor(owner, d, diff, reason);
    if (sug) {
      broadcast(owner, 'replan:suggested', { date: sug.date, reason: sug.reason, summary: sug.summary });
      void pushReplanNudge(owner, sug.summary);
    }
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

// ─── B4: nudge-first escalation (reflow → suggest → accept re-authors) ─────────
//
// Two clocks: the deterministic reflow above is fast/sync/LLM-free; this layer only
// DETECTS a big disruption and surfaces ONE actionable nudge. The LLM re-author runs
// solely via POST /api/plan/reauthor (the accept route) — never here, never in reflow().

interface Suggestion { date: string; reason: string; summary: string; atRisk: number }

// One outstanding suggestion per owner — persisted in `replan_suggestions` (migration
// 0067) so the nudge survives a server restart, not just a page reload. PK owner_id +
// INSERT OR REPLACE gives "one per owner; a new day overwrites".

/**
 * The high-priority (P≤2) task ids that a reflow left at risk — dropped (`removed`)
 * or unplaceable (`unplaced`). This is the disruption signal: a chronically-full day
 * of low-priority backlog does NOT nag; only an important task losing its slot does.
 */
function highPriorityAtRisk(diff: ReflowDiff): string[] {
  const ids = [...new Set<string>([...diff.removed.map((r) => r.task_id), ...diff.unplaced])];
  if (ids.length === 0) return [];
  const rows = sqlite
    .prepare(`SELECT id, priority FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { id: string; priority: number | null }[];
  return rows.filter((r) => (r.priority ?? 3) <= 2).map((r) => r.id);
}

/** B4 disruption predicate: a high-priority task is at risk after the deterministic reflow. */
export function isBigDisruption(diff: ReflowDiff): boolean {
  return highPriorityAtRisk(diff).length > 0;
}

/**
 * Record + return a new suggestion when a reflow is a big disruption AND none is
 * already outstanding for this (owner, date). Returns null otherwise (no disruption,
 * or de-duped). Pure bookkeeping — the caller broadcasts/pushes.
 */
function maybeSuggestReauthor(owner: string, date: string, diff: ReflowDiff, reason: string): Suggestion | null {
  const atRisk = highPriorityAtRisk(diff);
  if (atRisk.length === 0) return null;
  const existing = sqlite.prepare(`SELECT date FROM replan_suggestions WHERE owner_id = ?`).get(owner) as { date: string } | undefined;
  if (existing && existing.date === date) return null; // anti-spam: one per (owner, day)
  const k = atRisk.length;
  const sug: Suggestion = { date, reason, summary: `${k} priority task${k === 1 ? '' : 's'} at risk`, atRisk: k };
  sqlite
    .prepare(`INSERT OR REPLACE INTO replan_suggestions (owner_id, date, reason, summary, at_risk) VALUES (?, ?, ?, ?, ?)`)
    .run(owner, date, reason, sug.summary, k);
  return sug;
}

/** Best-effort Web Push for the nudge — mirrors reminders.deliver; never throws. */
async function pushReplanNudge(owner: string, summary: string): Promise<void> {
  try {
    for (const s of subsFor(owner)) {
      const res = await sendPush(s.sub, { title: 'Re-plan your day?', body: summary, tag: 'replan:suggested', url: '/' });
      if (res === 'gone') sqlite.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(s.id);
    }
  } catch {
    // SSE already delivered the nudge in-app; push is a bonus.
  }
}

/** The outstanding suggestion for an owner (B4 — read by routes/tests). */
export function outstandingSuggestion(owner: string): Suggestion | undefined {
  const row = sqlite
    .prepare(`SELECT date, reason, summary, at_risk FROM replan_suggestions WHERE owner_id = ?`)
    .get(owner) as { date: string; reason: string; summary: string; at_risk: number } | undefined;
  return row ? { date: row.date, reason: row.reason, summary: row.summary, atRisk: row.at_risk } : undefined;
}

/** Clear the outstanding suggestion (on accept/dismiss). */
export function clearSuggestion(owner: string): void {
  sqlite.prepare(`DELETE FROM replan_suggestions WHERE owner_id = ?`).run(owner);
}

/** Test-only: clear pending debounce timers, the re-entrancy guard, and suggestions. */
export function _resetReplanState(): void {
  for (const t of pendingReplans.values()) clearTimeout(t);
  pendingReplans.clear();
  reflowing.clear();
  sqlite.exec(`DELETE FROM replan_suggestions`);
}
