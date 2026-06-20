import type { Database } from 'better-sqlite3';

export const id = '0013_patterns';

/**
 * Pattern model (Phase G, ticket G1). A **Pattern** is a typed, reusable collection
 * of tasks — Routine ▢ / Habit ◯ / Ritual △ (+ user-defined types). Patterns have
 * **no own recurrence** (collections only — repetition stays E's task-level RRULE)
 * and, in V1, contain **tasks only** (no pattern nesting). Membership is
 * many-to-many: a task can belong to several patterns.
 *
 * Additive + idempotent. Seeds the three built-in types for the single owner.
 */
export function up(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pattern_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES owners(id),
    name TEXT NOT NULL,
    icon_shape TEXT NOT NULL,          -- square | circle | triangle | <custom>
    reminder_config TEXT,              -- JSON; opaque until Phase H reads it
    is_builtin INTEGER DEFAULT 0
  );`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_pattern_types_owner_name
           ON pattern_types(owner_id, name);`);

  db.exec(`CREATE TABLE IF NOT EXISTS patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES owners(id),
    type_id INTEGER REFERENCES pattern_types(id),
    name TEXT NOT NULL,
    tag TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_patterns_owner_type ON patterns(owner_id, type_id);`);

  // Membership: many-to-many, ordered. ON DELETE CASCADE keeps it tidy but never
  // touches the tasks themselves (deleting a pattern leaves its tasks intact).
  db.exec(`CREATE TABLE IF NOT EXISTS pattern_tasks (
    pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,
    PRIMARY KEY (pattern_id, task_id)
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_pattern_tasks_task ON pattern_tasks(task_id);`);

  // Seed the built-in types for the single owner (1). Idempotent via the unique
  // (owner_id, name) index. Owner 1 exists by migration 0003.
  const seed = db.prepare(
    `INSERT OR IGNORE INTO pattern_types (owner_id, name, icon_shape, is_builtin) VALUES (?, ?, ?, 1)`
  );
  seed.run(1, 'Routine', 'square');
  seed.run(1, 'Habit', 'circle');
  seed.run(1, 'Ritual', 'triangle');
}
