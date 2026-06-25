import Router from '@koa/router';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { timeBlocks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi, toApiList } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { ensurePatternsForRange } from '../engine/patterns-place.js';
import { ensureRecurringBlocksForRange } from '../engine/blocks-recur.js';
import { removeEntityTags, splitTagString, syncLeveledEntityTags, entityTagLevels } from '../services/tags.js';
import { localISODate } from '../lib/dates.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { writeAudit } from '../lib/audit.js';
import { enqueueOutbound, pushOutboundDeletes } from '../agents/sync.js';

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
  ]);
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

export function blocksRouter() {
  const router = new Router();

  // GET /api/blocks?from=ISO&to=ISO&state=someday
  // `state=someday` returns all of the owner's someday Time Blocks regardless of
  // date (they have no real time) — the horizon lane reads them this way.
  // (`state` is the Time-Block state: 'scheduled' | 'someday'; CON-2.)
  router.get('/api/blocks', async (ctx) => {
    const { from, to, state } = ctx.query as Record<string, string>;

    // Lazy pattern placement (PR-C+, Phase D refactor): when the read targets
    // a real time range (not the concept list), ensure every recurring Habit/
    // Routine pattern that fires inside it is on the board before we SELECT.
    // Idempotent via the marker on time_blocks → safe to call on every read.
    if (from && to && !state) {
      ensurePatternsForRange(currentOwnerId(), from, to);
      // CON-4: materialize recurring Time-Block instances for the range (idempotent).
      ensureRecurringBlocksForRange(currentOwnerId(), from, to);
    }

    const conditions = [];
    if (from) conditions.push(gte(timeBlocks.startAt, from));
    if (to)   conditions.push(lte(timeBlocks.endAt, to));
    if (state) conditions.push(eq(timeBlocks.blockType, state));

    const fetched = conditions.length
      ? await db.select().from(timeBlocks).where(and(...conditions))
      : await db.select().from(timeBlocks);
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
    };

    if (!body.title || !body.start_at || !body.end_at) {
      ctx.status = 400;
      ctx.body = { error: 'title, start_at, and end_at are required' };
      return;
    }

    const [block] = await db
      .insert(timeBlocks)
      .values({
        taskId: body.task_id,
        title: body.title,
        blockKind: body.block_kind ?? 'task',
        tag: body.tag,
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
      ? await db.update(timeBlocks).set(update).where(eq(timeBlocks.id, id)).returning()
      : await db.select().from(timeBlocks).where(eq(timeBlocks.id, id));
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

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
        .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? AND occurrence_date >= ? RETURNING id`)
        .all(id, today) as { id: string }[]) {
        removeEntityTags('time_block', inst.id);
      }
    }

    const out = { ...toApi(block), secondary_tags: secondaryTagsOf(id) };
    broadcast(currentOwnerId(), 'block:updated', out);
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
    const body = (ctx.request.body ?? {}) as { delta_minutes?: number };
    const delta = Math.round(Number(body.delta_minutes ?? 0));

    const anchor = sqlite
      .prepare(`SELECT id, block_kind, parent_block_id FROM time_blocks WHERE id = ?`)
      .get(id) as { id: string; block_kind: string; parent_block_id: string | null } | undefined;
    if (!anchor) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    // The group's parent: the container itself, the member's parent, or (a loose
    // block) itself alone.
    const parentId = anchor.block_kind === 'timeblock' ? anchor.id : anchor.parent_block_id ?? anchor.id;
    const members = sqlite
      .prepare(`SELECT id, start_at, end_at FROM time_blocks WHERE id = ? OR parent_block_id = ?`)
      .all(parentId, parentId) as { id: string; start_at: string; end_at: string }[];

    const deltaMs = delta * 60_000;
    const shift = (iso: string) => new Date(Date.parse(iso) + deltaMs).toISOString();
    const upd = sqlite.prepare(`UPDATE time_blocks SET start_at = ?, end_at = ? WHERE id = ?`);
    sqlite.transaction(() => {
      for (const m of members) upd.run(shift(m.start_at), shift(m.end_at), m.id);
    })();

    const ids = members.map((m) => m.id);
    const rows = ids.length ? await db.select().from(timeBlocks).where(inArray(timeBlocks.id, ids)) : [];
    broadcast(currentOwnerId(), 'block:updated', { moved_group: parentId, count: ids.length });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: `block:${parentId}` });
    ctx.body = { blocks: toApiList(rows) };
  });

  // POST /api/blocks/:id/promote — turn a Concept into a scheduled Plan.
  // The client supplies the chosen start (and all_day for day-long Plans); end
  // defaults to start + the concept's duration_minutes.
  router.post('/api/blocks/:id/promote', async (ctx) => {
    const id = ctx.params.id;
    const body = (ctx.request.body ?? {}) as { start_at?: string; end_at?: string; all_day?: boolean };
    if (!body.start_at) { ctx.status = 422; ctx.body = { error: 'start_at is required to promote' }; return; }
    const [existing] = await db.select().from(timeBlocks).where(eq(timeBlocks.id, id));
    if (!existing) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    const dur = existing.durationMinutes ?? 60;
    const endAt = body.end_at ?? new Date(Date.parse(body.start_at) + dur * 60_000).toISOString();
    const [block] = await db
      .update(timeBlocks)
      .set({ blockType: 'scheduled', allDay: body.all_day ?? false, startAt: body.start_at, endAt, goalStartDate: null })
      .where(eq(timeBlocks.id, id))
      .returning();
    const out = toApi(block);
    broadcast(currentOwnerId(), 'block:updated', out);
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'promote', entity: `block:${id}` });
    ctx.body = { block: out };
  });

  // DELETE /api/blocks/:id[?children=delete]
  // Default: deleting a Plan detaches its members (FK ON DELETE SET NULL) — they
  // survive as loose task blocks. `?children=delete` removes the members too
  // (PR-C: the "remove tasks" choice in the delete-Plan confirm dialog).
  router.delete('/api/blocks/:id', async (ctx) => {
    const id = ctx.params.id;
    // Push remote deletes before the block (and its external_events rows) are CASCADE-removed.
    await pushOutboundDeletes(id);
    if ((ctx.query.children as string) === 'delete') {
      // CON-3 cascade: members are HARD-deleted here — drop their tag rows first.
      const members = sqlite
        .prepare(`SELECT id FROM time_blocks WHERE parent_block_id = ?`)
        .all(id) as { id: string }[];
      for (const m of members) removeEntityTags('time_block', m.id);
      sqlite.prepare(`DELETE FROM time_blocks WHERE parent_block_id = ?`).run(id);
    }
    // CON-4: deleting a recurring template also removes its materialized instances
    // (+ their tag rows) — otherwise orphan instances would linger with a dead parent.
    for (const inst of sqlite
      .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? RETURNING id`)
      .all(id) as { id: string }[]) {
      removeEntityTags('time_block', inst.id);
    }
    const [block] = await db.delete(timeBlocks).where(eq(timeBlocks.id, id)).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    // CON-3 cascade: the block itself is HARD-deleted — drop its tag rows.
    removeEntityTags('time_block', id);
    broadcast(currentOwnerId(), 'block:deleted', { id });
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
          WHERE is_auto = 1 AND is_locked = 0 AND block_kind = 'task' AND source_kind = 'agent'
            AND status NOT IN ('completed','skipped')
            AND start_at < ? AND end_at > ?
          RETURNING id`,
      )
      .all(dayEndISO, dayStartISO) as { id: string }[];
    for (const r of removed) removeEntityTags('time_block', r.id);
    if (removed.length) broadcast(owner, 'block:deleted', { cleared: removed.length, date });
    writeAudit({ ownerId: owner, actor: 'owner', action: 'clear-day', entity: `day:${date}` });
    ctx.body = { ok: true, cleared: removed.length };
  });

  return router;
}
