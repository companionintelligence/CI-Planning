import type { Database } from 'better-sqlite3';

export const id = '0161_completion_score';

/**
 * The close ritual's rating, restated as a 1-5 score (owner request 2026-08-29).
 *
 * 0137 stored a four-face vocabulary in `completion_mood` and argued explicitly against a
 * numeric scale: "people answer a face honestly and instantly, where a numeric self-score
 * invites deliberation". That objection was about the INPUT, and it still stands — so the
 * input is still faces. What changed is that three faces (frown / flat / smile) with an
 * optional SECOND pick express five levels instead of four unordered temperatures:
 *
 *     frown = 1 · frown+flat = 2 · flat = 3 · flat+smile = 4 · smile = 5
 *
 * The opposite pair (frown+smile) is unreachable by construction in the UI, so every
 * stored value is a point on one ordered scale. That ordering is the whole reason for the
 * change: `happy | flat | frustrated | stressed` cannot be averaged, ranked, or trended —
 * two of its members are both "bad" in different ways — whereas 1-5 can.
 *
 *  - completion_score: INTEGER, nullable.
 *      NULL  = never prompted, or prompted and the sheet was closed without an answer
 *              reaching the server. Indistinguishable from a pre-migration row, which is
 *              what makes the ritual stay optional.
 *      1-5   = the user picked faces.
 *      0     = PROMPTED AND DECLINED. A deliberate sentinel, not a rating: the queue's
 *              "skip" and "skip the rest" write it. It is excluded from every score
 *              aggregate (mean, distribution) and reported on its own as a decline count.
 *              Writing 3 here instead would have been a lie — a fabricated neutral rating
 *              that drags the mean and, because triality's `day_energy` reads the single
 *              latest reaction, would let a dismissal displace a real rating given hours
 *              earlier. Same reasoning 0137 used to refuse stamping `reaction_at` on a
 *              duration-only edit.
 *
 * `completion_mood` is DROPPED rather than left dual-written. The owner confirmed there is
 * no history worth preserving, and a dead column that two services still read is exactly
 * how the two of them drift apart.
 *
 * Idempotent via the B0 addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);

  if (!has('completion_score')) db.exec(`ALTER TABLE tasks ADD COLUMN completion_score INTEGER`);

  // Partial index, mirroring 0137's ix_tasks_owner_mood: the metrics rollups scan score by
  // owner over a date window, and only a minority of tasks ever carry one.
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_tasks_owner_score
      ON tasks(owner_id, completion_score) WHERE completion_score IS NOT NULL;
  `);

  // Drop 0137's column and its index. The index first — SQLite would otherwise carry a
  // partial index whose WHERE clause references a column that no longer exists.
  db.exec(`DROP INDEX IF EXISTS ix_tasks_owner_mood`);
  if (has('completion_mood')) db.exec(`ALTER TABLE tasks DROP COLUMN completion_mood`);
}
