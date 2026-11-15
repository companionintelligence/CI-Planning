import type { Database } from 'better-sqlite3';

export const id = '0180_shared_planner_access';

/** Invitations grant access to explicit tasks/objectives, never an owner's tenant. */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_planner_invites (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      recipient_owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id, email)
    );
    CREATE INDEX IF NOT EXISTS ix_shared_planner_invites_recipient
      ON shared_planner_invites(recipient_owner_id, status);
    CREATE TABLE IF NOT EXISTS shared_planner_items (
      invite_id TEXT NOT NULL REFERENCES shared_planner_invites(id) ON DELETE CASCADE,
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('task', 'objective')),
      entity_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(invite_id, entity_kind, entity_id)
    );
    CREATE INDEX IF NOT EXISTS ix_shared_planner_items_entity
      ON shared_planner_items(entity_kind, entity_id);
  `);
}
