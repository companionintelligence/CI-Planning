/**
 * B1 — Reactive reflow core (Phase M Workstream B).
 *
 * `reflow(owner, date)` re-places only the movable auto blocks for the day,
 * deterministically. It never calls the LLM.
 *
 * SNAPSHOT-BASED: the re-place set is exactly the movable blocks reflow snapshotted —
 * clear set == re-place set by construction. `daily_plan` is only an ORDERING hint
 * (authored position first, current block order for anything unauthored); it no longer
 * gates membership. The old restage (daily_plan ∩ status='open' ∩ placed) silently
 * DROPPED any placement outside that set while clearPriorAuto still deleted its block —
 * tasks staged after the day was authored (author-once), tasks another path had flipped
 * to 'scheduled', and everything placed by autoScheduleOnIngest (which never authors)
 * vanished on the next task edit / calendar sync / missed sweep.
 *
 * Gap-close: reflow re-places ONLY the tasks already holding an auto block on the day,
 * so a freed slot compacts and no un-placed backlog is pulled onto the board. Intake
 * is exclusively the explicit Auto/Schedule path. Blocks whose task is TERMINAL
 * (done/cancelled/…) are garbage-collected — cleared, not re-placed — deliberately
 * (that was an accident of the old filter worth keeping).
 *
 * Anti-thrash rules (in priority order):
 *   1. In-progress blocks are never moved.
 *   2. Manually-locked auto blocks are held (slot AND task) — never moved or duplicated.
 *   3. Recently-moved blocks (last_moved_at within STABILITY_WINDOW_MS) are held.
 *   4. All other auto blocks are cleared and re-placed.
 *
 * Protected blocks (1–3) are passed to placeFlightPlan as an in-memory `protectIds`
 * set: clearPriorAuto skips them and dayObstacles already routes placement around any
 * live task block. Nothing is ever written to is_locked, so an interrupted reflow can
 * never leave a block stuck "locked". Reflow never reads or writes `flight_plan` —
 * re-placement goes through placeFlightPlan's `replaceTaskIds`, so a re-place failure
 * can't leak rows into the user's staging area.
 */
import { store } from '../db/store.js';
import { placeFlightPlan } from './autoplan.js';
import { serverTimezone, utcDayBounds, localDateInTZ } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import { logger } from '../lib/logger.js';
import { sendPush } from '../lib/push.js';
import { subsFor } from './reminders.js';
import { revertTaskPlacementStatus, TERMINAL_BLOCK_STATUS_SQL } from '../services/block-task-sync.js';

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

function snapshotAutoBlocks(owner: string, dayStartISO: string, dayEndISO: string): Promise<BlockSnapshot[]> {
  // Owner-scoped (F-REFLOW): without `owner_id = ?` a reflow would snapshot — then
  // re-place/stamp — another owner's overlapping blocks. Silent cross-tenant corruption.
  return store()
    .prepare(
      `SELECT id, task_id, start_at, end_at, is_locked, status, last_moved_at
         FROM time_blocks
        WHERE owner_id = ? AND task_id IS NOT NULL
          AND is_auto = 1 AND block_kind = 'task' AND source_kind = 'agent'
          AND start_at < ? AND end_at > ?
          AND status NOT IN ('completed', 'skipped', 'cancelled', 'missed')`
    )
    .all<BlockSnapshot>(owner, dayEndISO, dayStartISO);
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

/** Task statuses that are still live work — anything else holding a movable agent
 *  block is stale (the task finished/was cancelled out from under it) and its block
 *  is garbage-collected by reflow rather than re-placed. */
const REPLACEABLE_TASK_STATUSES = new Set(['open', 'scheduled', 'in_progress']);

/**
 * Partition the day's movable snapshot (unprotected auto blocks) into:
 *  - `replaceTaskIds` — tasks that are still live work, ORDERED by the day's authored
 *    `daily_plan.position` where rows exist, then by current block start for anything
 *    unauthored (minimal movement: an unauthored latecomer keeps its relative slot).
 *  - `gcBlockIds` — blocks whose task is terminal; cleared, never re-placed.
 *
 * Membership comes from the SNAPSHOT alone — never from daily_plan (whose author-once
 * coverage goes stale the moment a task is staged after the day's first Auto run) and
 * never from a status filter narrower than "live work".
 */
async function partitionReplaceSet(
  owner: string,
  date: string,
  snapshot: BlockSnapshot[],
  protectedTaskIds: Set<string>,
): Promise<{ replaceTaskIds: string[]; gcBlockIds: string[] }> {
  const movable = snapshot.filter((b) => !protectedTaskIds.has(b.task_id));
  if (movable.length === 0) return { replaceTaskIds: [], gcBlockIds: [] };

  const taskIds = [...new Set(movable.map((b) => b.task_id))];
  const statusById = new Map(
    (await store()
      .prepare(`SELECT id, status FROM tasks WHERE owner_id = ? AND id IN (${taskIds.map(() => '?').join(',')})`)
      .all<{ id: string; status: string }>(owner, ...taskIds)).map((r) => [r.id, r.status]),
  );
  const dpPos = new Map(
    (await store()
      .prepare(`SELECT task_id, position FROM daily_plan WHERE owner_id = ? AND date = ? AND task_id IN (${taskIds.map(() => '?').join(',')})`)
      .all<{ task_id: string; position: number }>(owner, date, ...taskIds)).map((r) => [r.task_id, r.position]),
  );
  const earliestStart = new Map<string, string>();
  for (const b of movable) {
    const cur = earliestStart.get(b.task_id);
    if (!cur || b.start_at < cur) earliestStart.set(b.task_id, b.start_at);
  }

  const live = taskIds.filter((id) => REPLACEABLE_TASK_STATUSES.has(statusById.get(id) ?? ''));
  live.sort((a, b) => {
    const pa = dpPos.get(a) ?? Number.POSITIVE_INFINITY;
    const pb = dpPos.get(b) ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const sa = earliestStart.get(a) ?? '';
    const sb = earliestStart.get(b) ?? '';
    return sa < sb ? -1 : sa > sb ? 1 : a.localeCompare(b);
  });
  const liveSet = new Set(live);
  const gcBlockIds = movable.filter((b) => !liveSet.has(b.task_id)).map((b) => b.id);
  return { replaceTaskIds: live, gcBlockIds };
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
 * Re-place all movable auto blocks for `date` deterministically (snapshot-based:
 * clear set == re-place set; `daily_plan` orders, never gates). Protected blocks
 * (in-progress, locked, recently moved) hold their slot AND their task.
 *
 * Never calls the LLM. Returns a diff of what moved, was removed, or was added.
 */
export async function reflow(
  owner: string = currentOwnerId(),
  date?: string,
  _reason?: string,
  opts: { nowMs?: number } = {},
): Promise<ReflowDiff> {
  const prefs = await store()
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ timezone: string | null }>(owner);
  const tz = prefs?.timezone || serverTimezone();
  const nowMs = opts.nowMs ?? Date.now(); // injectable clock (tests): default-date, stability window, R3 clamp
  // OWNER-local today, not the server's: an owner west of the server editing in the
  // evening must reflow the day they're looking at, not the server's tomorrow.
  const d = date ?? localDateInTZ(new Date(nowMs).toISOString(), tz);

  // Use the SAME day window as clearPriorAuto/dayPlans (utcDayBounds — DST-aware, end is
  // next-day midnight, not start+24h). The snapshot defines the re-place set, so it must
  // match the clear window exactly or a DST-day block could be dropped/duplicated.
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(d, tz);

  // 1. Snapshot auto blocks before any changes.
  const snapshot = await snapshotAutoBlocks(owner, dayStartISO, dayEndISO);
  const beforeMap = toTaskMap(snapshot);

  // 2. Which blocks are protected (in-progress, locked, or recently moved)?
  const protectedIds = computeProtected(snapshot, nowMs);
  const protectedTaskIds = new Set(
    [...protectedIds]
      .map((id) => snapshot.find((b) => b.id === id)?.task_id)
      .filter((t): t is string => t != null)
  );

  // 3. Partition the movable snapshot: live tasks get re-placed (authored order first,
  //    block order for the unauthored tail); terminal tasks' stale blocks get GC'd.
  const { replaceTaskIds, gcBlockIds } = await partitionReplaceSet(owner, d, snapshot, protectedTaskIds);
  if (gcBlockIds.length > 0) {
    await store()
      .prepare(`DELETE FROM time_blocks WHERE owner_id = ? AND id IN (${gcBlockIds.map(() => '?').join(',')})`)
      .run(owner, ...gcBlockIds);
  }

  // 4. Place. `replaceTaskIds` is BOTH the clear scope and the re-place set inside
  //    placeFlightPlan (never the user's flight_plan staging); `protectIds` keeps the
  //    protected blocks out of the DELETE (in memory — never written to is_locked),
  //    and dayObstacles already routes placement around them.
  placeFlightPlan(owner, { date: d, replaceTaskIds, protectIds: protectedIds, nowMs });

  // 5. Snapshot after and compute the diff. A task whose block the pin pass converted
  //    to a stated-time is_auto=0 block leaves the agent snapshot but is still placed —
  //    it must not be reported `removed` (B4 would nag about a task that's fine).
  //    Scoped to THIS day's window (same bounds as the snapshots): an active block on a
  //    DIFFERENT day must not mask a genuine same-day removal/unplaced.
  const hasActiveBlockToday = store().prepare(
    `SELECT 1 FROM time_blocks WHERE task_id = ? AND owner_id = ? AND block_kind = 'task'
      AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
      AND start_at < ? AND end_at > ? LIMIT 1`,
  );
  const activeToday = async (taskId: string) => !!(await hasActiveBlockToday.get(taskId, owner, dayEndISO, dayStartISO));
  const afterSnapshot = await snapshotAutoBlocks(owner, dayStartISO, dayEndISO);
  const afterMap = toTaskMap(afterSnapshot);
  const { moved, removed: removedRaw, added } = diffBlocks(beforeMap, afterMap);
  // Explicit loops, not `.filter(activeToday)`: an async predicate returns a Promise,
  // which is always truthy, so every candidate would survive the filter.
  const removed: typeof removedRaw = [];
  for (const r of removedRaw) if (!(await activeToday(r.task_id))) removed.push(r);

  // 6. Stamp last_moved_at on blocks that actually changed time.
  const nowISO = new Date(nowMs).toISOString();
  const stamp = store().prepare(`UPDATE time_blocks SET last_moved_at = ? WHERE id = ? AND owner_id = ?`);
  for (const m of moved) await stamp.run(nowISO, m.block_id, owner);

  // 7. Unplaced = tasks we tried to re-place that no longer hold an active block ON
  //    THIS DAY (same pin-conversion caveat as `removed` above; day-scoped so a block
  //    on another day doesn't hide a genuine same-day failure to place).
  const unplaced: string[] = [];
  for (const id of replaceTaskIds) if (!afterMap.has(id) && !(await activeToday(id))) unplaced.push(id);

  return { moved, removed, added, unplaced };
}

/**
 * One-time startup recovery: clear `is_locked` left on our OWN auto blocks by a reflow
 * that was interrupted before the pre-fix `unfreeze` could run. Genuine user/calendar
 * locks live on manual or meeting blocks (is_auto=0) and are never touched. Idempotent —
 * a no-op once clean. (Post-fix, reflow no longer writes is_locked at all, so no new
 * residue is ever produced; this only heals databases written by the old code.)
 */
export async function recoverStaleFreezeLocks(): Promise<number> {
  const res = await store()
    .prepare(
      `UPDATE time_blocks SET is_locked = 0
        WHERE is_locked = 1 AND is_auto = 1 AND source_kind = 'agent' AND block_kind = 'task'
          AND status = 'planned'`
    )
    .run();
  return res.changes;
}

// ─── B2: triggers + debounce ───────────────────────────────────────────────────

const pendingReplans = new Map<string, ReturnType<typeof setTimeout>>(); // owner → trailing timer
const reflowing = new Set<string>(); // owner currently inside a reflow (re-entrancy guard)

/** Reflow is gated per owner by scheduling_prefs.auto_defense_enabled (default on). */
async function autoDefenseEnabled(owner: string): Promise<boolean> {
  const row = await store()
    .prepare(`SELECT auto_defense_enabled FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ auto_defense_enabled: number }>(owner);
  return (row?.auto_defense_enabled ?? 1) === 1;
}

/** The owner-local current date (scheduling_prefs.timezone, falling back to the server
 *  zone) — the reactive path must target the day the OWNER is living in, not the
 *  server's calendar day. */
async function ownerLocalDate(owner: string): Promise<string> {
  const prefs = await store()
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ timezone: string | null }>(owner);
  return localDateInTZ(new Date().toISOString(), prefs?.timezone || serverTimezone());
}

/**
 * Run one reflow now and broadcast the diff. Swallows errors — never throws to a timer.
 *
 * Also owns the `auto_defense_enabled` gate, which used to sit in `requestReplan`. It
 * moved here so `requestReplan` could stay SYNCHRONOUS: the gate is the only DB read on
 * that path, and making it async would have turned 21 fire-and-forget trigger sites
 * (request + sync handlers) into awaits for no benefit — the same reasoning that keeps
 * `writeAudit` floating. Evaluating the gate at fire time rather than trigger time is
 * also strictly more correct: a trigger raised just before the owner disables
 * auto-defense no longer reflows 1.5s later.
 */
async function fireReplan(owner: string, date: string | undefined, reason: string): Promise<void> {
  if (reflowing.has(owner)) return; // re-entrancy: a reflow's own writes must not re-trigger
  reflowing.add(owner);
  try {
    if (!(await autoDefenseEnabled(owner))) return;
    const d = date ?? (await ownerLocalDate(owner));
    const diff = await reflow(owner, d, reason);
    broadcast(owner, 'schedule:done', { reason, ...diff });
    // B4: on a BIG disruption (a high-priority task can't fit), escalate by surfacing
    // ONE actionable nudge — never re-author here. The LLM only runs on explicit accept
    // (POST /api/plan/reauthor). This is the reactive path; the accept route calls
    // reflow() directly, so an accepted re-author can never re-trigger a suggestion.
    const sug = await maybeSuggestReauthor(owner, d, diff, reason);
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
    if (reflowing.has(owner)) return; // ignore triggers raised during an in-flight reflow
    const existing = pendingReplans.get(owner);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingReplans.delete(owner);
      // Floated deliberately: fireReplan owns the auto_defense_enabled gate and swallows
      // its own errors, so there is nothing here to await or catch.
      void fireReplan(owner, date, reason);
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
export async function sweepMissedBlocks(
  owner: string = currentOwnerId(),
  date?: string,
  now: number = Date.now(),
): Promise<{ skipped: number; requeued: number }> {
  const prefs = await store()
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ timezone: string | null }>(owner);
  const tz = prefs?.timezone || serverTimezone();
  const d = date ?? localDateInTZ(new Date(now).toISOString(), tz);
  // Same DST-aware day window as reflow/clearPriorAuto (utcDayBounds), not start+24h.
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(d, tz);
  const nowISO = new Date(now).toISOString();

  const missed = await store()
    .prepare(
      `SELECT id, task_id FROM time_blocks
        WHERE owner_id = ? AND task_id IS NOT NULL
          AND is_auto = 1 AND block_kind = 'task' AND source_kind = 'agent'
          AND status = 'planned'
          AND end_at <= ?
          AND start_at < ? AND end_at > ?`
    )
    .all<{ id: string; task_id: string }>(owner, nowISO, dayEndISO, dayStartISO);

  if (missed.length === 0) return { skipped: 0, requeued: 0 };

  const markSkipped = store().prepare(`UPDATE time_blocks SET status = 'skipped' WHERE id = ? AND owner_id = ?`);
  const restage = store().prepare(
    `INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`
  );
  // Append re-queued tasks at the END of the flight-plan (nextPos), not position 0 — a
  // hard-coded 0 collided every requeued task onto the same slot, so the (position,
  // task_id) order was arbitrary and unstable across sweeps.
  let pos = (await store().prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get<{ m: number }>(owner))!.m + 1;
  let requeued = 0;
  await store().transaction(async () => {
    for (const blk of missed) {
      await markSkipped.run(blk.id, owner);
      // R2 parity: skipping a task's only active placement returns it to the open
      // backlog (scheduled ⇒ open) — MUST run before the open-check below, or a
      // placement-scheduled task would never re-queue.
      revertTaskPlacementStatus(blk.task_id, owner);
      // Only re-queue tasks that are still open (a completed task's stale block isn't work).
      const open = await store().prepare(`SELECT 1 FROM tasks WHERE id = ? AND status = 'open'`).get(blk.task_id);
      if (open && (await restage.run(owner, blk.task_id, pos)).changes > 0) { pos++; requeued++; }
    }
  });

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
async function highPriorityAtRisk(diff: ReflowDiff): Promise<string[]> {
  const ids = [...new Set<string>([...diff.removed.map((r) => r.task_id), ...diff.unplaced])];
  if (ids.length === 0) return [];
  const rows = await store()
    .prepare(`SELECT id, priority FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all<{ id: string; priority: number | null }>(...ids);
  return rows.filter((r) => (r.priority ?? 3) <= 2).map((r) => r.id);
}

/** B4 disruption predicate: a high-priority task is at risk after the deterministic reflow. */
export async function isBigDisruption(diff: ReflowDiff): Promise<boolean> {
  return (await highPriorityAtRisk(diff)).length > 0;
}

/**
 * Record + return a new suggestion when a reflow is a big disruption AND none is
 * already outstanding for this (owner, date). Returns null otherwise (no disruption,
 * or de-duped). Pure bookkeeping — the caller broadcasts/pushes.
 */
async function maybeSuggestReauthor(owner: string, date: string, diff: ReflowDiff, reason: string): Promise<Suggestion | null> {
  const atRisk = await highPriorityAtRisk(diff);
  if (atRisk.length === 0) return null;
  const existing = await store().prepare(`SELECT date FROM replan_suggestions WHERE owner_id = ?`).get<{ date: string }>(owner);
  if (existing && existing.date === date) return null; // anti-spam: one per (owner, day)
  const k = atRisk.length;
  const sug: Suggestion = { date, reason, summary: `${k} priority task${k === 1 ? '' : 's'} at risk`, atRisk: k };
  await store()
    .prepare(`INSERT OR REPLACE INTO replan_suggestions (owner_id, date, reason, summary, at_risk) VALUES (?, ?, ?, ?, ?)`)
    .run(owner, date, reason, sug.summary, k);
  return sug;
}

/** Best-effort Web Push for the nudge — mirrors reminders.deliver; never throws. */
async function pushReplanNudge(owner: string, summary: string): Promise<void> {
  try {
    for (const s of subsFor(owner)) {
      const res = await sendPush(s.sub, { title: 'Re-plan your day?', body: summary, tag: 'replan:suggested', url: '/' });
      if (res === 'gone') await store().prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(s.id);
    }
  } catch {
    // SSE already delivered the nudge in-app; push is a bonus.
  }
}

/** The outstanding suggestion for an owner (B4 — read by routes/tests). */
export async function outstandingSuggestion(owner: string): Promise<Suggestion | undefined> {
  const row = await store()
    .prepare(`SELECT date, reason, summary, at_risk FROM replan_suggestions WHERE owner_id = ?`)
    .get<{ date: string; reason: string; summary: string; at_risk: number }>(owner);
  return row ? { date: row.date, reason: row.reason, summary: row.summary, atRisk: row.at_risk } : undefined;
}

/** Clear the outstanding suggestion (on accept/dismiss). */
export async function clearSuggestion(owner: string): Promise<void> {
  await store().prepare(`DELETE FROM replan_suggestions WHERE owner_id = ?`).run(owner);
}

/** Test-only: clear pending debounce timers, the re-entrancy guard, and suggestions. */
export async function _resetReplanState(): Promise<void> {
  for (const t of pendingReplans.values()) clearTimeout(t);
  pendingReplans.clear();
  reflowing.clear();
  await store().exec(`DELETE FROM replan_suggestions`);
}
