import type { Database } from 'better-sqlite3';

export const id = '0135_categories_capture';

/**
 * Categories ⇄ Balance — Phase B (CAPTURE) storage. Follows 0134, which created
 * `entity_categories` (1–3 categories per task/time_block) and re-seeded the six
 * Balance dimensions, but left no write path: nothing populates the store and there
 * is nowhere to record the per-element texture settings the renderer needs.
 *
 * 1. Backfill: carry any SURVIVING single `time_blocks.category_id` into
 *    `entity_categories` at position 0, so a block keeps its category once the write
 *    path switches to the 1–3 store. 0134 already NULLed category_ids that pointed at
 *    the retired category tags, so this only forwards assignments made against a live
 *    (post-0134) category tag. The `category_id`/`color_token` columns STAY for now —
 *    `blockColorVar` still reads them; Phase C retires the reader.
 *
 * 2. Per-element texture override, on BOTH `tasks` and `time_blocks`
 *    (owner ruling 2026-07-21: columns on each table, not a separate table):
 *      texture_enabled     INTEGER NOT NULL DEFAULT 1  — 1 = show the (category-derived)
 *                                                        texture, 0 = user turned it off
 *      texture_color_token TEXT                        — user colour override; NULL ⇒
 *                                                        derive from the element's categories
 *    Constant DEFAULT 1 is legal on ADD COLUMN (unlike a non-constant default / bare
 *    NOT NULL, which would force a table rebuild — see 0133/0129).
 *
 * Additive + idempotent: INSERT OR IGNORE for the backfill (entity_categories PK), and
 * each ADD COLUMN is guarded by a table_info check. Deletes/nulls nothing.
 */

function hasColumn(db: Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

export function up(db: Database): void {
  // 1. Carry live block→category assignments into the position-ordered 1–3 store.
  db.exec(`
    INSERT OR IGNORE INTO entity_categories (entity_kind, entity_id, category_tag_id, position)
    SELECT 'time_block', tb.id, tb.category_id, 0
      FROM time_blocks tb
     WHERE tb.category_id IS NOT NULL
       AND tb.category_id IN (SELECT id FROM tags WHERE kind = 'category')
  `);

  // 2. Per-element texture override columns on tasks + time_blocks.
  for (const table of ['tasks', 'time_blocks']) {
    if (!hasColumn(db, table, 'texture_enabled')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN texture_enabled INTEGER NOT NULL DEFAULT 1`);
    }
    if (!hasColumn(db, table, 'texture_color_token')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN texture_color_token TEXT`);
    }
  }
}
