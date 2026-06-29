import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { applyOp, type Op, type ApplyResult } from '../sync/apply.js';
import { logSyncEvent, emitToClients } from './sse.js';

/** Maximum ops in a single batch — prevents runaway requests. */
const BATCH_LIMIT = 200;

/**
 * POST /api/sync
 *
 * Apply a batch of field-level ops in one transaction. Each op is applied
 * with field-level LWW + monotonic completion (§3/§4). The full batch commits
 * atomically; individual op failures are reported per-op without aborting the
 * batch. SSE events are emitted AFTER the transaction commits so clients never
 * receive events for uncommitted data.
 *
 * Request:  { ops: Op[] }
 * Response: { results: (ApplyResult | { opId, error })[] }
 */
export function syncRouter() {
  const router = new Router();

  router.post('/api/sync', async (ctx) => {
    const body = ctx.request.body as { ops?: unknown };
    if (!Array.isArray(body?.ops)) {
      ctx.status = 400;
      ctx.body = { error: 'ops must be an array' };
      return;
    }
    const ops = body.ops as Op[];
    if (ops.length > BATCH_LIMIT) {
      ctx.status = 400;
      ctx.body = { error: `batch too large (max ${BATCH_LIMIT})` };
      return;
    }

    const ownerId = currentOwnerId();

    // Collect (seq, event, payload) tuples to emit after the tx commits.
    const toEmit: { seq: number; event: string; payload: unknown }[] = [];
    const results: (ApplyResult | { opId: string; error: string })[] = [];

    sqlite.transaction(() => {
      for (const op of ops) {
        try {
          const result = applyOp(sqlite, op, ownerId);
          const eventName = op.entity === 'task' ? 'task:updated' : 'block:updated';
          const payload = { id: op.entityId, version: result.version, ...result.applied };
          // logSyncEvent is inside the transaction — it shares the same connection
          // and therefore the same tx; a rollback would also roll back the log row.
          const seq = logSyncEvent(ownerId, eventName, payload);
          toEmit.push({ seq, event: eventName, payload });
          results.push(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'apply failed';
          results.push({ opId: op.opId, error: msg });
        }
      }
    })();

    // Broadcast after the transaction commits so events are never for rolled-back data.
    for (const { seq, event, payload } of toEmit) {
      emitToClients(ownerId, seq, event, payload);
    }

    ctx.body = { results };
  });

  return router;
}
