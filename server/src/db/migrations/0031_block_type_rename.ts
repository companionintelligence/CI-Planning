import type { Database } from 'better-sqlite3';

export const id = '0031_block_type_rename';

/**
 * CON-2 vocabulary canon: rename the Time-Block *state* values to match the
 * glossary (docs/GLOSSARY.md) — `plan` → `scheduled`, `concept` → `someday`.
 * Pure value relabel; all readers are updated in the same change, so it's
 * behavior-preserving (the behavior-baseline blocks snapshot updates as an
 * intentional, reviewed diff). Additive + idempotent — WHERE matches only the
 * old values, so a re-run is a no-op.
 */
export function up(db: Database): void {
  db.exec(`UPDATE time_blocks SET block_type = 'scheduled' WHERE block_type = 'plan';`);
  db.exec(`UPDATE time_blocks SET block_type = 'someday' WHERE block_type = 'concept';`);
}
