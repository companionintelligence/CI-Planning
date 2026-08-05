import { store } from '../db/store.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Flight-plan staging service (Phase W · W5, Decision 3). The flight-plan is the
 * persisted, owner-scoped staging area (Phase G, G4): staging a task or a whole
 * pattern's member tasks, toggling/reordering entries, and Reset. Extracted VERBATIM
 * from routes/flight-plan.ts so REST + GraphQL share ONE owner-scoped implementation —
 * the route suite (flight-plan.test.ts) is the byte-equivalence lock.
 *
 * The two-step Auto endpoints (fill/run/priority/undo) call engine functions directly,
 * not this staging logic, so they stay in the route (GraphQL engine ops are W13).
 *
 * `writeAudit` lives here (the tags-service precedent) so REST and GraphQL emit identical
 * audit rows; SSE `broadcast` stays transport-side (route + resolver each fire it), since
 * the service is transport-agnostic and returns a rich-enough result to do so.
 *
 * Async via the store facade (pass A) — formerly sync on raw better-sqlite3.
 */

/** One enriched flight-plan row — the exact shape REST returns (snake_case + the derived
 *  `selected`/`is_recurring` booleans). GraphQL reads task_id/selected/position/source_kind
 *  from it; the task-detail columns (title/priority/…) exist for the REST client. */
export interface FlightPlanRow {
  task_id: string;
  selected: boolean;
  position: number;
  source_kind: string;
  source_ref: string | null;
  added_at: string;
  title: string;
  priority: number | null;
  estimated_minutes: number | null;
  status: string;
  recurrence_rule: string | null;
  is_recurring: boolean;
}

interface FpRawRow {
  task_id: string;
  selected: number;
  position: number;
  source_kind: string;
  source_ref: string | null;
  added_at: string;
  title: string;
  priority: number | null;
  estimated_minutes: number | null;
  status: string;
  recurrence_rule: string | null;
}

/** The owner's flight-plan, ordered by (position, task_id) — joined to tasks so only
 *  entries with a live task are returned (task_id FK is ON DELETE CASCADE anyway). The
 *  JOIN also pins `t.owner_id = fp.owner_id` (defense-in-depth): even if a flight_plan row
 *  ever pointed at another owner's task (polluted data / an unsafe write path), its fields
 *  can never leak through this read. */
export async function listFlightPlan(owner: string): Promise<FlightPlanRow[]> {
  const rows = await store()
    .prepare(
      `SELECT fp.task_id, fp.selected, fp.position, fp.source_kind, fp.source_ref, fp.added_at,
              t.title, t.priority, t.estimated_minutes, t.status, t.recurrence_rule
         FROM flight_plan fp JOIN tasks t ON t.id = fp.task_id AND t.owner_id = fp.owner_id
        WHERE fp.owner_id = ? ORDER BY fp.position, fp.task_id`,
    )
    .all<FpRawRow>(owner);
  return rows.map((r) => ({ ...r, selected: !!r.selected, is_recurring: !!r.recurrence_rule }));
}

async function nextPos(owner: string): Promise<number> {
  return (await store().prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM flight_plan WHERE owner_id = ?`).get<{ m: number }>(owner))!.m + 1;
}

export type StageInput = { taskId?: string | number | null; patternId?: string | number | null };
export type StageResult =
  | { ok: true; added: number }
  | { ok: false; error: 'task_not_found' | 'pattern_not_found' | 'is_instance' | 'nothing_specified' };

/**
 * Stage a task, or a whole pattern's member tasks (each tagged with its source pattern).
 * Mirrors POST /api/flight-plan exactly — pattern takes precedence when both are given,
 * a recurrence INSTANCE is rejected (stage the template), unknown ids are not_found.
 * INSERT OR IGNORE means already-staged rows are skipped (added counts only new rows).
 */
export async function stage(owner: string, input: StageInput): Promise<StageResult> {
  const ins = store().prepare(
    `INSERT OR IGNORE INTO flight_plan (owner_id, task_id, source_kind, source_ref, selected, position) VALUES (?, ?, ?, ?, 1, ?)`,
  );
  let added = 0;
  if (input.patternId != null) {
    const owns = await store().prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(input.patternId, owner);
    if (!owns) return { ok: false, error: 'pattern_not_found' };
    // Filter members to the owner's own tasks (pattern_tasks carries no owner_id, so a
    // polluted membership row can't stage — and later expose — a cross-owner task). The
    // (position, task_id) order is deterministic even if two members share a position.
    const members = await store()
      .prepare(
        `SELECT pt.task_id FROM pattern_tasks pt JOIN tasks t ON t.id = pt.task_id
          WHERE pt.pattern_id = ? AND t.owner_id = ? ORDER BY pt.position, pt.task_id`,
      )
      .all<{ task_id: string }>(input.patternId, owner);
    let pos = await nextPos(owner);
    for (const m of members) if ((await ins.run(owner, m.task_id, 'pattern', input.patternId, pos++)).changes > 0) added++;
  } else if (input.taskId != null) {
    const t = await store().prepare(`SELECT recurrence_parent_id FROM tasks WHERE id = ? AND owner_id = ?`).get<{ recurrence_parent_id: string | null }>(input.taskId, owner);
    if (!t) return { ok: false, error: 'task_not_found' };
    if (t.recurrence_parent_id) return { ok: false, error: 'is_instance' };
    if ((await ins.run(owner, input.taskId, 'manual', null, await nextPos(owner))).changes > 0) added++;
  } else {
    return { ok: false, error: 'nothing_specified' };
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'stage', entity: 'flight-plan:stage' });
  return { ok: true, added };
}

export type UpdateEntryResult = { ok: true } | { ok: false; error: 'not_staged' };

/** Toggle `selected` and/or set `position` on a staged entry. Mirrors PATCH — a
 *  non-staged task is not_found; only the keys the caller sent are written. */
export async function updateEntry(owner: string, taskId: string, patch: { selected?: boolean; position?: number }): Promise<UpdateEntryResult> {
  if (!(await store().prepare(`SELECT 1 FROM flight_plan WHERE owner_id = ? AND task_id = ?`).get(owner, taskId))) {
    return { ok: false, error: 'not_staged' };
  }
  if (patch.selected !== undefined) await store().prepare(`UPDATE flight_plan SET selected = ? WHERE owner_id = ? AND task_id = ?`).run(patch.selected ? 1 : 0, owner, taskId);
  if (patch.position !== undefined) await store().prepare(`UPDATE flight_plan SET position = ? WHERE owner_id = ? AND task_id = ?`).run(patch.position, owner, taskId);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'toggle', entity: `flight-plan:${taskId}` });
  return { ok: true };
}

/** Unstage one entry. Idempotent (mirrors DELETE — no existence check, no 404). */
export async function unstageEntry(owner: string, taskId: string): Promise<void> {
  await store().prepare(`DELETE FROM flight_plan WHERE owner_id = ? AND task_id = ?`).run(owner, taskId);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'remove', entity: `flight-plan:${taskId}` });
}

/** Clear the whole flight-plan (the Reset button). Returns the row count cleared. */
export async function resetFlightPlan(owner: string): Promise<{ cleared: number }> {
  const r = await store().prepare(`DELETE FROM flight_plan WHERE owner_id = ?`).run(owner);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'reset', entity: 'flight-plan:reset' });
  return { cleared: r.changes };
}
