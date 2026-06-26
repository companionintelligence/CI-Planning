import Router from '@koa/router';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { possibleTasks, tasks } from '../db/schema.js';
import { broadcast } from './sse.js';
import { toApiList, taskToApi } from '../lib/serialize.js';
import { currentOwnerId } from '../lib/context.js';
import { writeAudit } from '../lib/audit.js';
import { autoScheduleOnIngest } from '../engine/autoplan.js';

/**
 * Linchpin (auto-scheduling finding 2): copy a possible-task's suggested tags onto
 * the promoted task's entity_tags, or the direction tag the Auto engine matches on
 * vanishes exactly when an item becomes schedulable. Level by kind — the direction
 * (pattern) tag lands at level 1 (the placement-relevant read, taskTagNames), content
 * (intention) tags at level 2 (secondary). Idempotent inserts onto a fresh task.
 */
const selectPossibleTags = sqlite.prepare(
  `SELECT pt.tag_id AS id, tg.kind AS kind FROM possible_task_tags pt
     JOIN tags tg ON tg.id = pt.tag_id
    WHERE pt.possible_task_id = ?`,
);
const insertTaskTag = sqlite.prepare(
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`,
);
function carryPossibleTags(possibleId: string, taskId: string): void {
  for (const r of selectPossibleTags.all(possibleId) as { id: string; kind: string }[]) {
    insertTaskTag.run(taskId, r.id, r.kind === 'pattern' ? 1 : 2);
  }
}

export function possiblesRouter() {
  const router = new Router();

  // GET /api/possible-tasks
  router.get('/api/possible-tasks', async (ctx) => {
    const { status = 'pending' } = ctx.query as Record<string, string>;
    const rows = await db
      .select()
      .from(possibleTasks)
      .where(eq(possibleTasks.status, status));
    ctx.body = { possibles: toApiList(rows) };
  });

  // POST /api/possible-tasks/:id/promote
  router.post('/api/possible-tasks/:id/promote', async (ctx) => {
    const id = ctx.params.id;
    const [possible] = await db.select().from(possibleTasks).where(eq(possibleTasks.id, id));
    if (!possible) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    const overrides = (ctx.request.body ?? {}) as Partial<{
      title: string;
      due_at: string;
      priority: number;
    }>;

    const [task] = await db
      .insert(tasks)
      .values({
        title: overrides.title ?? possible.rawTitle,
        description: possible.rawSummary ?? undefined,
        dueAt: overrides.due_at ?? possible.proposedDueAt ?? undefined,
        priority: overrides.priority ?? possible.proposedPriority ?? 3,
        ownerId: possible.proposedOwnerId ?? currentOwnerId(),
        sourceKind: possible.sourceKind ?? 'agent',
        sourceRef: possible.sourceRef ?? undefined,
      })
      .returning();

    carryPossibleTags(id, task.id);

    await db
      .update(possibleTasks)
      .set({ status: 'promoted', promotedTaskId: task.id })
      .where(eq(possibleTasks.id, id));

    const out = taskToApi(task);
    broadcast(currentOwnerId(), 'possible:promoted', { id, task: out });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'promote', entity: `possible:${id}` });

    // TM-5: in the Hands-off trust mode, auto-block the promoted work (estimate-bearing only).
    // Best-effort — a placement hiccup must not fail the promote. No-op in Cautious/Balanced.
    try { autoScheduleOnIngest(currentOwnerId(), { requireEstimate: true }); } catch { /* best-effort */ }

    ctx.status = 201;
    ctx.body = { task: out };
  });

  // POST /api/possible-tasks/:id/dismiss
  router.post('/api/possible-tasks/:id/dismiss', async (ctx) => {
    const id = ctx.params.id;
    const [possible] = await db
      .update(possibleTasks)
      .set({ status: 'dismissed' })
      .where(eq(possibleTasks.id, id))
      .returning();
    if (!possible) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    broadcast(currentOwnerId(), 'possible:dismissed', { id });
    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'dismiss', entity: `possible:${id}` });
    ctx.body = { ok: true };
  });

  return router;
}
