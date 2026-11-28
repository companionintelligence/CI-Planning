import type { Database } from 'better-sqlite3';

export const id = '0184_tag_colors';

export function up(db: Database): void {
  db.exec('ALTER TABLE tags ADD COLUMN color_token TEXT');
}
