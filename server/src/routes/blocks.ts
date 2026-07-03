import Router from '@koa/router';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { timeBlocks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi, toApiList } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { ensurePatternsForRange } from '../engine/patterns-place.js';
import { ensureRecurringBlocksForRange, excludeBlockOccurrence } from '../engine/blocks-recur.js';
import { placeTasksInBlock } from '../engine/blocks-place.js';
import { removeEntityTags, splitTagString, syncLeveledEntityTags, entityTagLevels } from '../services/tags.js';
import { getCategoryPrefs } from '../services/category-prefs.js';
import { localISODate } from '../lib/dates.js';
import { blocksToICal, type ICalBlock } from '../lib/ical.js';
import { serverTimezone, zonedWallTimeToUTC, localDateInTZ } from '../lib/tz.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';
import { enqueueOutbound, pushOutboundDeletes } from '../agents/sync.js';
import { syncTaskFromBlock, mirrorBlockStatusToTask, applyTaskPlacementStatus, revertTaskPlacementStatus } from '../services/block-task-sync.js';
import { timeSenseEnabled } from '../lib/flags.js';
import { extendBlock } from '../engine/extend-block.js';
import { syncBlockFocusReminders, clearBlockFocusReminders } from '../engine/reminders.js';

/**
 * cockpit-v2 Phase 5: sync a block's leveled tags. `time_blocks.tag` stays the
 * top-level mirror; secondary tags live only in entity_tags at level 2. A field
 * left `undefined` (a partial PATCH) preserves that level's existing tags.
 */
function applyBlockTagLevels(
  blockId: string,
  opts: { tag?: string | null; secondary?: string[] },
): void {
  const existing = entityTagLevels('time_block', blockId);
  const top = opts.tag !== undefined ? splitTagString(opts.tag) : existing.filter((t) => t.level === 1).map((t) => t.name);
  const secondary = opts.secondary !== undefined ? opts.secondary : existing.filter((t) => t.level > 1).map((t) => t.name);
  syncLeveledEntityTags('time_block', blockId, [
    { level: 1, names: top },
    { level: 2, names: secondary },
  ], currentOwnerId());
}

/** A block's secondary (level>1) tag names, for the read surface. */
function secondaryTagsOf(blockId: string): string[] {
  return entityTagLevels('time_block', blockId).filter((t) => t.level > 1).map((t) => t.name);
}

/** §A3: the "why now" rationale for a placed block, joined from daily_plan via block_id (null when none). */
function rationaleOf(blockId: string): string | null {
  const row = sqlite.prepare(`SELECT rationale FROM daily_plan WHERE block_id = ? LIMIT 1`).get(blockId) as
    | { rationale: string | null }
    | undefined;
  return row?.rationale ?? null;
}

/**
 * Shared block fetch for a date range — the single source of truth for both the JSON
 * read (`GET /api/blocks`) and the `.ics` export, so the two never drift. Lazily
 * materializes recurring patterns + Time-Block instances, selects the range, drops
 * recurrence *templates* (rule set, no parent — never rendered), and enriches with
 * secondary tags + the "why now" rationale.
 */
async function fetchBlocksForRange(from: string, to: string): Promise<Record<string, unknown>[]> {
  ensurePatternsForRange(currentOwnerId(), from, to);
  ensureRecurringBlocksForRange(currentOwnerId(), from, to);
  const fetched = await db.select().from(timeBlocks)
    .where(and(eq(timeBlocks.ownerId, currentOwnerId()), gte(timeBlocks.startAt, from), lte(timeBlocks.endAt, to)));
  const rows = fetched.filter((b) => !(b.recurrenceRule && !b.recurrenceParentId));
  return toApiList(rows).map((b) => ({
    ...b,
    secondary_tags: secondaryTagsOf(b.id as string),
    rationale: rationaleOf(b.id as string),
  }));
}

export function blocksRouter() {
  const router = new Router();

  // GET /api/blocks?from=ISO&to=ISO&state=someday
  // `state=someday` returns all of the owner's someday Time Blocks regardless of
  // date (they have no real time) — the horizon lane reads them this way.
  // (`state` is the Time-Block state: 'scheduled' | 'someday'; CON-2.)
  router.get('/api/blocks', async (ctx) => {
    const { from, to, state } = ctx.query as Record<string, string>;

    // The common day-view read (a real time range, not the concept list) shares the
    // export's fetch helper: lazy materialization + range select + enrich.
    if (from && to && !state) {
      ctx.body = { blocks: await fetchBlocksForRange(from, to) };
      return;
    }

    // `state=someday` (no range) and partial-range reads keep the conditional select.
    const conditions = [eq(timeBlocks.ownerId, currentOwnerId())];
    if (from) conditions.push(gte(timeBlocks.startAt, from));
    if (to)   conditions.push(lte(timeBlocks.endAt, to));
    if (state) conditions.push(eq(timeBlocks.blockType, state));

    const fetched = await db.select().from(timeBlocks).where(and(...conditions));
    // CON-4: recurrence *templates* (rule set, no parent) are never rendered — only
    // their materialized instances are. Drop them from the read surface.
    const rows = fetched.filter((b) => !(b.recurrenceRule && !b.recurrenceParentId));

    // Phase 5: attach each block's secondary (level>1) tags from entity_tags.
    // §A3: attach the per-task rationale joined from daily_plan via block_id.
    const blocks = toApiList(rows).map((b) => ({
      ...b,
      secondary_tags: secondaryTagsOf(b.id as string),
      rationale: rationaleOf(b.id as string),
    }));
    ctx.body = { blocks };
  });

  // GET /api/blocks/export.ics?from=ISO&to=ISO — download the range's dated blocks as
  // a standard iCalendar file. Registered before the `/:id` routes so the literal path
  // can't be shadowed. Defaults to today when from/to are absent.
  router.get('/api/blocks/export.ics', async (ctx) => {
    const from = (ctx.query.from as string) || `${localISODate()}T00:00:00.000Z`;
    const to   = (ctx.query.to as string)   || `${localISODate()}T23:59:59.999Z`;
    const blocks = await fetchBlocksForRange(from, to);
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

    // 0069: a time block is owned by EITHER a tag (direction) OR a category — never
    // both (the scheduler partitions on this). color_token is the forward-only stamp
    // copied from category_prefs at create-time.
    const hasTag = body.tag != null && body.tag !== '';
    const hasCat = body.category_id != null && body.category_id !== '';
    if (hasTag && hasCat) { ctx.status = 422; ctx.body = { error: 'a time block may set a tag or a category, not both' }; return; }
    if (hasCat) {
      const ok = sqlite.prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ? AND kind = 'category' LIMIT 1`).get(body.category_id, currentOwnerId());
      if (!ok) { ctx.status = 422; ctx.body = { error: 'category_id must reference a category tag' }; return; }
    }
    const colorToken = hasCat
      ? (body.color_token ?? getCategoryPrefs(currentOwnerId())[body.category_id!]?.color_token ?? 'primary')
      : undefined;

    const [block] = await db
      .insert(timeBlocks)
      .values({
        taskId: body.task_id,
        ownerId: currentOwnerId(),
        title: body.title,
        blockKind: body.block_kind ?? 'task',
        tag: body.tag,
        categoryId: body.category_id,
        colorToken,
        blockType: body.block_type,
        goalStartDate: body.goal_start_date,
        durationMinutes: body.duration_minutes,
        note: body.note,
        startAt: body.start_at,
        endAt: body.end_at,
        isLocked: body.is_locked ?? false,
        allDay: body.all_day ?? false,
        isAuto: false,
        sourceKind: 'manual',
        // CON-4: a recurrence_rule makes this a template (anchor defaults to start_at).
        // It is never rendered directly; GET materializes its instances.
        recurrenceRule: body.recurrence_rule,
        recurrenceDtstart: body.recurrence_rule ? (body.recurrence_dtstart ?? body.start_at) : undefined,
      })
      .returning();

    // CON-3 + Phase 5: mirror the top-level tag string and any secondary tags
    // into the normalized store.
    if (body.tag !== undefined || body.secondary_tags !== undefined) {
      applyBlockTagLevels(block.id, { tag: body.tag, secondary: body.secondary_tags });
    }

    const out = { ...toApi(block), secondary_tags: secondaryTagsOf(block.id) };
    broadcast(currentOwnerId(), 'block:created', out);

    // REQ2: a placed task IS scheduled — on create (not just PATCH), mirror the
    // placement onto the task's scheduling-intent fields and flip open → scheduled.
    if (block.blockKind === 'task' && block.taskId) {
      syncTaskFromBlock(block.id, currentOwnerId());
      const flipped = applyTaskPlacementStatus(block.taskId, currentOwnerId());
      broadcast(currentOwnerId(), 'task:updated', { id: block.taskId });
      void flipped;
    }

    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'create', entity: `block:${block.id}` });
    enqueueOutbound(block.id);
    ctx.status = 201;
    ctx.body = { block: out };
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

    // I10: inbound calendar mirrors are authoritative — the owner may not directly
    // edit their title or time. The next sync cycle will overwrite any local change
    // anyway; rejecting here prevents silent drift and a confusing UX.
    if (body.title !== undefined || body.start_at !== undefined || body.end_at !== undefined) {
      const isInboundBlock = sqlite
        .prepare(`SELECT 1 FROM external_events WHERE block_id = ? AND direction = 'inbound'`)
        .get(id);
      if (isInboundBlock) {
        ctx.status = 422;
        ctx.body = { error: 'Calendar meeting blocks are read-only — edit the event in Google Calendar' };
        return;
      }
    }

    // 0069: enforce the tag XOR category_id partition on the MERGED row + validate the
    // category kind. (color re-stamp is handled below, only when category_id changes.)
    const existing = sqlite.prepare(`SELECT tag, category_id FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get(id, currentOwnerId()) as { tag: string | null; category_id: string | null } | undefined;
    if (!existing) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const effTag = body.tag !== undefined ? body.tag : existing.tag;
    const effCat = body.category_id !== undefined ? body.category_id : existing.category_id;
    if (effTag != null && effTag !== '' && effCat != null && effCat !== '') {
      ctx.status = 422; ctx.body = { error: 'a time block may set a tag or a category, not both' }; return;
    }
    if (body.category_id != null && body.category_id !== '') {
      const ok = sqlite.prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ? AND kind = 'category' LIMIT 1`).get(body.category_id, currentOwnerId());
      if (!ok) { ctx.status = 422; ctx.body = { error: 'category_id must reference a category tag' }; return; }
    }

    const update: Partial<typeof timeBlocks.$inferInsert> = {};
    if (body.title           !== undefined) update.title           = body.title;
    if (body.start_at        !== undefined) update.startAt         = body.start_at;
    if (body.end_at          !== undefined) update.endAt           = body.end_at;
    // A manual timing change promotes an auto block to manual so clearPriorAuto
    // won't reclaim it on the next Auto Schedule run.
    if (body.start_at !== undefined || body.end_at !== undefined) update.isAuto = false;
    if (body.is_locked       !== undefined) update.isLocked        = body.is_locked;
    if (body.status          !== undefined) update.status          = body.status;
    if (body.block_kind      !== undefined) update.blockKind       = body.block_kind;
    if (body.tag             !== undefined) update.tag             = body.tag;
    if (body.block_type      !== undefined) update.blockType       = body.block_type;
    if (body.goal_start_date !== undefined) update.goalStartDate   = body.goal_start_date;
    if (body.duration_minutes!== undefined) update.durationMinutes = body.duration_minutes;
    if (body.all_day         !== undefined) update.allDay          = body.all_day;
    // Attach to / detach from a Plan (PR-C): a number attaches, null detaches.
    if (body.parent_block_id !== undefined) update.parentBlockId   = body.parent_block_id;
    // 0069: re-stamp the frozen color ONLY when the category actually changes (a
    // deliberate re-assignment); detaching (null) clears it, a no-op patch keeps it.
    if (body.category_id !== undefined) {
      update.categoryId = body.category_id;
      if (body.category_id !== existing.category_id) {
        update.colorToken = body.category_id != null && body.category_id !== ''
          ? (getCategoryPrefs(currentOwnerId())[body.category_id]?.color_token ?? 'primary')
          : null;
      }
    }
    // CON-4 series edit: changing the rule on a template re-anchors + re-materializes.
    if (body.recurrence_rule !== undefined) {
      update.recurrenceRule = body.recurrence_rule;
      update.recurrenceDtstart = body.recurrence_rule
        ? (body.recurrence_dtstart ?? undefined)
        : null; // clearing the rule turns the template back into a one-off
    } else if (body.recurrence_dtstart !== undefined) {
      update.recurrenceDtstart = body.recurrence_dtstart;
    }

    // A tags-only PATCH (e.g. secondary_tags) has no column changes; drizzle
    // rejects an empty .set(), so fetch the row instead of updating it.
    const [block] = Object.keys(update).length
      ? await db.update(timeBlocks).set(update).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, currentOwnerId()))).returning()
      : await db.select().from(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, currentOwnerId())));
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // Phase L: stamp version/field_ts for sync versioning (mirrors tasks PATCH).
    if (Object.keys(update).length > 0) {
      stampRow(sqlite, 'block', id, Object.keys(update));
    }

    // CON-3 + Phase 5: keep the normalized store in sync. A partial PATCH that
    // omits `tag` or `secondary_tags` preserves that level (null/'' clears top).
    if (body.tag !== undefined || body.secondary_tags !== undefined) {
      applyBlockTagLevels(id, { tag: body.tag, secondary: body.secondary_tags });
    }

    // CON-4 series edit: a rule (or anchor) change drops future-or-today instances
    // of this template + their tag rows; GET re-materializes under the new rule.
    if (body.recurrence_rule !== undefined || body.recurrence_dtstart !== undefined) {
      const today = localISODate();
      for (const inst of sqlite
        .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? AND occurrence_date >= ? AND owner_id = ? RETURNING id`)
        .all(id, today, currentOwnerId()) as { id: string }[]) {
        removeEntityTags('time_block', inst.id);
      }
    }

    const out = { ...toApi(block), secondary_tags: secondaryTagsOf(id) };
    broadcast(currentOwnerId(), 'block:updated', out);

    // REQ2: a placed task IS scheduled — keep the linked task's scheduling-intent
    // fields (and its done-state) in lockstep with the block. A time change mirrors
    // start → scheduled_for/task_time; a status change mirrors done ⇄ open.
    let syncedTask: string | null = null;
    if (body.start_at !== undefined || body.end_at !== undefined) syncedTask = syncTaskFromBlock(id, currentOwnerId());
    if (body.status !== undefined) syncedTask = mirrorBlockStatusToTask(id, currentOwnerId()) ?? syncedTask;
    if (syncedTask) broadcast(currentOwnerId(), 'task:updated', { id: syncedTask });

    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `block:${id}` });
    enqueueOutbound(id); // I9 + writeback gate handled inside enqueueOutbound
    ctx.body = { block: out };
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
    const delta = Math.round(Number(body.delta_minutes ?? 0));

    const anchor = sqlite
      .prepare(`SELECT id, block_kind, parent_block_id FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get(id, owner) as { id: string; block_kind: string; parent_block_id: string | null } | undefined;
    if (!anchor) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // The group's parent: the container itself, the member's parent, or (a loose
    // block) itself alone.
    const parentId = anchor.block_kind === 'timeblock' ? anchor.id : anchor.parent_block_id ?? anchor.id;
    const members = sqlite
      .prepare(`SELECT id, start_at, end_at FROM time_blocks WHERE (id = ? OR parent_block_id = ?) AND owner_id = ?`)
      .all(parentId, parentId, owner) as { id: string; start_at: string; end_at: string }[];

    const deltaMs = delta * 60_000;
    const shift = (iso: string) => new Date(Date.parse(iso) + deltaMs).toISOString();
    const upd = sqlite.prepare(`UPDATE time_blocks SET start_at = ?, end_at = ? WHERE id = ? AND owner_id = ?`);
    sqlite.transaction(() => {
      for (const m of members) upd.run(shift(m.start_at), shift(m.end_at), m.id, owner);
    })();

    const ids = members.map((m) => m.id);
    const rows = ids.length ? await db.select().from(timeBlocks).where(and(inArray(timeBlocks.id, ids), eq(timeBlocks.ownerId, owner))) : [];
    broadcast(currentOwnerId(), 'block:updated', { moved_group: parentId, count: ids.length });

    // REQ2: mirror each moved task member's new placement onto its task (non-task
    // members — focus/break/meeting/the container — are skipped by the helper).
    const movedTasks = new Set<string>();
    for (const m of members) { const t = syncTaskFromBlock(m.id, currentOwnerId()); if (t) movedTasks.add(t); }
    for (const t of movedTasks) broadcast(currentOwnerId(), 'task:updated', { id: t });

    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `block:${parentId}` });
    ctx.body = { blocks: toApiList(rows) };
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
      plan = extendBlock(ctx.params.id, minutes, { commit: false }, owner);
    } catch (err) {
      ctx.status = 404; ctx.body = { error: (err as Error).message }; return;
    }

    // Blocked by a fixed entity → surface it, no write.
    if (!plan.fits) { ctx.body = plan; return; }
    // Needs a move the user hasn't confirmed yet → return the move set, no write.
    if (plan.movedSet.length > 0 && !body.confirm) { ctx.body = { ...plan, committed: false }; return; }

    // Silent fit, or a confirmed move → apply.
    const applied = extendBlock(ctx.params.id, minutes, { commit: true }, owner);
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
    const exists = sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(ctx.params.id, owner);
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

  // POST /api/blocks/:id/reschedule — Phase Z · Z3 "Schedule again" (§1.1b).
  // The block ended but the task isn't done: mark this attempt skipped and re-stage
  // the SAME task onto the flight-plan (source_kind='reschedule'), staged-not-placed
  // — Auto lands it later, inheriting the task's own defaults (no clone). Flag-gated.
  router.post('/api/blocks/:id/reschedule', async (ctx) => {
    const owner = currentOwnerId();
    if (!timeSenseEnabled(owner)) { ctx.status = 404; ctx.body = { error: 'Not found' }; return; }
    const id = ctx.params.id;

    const block = sqlite
      .prepare(`SELECT id, task_id FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get(id, owner) as { id: string; task_id: string | null } | undefined;
    if (!block) { ctx.status = 404; ctx.body = { error: 'block not found' }; return; }
    if (!block.task_id) { ctx.status = 422; ctx.body = { error: 'block has no task to reschedule' }; return; }

    const t = sqlite
      .prepare(`SELECT recurrence_parent_id, status FROM tasks WHERE id = ? AND owner_id = ?`)
      .get(block.task_id, owner) as { recurrence_parent_id: string | null; status: string } | undefined;
    if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return; }
    // "Schedule again" is for unfinished work only — a done/cancelled task must not
    // be re-staged (Auto would place a fresh block for already-closed work).
    if (t.status === 'done' || t.status === 'cancelled') {
      ctx.status = 422; ctx.body = { error: 'task is already closed — nothing to reschedule' }; return;
    }
    // Same guard as the stage endpoint: series instances re-land via their RRULE.
    if (t.recurrence_parent_id) { ctx.status = 422; ctx.body = { error: 'series instances re-land via their rule, not reschedule' }; return; }

    const nextPos = (sqlite
      .prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM flight_plan WHERE owner_id = ?`)
      .get(owner) as { n: number }).n;

    let staged = false;
    sqlite.transaction(() => {
      // Attempt 1 becomes history — skipped, not deleted. The partial time_entry is
      // left as-is: the task stays open, and calibration only reads DONE tasks, so
      // the partial never enters estimate_calibration (§1.1b / N L169) — no flag needed.
      sqlite.prepare(`UPDATE time_blocks SET status = 'skipped' WHERE id = ? AND owner_id = ?`).run(id, owner);
      staged = sqlite
        .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, source_kind, source_ref, selected, position) VALUES (?, ?, 'reschedule', NULL, 1, ?)`)
        .run(owner, block.task_id, nextPos).changes > 0;
      // Z4: a skipped attempt's focus cues must not fire for the abandoned block.
      clearBlockFocusReminders(id);
    })();

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
    const body = (ctx.request.body ?? {}) as { start_at?: string; end_at?: string; all_day?: boolean };
    if (!body.start_at) { ctx.status = 422; ctx.body = { error: 'start_at is required to promote' }; return; }
    const [existing] = await db.select().from(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, currentOwnerId())));
    if (!existing) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const dur = existing.durationMinutes ?? 60;
    const endAt = body.end_at ?? new Date(Date.parse(body.start_at) + dur * 60_000).toISOString();
    const [block] = await db
      .update(timeBlocks)
      .set({ blockType: 'scheduled', allDay: body.all_day ?? false, startAt: body.start_at, endAt, goalStartDate: null })
      .where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, currentOwnerId())))
      .returning();
    const out = toApi(block);
    broadcast(currentOwnerId(), 'block:updated', out);
    // REQ2: a promoted concept linked to a task gets concrete times — mirror them.
    const promotedTask = syncTaskFromBlock(id, currentOwnerId());
    if (promotedTask) broadcast(currentOwnerId(), 'task:updated', { id: promotedTask });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'promote', entity: `block:${id}` });
    ctx.body = { block: out };
  });

  // DELETE /api/blocks/:id[?children=delete]
  // Default: deleting a Plan detaches its members (FK ON DELETE SET NULL) — they
  // survive as loose task blocks. `?children=delete` removes the members too
  // (PR-C: the "remove tasks" choice in the delete-Plan confirm dialog).
  router.delete('/api/blocks/:id', async (ctx) => {
    const id = ctx.params.id;
    const owner = currentOwnerId();

    // Verify ownership before any side effects (e.g. remote deletes).
    if (!sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(id, owner)) {
      ctx.status = 404; ctx.body = { error: 'not found' }; return;
    }

    // Push remote deletes before the block (and its external_events rows) are CASCADE-removed.
    await pushOutboundDeletes(id);
    // REQ2: collect the task ids of every task-block about to be removed (the block
    // itself + cascade-deleted children + recurring instances) BEFORE deletion, so we
    // can return their tasks to the open backlog afterward. This handler isn't
    // transactional, so gather up front.
    const affectedTaskIds = new Set<string>();
    const collectTaskId = (blockId: string) => {
      const row = sqlite
        .prepare(`SELECT task_id, block_kind FROM time_blocks WHERE id = ? AND owner_id = ?`)
        .get(blockId, owner) as { task_id: string | null; block_kind: string } | undefined;
      if (row?.task_id && row.block_kind === 'task') affectedTaskIds.add(row.task_id);
    };
    collectTaskId(id);
    if ((ctx.query.children as string) === 'delete') {
      // CON-3 cascade: members are HARD-deleted here — drop their tag rows first.
      const members = sqlite
        .prepare(`SELECT id FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`)
        .all(id, owner) as { id: string }[];
      for (const m of members) { collectTaskId(m.id); removeEntityTags('time_block', m.id); }
      sqlite.prepare(`DELETE FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`).run(id, owner);
    }
    // CON-4: deleting a recurring template also removes its materialized instances
    // (+ their tag rows) — otherwise orphan instances would linger with a dead parent.
    for (const inst of sqlite
      .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? AND owner_id = ? RETURNING id, task_id, block_kind`)
      .all(id, owner) as { id: string; task_id: string | null; block_kind: string }[]) {
      if (inst.task_id && inst.block_kind === 'task') affectedTaskIds.add(inst.task_id);
      removeEntityTags('time_block', inst.id);
    }
    const [block] = await db.delete(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, owner))).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    // CON-3 cascade: the block itself is HARD-deleted — drop its tag rows.
    removeEntityTags('time_block', id);
    // 0074: deleting a lazily-placed recurring-pattern CONTAINER opts that
    // (pattern, local-day) out, so the next GET /api/blocks read won't regenerate
    // it. Without this the marker-based idempotency re-places it immediately and
    // the block can never be removed. Scoped to containers (block_kind='timeblock')
    // — a single child task block deletion is a partial edit, not a day opt-out.
    if (block.sourceKind === 'pattern' && block.blockKind === 'timeblock' && block.sourceRef && block.startAt) {
      const tz = (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(currentOwnerId()) as { timezone: string | null } | undefined)?.timezone || serverTimezone();
      sqlite
        .prepare(`INSERT OR IGNORE INTO pattern_day_optouts (owner_id, pattern_id, date) VALUES (?, ?, ?)`)
        .run(currentOwnerId(), String(block.sourceRef), localDateInTZ(block.startAt, tz));
    }
    // CON-4 sibling of the opt-out above: deleting a recurring Time-Block INSTANCE
    // records its day in the template's EXDATE, so ensureRecurringBlocksForRange
    // won't re-materialize it on the next read. Without this, recurring blocks with
    // no tasks inside (e.g. a "Deep-focus" block) were impossible to delete.
    if (block.recurrenceParentId && block.occurrenceDate) {
      excludeBlockOccurrence(owner, block.recurrenceParentId, block.occurrenceDate);
    }
    broadcast(currentOwnerId(), 'block:deleted', { id });
    // REQ2: a task with no remaining active placement returns to the open backlog.
    for (const taskId of affectedTaskIds) {
      if (revertTaskPlacementStatus(taskId, currentOwnerId())) {
        broadcast(currentOwnerId(), 'task:updated', { id: taskId });
      }
    }
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'delete', entity: `block:${id}` });
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
    const tzRow = sqlite
      .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
      .get(owner) as { timezone?: string } | undefined;
    const tz = tzRow?.timezone || serverTimezone();
    const dayStartISO = zonedWallTimeToUTC(date, '00:00', tz);
    const dayEndISO = new Date(Date.parse(dayStartISO) + 24 * 60 * 60_000).toISOString();
    const removed = sqlite
      .prepare(
        `DELETE FROM time_blocks
          WHERE owner_id = ?
            AND is_auto = 1 AND is_locked = 0 AND block_kind = 'task' AND source_kind = 'agent'
            AND status NOT IN ('completed','skipped')
            AND start_at < ? AND end_at > ?
          RETURNING id, task_id`,
      )
      .all(owner, dayEndISO, dayStartISO) as { id: string; task_id: string | null }[];
    for (const r of removed) removeEntityTags('time_block', r.id);
    // REQ2: a task whose last active placement was just cleared returns to the open
    // backlog — otherwise it's stranded at status='scheduled' with no block.
    for (const taskId of new Set(removed.map((r) => r.task_id).filter((t): t is string => !!t))) {
      if (revertTaskPlacementStatus(taskId, owner)) broadcast(owner, 'task:updated', { id: taskId });
    }
    if (removed.length) broadcast(owner, 'block:deleted', { cleared: removed.length, date });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'clear-day', entity: `day:${date}` });
    ctx.body = { ok: true, cleared: removed.length };
  });

  // POST /api/blocks/:id/add-tasks — attach existing tasks to a Time-Block container,
  // scattering them into its free time as child blocks (parent_block_id set). Used by
  // the New/Edit Time-Block modal's "add existing tasks/habits/routines" control.
  router.post('/api/blocks/:id/add-tasks', async (ctx) => {
    const id = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { task_ids?: unknown };
    const taskIds = Array.isArray(body.task_ids) ? body.task_ids.filter((x): x is string => typeof x === 'string') : [];
    const result = placeTasksInBlock(currentOwnerId(), id, taskIds);
    if (result.blocksCreated > 0) {
      writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'add-tasks', entity: `block:${id}` });
    }
    ctx.body = { ok: true, ...result };
  });

  return router;
}
