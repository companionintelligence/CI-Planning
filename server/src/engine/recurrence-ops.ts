/**
 * Recurrence instance operations (Phase E, PR-3): per-instance skip, habit streak,
 * and the template-resolution + future-instance cleanup that the series-edit path
 * (`PATCH /api/tasks/:id?scope=series`) relies on.
 *
 * Pairs with recurrence-generate.ts (which materializes instances). A skip is made
 * **durable** by writing the skipped day into the template's EXDATE, so a later
 * regenerate won't resurrect it; the instance row itself becomes `skipped`.
 */
import { sqlite } from '../db/index.js';
import { localISODate } from '../lib/dates.js';
import { removeEntityTags } from '../services/tags.js';

interface TaskRow {
  id: string;
  status: string;
  recurrence_rule: string | null;
  recurrence_parent_id: string | null;
  recurrence_exdates: string | null;
  occurrence_date: string | null;
  is_habit: number;
  owner_id: string;
}

function getTask(id: string): TaskRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, status, recurrence_rule, recurrence_parent_id, recurrence_exdates,
              occurrence_date, is_habit, owner_id
         FROM tasks WHERE id = ?`
    )
    .get(id) as TaskRow | undefined;
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
export function resolveTemplateId(id: string): string | null {
  const t = getTask(id);
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
export function skipInstance(id: string): SkipResult {
  const inst = getTask(id);
  if (!inst) return { ok: false, reason: 'not_found' };
  if (inst.recurrence_parent_id == null || inst.occurrence_date == null) {
    return { ok: false, reason: 'not_instance' };
  }
  const templateId = inst.recurrence_parent_id;
  const date = inst.occurrence_date;

  sqlite.prepare(`UPDATE tasks SET status = 'skipped' WHERE id = ?`).run(id);

  const tpl = getTask(templateId);
  if (tpl) {
    const ex = parseExdates(tpl.recurrence_exdates);
    if (!ex.includes(date)) {
      ex.push(date);
      ex.sort();
      sqlite.prepare(`UPDATE tasks SET recurrence_exdates = ? WHERE id = ?`).run(JSON.stringify(ex), templateId);
    }
  }
  return { ok: true, instanceId: id, templateId, date };
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
export function computeStreak(id: string, today: string = localISODate()): StreakResult | null {
  const templateId = resolveTemplateId(id);
  if (templateId == null) return null;

  const past = sqlite
    .prepare(
      `SELECT occurrence_date AS date, status FROM tasks
        WHERE recurrence_parent_id = ? AND occurrence_date IS NOT NULL AND occurrence_date <= ?
        ORDER BY occurrence_date DESC`
    )
    .all(templateId, today) as { date: string; status: string }[];

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
export function deleteFutureOpenInstances(templateId: string, today: string = localISODate()): number {
  // CON-3 cascade: instances are HARD-deleted — a user can tag a single occurrence,
  // so clear those tag rows before dropping the instances.
  const dropped = sqlite
    .prepare(
      `DELETE FROM tasks
        WHERE recurrence_parent_id = ? AND status = 'open'
          AND occurrence_date IS NOT NULL AND occurrence_date >= ?
        RETURNING id`
    )
    .all(templateId, today) as { id: string }[];
  for (const t of dropped) removeEntityTags('task', t.id);
  return dropped.length;
}
