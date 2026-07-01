import type { Database } from 'better-sqlite3';
import { rebuildTable } from '../migrate.js';

export const id = '0094_daily_summaries_owner_default';
// Rebuild toggles foreign_keys OFF/ON (a no-op inside a transaction). CON-1.
export const manual = true;

/**
 * Q4 (schema hygiene) — drop the bogus `owner_id ... DEFAULT 1` on daily_summaries.
 *
 * 0001 declared `owner_id INTEGER NOT NULL DEFAULT 1`; 0030 retyped it INTEGER→TEXT
 * but KEPT the integer literal default. So today it's `TEXT NOT NULL DEFAULT 1` — a
 * default that names no real owner (owners are UUIDv7 TEXT since 0030). It's inert
 * only because every writer supplies owner_id explicitly (agents/summarize.ts); a
 * row that ever fell back to the default would be a broken owner reference — a real
 * isolation bug under multi-tenant. Rebuild so owner_id is `TEXT NOT NULL` with NO
 * default: an insert that omits owner_id now fails loudly instead of writing `1`.
 *
 * SQLite can't drop a column default in place, so this is the canonical `rebuildTable`
 * 12-step dance (manages its own tx + foreign_keys pragma — hence `manual`).
 * daily_summaries is a LEAF table + a REGENERABLE cache (day briefings keyed by
 * inputs_hash) with NO indexes besides the auto PK — the lowest-consequence rebuild
 * in the phase, and no `afterSql` is needed. The new table reproduces the live
 * physical shape faithfully (same column order + per-column constraints); the ONLY
 * change is removing owner_id's default, so the schema-shape golden stays stable.
 *
 * Idempotent: guards on owner_id already being TEXT NOT NULL with no default.
 */
export function up(db: Database): void {
  const ownerCol = (db.prepare(`PRAGMA table_info(daily_summaries)`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[]).find((c) => c.name === 'owner_id');
  if (
    ownerCol &&
    ownerCol.dflt_value == null &&
    ownerCol.notnull === 1 &&
    (ownerCol.type || '').toUpperCase() === 'TEXT'
  ) {
    return; // already TEXT NOT NULL, no default — re-run safety.
  }

  rebuildTable(db, {
    table: 'daily_summaries',
    createNewSql: `
      CREATE TABLE daily_summaries_new (
        owner_id    TEXT NOT NULL REFERENCES owners(id),
        date        TEXT NOT NULL,
        prose       TEXT NOT NULL,
        stats       TEXT NOT NULL,
        focus       TEXT NOT NULL DEFAULT '[]',
        llm         INTEGER NOT NULL DEFAULT 0,
        inputs_hash TEXT NOT NULL,
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_id, date)
      );`,
    columns: 'owner_id, date, prose, stats, focus, llm, inputs_hash, created_at, updated_at',
  });
}
