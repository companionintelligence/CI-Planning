import type { Database } from 'better-sqlite3';

export const id = '0147_ingest_windows';

/**
 * Per-owner ingestion windows: how much of each upstream source a pull actually reads.
 *
 *   memory_window_days  — how far AHEAD the Companion Memory pull looks for upcoming
 *                         events. Default 2 = the 48h that agents/memory-suggest.ts and
 *                         agents/summarize.ts previously hardcoded, so an existing owner's
 *                         behavior is byte-identical until they change it.
 *   email_lookback_days — how far BACK a Gmail ingest may reach. Default 7. This one is
 *                         NOT a pure no-op: the Gmail cursor previously had no floor at
 *                         all, so a first ingest (or the first run after a long outage)
 *                         read as far back as the MCP Gmail tool would return. The floor
 *                         bounds that; on a healthy 15-minute cadence the watermark is
 *                         always newer than the floor, so the steady state is unchanged.
 *
 * The two directions are deliberate and NOT symmetric — memory suggestions mirror
 * UPCOMING events into tasks (a backward memory window would stage tasks for things that
 * already happened), while an inbox is only ever read backwards.
 *
 * Additive + idempotent (PRAGMA guard: SQLite ALTER has no IF NOT EXISTS).
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('memory_window_days')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN memory_window_days INTEGER NOT NULL DEFAULT 2`);
  }
  if (!cols.includes('email_lookback_days')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN email_lookback_days INTEGER NOT NULL DEFAULT 7`);
  }
}
