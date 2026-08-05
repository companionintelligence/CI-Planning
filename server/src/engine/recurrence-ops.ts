/**
 * Recurrence instance operations (Phase E, PR-3): per-instance skip, habit streak,
 * and the template-resolution + future-instance cleanup that the series-edit path
 * (`PATCH /api/tasks/:id?scope=series`) relies on.
 *
 * Pairs with recurrence-generate.ts (which materializes instances). A skip is made
 * **durable** by writing the skipped day into the template's EXDATE, so a later
 * regenerate won't resurrect it; the instance row itself becomes `skipped`.
 */
import { store } from '../db/store.js';
import { localISODate } from '../lib/dates.js';
import { removeEntityTags } from '../services/tags.js';

interface TaskRow {
  id: string;
  status: string;
  recurrence_rule: string | null;
  recurrence_parent_id: string | null;
  recurrence_exdates: string | null;
  occurrence_date: string | null;
  owner_id: string;
}

function getTask(id: string): Promise<TaskRow | undefined> {
  return store()
    .prepare(
      `SELECT id, status, recurrence_rule, recurrence_parent_id, recurrence_exdates,
              occurrence_date, owner_id
         FROM tasks WHERE id = ?`
    )
    .get<TaskRow>(id);
}

/** Parse the stored EXDATE JSON (`string[]`), tolerating null/garbage. */
function parseExdates(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The template id for a task: itself if it is a template, its parent if it is an
 * instance, else null (the task isn't part of a recurring series).
 */
export async function resolveTemplateId(id: string): Promise<string | null> {
  const t = await getTask(id);
  if (!t) return null;
  if (t.recurrence_parent_id != null) return t.recurrence_parent_id; // instance → template
  if (t.recurrence_rule != null) return t.id; // already a template
  return null; // not a recurring task
}

export type SkipResult =
  | { ok: true; instanceId: string; templateId: string; date: string }
  | { ok: false; reason: 'not_found' | 'not_instance' };

/**
 * Skip one recurring instance: mark it `skipped` and append its occurrence day to
 * the template's EXDATE so a regenerate won't bring it back. Idempotent — a second
 * skip of the same instance is a no-op on the EXDATE set.
 */
export async function skipInstance(id: string): Promise<SkipResult> {
  const inst = await getTask(id);
  if (!inst) return { ok: false, reason: 'not_found' };
  if (inst.recurrence_parent_id == null || inst.occurrence_date == null) {
    return { ok: false, reason: 'not_instance' };
  }
  const templateId = inst.recurrence_parent_id;
  const date = inst.occurrence_date;

  await store().prepare(`UPDATE tasks SET status = 'skipped' WHERE id = ?`).run(id);
  await appendTemplateExdate(templateId, date);
  return { ok: true, instanceId: id, templateId, date };
}

/**
 * Append `date` to a task template's EXDATE list, compare-and-swap.
 *
 * The task-side twin of blocks-recur's `excludeBlockOccurrence`, and it needs the same
 * guard for the same reason: read-modify-write on a JSON array was race-free only while
 * better-sqlite3 put no await between the SELECT and the UPDATE. Skipping two occurrences
 * of one template concurrently would otherwise let the second write drop the first's date,
 * and the generator would bring that occurrence straight back. `COALESCE(col,'')` keeps
 * the guard portable (`IS` / `IS NOT DISTINCT FROM` are dialect-specific).
 */
async function appendTemplateExdate(templateId: string, date: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tpl = await getTask(templateId);
    if (!tpl) return; // template gone — nothing to exclude
    const ex = parseExdates(tpl.recurrence_exdates);
    if (ex.includes(date)) return; // already excluded (possibly by the writer that beat us)
    ex.push(date);
    ex.sort();
    const res = await store()
      .prepare(
        `UPDATE tasks SET recurrence_exdates = ?
          WHERE id = ? AND COALESCE(recurrence_exdates, '') = ?`,
      )
      .run(JSON.stringify(ex), templateId, tpl.recurrence_exdates ?? '');
    if (res.changes > 0) return;
  }
  // Sustained contention on one template, not a transient interleave. Failing loudly
  // beats dropping the exclusion — that resurrects the occurrence the caller just skipped.
  throw new Error(`skipInstance: EXDATE write lost 5 races on template ${templateId}`);
}

export interface StreakResult {
  templateId: string;
  /** Consecutive `done` instances back from today. */
  current: number;
  /** Up to 7 most recent occurrences (≤ today), oldest→newest, for the dot strip. */
  recent: { date: string; status: string }[];
}

/**
 * Streak for a recurring task (pass a template or any instance id). Counts
 * consecutive `done` instances back from today; a `skipped` / `missed` / past-`open`
 * breaks it. Today's still-`open` instance is *pending* — it neither counts nor
 * breaks the streak. Returns null for a non-recurring task.
 */
export async function computeStreak(id: string, today: string = localISODate()): Promise<StreakResult | null> {
  const templateId = await resolveTemplateId(id);
  if (templateId == null) return null;

  const past = await store()
    .prepare(
      `SELECT occurrence_date AS date, status FROM tasks
        WHERE recurrence_parent_id = ? AND occurrence_date IS NOT NULL AND occurrence_date <= ?
        ORDER BY occurrence_date DESC`
    )
    .all<{ date: string; status: string }>(templateId, today);

  let current = 0;
  for (const inst of past) {
    if (inst.date === today && inst.status === 'open') continue; // today not done yet → pending
    if (inst.status === 'done') {
      current++;
      continue;
    }
    break; // skipped / missed / a past still-open day breaks the streak
  }

  const recent = past.slice(0, 7).reverse(); // oldest→newest for left-to-right rendering
  return { templateId, current, recent };
}

/**
 * Delete future, un-actioned instances of a template (occurrence_date ≥ today,
 * status `open`). Used by a series rule change: past / completed / skipped / missed
 * instances are preserved; the generator then re-materializes the window under the
 * new rule. Returns the number deleted.
 */
export async function deleteFutureOpenInstances(templateId: string, today: string = localISODate()): Promise<number> {
  // CON-3 cascade: instances are HARD-deleted — a user can tag a single occurrence,
  // so clear those tag rows before dropping the instances.
  const dropped = await store()
    .prepare(
      `DELETE FROM tasks
        WHERE recurrence_parent_id = ? AND status = 'open'
          AND occurrence_date IS NOT NULL AND occurrence_date >= ?
        RETURNING id`
    )
    .all<{ id: string }>(templateId, today);
  for (const t of dropped) await removeEntityTags('task', t.id);
  return dropped.length;
}
