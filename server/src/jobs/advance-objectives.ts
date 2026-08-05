import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { logger } from '../lib/logger.js';

/**
 * Phase N1 — cadence push: for each active objective with a due cadence period,
 * nominate its next-action task into the Flight-plan staging tray.
 *
 * Anti-thrash rules (all must pass before nominating):
 *  - cadence !== 'none'
 *  - status === 'active'
 *  - not archived (0129) — the archive is orthogonal to status, so an archived objective
 *    keeps status 'active' (that is what makes restore lossless). Without an explicit
 *    archived_at check this job would go on pushing a filed-away objective's tasks into
 *    the owner's flight plan every period — the one place the archive has to hold, since
 *    nothing here is user-initiated.
 *  - last_advanced_at is older than the cadence period (or NULL)
 *  - a next-action task exists (highest-priority open leaf task in the LIVE subtree)
 *  - the next-action task is not already staged, in_progress, done, or cancelled
 *
 * UPSERT semantics: if the next-action is already staged (e.g. from a pattern),
 * the row's source_kind/source_ref is repointed to the objective — the task stays
 * in the staging tray, not duplicated, not silently ignored.
 *
 * Bumps last_advanced_at on every successful nomination so the task is not
 * re-nominated until the next period.
 */
export async function advanceObjectives(
  owner: string = currentOwnerId(),
  { now = new Date().toISOString() }: { now?: string } = {},
): Promise<{
  nominated: number;
  skipped: number;
}> {
  let nominated = 0;
  let skipped = 0;

  // Period thresholds in days.
  const PERIOD_DAYS: Record<string, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
  };

  // Fetch LIVE active objectives that have a cadence and are due for advancement.
  const objectives = await store()
    .prepare(
      `SELECT id, cadence, last_advanced_at
         FROM objectives
        WHERE owner_id = ?
          AND status = 'active'
          AND archived_at IS NULL
          AND cadence != 'none'`
    )
    .all<{ id: string; cadence: string; last_advanced_at: string | null }>(owner);

  for (const obj of objectives) {
    const periodDays = PERIOD_DAYS[obj.cadence];
    if (!periodDays) { skipped++; continue; }

    // Anti-thrash: skip if advanced within the current period.
    if (obj.last_advanced_at) {
      const msAgo = new Date(now).getTime() - new Date(obj.last_advanced_at).getTime();
      const daysAgo = msAgo / 86_400_000;
      if (daysAgo < periodDays) { skipped++; continue; }
    }

    // Find next-action: highest-priority open task across the owner's full LIVE subtree
    // (this objective + all non-archived descendants via recursive CTE). Mirrors
    // buildTree's next_action walk exactly — an archived branch must not nominate work,
    // and the descent stays inside the owner. Owner-scoping matters most HERE: this is a
    // WRITER, so an unconstrained walk over corrupt sync/import data would not just
    // display another owner's task, it would stage it in this owner's flight plan.
    const nextAction = await store()
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? AS id
           UNION ALL
           SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
            WHERE o.archived_at IS NULL AND o.owner_id = ?
         )
         SELECT t.id, t.status
           FROM objective_tasks ot
           JOIN tasks t ON t.id = ot.task_id
           JOIN sub ON ot.objective_id = sub.id
          WHERE ot.linked = 1 AND t.owner_id = ? AND t.status NOT IN ('done', 'cancelled', 'deferred', 'in_progress')
          ORDER BY t.priority ASC, t.id ASC
          LIMIT 1`
      )
      .get<{ id: string; status: string }>(obj.id, owner, owner);

    if (!nextAction) {
      // No next action (all done, or no tasks linked) — flag but don't nominate.
      logger.info(`advance_objectives: objective ${obj.id} has no next action — skipping`);
      skipped++;
      continue;
    }

    // Anti-thrash: skip if already staged (even without an in_progress check above,
    // check the flight_plan; we still UPSERT to repoint the source if it exists
    // but was from a different source kind — that's the explicit N1 requirement).
    // Exception: if task is 'in_progress' (caught above) don't repoint.

    const nextPos = (await store()
        .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`)
        .get<{ m: number }>(owner))!.m + 1;

    // UPSERT: if already staged, repoint source to this objective.
    // If not staged, add it fresh.
    await store()
      .prepare(
        `INSERT INTO flight_plan (owner_id, task_id, source_kind, source_ref, selected, position, added_at)
         VALUES (?, ?, 'objective', ?, 1, ?, ?)
         ON CONFLICT (owner_id, task_id) DO UPDATE SET
           source_kind = 'objective',
           source_ref  = excluded.source_ref`
      )
      .run(owner, nextAction.id, obj.id, nextPos, now);

    // Bump last_advanced_at so this objective isn't re-run until the next period.
    await store()
      .prepare(`UPDATE objectives SET last_advanced_at = ? WHERE id = ?`)
      .run(now, obj.id);

    nominated++;
  }

  return { nominated, skipped };
}
