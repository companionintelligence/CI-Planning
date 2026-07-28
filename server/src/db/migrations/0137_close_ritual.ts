import type { Database } from 'better-sqlite3';

export const id = '0137_close_ritual';

/**
 * The close ritual (owner request 2026-07-28): when a task is finished, let the user
 * record how it FELT, why, and how long it really took.
 *
 * Three new columns, all nullable — the ritual is strictly optional and the plain
 * checkbox completion must stay frictionless. A task closed without the ritual is
 * indistinguishable from one closed before this migration existed.
 *
 *  - completion_mood: 'happy' | 'flat' | 'frustrated' | 'stressed' — the "temperature"
 *    faces. A small closed vocabulary, not a 1-5 score: people answer a face honestly
 *    and instantly, where a numeric self-score invites deliberation and drifts per user.
 *
 *  - completion_note: the closing note. DELIBERATELY NOT `tasks.notes` — that column is
 *    the task's description (and is what the memory enrichment pass fills). Reusing it
 *    would make a reflection overwrite context, and would make "why was this hard?"
 *    indistinguishable from "what is this about?".
 *
 *  - reaction_at: WHEN the reflection was recorded, which is NOT `completed_at` (the
 *    assumed task end). The two differ whenever someone ticks a task off and reflects
 *    later — or reflects on a task completed days ago. Storing both keeps the latency
 *    (`reaction_at − completed_at`) derivable, and that gap is itself signal: an
 *    immediate reaction is a fresher read on the work than one reconstructed a week on.
 *
 * Idempotent via the B0 addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('completion_mood')) db.exec(`ALTER TABLE tasks ADD COLUMN completion_mood TEXT`);
  if (!has('completion_note')) db.exec(`ALTER TABLE tasks ADD COLUMN completion_note TEXT`);
  if (!has('reaction_at')) db.exec(`ALTER TABLE tasks ADD COLUMN reaction_at TEXT`);

  // Partial index: the metrics rollups scan mood by owner over a date window, and only a
  // minority of tasks ever carry one.
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_tasks_owner_mood
      ON tasks(owner_id, completion_mood) WHERE completion_mood IS NOT NULL;
  `);
}
