import type { Database } from 'better-sqlite3';

export const id = '0099_time_blocks_owner_id';
// Rebuild toggles foreign_keys OFF/ON (a no-op inside a transaction). CON-1.
export const manual = true;

/**
 * T1 (multi-tenant) — give `time_blocks` a real `owner_id`.
 *
 * `time_blocks` was created in the 0001 baseline with NO `owner_id` and only ever
 * grown by `ALTER ADD COLUMN` (retyped INTEGER→TEXT in 0030). A block was reachable
 * by an owner only through `task_id → tasks.owner_id`, and CONTAINER
 * (`block_kind='timeblock'`) and synced-MEETING (`'meeting'`) blocks have `task_id`
 * NULL — so they had NO owner path at all. Under multi-tenant that's the calendar's
 * single biggest isolation hole. Add `owner_id TEXT NOT NULL REFERENCES owners(id)
 * ON DELETE CASCADE`, backfilling every existing row to its correct owner.
 *
 * WHY HAND-WRITTEN (not `rebuildTable`): rebuildTable's `INSERT..SELECT` copies only
 * columns shared between old and new tables, so it CANNOT populate a brand-new
 * NOT NULL `owner_id` in one pass (F-REBUILD). Rather than the nullable→backfill→
 * re-tighten two-rebuild dance, we hand-write the canonical 12-step ONCE with the
 * backfill inlined into the copy's SELECT — a single table rewrite that lands
 * `owner_id` already NOT NULL:
 *   owner_id = COALESCE(the block's task's owner, the single owner)
 * Task-backed blocks inherit their task's owner; container/meeting blocks (task_id
 * NULL) fall back to the one owner that exists at migration time — deterministically
 * the SYSTEM_OWNER sentinel (`00000000-…-0001`), which sorts first among UUIDv7 ids.
 *
 * SHAPE FIDELITY: the new table reproduces the live physical column order EXACTLY
 * (the schema-shape characterization golden captures column names in PRAGMA order),
 * inserting `owner_id` at position 3 — right after `task_id`, mirroring the sibling
 * `time_entries` (id, task_id, owner_id, …). All per-column types/defaults/nullability
 * are preserved (e.g. is_locked/is_auto/all_day stay `INTEGER DEFAULT` — NULLABLE, not
 * NOT NULL). All SIX pre-existing indexes are recreated (rebuildTable's DROP drops
 * them), plus a new owner-scoped range index `ix_time_blocks_owner_start(owner_id,
 * start_at)` so the hot `GET /api/blocks` range read stays index-backed. The golden
 * is regenerated in the same PR; the ONLY diff is `time_blocks.owner_id`.
 *
 * CASCADE (F-CASCADE): `owner_id` carries `ON DELETE CASCADE` per the T1 ticket — a
 * deleted owner's calendar goes with them. This is intentionally inconsistent with
 * the newer no-cascade owner FKs (flight_plan 0093, sync_events 0098, pattern_day_optouts
 * 0074), which defer owner-delete semantics to Phase U. Owners are never deleted today,
 * so the behavior is dormant; U normalizes owner-delete cascade across all tables.
 *
 * A scoped `PRAGMA foreign_key_check(time_blocks)` gates the result — the rebuild
 * copies every id verbatim (so the 6 inbound FKs from time_entries/reminders/
 * external_events/outbound_queue/daily_plan and the parent_block_id self-ref stay
 * valid) and backfills owner_id to real owners, so a violation means a genuine orphan
 * and aborts the migration.
 *
 * Idempotent: guards on `owner_id` already existing on the table, so a re-run — or an
 * already-migrated DB — is a no-op.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (cols.includes('owner_id')) return; // already migrated — re-run safety.

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      // New table: exact live physical column order (PRAGMA order, per the golden),
      // with owner_id inserted at position 3. Types/defaults/nullability preserved.
      db.exec(`
        CREATE TABLE time_blocks_new (
          id                    TEXT PRIMARY KEY NOT NULL,
          task_id               TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          owner_id              TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
          title                 TEXT NOT NULL,
          block_kind            TEXT DEFAULT 'task',
          start_at              TEXT NOT NULL,
          end_at                TEXT NOT NULL,
          is_locked             INTEGER DEFAULT 0,
          is_auto               INTEGER DEFAULT 1,
          source_kind           TEXT DEFAULT 'manual',
          source_ref            TEXT,
          status                TEXT DEFAULT 'planned',
          created_at            TEXT DEFAULT CURRENT_TIMESTAMP,
          all_day               INTEGER DEFAULT 0,
          tag                   TEXT,
          block_type            TEXT,
          goal_start_date       TEXT,
          duration_minutes      INTEGER,
          note                  TEXT,
          parent_block_id       TEXT REFERENCES time_blocks(id) ON DELETE SET NULL,
          recurrence_rule       TEXT,
          recurrence_dtstart    TEXT,
          recurrence_parent_id  TEXT,
          occurrence_date       TEXT,
          auto_run_id           TEXT,
          last_moved_at         TEXT,
          category_id           TEXT REFERENCES tags(id) ON DELETE SET NULL,
          color_token           TEXT,
          recurrence_exdates    TEXT,
          version               INTEGER NOT NULL DEFAULT 1,
          updated_at            TEXT,
          field_ts              TEXT
        );
      `);

      // Copy every row, backfilling owner_id inline: task-backed blocks inherit the
      // task's owner; task_id-NULL blocks (containers, synced meetings) get the single
      // owner (SYSTEM_OWNER sorts first). All other columns copy verbatim.
      db.exec(`
        INSERT INTO time_blocks_new
          (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto,
           source_kind, source_ref, status, created_at, all_day, tag, block_type,
           goal_start_date, duration_minutes, note, parent_block_id, recurrence_rule,
           recurrence_dtstart, recurrence_parent_id, occurrence_date, auto_run_id,
           last_moved_at, category_id, color_token, recurrence_exdates, version,
           updated_at, field_ts)
        SELECT
          id, task_id,
          COALESCE(
            (SELECT t.owner_id FROM tasks t WHERE t.id = time_blocks.task_id),
            (SELECT id FROM owners ORDER BY id LIMIT 1)
          ),
          title, block_kind, start_at, end_at, is_locked, is_auto,
          source_kind, source_ref, status, created_at, all_day, tag, block_type,
          goal_start_date, duration_minutes, note, parent_block_id, recurrence_rule,
          recurrence_dtstart, recurrence_parent_id, occurrence_date, auto_run_id,
          last_moved_at, category_id, color_token, recurrence_exdates, version,
          updated_at, field_ts
        FROM time_blocks;
      `);

      db.exec(`DROP TABLE time_blocks;`);
      db.exec(`ALTER TABLE time_blocks_new RENAME TO time_blocks;`);

      // Recreate all 6 pre-existing indexes verbatim (the rebuild dropped them) + the
      // new owner-scoped range index.
      db.exec(`
        CREATE INDEX IF NOT EXISTS ix_time_blocks_task ON time_blocks(task_id);
        CREATE INDEX IF NOT EXISTS ix_time_blocks_category ON time_blocks(category_id);
        CREATE INDEX IF NOT EXISTS ix_time_blocks_parent ON time_blocks(parent_block_id);
        CREATE INDEX IF NOT EXISTS ix_time_blocks_pattern_source
          ON time_blocks(source_ref, start_at)
          WHERE source_kind = 'pattern';
        CREATE UNIQUE INDEX IF NOT EXISTS ux_block_occurrence
          ON time_blocks(recurrence_parent_id, occurrence_date)
          WHERE recurrence_parent_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_time_blocks_ingest_source
          ON time_blocks(source_kind, source_ref)
          WHERE source_kind IN ('gmail','gcal') AND source_ref IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ix_time_blocks_owner_start ON time_blocks(owner_id, start_at);
      `);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // Fail loud on any orphan the rebuild would otherwise silently retain (owner_id
  // pointing at a missing owner, or a preserved FK gone dangling).
  const violations = db.prepare(`PRAGMA foreign_key_check(time_blocks)`).all();
  if (violations.length > 0) {
    throw new Error(
      `0099_time_blocks_owner_id: foreign_key_check found ${violations.length} violation(s) after rebuild; aborting.`,
    );
  }
}
