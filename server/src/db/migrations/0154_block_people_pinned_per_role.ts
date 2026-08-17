import type { Database } from 'better-sqlite3';

export const id = '0154_block_people_pinned_per_role';

/**
 * Splits 0153's single `people_pinned` into ONE FLAG PER ROLE.
 *
 * 0153 gave a block a way to say "nobody is on this" — necessary, because "no rows" was
 * doing double duty for "never set, inherit" and "deliberately cleared". But it pinned
 * the whole BLOCK, and the two sets are independent: editing a meeting's attendees would
 * also pin its (empty) beneficiary set, silently ending the inherit-from-task rule for a
 * field the user never touched.
 *
 * A separate flag per role restores that independence — a block can carry its own
 * attendees while still inheriting who the underlying task is for, which is exactly the
 * behaviour blockPeopleApi's doc has claimed all along.
 *
 * 0153 is NOT edited in place: it has already been applied on at least one database, and
 * the runner keys on migration id, so an edit would never re-run. The column it added is
 * backfilled into both new ones and then dropped.
 *
 * Idempotent: guarded on column presence in both directions.
 */
export function up(db: Database): void {
  const cols = () => (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  const before = cols();

  if (!before.includes('responsible_pinned')) {
    db.exec(`ALTER TABLE time_blocks ADD COLUMN responsible_pinned INTEGER NOT NULL DEFAULT 0`);
  }
  if (!before.includes('beneficiaries_pinned')) {
    db.exec(`ALTER TABLE time_blocks ADD COLUMN beneficiaries_pinned INTEGER NOT NULL DEFAULT 0`);
  }

  // Carry 0153's answer across for anything already pinned, then retire the column.
  // A block pinned under the old rule really did have BOTH sets pinned, so both flags
  // take the value — this preserves the exact behaviour those rows had.
  if (before.includes('people_pinned')) {
    db.exec(`UPDATE time_blocks
                SET responsible_pinned = people_pinned,
                    beneficiaries_pinned = people_pinned
              WHERE people_pinned = 1`);
    // SQLite has supported DROP COLUMN since 3.35 (better-sqlite3 12 bundles far newer),
    // and nothing indexes or views this column, so the simple form is safe here.
    db.exec(`ALTER TABLE time_blocks DROP COLUMN people_pinned`);
  }
}
