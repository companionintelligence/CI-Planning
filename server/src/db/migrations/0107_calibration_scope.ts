import type { Database } from 'better-sqlite3';
import { rebuildTable } from '../migrate.js';

export const id = '0107_calibration_scope';
// PK change (owner_id → composite) requires a table rebuild — toggles foreign_keys
// OFF for the swap, so it runs outside the runner's auto-transaction. CON-1.
export const manual = true;

/**
 * Phase Z · Z0 (Time-Sense) — scope-key the estimate calibration.
 *
 * Phase N (0083) shipped `estimate_calibration` as ONE global row per owner.
 * The Calibration Loop needs per-scope defaults ("#taxes runs long", "dinner +
 * #reservation runs longer than dinner alone"), so the PK widens to
 * (owner_id, scope_kind, scope_ref):
 *   scope_kind  'global' | 'subtype' | 'tag' | 'tag_combo' | 'category' | 'objective'
 *   scope_ref   tag id, sorted '+'-joined tag-id tuple, category tag id, subtype,
 *               objective id, or '' for global
 * Existing rows backfill as scope_kind='global', scope_ref='' via the column
 * DEFAULTs (the copy omits the new columns).
 *
 * `calibration_combo_pins` records USER-CONFIRMED tag combos (hybrid decision,
 * 2026-07-01): the nightly job only *suggests* divergent combos; a tag_combo
 * calibration row is computed only for pinned refs — avoids the sparse-data
 * explosion of auto-materializing every tuple.
 *
 * Also moves the `calibrate_estimates` cron weekly (Sun 04:00) → nightly 01:30
 * (the slot 0095 vacated), after review_day at 01:00 — the loop needs fresh
 * scopes every morning, not week-old ones. Guarded on the 0083-seeded value so
 * a re-run (or an operator-customized cron) is never clobbered.
 *
 * Forward-only + idempotent (guards on scope_kind already existing).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(estimate_calibration)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes('scope_kind')) {
    rebuildTable(db, {
      table: 'estimate_calibration',
      createNewSql: `
        CREATE TABLE estimate_calibration_new (
          owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
          scope_kind   TEXT NOT NULL DEFAULT 'global',
          scope_ref    TEXT NOT NULL DEFAULT '',
          computed_at  TEXT NOT NULL,
          sample_count INTEGER NOT NULL DEFAULT 0,
          bias_ratio   REAL,
          p25          REAL,
          p50          REAL,
          p75          REAL,
          PRIMARY KEY (owner_id, scope_kind, scope_ref)
        );`,
      columns: 'owner_id, computed_at, sample_count, bias_ratio, p25, p50, p75',
    });
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_combo_pins (
      owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      scope_ref  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner_id, scope_ref)
    );
  `);

  db.prepare(`UPDATE scheduled_jobs SET cron = '30 1 * * *' WHERE kind = 'calibrate_estimates' AND cron = '0 4 * * 0'`).run();
}
