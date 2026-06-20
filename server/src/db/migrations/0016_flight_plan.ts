import type { Database } from 'better-sqlite3';

export const id = '0016_flight_plan';

/**
 * The flight-plan (Phase G, ticket G4): a persisted, owner-scoped staging area.
 * Per the locked decision it survives reloads/devices and is cleared by a Reset
 * button — so it's a table, not client state. Holds tasks (members of a staged
 * pattern land here as individual rows, tagged with their source pattern via
 * `source_pattern_id`). `selected` drives the two-step Auto pass. Additive +
 * idempotent.
 */
export function up(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS flight_plan (
    owner_id INTEGER REFERENCES owners(id),
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source_pattern_id INTEGER REFERENCES patterns(id) ON DELETE SET NULL,  -- null = added directly
    selected INTEGER DEFAULT 1,
    position INTEGER DEFAULT 0,
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, task_id)
  );`);
}
