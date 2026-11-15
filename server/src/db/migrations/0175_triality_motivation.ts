import type { Database } from 'better-sqlite3';

export const id = '0175_triality_motivation';

/**
 * Who a Triality suggestion was for (`tasks.motivation`: me / us / them), stamped on the
 * impression log at show time.
 *
 * Triality already READS the label: a candidate's own label pairs with the owner's recent
 * me-share drift (`motivation_balance`, services/triality-vector.ts). But the log kept only the
 * action reference, so "what share of what we suggested was for them" could only be answered by
 * joining to the task's CURRENT label, which the owner may have changed since. The stamp freezes
 * what the suggestion carried when it was shown.
 *
 * Values, enforced in code rather than a CHECK constraint (repo convention):
 *   'me' | 'us' | 'them'  the candidate's label;
 *   'none'                the candidate had no label (an unlabeled task, or a pattern: patterns
 *                         carry no motivation);
 * NULL means the pick was shown before this stamp existed and is not reconstructable. Readers must
 * leave NULL out of any split rather than call it 'none' (the `weights_source` rule, 0174).
 *
 * Descriptive only: never fed back into ranking, and no index (no reader scans on it).
 * SQLite-only (the Postgres baseline stops at 0147).
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(triality_log)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'motivation')) {
    db.exec(`ALTER TABLE triality_log ADD COLUMN motivation TEXT`);
  }
}
