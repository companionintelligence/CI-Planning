import { join } from 'node:path';
import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { clearPlannerRange } from '../engine/clear-range.js';
import { snapshot, backupDir } from '../lib/backup.js';
import { writeAudit } from '../lib/audit.js';
import { broadcast } from './sse.js';
import { validateClearRange } from '../services/engine-ops.js';

/**
 * Phase P · P2 — owner-facing "Clear Date Range". A first-class wrapper over the
 * shared `clearPlannerRange` engine: clears planner instances from `start` (and,
 * if given, through `end`) and stops the recurrence engines repopulating them.
 *
 *   - open-ended (no `end`) → caps each generator's rule with UNTIL (stops forever).
 *   - bounded (`start..end`) → per-day exdates/opt-outs (series resumes after `end`).
 *
 * `dry_run` returns the same report without writing (for the Settings preview).
 * A real apply snapshots the DB first so it's recoverable.
 */
export function plannerRouter() {
  const router = new Router();

  // POST /api/planner/clear  { start, end?, dry_run? }
  router.post('/api/planner/clear', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { start?: unknown; end?: unknown; dry_run?: unknown };

    // Validation lives in services/engine-ops.ts (shared with GraphQL): all the 400 checks
    // (start/end YYYY-MM-DD, end >= start, bounded span <= MAX_SPAN_DAYS, dry_run boolean)
    // from ONE source. The bounded-span cap is a 400 here rather than letting the engine
    // throw a bare Error → 500. The snapshot + clearPlannerRange + broadcast stay in the
    // transport (route + resolver each fire them).
    const v = validateClearRange({ start: body.start, end: body.end, dryRun: body.dry_run });
    if (!v.ok) {
      ctx.status = 400;
      ctx.body = { error: v.error };
      return;
    }
    const { start, end, dryRun } = v;
    const owner = currentOwnerId();

    // Snapshot BEFORE a real apply — this is a bulk destructive op. Return only the
    // snapshot FILENAME to the client (not the absolute host path, which would leak
    // the server's directory layout).
    let backup: string | undefined;
    if (!dryRun) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `companion-preclear-${ts}.db`;
      await snapshot(join(backupDir, filename));
      backup = filename;
    }

    const result = clearPlannerRange({
      owner,
      start: start as string,
      end: end as string | null,
      suppress: 'auto',
      autoOnly: false, // the explicit tool may remove user-placed/locked blocks too, by design
      dryRun,
    });

    if (!dryRun) {
      writeAudit({ ownerId: owner, actor: 'owner', action: 'clear-range', entity: `planner:${start}..${end ?? ''}` });
      broadcast(owner, 'block:deleted', { cleared: result.blocksDeleted, start, end });
    }

    ctx.body = { ...result, ...(backup ? { backup } : {}) };
  });

  return router;
}
