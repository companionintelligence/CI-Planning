import type { Database } from 'better-sqlite3';
import { rebuildTable } from '../migrate.js';

export const id = '0098_sync_events_owner_fk';
// Rebuild toggles foreign_keys OFF/ON (a no-op inside a transaction). CON-1.
export const manual = true;

/**
 * T4 (multi-tenant) — enforce `sync_events.owner_id` as a real FK to `owners(id)`.
 *
 * `sync_events` (created in 0077, never altered since) declared `owner_id TEXT
 * NOT NULL` with NO `.references()` — so `owner_id` is a value, not an enforced
 * foreign key. Every writer already supplies a real owner id, but nothing stops
 * a stray/orphan owner_id from landing in this append-only log — a latent
 * isolation gap under multi-tenant. Rebuild the table so `owner_id` carries
 * `REFERENCES owners(id)`, changing NOTHING else: same columns, same order, the
 * same `seq` INTEGER PRIMARY KEY AUTOINCREMENT, and the same
 * `sync_events_owner_seq (owner_id, seq)` index (recreated in `afterSql`, since
 * rebuildTable's swap drops the old table and its indexes).
 *
 * SQLite can't add a column-level FK in place, so this is the canonical
 * `rebuildTable` 12-step dance (manages its own tx + foreign_keys pragma — hence
 * `manual`). We deliberately do NOT add `ON DELETE CASCADE`: owners are never
 * deleted today, and matching the surrounding owner-scoped tables' behavior
 * (e.g. flight_plan 0093 also omits cascade) keeps owner-delete semantics
 * uniform. Preserving the exact column set + order keeps the schema-shape
 * characterization golden (baseline.characterization) stable — it captures
 * column names only, and this migration changes none.
 *
 * The new table reproduces the live physical shape faithfully; the ONLY change
 * is `owner_id` gaining the FK reference. A `PRAGMA foreign_key_check` runs after
 * the rebuild and aborts (throws) on any violation, so a DB with a pre-existing
 * orphan owner_id fails loudly rather than silently retaining a dangling ref.
 *
 * CASCADE-CONSISTENCY NOTE (F-CASCADE, deferred to Phase U): `pattern_day_optouts`
 * (0074) also references `owners(id)` but WITHOUT `ON DELETE CASCADE`, unlike the
 * newer owner-scoped tables that will gain CASCADE. This inconsistency is
 * intentional here — normalizing owner-delete cascade behavior belongs with
 * owner deletion in Phase U. This migration changes NO cascade behavior.
 *
 * Idempotent: guards on `owner_id` already being an FK (checks
 * `PRAGMA foreign_key_list`) so a re-run — or an already-rebuilt DB — is a no-op.
 */
export function up(db: Database): void {
  // Idempotency guard: if owner_id already references owners(id), no-op. A fresh
  // 0077 table has an empty foreign_key_list; a rebuilt one lists exactly this FK.
  const fkList = db.prepare(`PRAGMA foreign_key_list(sync_events)`).all() as {
    table: string;
    from: string;
    to: string;
  }[];
  const alreadyFk = fkList.some(
    (fk) => fk.from === 'owner_id' && fk.table === 'owners' && fk.to === 'id',
  );
  if (alreadyFk) return; // already an enforced FK — re-run safety.

  rebuildTable(db, {
    table: 'sync_events',
    createNewSql: `
      CREATE TABLE sync_events_new (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id  TEXT    NOT NULL REFERENCES owners(id),
        entity    TEXT    NOT NULL DEFAULT '',
        entity_id TEXT    NOT NULL DEFAULT '',
        version   INTEGER,
        event     TEXT    NOT NULL,
        payload   TEXT    NOT NULL,
        at        TEXT    NOT NULL
      );`,
    columns: 'seq, owner_id, entity, entity_id, version, event, payload, at',
    // Recreate the one index 0077 defined — rebuildTable's DROP TABLE removed it.
    afterSql: `CREATE INDEX IF NOT EXISTS sync_events_owner_seq ON sync_events (owner_id, seq);`,
  });

  // Fail loud on any orphan owner_id the rebuild would otherwise silently retain.
  const violations = db.prepare(`PRAGMA foreign_key_check(sync_events)`).all();
  if (violations.length > 0) {
    throw new Error(
      `0098_sync_events_owner_fk: foreign_key_check found ${violations.length} orphan sync_events.owner_id row(s); aborting.`,
    );
  }
}
