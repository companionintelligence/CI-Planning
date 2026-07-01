import { join } from 'node:path';
import Router from '@koa/router';
import { currentOwnerId } from '../lib/context.js';
import { isValidISODate } from '../lib/dates.js';
import { clearPlannerRange } from '../engine/clear-range.js';
import { MAX_SPAN_DAYS } from '../engine/recurrence.js';
import { snapshot, backupDir } from '../lib/backup.js';
import { writeAudit } from '../lib/audit.js';
import { broadcast } from './sse.js';

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
    const start = body.start;
    const end = body.end === undefined || body.end === null || body.end === '' ? null : body.end;

    if (!isValidISODate(start)) {
      ctx.status = 400;
      ctx.body = { error: 'start must be a YYYY-MM-DD date' };
      return;
    }
    if (end !== null && !isValidISODate(end)) {
      ctx.status = 400;
      ctx.body = { error: 'end must be a YYYY-MM-DD date' };
      return;
    }
    if (end !== null && (end as string) < (start as string)) {
      ctx.status = 400;
      ctx.body = { error: 'end must be on or after start' };
      return;
    }
    // Cap the bounded span here (a 400) rather than letting the engine throw a bare
    // Error → 500 leaking an internal message, and before wasting a snapshot on apply.
    if (end !== null) {
      const span = Math.floor((Date.parse(`${end as string}T00:00:00Z`) - Date.parse(`${start as string}T00:00:00Z`)) / 86_400_000);
      if (span > MAX_SPAN_DAYS) {
        ctx.status = 400;
        ctx.body = { error: `end must be within ${MAX_SPAN_DAYS} days of start` };
        return;
      }
    }

    // `dry_run` must be an explicit boolean if present — otherwise a truthy non-bool
    // (e.g. the string "false") would silently flip an intended apply into a preview.
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
      ctx.status = 400;
      ctx.body = { error: 'dry_run must be a boolean' };
      return;
    }
    const owner = currentOwnerId();
    const dryRun = body.dry_run === true;

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
