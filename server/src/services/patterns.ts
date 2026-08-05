import { store } from '../db/store.js';
import { writeAudit } from '../lib/audit.js';
import { removeEntityTags, routineDerivedTags, type DerivedRoutineTags } from './tags.js';
import { validatePatternRule } from '../engine/patterns-place.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';
import { localISODate } from '../lib/dates.js';

/**
 * Patterns (Phase G, ticket G1) — typed, reusable task collections (Routine ▢ / Habit ◯
 * / Ritual △ + user-defined kinds). Tasks-only, many-to-many membership; no own
 * recurrence per member. Owner-scoped throughout.
 *
 * Phase W · W6 (Decision 3): the pattern-type + pattern CRUD is extracted here so REST +
 * GraphQL share ONE owner-scoped implementation — `patterns.test.ts` (and
 * patterns-promote / pattern-recurrence) is the byte-equivalence lock. `writeAudit` fires
 * INSIDE these functions (the tags-service precedent); SSE `broadcast` stays transport-side
 * (route + resolver each fire it). The engine-ish handlers (fast-tasks, promote-from-*,
 * place-today) remain in routes/patterns.ts and reuse the exported helpers below.
 *
 * Reads/writes go through the store facade, so these are async. The multi-statement
 * sequences that used to be atomic purely BECAUSE better-sqlite3 was synchronous are
 * now explicit transactions (setMembers, deletePattern, ensureHabitPattern), and the
 * one cross-request check-then-write (deletePatternType's in-use guard) is a single
 * guarded statement — see docs/passA-worklist.md, "implicit atomicity".
 */

// ── Row + serialized shapes (the exact REST payloads) ─────────────────────────
export interface TypeRow {
  id: string;
  owner_id: string;
  name: string;
  icon_shape: string;
  reminder_config: string | null;
  is_builtin: number;
  color_token: string | null;
  texture: string | null;
  default_est_minutes: number | null;
  notify: number;
}
export interface PatternRow {
  id: string;
  owner_id: string;
  type_id: string | null;
  name: string;
  tag: string | null;
  notes: string | null;
  recurrence_rule: string | null;
  recurrence_dtstart: string | null;
  /** #391 — per-ITEM colour (CI-Hub token). NULL = inherit the type's colour. */
  color_token: string | null;
  created_at: string;
}

export function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const serializeType = (t: TypeRow) => ({
  id: t.id,
  owner_id: t.owner_id,
  name: t.name,
  icon_shape: t.icon_shape,
  reminder_config: parseJson(t.reminder_config),
  is_builtin: !!t.is_builtin,
  color_token: t.color_token,
  texture: t.texture,
  default_est_minutes: t.default_est_minutes,
  notify: !!t.notify,
});

/** Member task ids for a pattern, in (position, task_id) order. */
export async function taskIdsOf(patternId: string): Promise<string[]> {
  return (
    await store()
      .prepare(`SELECT task_id FROM pattern_tasks WHERE pattern_id = ? ORDER BY position, task_id`)
      .all<{ task_id: string }>(patternId)
  ).map((r) => r.task_id);
}

/**
 * AF-11 (D2): a routine's tags are DERIVED — the union of its member tasks' tags,
 * kind-classified into `directions` (multiple legal) + `intentions`. `tag` (the old
 * authored column) is kept in the payload for API-shape compat but is always null
 * after migration 0120. List callers pass the batched `derived` map entry (one query
 * for the whole list — see routineDerivedTagsByIds); single-row callers omit it.
 */
export const serializePattern = async (p: PatternRow, derived?: DerivedRoutineTags) => {
  const d = derived ?? await routineDerivedTags(p.id);
  return {
    id: p.id,
    owner_id: p.owner_id,
    type_id: p.type_id,
    name: p.name,
    tag: p.tag,
    directions: d.directions,
    intentions: d.intentions,
    notes: p.notes,
    recurrence_rule: p.recurrence_rule,
    recurrence_dtstart: p.recurrence_dtstart,
    color_token: p.color_token,
    created_at: p.created_at,
    task_ids: await taskIdsOf(p.id),
  };
};

/**
 * Replace a pattern's membership set with `taskIds` (in order). Each insert is
 * self-guarded to the OWNER's own tasks — the FK only checks a task exists, not that
 * it belongs to this owner, so a foreign task id is silently dropped (mirroring how
 * setDependencies drops cross-owner blockers) rather than leaking onto the pattern.
 */
export async function setMembers(owner: string, patternId: string, taskIds: string[]) {
  const ins = store().prepare(
    `INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?)`,
  );
  // Transactional now that the clear and the re-insert are no longer contiguous: a
  // concurrent reader (taskIdsOf, or the placement engine) would otherwise observe the
  // pattern with ZERO members for the duration of the loop.
  await store().transaction(async () => {
    await store().prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ?`).run(patternId);
    for (const [i, taskId] of taskIds.entries()) await ins.run(patternId, taskId, i, taskId, owner);
  });
}

/** The name of one of the OWNER's pattern types by id (used for the Ritual-recurrence
 *  guard). Owner-scoped so a stray cross-owner type_id can't drive recurrence validation
 *  off another owner's kind name. */
async function typeNameOf(owner: string, typeId: string | null): Promise<string | null> {
  if (typeId == null) return null;
  const row = await store().prepare(`SELECT name FROM pattern_types WHERE id = ? AND owner_id = ?`).get<{ name: string }>(typeId, owner);
  return row?.name ?? null;
}

/**
 * Validate + normalize a recurrence body on a pattern. Only Habit + Routine types may
 * carry a rule (Rituals are hidden in V1). If the caller omits `recurrence_dtstart`,
 * defaults to local-noon-as-UTC (mirrors the task-level convention in
 * engine/recurrence.ts — keeps every hit a safe ~12h from the local midnight boundary so
 * a DST flip never moves a hit's local date).
 */
async function buildRecurrenceFields(
  owner: string,
  typeId: string | null,
  rule: string | null | undefined,
  dtstart: string | null | undefined,
): Promise<{ ok: true; rule: string | null; dtstart: string | null } | { ok: false; error: string }> {
  if (rule === undefined && dtstart === undefined) return { ok: true, rule: undefined as unknown as null, dtstart: undefined as unknown as null };
  if (rule == null) return { ok: true, rule: null, dtstart: null }; // explicit clear
  const typeName = await typeNameOf(owner, typeId);
  if (typeName !== 'Habit' && typeName !== 'Routine') {
    return { ok: false, error: 'only Habit and Routine patterns can recur' };
  }
  const v = validatePatternRule(rule);
  if (!v.ok) return { ok: false, error: v.error };
  if (dtstart) return { ok: true, rule: v.rule, dtstart };
  const tz = (await store().prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get<{ timezone: string | null }>(owner))?.timezone || serverTimezone();
  return { ok: true, rule: v.rule, dtstart: zonedWallTimeToUTC(localISODate(), '12:00', tz) };
}

// ── Pattern types (PatternKindType) ───────────────────────────────────────────
export interface TypeInput {
  name?: string;
  icon_shape?: string;
  reminder_config?: unknown;
  color_token?: string | null;
  texture?: string | null;
  default_est_minutes?: number | null;
  notify?: boolean;
}

/** The owner's pattern types, built-ins first. Ritual is hidden unless `enable_rituals`
 *  is set (0024) — the row stays in the DB so flipping the flag back on restores it. */
export async function listPatternTypeRows(owner: string): Promise<TypeRow[]> {
  const rows = await store().prepare(`SELECT * FROM pattern_types WHERE owner_id = ? ORDER BY is_builtin DESC, id`).all<TypeRow>(owner);
  const enableRituals = !!(await store().prepare(`SELECT enable_rituals FROM scheduling_prefs WHERE owner_id = ?`).get<{ enable_rituals: number }>(owner))?.enable_rituals;
  return enableRituals ? rows : rows.filter((r) => r.name !== 'Ritual');
}

/** One of the owner's pattern types (raw row), or undefined (not found / not this owner's). */
export function getPatternTypeRow(owner: string, id: string): Promise<TypeRow | undefined> {
  return store().prepare(`SELECT * FROM pattern_types WHERE id = ? AND owner_id = ?`).get<TypeRow>(id, owner);
}

export type CreateTypeResult = { ok: true; row: TypeRow } | { ok: false; error: 'missing_fields' | 'insert_failed'; message?: string };

export async function createPatternType(owner: string, input: TypeInput): Promise<CreateTypeResult> {
  if (!input.name?.trim() || !input.icon_shape?.trim()) return { ok: false, error: 'missing_fields' };
  try {
    const row = (await store()
      .prepare(
        `INSERT INTO pattern_types (id, owner_id, name, icon_shape, reminder_config, is_builtin, color_token, texture, default_est_minutes, notify)
         VALUES (uuid7(), ?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING *`,
      )
      .get<TypeRow>(
        owner,
        input.name.trim(),
        input.icon_shape.trim(),
        input.reminder_config != null ? JSON.stringify(input.reminder_config) : null,
        input.color_token ?? null,
        input.texture ?? null,
        input.default_est_minutes ?? null,
        input.notify ? 1 : 0,
      ))!;
    writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `routine:${row.id}` });
    return { ok: true, row };
  } catch (err) {
    return { ok: false, error: 'insert_failed', message: (err as Error).message };
  }
}

export type UpdateTypeResult = { ok: true; row: TypeRow } | { ok: false; error: 'not_found' };

export async function updatePatternType(owner: string, id: string, input: TypeInput): Promise<UpdateTypeResult> {
  const existing = await getPatternTypeRow(owner, id);
  if (!existing) return { ok: false, error: 'not_found' };
  const name = input.name?.trim() ?? existing.name;
  const iconShape = input.icon_shape?.trim() ?? existing.icon_shape;
  // Explicit null clears to SQL NULL (consistent with createPatternType), not the string
  // "null" that JSON.stringify(null) would store.
  const reminder = input.reminder_config !== undefined
    ? (input.reminder_config != null ? JSON.stringify(input.reminder_config) : null)
    : existing.reminder_config;
  const colorToken = input.color_token !== undefined ? input.color_token : existing.color_token;
  const texture = input.texture !== undefined ? input.texture : existing.texture;
  const defaultEst = input.default_est_minutes !== undefined ? input.default_est_minutes : existing.default_est_minutes;
  const notify = input.notify !== undefined ? (input.notify ? 1 : 0) : existing.notify;
  const row = (await store()
    .prepare(
      `UPDATE pattern_types SET name = ?, icon_shape = ?, reminder_config = ?, color_token = ?, texture = ?, default_est_minutes = ?, notify = ?
        WHERE id = ? RETURNING *`,
    )
    .get<TypeRow>(name, iconShape, reminder, colorToken, texture, defaultEst, notify, id))!;
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${id}` });
  return { ok: true, row };
}

export type DeleteTypeResult = { ok: true } | { ok: false; error: 'not_found' | 'builtin' | 'in_use' };

export async function deletePatternType(owner: string, id: string): Promise<DeleteTypeResult> {
  const t = await getPatternTypeRow(owner, id);
  if (!t) return { ok: false, error: 'not_found' };
  if (t.is_builtin) return { ok: false, error: 'builtin' };
  // Guard + delete in ONE statement (the routes/accounts.ts PATCH pattern). The separate
  // COUNT-then-DELETE was race-free only while better-sqlite3 was synchronous; with an
  // await between them a pattern created concurrently on this kind would be orphaned by a
  // delete that had already read c = 0. Owner-scoped inside the guard for the same reason
  // the count was: only THIS owner's patterns may block THIS owner's kind.
  const res = await store()
    .prepare(
      `DELETE FROM pattern_types WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM patterns WHERE type_id = ? AND owner_id = ?)`,
    )
    .run(id, id, owner);
  if (res.changes === 0) return { ok: false, error: 'in_use' };
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `routine:${id}` });
  return { ok: true };
}

// ── Patterns (PatternType) ────────────────────────────────────────────────────
export interface CreatePatternInput {
  type_id?: string | null;
  name?: string;
  /** AF-11: accepted for API compat, IGNORED — routines derive tags from members. */
  tag?: string | null;
  notes?: string | null;
  task_ids?: string[];
  recurrence_rule?: string | null;
  recurrence_dtstart?: string | null;
  /** #391 — per-item colour token; explicit null clears (inherit the type's). */
  color_token?: string | null;
}
export type UpdatePatternInput = CreatePatternInput;

/** The owner's patterns (raw rows), newest first — the REST list order. */
export function listPatternRows(owner: string): Promise<PatternRow[]> {
  return store().prepare(`SELECT * FROM patterns WHERE owner_id = ? ORDER BY created_at DESC, id DESC`).all<PatternRow>(owner);
}

/** One of the owner's patterns (raw row), or undefined (not found / not this owner's). */
export function getPatternRow(owner: string, id: string): Promise<PatternRow | undefined> {
  return store().prepare(`SELECT * FROM patterns WHERE id = ? AND owner_id = ?`).get<PatternRow>(id, owner);
}

export type CreatePatternResult =
  | { ok: true; row: PatternRow }
  | { ok: false; error: 'name_required' | 'unknown_type' | 'bad_recurrence' | 'bad_membership'; message?: string };

export async function createPattern(owner: string, input: CreatePatternInput): Promise<CreatePatternResult> {
  if (!input.name?.trim()) return { ok: false, error: 'name_required' };
  // Validate the type belongs to this owner.
  if (input.type_id != null) {
    const type = await store().prepare(`SELECT id FROM pattern_types WHERE id = ? AND owner_id = ?`).get<{ id: string }>(input.type_id, owner);
    if (!type) return { ok: false, error: 'unknown_type' };
  }
  const rec = await buildRecurrenceFields(owner, input.type_id ?? null, input.recurrence_rule, input.recurrence_dtstart);
  if (!rec.ok) return { ok: false, error: 'bad_recurrence', message: rec.error };

  // AF-11 (D2): routines author NO tags — their tags derive from member tasks at read
  // time. An incoming `tag` is accepted for API compat (old clients still send it) but
  // IGNORED: the column stays NULL and nothing is mirrored to entity_tags.
  const p = (await store()
    .prepare(`INSERT INTO patterns (id, owner_id, type_id, name, tag, notes, recurrence_rule, recurrence_dtstart, color_token) VALUES (uuid7(), ?, ?, ?, NULL, ?, ?, ?, ?) RETURNING *`)
    .get<PatternRow>(
      owner,
      input.type_id ?? null,
      input.name.trim(),
      input.notes ?? null,
      rec.rule === undefined ? null : rec.rule,
      rec.dtstart === undefined ? null : rec.dtstart,
      input.color_token ?? null,
    ))!;
  if (Array.isArray(input.task_ids) && input.task_ids.length) {
    try {
      await setMembers(owner, p.id, input.task_ids);
    } catch (err) {
      return { ok: false, error: 'bad_membership', message: (err as Error).message };
    }
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `routine:${p.id}` });
  return { ok: true, row: p };
}

export type UpdatePatternResult =
  | { ok: true; row: PatternRow }
  | { ok: false; error: 'not_found' | 'unknown_type' | 'bad_recurrence' | 'bad_membership'; message?: string };

export async function updatePattern(owner: string, id: string, input: UpdatePatternInput): Promise<UpdatePatternResult> {
  const existing = await getPatternRow(owner, id);
  if (!existing) return { ok: false, error: 'not_found' };
  // Validate a newly-assigned type belongs to this owner (createPattern does the same).
  // patterns.type_id only FKs pattern_types.id with no owner constraint, so without this a
  // PATCH could point a pattern at another owner's kind (breaking delete guards + driving
  // recurrence validation off a foreign kind name).
  if (input.type_id != null) {
    const type = await store().prepare(`SELECT id FROM pattern_types WHERE id = ? AND owner_id = ?`).get<{ id: string }>(input.type_id, owner);
    if (!type) return { ok: false, error: 'unknown_type' };
  }
  const nextTypeId = input.type_id !== undefined ? input.type_id : existing.type_id;
  const rec = await buildRecurrenceFields(owner, nextTypeId, input.recurrence_rule, input.recurrence_dtstart);
  if (!rec.ok) return { ok: false, error: 'bad_recurrence', message: rec.error };

  // AF-11 (D2): `input.tag` is accepted-and-IGNORED (API compat) — the column is
  // preserved as-is (NULL after migration 0120) and entity_tags is never written.
  const row = (await store()
    .prepare(`UPDATE patterns SET type_id = ?, name = ?, notes = ?, recurrence_rule = ?, recurrence_dtstart = ?, color_token = ? WHERE id = ? RETURNING *`)
    .get<PatternRow>(
      nextTypeId,
      input.name?.trim() ?? existing.name,
      input.notes !== undefined ? input.notes : existing.notes,
      rec.rule === undefined ? existing.recurrence_rule : rec.rule,
      rec.dtstart === undefined ? existing.recurrence_dtstart : rec.dtstart,
      input.color_token !== undefined ? input.color_token : existing.color_token,
      id,
    ))!;
  if (Array.isArray(input.task_ids)) {
    try {
      await setMembers(owner, id, input.task_ids);
    } catch (err) {
      return { ok: false, error: 'bad_membership', message: (err as Error).message };
    }
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${id}` });
  return { ok: true, row };
}

export type DeletePatternResult = { ok: true } | { ok: false; error: 'not_found' };

export async function deletePattern(owner: string, id: string): Promise<DeletePatternResult> {
  const p = await store().prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get<{ id: string }>(id, owner);
  if (!p) return { ok: false, error: 'not_found' };
  // Ritual-local fast tasks are owned by the pattern — delete them with it. Shared real
  // tasks are untouched (only membership rows cascade). CON-3 cascade: hard-deleted tasks
  // + the routine drop their tag rows first (fast-task ids read before the DELETE).
  const fastTasks = await store()
    .prepare(`SELECT id FROM tasks WHERE subtype = 'quick' AND id IN (SELECT task_id FROM pattern_tasks WHERE pattern_id = ?)`)
    .all<{ id: string }>(id);
  for (const t of fastTasks) await removeEntityTags('task', t.id);
  // One transaction: the fast-task purge reads its ids from pattern_tasks, which the
  // pattern DELETE cascades away. Split across an await, a failure between them would
  // leave the ritual's fast tasks orphaned with no pattern left to identify them by.
  await store().transaction(async () => {
    await store().prepare(`DELETE FROM tasks WHERE subtype = 'quick' AND id IN (SELECT task_id FROM pattern_tasks WHERE pattern_id = ?)`).run(id);
    await store().prepare(`DELETE FROM patterns WHERE id = ?`).run(id); // pattern_tasks cascade; shared tasks untouched
  });
  await removeEntityTags('routine', id);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `routine:${id}` });
  return { ok: true };
}

export type AddTaskResult = { ok: true } | { ok: false; error: 'not_found' | 'add_failed'; message?: string };

/** Add one task to a pattern (owner-scoped). FK guards task existence; a failure surfaces
 *  as add_failed (the route 400s it). Idempotent on the (pattern, task) PK. */
export async function addPatternTask(owner: string, patternId: string, taskId: string, position = 0): Promise<AddTaskResult> {
  if (!(await store().prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, owner))) return { ok: false, error: 'not_found' };
  // The task must be the owner's own too — the FK guards existence, not ownership, so
  // without this a caller could add another owner's task to their pattern and read its
  // title/estimate at placement time. not_found (same as a missing pattern) so ownership
  // isn't probeable.
  if (!(await store().prepare(`SELECT 1 FROM tasks WHERE id = ? AND owner_id = ?`).get(taskId, owner))) return { ok: false, error: 'not_found' };
  try {
    await store().prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`).run(patternId, taskId, position);
  } catch (err) {
    return { ok: false, error: 'add_failed', message: (err as Error).message };
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${patternId}` });
  return { ok: true };
}

export type RemoveTaskResult = { ok: true } | { ok: false; error: 'not_found' };

/** Remove one task's membership from a pattern (owner-scoped; the task row is untouched). */
export async function removePatternTask(owner: string, patternId: string, taskId: string): Promise<RemoveTaskResult> {
  if (!(await store().prepare(`SELECT id FROM patterns WHERE id = ? AND owner_id = ?`).get(patternId, owner))) return { ok: false, error: 'not_found' };
  await store().prepare(`DELETE FROM pattern_tasks WHERE pattern_id = ? AND task_id = ?`).run(patternId, taskId);
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `routine:${patternId}` });
  return { ok: true };
}

/**
 * Habit → Pattern bridge (Phase G, G2 / E′). Ensure a habit task is represented as a
 * Habit-type Pattern, keeping the pattern model in sync with the task's `subtype='habit'`.
 * Idempotent; a no-op if the owner has no built-in Habit type or the task is already in one.
 */
export async function ensureHabitPattern(taskId: string, ownerId: string, name: string): Promise<void> {
  const habitType = await store()
    .prepare(`SELECT id FROM pattern_types WHERE name = 'Habit' AND is_builtin = 1 AND owner_id = ?`)
    .get<{ id: string }>(ownerId);
  if (!habitType) return;

  const already = await store()
    .prepare(
      `SELECT 1 FROM pattern_tasks pt JOIN patterns p ON p.id = pt.pattern_id
        WHERE pt.task_id = ? AND p.type_id = ?`,
    )
    .get(taskId, habitType.id);
  if (already) return;

  // The pattern row and its membership row commit together — the membership is what the
  // `already` probe above reads, so a pattern committed without one is invisible to the
  // idempotency check and would be re-created on every call.
  //
  // RESIDUAL RACE, deliberately not closed here: two concurrent calls can both pass the
  // probe and create two Habit patterns for one task, because the predicate depends on a
  // row neither has written yet. No single-statement guard fixes that; it needs a unique
  // index on the (task_id, habit-type) pair, which is a schema change and out of scope
  // for a refactor pass. Consequence is a duplicate habit pattern under a double-submit,
  // not data loss. Tracked in docs/passA-worklist.md for the post-cutover pass.
  await store().transaction(async () => {
    const p = (await store()
      .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
      .get<{ id: string }>(ownerId, habitType.id, name))!;
    await store().prepare(`INSERT OR IGNORE INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, 0)`).run(p.id, taskId);
  });
}
