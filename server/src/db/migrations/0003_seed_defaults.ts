import type { Database } from 'better-sqlite3';
import { serverTimezone } from '../../lib/tz.js';

export const id = '0003_seed_defaults';

/**
 * Backfill the timezone for rows predating the column, then seed the default
 * owner, their scheduling prefs, and the cron jobs. All idempotent: the backfill
 * only touches null/empty zones, owner seeding bails if owner 1 exists, and jobs
 * use INSERT OR IGNORE.
 */
export function up(db: Database): void {
  // Workday hours are wall-clock in this zone; never leave it null for the scheduler.
  db.prepare(
    `UPDATE scheduling_prefs SET timezone = ? WHERE timezone IS NULL OR timezone = ''`
  ).run(serverTimezone());

  const existing = db.prepare('SELECT id FROM owners WHERE id = 1').get();
  if (!existing) {
    db.prepare('INSERT INTO owners (id, name, email) VALUES (1, ?, ?)').run('Liam', 'liam.broza@gmail.com');
    db.prepare('INSERT INTO scheduling_prefs (owner_id, timezone) VALUES (1, ?)').run(serverTimezone());
  }

  const jobs = [
    { name: 'ingest_gmail',      kind: 'ingest_gmail',      cron: '*/30 * * * *' },
    { name: 'ingest_gcal',       kind: 'ingest_gcal',       cron: '*/30 * * * *' },
    { name: 'promote_possibles', kind: 'promote_possibles', cron: '0 2 * * *' },
    { name: 'nightly_grooming',  kind: 'nightly_grooming',  cron: '0 2 * * *' },
    { name: 'auto_schedule',     kind: 'auto_schedule',     cron: '0 3 * * *' },
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO scheduled_jobs (name, kind, cron) VALUES (?, ?, ?)');
  for (const j of jobs) insert.run(j.name, j.kind, j.cron);
}
