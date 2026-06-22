import type { Database } from 'better-sqlite3';

export const id = '0038_pattern_rename';

/**
 * Rename the `kind` value in the tags table from `'direction'` to `'pattern'`.
 * The three brand-set base tags (Home / Work / Community) switch to `kind='pattern'`.
 * Additive + idempotent.
 */
export function up(db: Database): void {
  db.exec(`UPDATE tags SET kind = 'pattern' WHERE kind = 'direction'`);
}
