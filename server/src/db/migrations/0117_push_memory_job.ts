import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0117_push_memory_job';

/**
 * Phase AA · AA4 — seeds the daily `push_memory` job. One-way push of the owner's
 * completed tasks / habit occurrences / reflections to CI-Server's capture ingest
 * (`POST /v1/events`), gated by memory_sync_enabled + the per-entity scope toggles and
 * watermarked by memory_last_synced_at (see services/memory.ts syncToMemory). Runs at
 * 02:00 (process tz = UTC baseline, as everywhere). INSERT OR IGNORE keeps the migration
 * idempotent.
 */
export function up(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, 'push_memory', 'push_memory', '0 2 * * *')`,
  ).run(newId()); // daily 02:00
}
