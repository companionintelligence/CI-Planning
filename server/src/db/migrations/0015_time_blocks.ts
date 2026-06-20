import type { Database } from 'better-sqlite3';

export const id = '0015_time_blocks';

/**
 * Time-Block containers (Phase G, ticket G3). A **Time-Block** is a named, tagged
 * container drawn as an outline over a time range in the PLANNER — a `time_blocks`
 * row with `block_kind = 'timeblock'` and a grouping `tag`. Plus reusable
 * `block_templates` (named, tagged, default duration) so a block can be saved and
 * re-instantiated on another day.
 *
 * Additive + idempotent. (Numbered 0015 to leave 0014 for the in-flight habit
 * bridge PR; the gap is cosmetic — the runner applies in array order.)
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('tag')) db.exec(`ALTER TABLE time_blocks ADD COLUMN tag TEXT`); // container/grouping tag

  db.exec(`CREATE TABLE IF NOT EXISTS block_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES owners(id),
    name TEXT NOT NULL,
    tag TEXT,
    default_minutes INTEGER DEFAULT 60
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_block_templates_owner ON block_templates(owner_id);`);
}
