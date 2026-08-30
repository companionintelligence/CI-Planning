import { store } from '../db/store.js';
import { writeAudit } from '../lib/audit.js';

/**
 * The close ritual (0137, rescored 0161): record how a finished task FELT, why, and how
 * long it really took — the per-task completion signal the app previously had no way to
 * capture.
 *
 * Three deliberate properties, unchanged since 0137:
 *
 *  1. OPTIONAL. The plain checkbox completion path (`updateTask({completed:true})`) is
 *     untouched and still writes nothing here. Everything below only ever runs because
 *     the user filled something in — or explicitly declined (see DECLINED).
 *  2. COMPLETION-AGNOSTIC. Closing works on an already-done task too, so a reflection can
 *     arrive minutes or days after the tick. That is the case `reaction_at` exists for.
 *  3. NON-DESTRUCTIVE to the description. `completion_note` is its own column;
 *     `tasks.notes` (what the task is about, and what memory enrichment fills) is never
 *     touched here.
 */

/** The lowest and highest real ratings. The three-face picker produces only these. */
export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

/**
 * "Prompted, and declined." Written by the queue's skip / skip-the-rest paths so a
 * dismissal is measurable, and deliberately NOT a 3.
 *
 * A 3 is a real point on the scale ("flat"). Storing it for a dismissal would invent an
 * answer the user refused to give: it would drag the metrics mean toward neutral with
 * data nobody entered, and — because triality's `day_energy` reads the single most recent
 * reaction — a dismissal at 11am would displace a genuine 5 given at 10am and flip that
 * dimension from +1 to 0. DECLINED is excluded from every aggregate and never stamps
 * `reaction_at`, so it can do neither.
 */
export const DECLINED_SCORE = 0;

export type Score = 0 | 1 | 2 | 3 | 4 | 5;

/** A real rating (1-5). DECLINED (0) is deliberately NOT one — see [[DECLINED_SCORE]]. */
export function isRating(v: unknown): v is Score {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_SCORE && v <= MAX_SCORE;
}

/** Anything the close route will persist into `completion_score`: a rating, or DECLINED. */
export function isScore(v: unknown): v is Score {
  return isRating(v) || v === DECLINED_SCORE;
}

export interface CloseTaskInput {
  score?: unknown;
  note?: unknown;
  /** The user's correction to how long it actually took, in minutes. */
  actualMinutes?: unknown;
}

export type CloseTaskResult =
  | { ok: true; taskId: string; completedAt: string; reactionAt: string | null; score: Score | null; actualMinutes: number }
  | { ok: false; error: 'not_found' };

// SQL at module scope, prepare at the use site (§5.5).
const SQL_TASK = `SELECT id, status, completed_at, actual_minutes FROM tasks WHERE id = ? AND owner_id = ?`;

/**
 * Close a task with an optional reflection. Completes it first when it is still open, so
 * one tap from the UI can both finish the task and record the reaction.
 *
 * `reaction_at` is stamped ONLY when the user actually supplied a RATING or a note. A
 * duration correction on its own is bookkeeping, not a reflection, and stamping it would
 * make the reaction-latency metric a lie — and a DECLINED is the explicit absence of a
 * reflection, so it does not stamp either.
 */
export async function closeTask(owner: string, taskId: string, input: CloseTaskInput): Promise<CloseTaskResult> {
  const task = await store()
    .prepare(SQL_TASK)
    .get<{ id: string; status: string; completed_at: string | null; actual_minutes: number }>(taskId, owner);
  if (!task) return { ok: false, error: 'not_found' };

  const now = new Date().toISOString();
  const score = isScore(input.score) ? input.score : null;
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 2000) : null;
  // A reaction is a REAL rating or a note. Duration-only edits and declines do not count.
  const hasReaction = isRating(score) || note !== null;

  // Complete it if it isn't already — and never clobber an original completed_at, so a
  // late reflection on last week's task keeps last week's end time.
  const completedAt = task.completed_at ?? now;

  const sets: string[] = [];
  const args: unknown[] = [];
  if (task.status !== 'done') {
    sets.push(`status = 'done'`, `completed_at = ?`);
    args.push(completedAt);
  }
  if (score !== null) { sets.push(`completion_score = ?`); args.push(score); }
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
    score,
    actualMinutes: minutes ?? task.actual_minutes,
  };
}
