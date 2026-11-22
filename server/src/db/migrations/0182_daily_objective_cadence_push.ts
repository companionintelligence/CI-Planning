import type { Database } from 'better-sqlite3';

export const id = '0182_daily_objective_cadence_push';

/** Run the cadence check daily so daily objectives can be nominated each morning. */
export function up(db: Database): void {
  db.prepare(`UPDATE scheduled_jobs SET cron = ? WHERE kind = ?`)
    .run('0 5 * * *', 'advance_objectives');
}
