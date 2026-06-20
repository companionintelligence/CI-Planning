import Router from '@koa/router';
import { eq, and, gte, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { timeBlocks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApi, toApiList } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';

export function blocksRouter() {
  const router = new Router();

  // GET /api/blocks?from=ISO&to=ISO&block_type=concept
  // `block_type=concept` returns all of the owner's Concepts regardless of date
  // (they have no real time) — the horizon lane reads them this way.
  router.get('/api/blocks', async (ctx) => {
    const { from, to, block_type } = ctx.query as Record<string, string>;

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
    const id = Number(ctx.params.id);
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
      all_day: boolean;
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

    const [block] = await db.update(timeBlocks).set(update).where(eq(timeBlocks.id, id)).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const out = toApi(block);
    broadcast(currentOwnerId(), 'block:updated', out);
    ctx.body = { block: out };
  });

  // POST /api/blocks/:id/promote — turn a Concept into a scheduled Plan.
  // The client supplies the chosen start (and all_day for day-long Plans); end
  // defaults to start + the concept's duration_minutes.
  router.post('/api/blocks/:id/promote', async (ctx) => {
    const id = Number(ctx.params.id);
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

  // DELETE /api/blocks/:id
  router.delete('/api/blocks/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const [block] = await db.delete(timeBlocks).where(eq(timeBlocks.id, id)).returning();
    if (!block) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'block:deleted', { id });
    ctx.body = { ok: true };
  });

  return router;
}
