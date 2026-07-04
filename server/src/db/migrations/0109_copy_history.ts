import type { Database } from 'better-sqlite3';

export const id = '0109_copy_history';

/**
 * Phase Z · Z7 (Time-Sense) — the Voice loop's anti-repetition memory (spec §2V.3).
 *
 * `copy_history` is a rolling window, per owner × surface, of the phrasing
 * signatures `renderCopy` has recently emitted. The gate reads its own surface's
 * window to reject a line that repeats a recent one; each emit records its
 * signature and prunes the window back to the surface's K. Cheap to read/write.
 *
 * ZERO NEW NOUNS: this is non-noun operational support state (like audit_log /
 * reminders) — regenerable, not user-authored, so it is deliberately NOT part of
 * the owner data export; a restore simply starts the window fresh. Declared
 * alongside the other Time-Sense support tables in the GLOSSARY amendment.
 *
 * `signature` is JSON: { opener, trigrams, template? } (see agents/render-copy.ts).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copy_history (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      surface    TEXT NOT NULL,
      signature  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- The gate reads one owner×surface window newest-first; this index serves it.
    CREATE INDEX IF NOT EXISTS copy_history_owner_surface_id
      ON copy_history (owner_id, surface, id DESC);
  `);
}
