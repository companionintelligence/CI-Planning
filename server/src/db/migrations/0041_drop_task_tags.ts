import type { Database } from 'better-sqlite3';

export const id = '0041_drop_task_tags';

/**
 * CON-3 final step — drop the legacy `task_tags` table. Its rows have lived in the
 * canonical `entity_tags` store (entity_kind='task', level=1) since the 0033 backfill,
 * and as of Wave 1 every task-tag READ goes through entity_tags
 * (services/tags.ts `taskTagNames`). Nothing reads or writes task_tags anymore.
 *
 * `possible_task_tags` is intentionally left untouched — it serves the Inbox
 * (possible_tasks), a separate store. Idempotent via IF EXISTS. Nothing FKs *into*
 * task_tags, so this is a plain DROP.
 */
export function up(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS task_tags`);
}
