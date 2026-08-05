import { store } from '../db/store.js';
import { writeAudit } from '../lib/audit.js';

/**
 * The close ritual (0137): record how a finished task FELT, why, and how long it really
 * took — the per-task completion signal the app previously had no way to capture.
 *
 * Three deliberate properties:
 *
 *  1. OPTIONAL. The plain checkbox completion path (`updateTask({completed:true})`) is
 *     untouched and still writes nothing here. Everything below only ever runs because
 *     the user filled something in.
 *  2. COMPLETION-AGNOSTIC. Closing works on an already-done task too, so a reflection can
 *     arrive minutes or days after the tick. That is the case `reaction_at` exists for.
 *  3. NON-DESTRUCTIVE to the description. `completion_note` is its own column;
 *     `tasks.notes` (what the task is about, and what memory enrichment fills) is never
 *     touched here.
 */

/** The four "temperature" faces. A closed vocabulary — anything else is rejected. */
export const MOODS = ['happy', 'flat', 'frustrated', 'stressed'] as const;
export type Mood = (typeof MOODS)[number];

export function isMood(v: unknown): v is Mood {
  return typeof v === 'string' && (MOODS as readonly string[]).includes(v);
}

export interface CloseTaskInput {
  mood?: unknown;
  note?: unknown;
  /** The user's correction to how long it actually took, in minutes. */
  actualMinutes?: unknown;
}

export type CloseTaskResult =
  | { ok: true; taskId: string; completedAt: string; reactionAt: string | null; mood: Mood | null; actualMinutes: number }
  | { ok: false; error: 'not_found' };

// SQL at module scope, prepare at the use site (§5.5).
const SQL_TASK = `SELECT id, status, completed_at, actual_minutes FROM tasks WHERE id = ? AND owner_id = ?`;

/**
 * Close a task with an optional reflection. Completes it first when it is still open, so
 * one tap from the UI can both finish the task and record the reaction.
 *
 * `reaction_at` is stamped ONLY when the user actually supplied a mood or a note — a
 * duration correction on its own is bookkeeping, not a reflection, and stamping it would
 * make the reaction-latency metric a lie.
 */
export async function closeTask(owner: string, taskId: string, input: CloseTaskInput): Promise<CloseTaskResult> {
  const task = await store()
    .prepare(SQL_TASK)
    .get<{ id: string; status: string; completed_at: string | null; actual_minutes: number }>(taskId, owner);
  if (!task) return { ok: false, error: 'not_found' };

  const now = new Date().toISOString();
  const mood = isMood(input.mood) ? input.mood : null;
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 2000) : null;
  // A reaction is a mood or a note. Duration-only edits do not count (see above).
  const hasReaction = mood !== null || note !== null;

  // Complete it if it isn't already — and never clobber an original completed_at, so a
  // late reflection on last week's task keeps last week's end time.
  const completedAt = task.completed_at ?? now;

  const sets: string[] = [];
  const args: unknown[] = [];
  if (task.status !== 'done') {
    sets.push(`status = 'done'`, `completed_at = ?`);
    args.push(completedAt);
  }
  if (mood !== null) { sets.push(`completion_mood = ?`); args.push(mood); }
  if (note !== null) { sets.push(`completion_note = ?`); args.push(note); }
  if (hasReaction) { sets.push(`reaction_at = ?`); args.push(now); }

  // A 0 is meaningful ("it took no time"), so the guard is on the TYPE, not truthiness.
  // Negative and absurd values are dropped rather than clamped — a typo should not
  // silently become a plausible number that then poisons calibration.
  const rawMinutes = input.actualMinutes;
  const minutes =
    typeof rawMinutes === 'number' && Number.isFinite(rawMinutes) && rawMinutes >= 0 && rawMinutes <= 24 * 60
      ? Math.round(rawMinutes)
      : null;
  if (minutes !== null) { sets.push(`actual_minutes = ?`); args.push(minutes); }

  if (sets.length > 0) {
    sets.push(`version = version + 1`, `updated_at = ?`);
    args.push(now);
    await store().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`).run(...args, taskId, owner);
    writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `task:${taskId}` });
  }

  return {
    ok: true,
    taskId,
    completedAt,
    reactionAt: hasReaction ? now : null,
    mood,
    actualMinutes: minutes ?? task.actual_minutes,
  };
}
