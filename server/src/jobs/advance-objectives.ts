import { sqlite } from '../db/index.js';
import { currentOwnerId, SYSTEM_OWNER } from '../lib/context.js';
import { logger } from '../lib/logger.js';

/**
 * Phase N1 — cadence push: for each active objective with a due cadence period,
 * nominate its next-action task into the Flight-plan staging tray.
 *
 * Anti-thrash rules (all must pass before nominating):
 *  - cadence !== 'none'
 *  - status === 'active'
 *  - last_advanced_at is older than the cadence period (or NULL)
 *  - a next-action task exists (highest-priority open leaf task in the subtree)
 *  - the next-action task is not already staged, in_progress, done, or cancelled
 *
 * UPSERT semantics: if the next-action is already staged (e.g. from a pattern),
 * the row's source_kind/source_ref is repointed to the objective — the task stays
 * in the staging tray, not duplicated, not silently ignored.
 *
 * Bumps last_advanced_at on every successful nomination so the task is not
 * re-nominated until the next period.
 */
export function advanceObjectives(
  owner: string = currentOwnerId(),
  { now = new Date().toISOString() }: { now?: string } = {},
): {
  nominated: number;
  skipped: number;
} {
  let nominated = 0;
  let skipped = 0;

  // Period thresholds in days.
  const PERIOD_DAYS: Record<string, number> = {
    weekly: 7,
    biweekly: 14,
    monthly: 30,
  };

  // Fetch active objectives that have a cadence and are due for advancement.
  const objectives = sqlite
    .prepare(
      `SELECT id, cadence, last_advanced_at
         FROM objectives
        WHERE owner_id = ?
          AND status = 'active'
          AND cadence != 'none'`
    )
    .all(owner) as { id: string; cadence: string; last_advanced_at: string | null }[];

  for (const obj of objectives) {
    const periodDays = PERIOD_DAYS[obj.cadence];
    if (!periodDays) { skipped++; continue; }

    // Anti-thrash: skip if advanced within the current period.
    if (obj.last_advanced_at) {
      const msAgo = new Date(now).getTime() - new Date(obj.last_advanced_at).getTime();
      const daysAgo = msAgo / 86_400_000;
      if (daysAgo < periodDays) { skipped++; continue; }
    }

    // Find next-action: highest-priority open task across the full subtree
    // (this objective + all descendants via recursive CTE).
    const nextAction = sqlite
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ? AS id
           UNION ALL
           SELECT o.id FROM objectives o JOIN sub ON o.parent_id = sub.id
         )
         SELECT t.id, t.status
           FROM objective_tasks ot
           JOIN tasks t ON t.id = ot.task_id
           JOIN sub ON ot.objective_id = sub.id
          WHERE ot.linked = 1 AND t.status NOT IN ('done', 'cancelled', 'deferred', 'in_progress')
          ORDER BY t.priority ASC, t.id ASC
          LIMIT 1`
      )
      .get(obj.id) as { id: string; status: string } | undefined;

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

    const nextPos = (
      sqlite
        .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`)
        .get(owner) as { m: number }
    ).m + 1;

    // UPSERT: if already staged, repoint source to this objective.
    // If not staged, add it fresh.
    sqlite
      .prepare(
        `INSERT INTO flight_plan (owner_id, task_id, source_kind, source_ref, selected, position, added_at)
         VALUES (?, ?, 'objective', ?, 1, ?, ?)
         ON CONFLICT (owner_id, task_id) DO UPDATE SET
           source_kind = 'objective',
           source_ref  = excluded.source_ref`
      )
      .run(owner, nextAction.id, obj.id, nextPos, now);

    // Bump last_advanced_at so this objective isn't re-run until the next period.
    sqlite
      .prepare(`UPDATE objectives SET last_advanced_at = ? WHERE id = ?`)
      .run(now, obj.id);

    nominated++;
  }

  return { nominated, skipped };
}
