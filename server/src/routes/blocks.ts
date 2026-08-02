import Router from '@koa/router';
// `sqlite` remains ONLY as stampRow's handle argument — it dies when sync/apply.ts
// ports to the facade. The route's own statements go through store().
import { sqlite } from '../db/index.js';
import { store } from '../db/store.js';
import { broadcast } from './sse.js';
import { currentOwnerId } from '../lib/context.js';
import { localISODate } from '../lib/dates.js';
import { blocksToICal, type ICalBlock } from '../lib/ical.js';
// W3.2 moved block CRUD (and its zonedWallTimeToUTC/localDateInTZ use) into
// services/blocks.ts; the only tz helpers still needed route-side are for the Z7
// whats-next render below.
import { serverTimezone, utcToZonedWallTime } from '../lib/tz.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';
import { enqueueOutbound, pushOutboundDeletes } from '../agents/sync.js';
import { forkSeriesAt } from '../engine/series-scope.js';
import { newId } from '../lib/ids.js';
import { syncTaskFromBlock, revertTaskPlacementStatus } from '../services/block-task-sync.js';
import {
  fetchBlocksForRange,
  listBlocks,
  createBlock,
  updateBlock,
  moveBlockGroup,
  promoteBlockToScheduled,
  deleteBlock,
  clearDayAutoBlocks,
  addTasksToBlock,
} from '../services/blocks.js';
import { timeSenseEnabled } from '../lib/flags.js';
import { extendBlock } from '../engine/extend-block.js';
import { syncBlockFocusReminders, clearBlockFocusReminders } from '../engine/reminders.js';
import { renderCopy } from '../agents/render-copy.js';

export function blocksRouter() {
  const router = new Router();

  // GET /api/blocks?from=ISO&to=ISO&state=someday
  // `state=someday` returns all of the owner's someday Time Blocks regardless of
  // date (they have no real time) — the horizon lane reads them this way.
  // (`state` is the Time-Block state: 'scheduled' | 'someday'; CON-2.)
  router.get('/api/blocks', async (ctx) => {
    const { from, to, state } = ctx.query as Record<string, string>;
    ctx.body = { blocks: await listBlocks(currentOwnerId(), { from, to, state }) };
  });

  // GET /api/blocks/export.ics?from=ISO&to=ISO — download the range's dated blocks as
  // a standard iCalendar file. Registered before the `/:id` routes so the literal path
  // can't be shadowed. Defaults to today when from/to are absent.
  router.get('/api/blocks/export.ics', async (ctx) => {
    const from = (ctx.query.from as string) || `${localISODate()}T00:00:00.000Z`;
    const to   = (ctx.query.to as string)   || `${localISODate()}T23:59:59.999Z`;
    const blocks = await fetchBlocksForRange(currentOwnerId(), from, to);
    const ics = blocksToICal(blocks as unknown as ICalBlock[]);
    ctx.set('Content-Type', 'text/calendar; charset=utf-8');
    ctx.set('Content-Disposition', `attachment; filename="companion-${from.slice(0, 10)}-${to.slice(0, 10)}.ics"`);
    ctx.body = ics;
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'export', entity: 'blocks:ics' });
  });

  // POST /api/blocks
  router.post('/api/blocks', async (ctx) => {
    const body = ctx.request.body as {
      task_id?: string;
      title: string;
      block_kind?: string;
      tag?: string;
      secondary_tags?: string[];
      block_type?: string;
      goal_start_date?: string;
      duration_minutes?: number;
      note?: string;
      start_at: string;
      end_at: string;
      is_locked?: boolean;
      all_day?: boolean;
      parent_block_id?: string | null;
      recurrence_rule?: string;
      recurrence_dtstart?: string;
      category_id?: string;
      color_token?: string;
    };

    if (!body.title || !body.start_at || !body.end_at) {
      ctx.status = 400;
      ctx.body = { error: 'title, start_at, and end_at are required' };
      return;
    }

    const result = await createBlock(currentOwnerId(), body);
    if (!result.ok) {
      if (result.error === 'missing_fields') { ctx.status = 400; ctx.body = { error: 'title, start_at, and end_at are required' }; return; }
      if (result.error === 'invalid_parent') { ctx.status = 422; ctx.body = { error: 'parent_block_id must reference one of your Time Blocks' }; return; }
      ctx.status = 422; ctx.body = { error: 'category_id must reference a category tag' }; return;
    }

    broadcast(currentOwnerId(), 'block:created', result.api);
    if (result.syncedTaskId) broadcast(currentOwnerId(), 'task:updated', { id: result.syncedTaskId });

    enqueueOutbound(result.block.id);
    ctx.status = 201;
    ctx.body = { block: result.api };
  });

  // PATCH /api/blocks/:id
  router.patch('/api/blocks/:id', async (ctx) => {
    const id = ctx.params.id;
    const body = ctx.request.body as Partial<{
      title: string;
      start_at: string;
      end_at: string;
      is_locked: boolean;
      status: string;
      block_kind: string;
      tag: string | null;
      block_type: string | null;
      goal_start_date: string | null;
      duration_minutes: number | null;
      note: string | null;
      all_day: boolean;
      parent_block_id: string | null;
      secondary_tags: string[];
      recurrence_rule: string | null;
      recurrence_dtstart: string | null;
      category_id: string | null;
    }>;

    const owner = currentOwnerId();

    // ?scope=following — apply the edit to this occurrence AND every later one, by
    // FORKING the series here: the original keeps everything before this day, and a new
    // template (which the edit lands on) carries the rest. Editing the existing template
    // instead would rewrite earlier occurrences too.
    let targetId = id;
    if ((ctx.query.scope as string) === 'following') {
      const inst = await store()
        .prepare(`SELECT recurrence_parent_id, occurrence_date FROM time_blocks WHERE id = ? AND owner_id = ?`)
        .get<{ recurrence_parent_id: string | null; occurrence_date: string | null }>(id, owner);
      if (inst?.recurrence_parent_id && inst.occurrence_date) {
        const fork = forkSeriesAt(owner, 'time_blocks', inst.recurrence_parent_id, inst.occurrence_date, newId());
        if (!fork.ok) {
          ctx.status = 422;
          ctx.body = { error: 'Could not split this series — its repeat rule could not be bounded' };
          return;
        }
        targetId = fork.newTemplateId!;
      }
      // A non-recurring block falls through to a plain single-row edit: "following" is
      // meaningless without a series, and erroring would be a worse answer than doing
      // exactly what the user asked for on the one item.
    }

    const result = await updateBlock(owner, targetId, body);
    if (!result.ok) {
      if (result.error === 'not_found') { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (result.error === 'inbound_readonly') {
        ctx.status = 422;
        ctx.body = { error: 'Calendar meeting blocks are read-only — edit the event in Google Calendar' };
        return;
      }
      if (result.error === 'invalid_parent') { ctx.status = 422; ctx.body = { error: 'parent_block_id must reference one of your Time Blocks' }; return; }
      ctx.status = 422; ctx.body = { error: 'category_id must reference a category tag' }; return;
    }

    // Phase L versioning (stampRow) now happens INSIDE updateBlock (W3.3) so a GraphQL
    // mutation versions on the same path; the route no longer stamps.
    broadcast(owner, 'block:updated', result.api);
    if (result.syncedTaskId) broadcast(owner, 'task:updated', { id: result.syncedTaskId });

    enqueueOutbound(id); // I9 + writeback gate handled inside enqueueOutbound
    ctx.body = { block: result.api };
  });

  // POST /api/blocks/:id/move-group { delta_minutes } — shift a Plan + all its
  // members by one minute delta, atomically (PR-C). `:id` may be the Plan
  // (block_kind='timeblock') OR any member; the group is resolved the same way.
  //
  // The shift is pure elapsed-ms math on each UTC instant (delta_minutes·60000ms),
  // so it is tz/DST-correct and matches the client's `instantFor` delta exactly —
  // relative offsets are preserved and delta 0 is a byte-identical no-op.
  router.post('/api/blocks/:id/move-group', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { delta_minutes?: number };

    const result = await moveBlockGroup(owner, id, body.delta_minutes ?? 0);
    if (!result.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    broadcast(owner, 'block:updated', { moved_group: result.parentId, count: result.blocks.length });
    for (const t of result.movedTaskIds) broadcast(owner, 'task:updated', { id: t });

    ctx.body = { blocks: result.blocks };
  });

  // POST /api/blocks/:id/extend { minutes, confirm? } — Phase Z · Z3 "Keep working".
  // Flag-gated (404 when Time-Sense off). Extends the block's end by `minutes`,
  // via a minimal forward cascade (§1.1a). Two-phase: a silent fit commits at
  // once; a fit that must move other entities returns them for confirmation and
  // only applies when `confirm` is true; a fixed obstacle returns blockedBy and
  // never writes.
  router.post('/api/blocks/:id/extend', async (ctx) => {
    const owner = currentOwnerId();
    if (!timeSenseEnabled(owner)) { ctx.status = 404; ctx.body = { error: 'Not found' }; return; }
    const body = (ctx.request.body ?? {}) as { minutes?: number; confirm?: boolean };
    const minutes = Math.round(Number(body.minutes ?? 10));
    if (!Number.isFinite(minutes) || minutes <= 0) {
      ctx.status = 422; ctx.body = { error: 'minutes must be a positive number' }; return;
    }

    let plan;
    try {
      plan = await extendBlock(ctx.params.id, minutes, { commit: false }, owner);
    } catch (err) {
      ctx.status = 404; ctx.body = { error: (err as Error).message }; return;
    }

    // Blocked by a fixed entity → surface it, no write.
    if (!plan.fits) { ctx.body = plan; return; }
    // Needs a move the user hasn't confirmed yet → return the move set, no write.
    if (plan.movedSet.length > 0 && !body.confirm) { ctx.body = { ...plan, committed: false }; return; }

    // Silent fit, or a confirmed move → apply.
    const applied = await extendBlock(ctx.params.id, minutes, { commit: true }, owner);
    broadcast(owner, 'block:updated', { id: ctx.params.id, extended: minutes, moved: applied.movedSet.length });
    // Mirror the new times back onto every affected task — the extended block AND
    // each cascade-moved block — so task_time/scheduled_for and armed reminders
    // don't drift from the block that actually moved (as move-group does).
    const affectedTasks = new Set<string>();
    for (const bid of [ctx.params.id, ...applied.movedSet.map((m) => m.block_id)]) {
      const t = syncTaskFromBlock(bid, owner);
      if (t) affectedTasks.add(t);
    }
    for (const t of affectedTasks) broadcast(owner, 'task:updated', { id: t });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `block:${ctx.params.id}` });
    ctx.body = applied;
  });

  // POST /api/blocks/:id/focus-reminders — Phase Z · Z4. Arm the block's Focus
  // Ritual background cues (T1/T3/T4) for tab-closed Web Push delivery; the Focus
  // screen calls this when the ritual opens. Flag-gated (404 off). Idempotent.
  // DELETE clears them (ritual dismissed / block finished in-tab).
  router.post('/api/blocks/:id/focus-reminders', async (ctx) => {
    const owner = currentOwnerId();
    if (!timeSenseEnabled(owner)) { ctx.status = 404; ctx.body = { error: 'Not found' }; return; }
    const exists = await store().prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(ctx.params.id, owner);
    if (!exists) { ctx.status = 404; ctx.body = { error: 'block not found' }; return; }
    const armed = syncBlockFocusReminders(owner, ctx.params.id);
    ctx.body = { ok: true, armed };
  });

  router.delete('/api/blocks/:id/focus-reminders', async (ctx) => {
    const owner = currentOwnerId();
    if (!timeSenseEnabled(owner)) { ctx.status = 404; ctx.body = { error: 'Not found' }; return; }
    clearBlockFocusReminders(ctx.params.id);
    ctx.body = { ok: true };
  });

  // GET /api/blocks/:id/whats-next — Phase Z · Z7. The T4 "what's next" line, rendered
  // through the Voice loop. The next event is derived SERVER-side (grounding integrity)
  // by mirroring the client's nextAfterFocus: the earliest non-container block starting
  // at/after this block's end. The Focus screen fetches it when the block ends; a fresh,
  // non-repeating line per block-end. Flag-gated (404 off).
  router.get('/api/blocks/:id/whats-next', async (ctx) => {
    const owner = currentOwnerId();
    if (!timeSenseEnabled(owner)) { ctx.status = 404; ctx.body = { error: 'Not found' }; return; }
    const block = await store()
      .prepare(`SELECT id, end_at FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get<{ id: string; end_at: string }>(ctx.params.id, owner);
    if (!block) { ctx.status = 404; ctx.body = { error: 'block not found' }; return; }
    const next = await store()
      .prepare(
        `SELECT title, start_at FROM time_blocks
          WHERE owner_id = ? AND id != ? AND block_kind != 'timeblock' AND start_at >= ?
          ORDER BY start_at LIMIT 1`,
      )
      .get<{ title: string; start_at: string }>(owner, block.id, block.end_at);
    // Blocks are stored as UTC instants; render the wall-clock in the owner's zone.
    // NEVER slice the ISO string for HH:MM (grid.ts invariant) — that leaks UTC to a
    // non-UTC user, mismatching the calendar's local display.
    const tz =
      (await store().prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get<{ timezone: string | null }>(owner))
        ?.timezone || serverTimezone();
    const copy = await renderCopy(
      't4_whats_next',
      next ? { next: next.title, next_time: utcToZonedWallTime(next.start_at, tz) } : {},
    );
    ctx.body = { text: copy.text, next: next ?? null };
  });

  // POST /api/blocks/:id/reschedule — Phase Z · Z3 "Schedule again" (§1.1b).
  // The block ended but the task isn't done: mark this attempt skipped and re-stage
  // the SAME task onto the flight-plan (source_kind='reschedule'), staged-not-placed
  // — Auto lands it later, inheriting the task's own defaults (no clone). Flag-gated.
  router.post('/api/blocks/:id/reschedule', async (ctx) => {
    const owner = currentOwnerId();
    if (!timeSenseEnabled(owner)) { ctx.status = 404; ctx.body = { error: 'Not found' }; return; }
    const id = ctx.params.id;

    const block = await store()
      .prepare(`SELECT id, task_id FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get<{ id: string; task_id: string | null }>(id, owner);
    if (!block) { ctx.status = 404; ctx.body = { error: 'block not found' }; return; }
    if (!block.task_id) { ctx.status = 422; ctx.body = { error: 'block has no task to reschedule' }; return; }

    const t = await store()
      .prepare(`SELECT recurrence_parent_id, status FROM tasks WHERE id = ? AND owner_id = ?`)
      .get<{ recurrence_parent_id: string | null; status: string }>(block.task_id, owner);
    if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return; }
    // "Schedule again" is for unfinished work only — a done/cancelled task must not
    // be re-staged (Auto would place a fresh block for already-closed work).
    if (t.status === 'done' || t.status === 'cancelled') {
      ctx.status = 422; ctx.body = { error: 'task is already closed — nothing to reschedule' }; return;
    }
    // Same guard as the stage endpoint: series instances re-land via their RRULE.
    if (t.recurrence_parent_id) { ctx.status = 422; ctx.body = { error: 'series instances re-land via their rule, not reschedule' }; return; }

    const nextPos = ((await store()
      .prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM flight_plan WHERE owner_id = ?`)
      .get<{ n: number }>(owner)))!.n;

    let staged = false;
    await store().transaction(async () => {
      // Attempt 1 becomes history — skipped, not deleted. The partial time_entry is
      // left as-is: the task stays open, and calibration only reads DONE tasks, so
      // the partial never enters estimate_calibration (§1.1b / N L169) — no flag needed.
      // Phase L: `skipped` is mergeable and unpinned, so without the stamp a queued op
      // still calling this block 'planned' would win LWW and resurrect the abandoned
      // attempt. (revertTaskPlacementStatus stamps the task side itself.)
      const info = await store().prepare(`UPDATE time_blocks SET status = 'skipped' WHERE id = ? AND owner_id = ?`).run(id, owner);
      if (info.changes > 0) stampRow(sqlite, 'block', id, ['status']);
      staged = (await store()
        .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, source_kind, source_ref, selected, position) VALUES (?, ?, 'reschedule', NULL, 1, ?)`)
        .run(owner, block.task_id, nextPos)).changes > 0;
      // Z4: a skipped attempt's focus cues must not fire for the abandoned block.
      clearBlockFocusReminders(id);
    });

    // Flip the task back to open (it was 'scheduled' while it held the block) so Auto
    // re-places it; broadcast so the board drops the skipped block and shows the stage.
    if (revertTaskPlacementStatus(block.task_id, owner)) broadcast(owner, 'task:updated', { id: block.task_id });
    broadcast(owner, 'block:updated', { id, rescheduled: block.task_id });
    broadcast(owner, 'flight_plan:updated', { added: staged ? 1 : 0 });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'reschedule', entity: `block:${id}` });
    ctx.body = { ok: true, task_id: block.task_id, staged };
  });

  // POST /api/blocks/:id/promote — turn a Concept into a scheduled Plan.
  // The client supplies the chosen start (and all_day for day-long Plans); end
  // defaults to start + the concept's duration_minutes.
  router.post('/api/blocks/:id/promote', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();
    const body = (ctx.request.body ?? {}) as { start_at?: string; end_at?: string; all_day?: boolean };

    const result = await promoteBlockToScheduled(owner, id, body);
    if (!result.ok) {
      if (result.error === 'start_at_required') { ctx.status = 422; ctx.body = { error: 'start_at is required to promote' }; return; }
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }

    broadcast(owner, 'block:updated', result.api);
    if (result.syncedTaskId) broadcast(owner, 'task:updated', { id: result.syncedTaskId });
    ctx.body = { block: result.api };
  });

  // DELETE /api/blocks/:id[?children=delete]
  // Default: deleting a Plan detaches its members (FK ON DELETE SET NULL) — they
  // survive as loose task blocks. `?children=delete` removes the members too
  // (PR-C: the "remove tasks" choice in the delete-Plan confirm dialog).
  router.delete('/api/blocks/:id', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();

    // Verify ownership before any side effects (e.g. remote deletes).
    if (!(await store().prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(id, owner))) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }

    // Push remote deletes before the block (and its external_events rows) are
    // CASCADE-removed — stays route-side (same reasoning as broadcast/enqueueOutbound).
    await pushOutboundDeletes(id);

    // ?scope=following truncates the recurring series at this occurrence; the default
    // ('instance') removes only this one, as it always has.
    const scope = (ctx.query.scope as string) === 'following' ? 'following' : 'instance';
    const result = await deleteBlock(owner, id, {
      deleteChildren: (ctx.query.children as string) === 'delete',
      scope,
    });
    if (!result.ok) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    broadcast(owner, 'block:deleted', { id });
    // REQ2: a task with no remaining active placement returns to the open backlog.
    for (const taskId of result.revertedTaskIds) broadcast(owner, 'task:updated', { id: taskId });

    ctx.body = { ok: true };
  });

  // POST /api/days/:date/clear — clear the day's AUTO-PLACED task blocks only.
  // The predicate mirrors clearPriorAuto (engine/autoplan.ts) exactly: only our
  // own agent auto placements (`is_auto=1 AND is_locked=0 AND block_kind='task'
  // AND source_kind='agent'`). It therefore preserves — by construction —
  // user-placed blocks (is_auto=0 / source 'manual'), locked blocks, calendar
  // meeting mirrors (block_kind!='task'), pattern/habit placements
  // (source_kind!='agent'), and completed/skipped occurrences. Keep this WHERE
  // in sync with autoplan.ts:187.
  router.post('/api/days/:date/clear', async (ctx) => {
    const owner = currentOwnerId();
    const date = ctx.params.date;

    const result = clearDayAutoBlocks(owner, date);

    for (const taskId of result.revertedTaskIds) broadcast(owner, 'task:updated', { id: taskId });
    if (result.removedCount) broadcast(owner, 'block:deleted', { cleared: result.removedCount, date });

    ctx.body = { ok: true, cleared: result.removedCount };
  });

  // POST /api/blocks/:id/add-tasks — attach existing tasks to a Time-Block container,
  // scattering them into its free time as child blocks (parent_block_id set). Used by
  // the New/Edit Time-Block modal's "add existing tasks/habits/routines" control.
  router.post('/api/blocks/:id/add-tasks', async (ctx) => {
    const id = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { task_ids?: unknown };
    const taskIds = Array.isArray(body.task_ids) ? body.task_ids.filter((x): x is string => typeof x === 'string') : [];
    const result = addTasksToBlock(currentOwnerId(), id, taskIds);
    ctx.body = { ok: true, ...result };
  });

  return router;
}
