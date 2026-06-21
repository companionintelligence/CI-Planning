import Router from '@koa/router';
import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { timeBlocks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi, toApiList } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { ensurePatternsForRange } from '../engine/patterns-place.js';

export function blocksRouter() {
  const router = new Router();

  // GET /api/blocks?from=ISO&to=ISO&block_type=concept
  // `block_type=concept` returns all of the owner's Concepts regardless of date
  // (they have no real time) — the horizon lane reads them this way.
  router.get('/api/blocks', async (ctx) => {
    const { from, to, block_type } = ctx.query as Record<string, string>;

    // Lazy pattern placement (PR-C+, Phase D refactor): when the read targets
    // a real time range (not the concept list), ensure every recurring Habit/
    // Routine pattern that fires inside it is on the board before we SELECT.
    // Idempotent via the marker on time_blocks → safe to call on every read.
    if (from && to && !block_type) {
      ensurePatternsForRange(currentOwnerId(), from, to);
    }

    const conditions = [];
    if (from) conditions.push(gte(timeBlocks.startAt, from));
    if (to)   conditions.push(lte(timeBlocks.endAt, to));
    if (block_type) conditions.push(eq(timeBlocks.blockType, block_type));

    const rows = conditions.length
      ? await db.select().from(timeBlocks).where(and(...conditions))
      : await db.select().from(timeBlocks);

    ctx.body = { blocks: toApiList(rows) };
  });

  // POST /api/blocks
  router.post('/api/blocks', async (ctx) => {
    const body = ctx.request.body as {
      task_id?: number;
      title: string;
      block_kind?: string;
      tag?: string;
      block_type?: string;
      goal_start_date?: string;
      duration_minutes?: number;
      note?: string;
      start_at: string;
      end_at: string;
      is_locked?: boolean;
      all_day?: boolean;
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
      })
      .returning();

    const out = toApi(block);
    broadcast(currentOwnerId(), 'block:created', out);
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
    }>;

    const update: Partial<typeof timeBlocks.$inferInsert> = {};
    if (body.title           !== undefined) update.title           = body.title;
    if (body.start_at        !== undefined) update.startAt         = body.start_at;
    if (body.end_at          !== undefined) update.endAt           = body.end_at;
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

    const [block] = await db.update(timeBlocks).set(update).where(eq(timeBlocks.id, id)).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const out = toApi(block);
    broadcast(currentOwnerId(), 'block:updated', out);
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
      .set({ blockType: 'plan', allDay: body.all_day ?? false, startAt: body.start_at, endAt, goalStartDate: null })
      .where(eq(timeBlocks.id, id))
      .returning();
    const out = toApi(block);
    broadcast(currentOwnerId(), 'block:updated', out);
    ctx.body = { block: out };
  });

  // DELETE /api/blocks/:id[?children=delete]
  // Default: deleting a Plan detaches its members (FK ON DELETE SET NULL) — they
  // survive as loose task blocks. `?children=delete` removes the members too
  // (PR-C: the "remove tasks" choice in the delete-Plan confirm dialog).
  router.delete('/api/blocks/:id', async (ctx) => {
    const id = ctx.params.id;
    if ((ctx.query.children as string) === 'delete') {
      sqlite.prepare(`DELETE FROM time_blocks WHERE parent_block_id = ?`).run(id);
    }
    const [block] = await db.delete(timeBlocks).where(eq(timeBlocks.id, id)).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'block:deleted', { id });
    ctx.body = { ok: true };
  });

  return router;
}
