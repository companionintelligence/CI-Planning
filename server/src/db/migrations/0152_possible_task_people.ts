import type { Database } from 'better-sqlite3';

export const id = '0152_possible_task_people';

/**
 * People detected on an inbox suggestion, carried onto the real task at promote —
 * the people counterpart to `possible_task_tags` (0001), and deliberately the same
 * shape: a join table rather than columns on `possible_tasks`, so a suggestion can
 * carry several responsible people AND several beneficiaries, and promotion is a
 * straight copy into `entity_people` (services/possibles.ts carryPossiblePeople).
 *
 * `confidence` is per-row because the two roles are detected very differently:
 * responsible people come from calendar attendees and mail headers (facts — confidence
 * 1), beneficiaries come from the model (a judgment — whatever it reported). Storing
 * one confidence on the suggestion could not express that.
 *
 * ON DELETE CASCADE on possible_task_id so dismissing/pruning a suggestion cannot
 * orphan rows; on person_id so deleting a person from the directory cleans up too.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS possible_task_people (
      possible_task_id TEXT NOT NULL REFERENCES possible_tasks(id) ON DELETE CASCADE,
      person_id        TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      role             TEXT NOT NULL,              -- 'responsible' | 'beneficiary'
      source           TEXT,                       -- 'llm' | 'calendar' | 'email'
      confidence       REAL,
      PRIMARY KEY (possible_task_id, person_id, role)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ix_possible_task_people_possible
       ON possible_task_people (possible_task_id)`,
  );
}
