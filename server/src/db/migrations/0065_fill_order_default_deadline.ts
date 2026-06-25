import type { Database } from 'better-sqlite3';

export const id = '0065_fill_order_default_deadline';

/**
 * Phase M: deadline-first becomes the default day order (`fill_order='overdue'`),
 * now that `fill_order` maps onto deterministic authoring (plan.ts deterministicIndices).
 *
 * 0055 added the column as `NOT NULL DEFAULT 'priority'` and backfilled every
 * existing row to that legacy default. This flips those legacy-default rows to
 * 'overdue' so the authored order is deadline-first out of the box. Users who
 * want priority-first can still re-select it in Settings (the knob is preserved).
 *
 * Guarded: skip on databases that pre-date the fill_order column (old migrate tests).
 */
export function up(db: Database): void {
  const has = (db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('scheduling_prefs') WHERE name = 'fill_order'`).get() as { c: number }).c > 0;
  if (!has) return;
  db.exec(`UPDATE scheduling_prefs SET fill_order = 'overdue' WHERE fill_order = 'priority';`);
}
