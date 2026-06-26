import type { Database } from 'better-sqlite3';
import { rebuildTable } from '../migrate.js';
import { newId } from '../../lib/ids.js';

export const id = '0068_day_types';
// Rebuilds pattern_blocks (toggles foreign_keys, a no-op inside a transaction). CON-1.
export const manual = true;

/**
 * T-SCHED-3 — custom day types + per-date assignment ("not every Monday is a
 * Workday"). Replaces the hardcoded workday/weekend split with:
 *   - `day_types(owner, key, name, is_builtin)`   — the owner's day-type catalog
 *   - `day_of_week_map(owner, dow, day_type_key)` — recurring weekly default
 *   - `day_assignments(owner, date, day_type_key)` — per-date override
 * and **removes the `CHECK(day_type IN ('workday','weekend'))`** on `pattern_blocks`
 * (migration 0037) so a custom day type can own its own availability windows.
 *
 * Behavior-preservation: `resolveDayType()` (services/day-types.ts) falls back to the
 * same UTC weekend heuristic `isWeekendDate()` used today when no override/map row
 * exists, so placement output is byte-identical until the owner customizes. The
 * seeded builtins + Mon–Fri/Sat–Sun map make those defaults visible+editable in the UI.
 *
 * `manual` (CON-1): the pattern_blocks rebuild toggles foreign_keys. up() is
 * idempotent — the rebuild guards on the CHECK still being present, the new tables
 * use IF NOT EXISTS, and seeding skips any owner that already has day_types.
 */
export function up(db: Database): void {
  // 1 — Drop the day_type CHECK on pattern_blocks via the 12-step rebuild, but only
  //     while it's still present (so a re-run is a no-op).
  const pbSql =
    (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='pattern_blocks'`).get() as
      | { sql: string }
      | undefined)?.sql ?? '';
  if (/CHECK\s*\(\s*day_type/i.test(pbSql)) {
    rebuildTable(db, {
      table: 'pattern_blocks',
      createNewSql: `
        CREATE TABLE pattern_blocks_new (
          id             TEXT PRIMARY KEY,
          owner_id       TEXT NOT NULL REFERENCES owners(id),
          pattern_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          day_type       TEXT NOT NULL,
          start_time     TEXT NOT NULL,
          end_time       TEXT NOT NULL
        );`,
      columns: 'id, owner_id, pattern_tag_id, day_type, start_time, end_time',
      afterSql: `CREATE INDEX IF NOT EXISTS ix_pattern_blocks_owner_daytype ON pattern_blocks(owner_id, day_type);`,
    });
  }

  // 2 + 3 — additive tables + seed, atomically.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS day_types (
        id         TEXT    PRIMARY KEY,
        owner_id   TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        key        TEXT    NOT NULL,
        name       TEXT    NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        UNIQUE(owner_id, key)
      );
      CREATE TABLE IF NOT EXISTS day_of_week_map (
        owner_id     TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        dow          INTEGER NOT NULL,            -- 0=Sun … 6=Sat (UTC noon, matches isWeekendDate)
        day_type_key TEXT    NOT NULL,
        PRIMARY KEY (owner_id, dow)
      );
      CREATE TABLE IF NOT EXISTS day_assignments (
        owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        date         TEXT NOT NULL,               -- 'YYYY-MM-DD' local date
        day_type_key TEXT NOT NULL,
        PRIMARY KEY (owner_id, date)
      );
    `);

    const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
    const hasTypes = db.prepare(`SELECT COUNT(*) AS n FROM day_types WHERE owner_id = ?`);
    const insType = db.prepare(`INSERT INTO day_types (id, owner_id, key, name, is_builtin) VALUES (?, ?, ?, ?, 1)`);
    const insMap = db.prepare(`INSERT OR IGNORE INTO day_of_week_map (owner_id, dow, day_type_key) VALUES (?, ?, ?)`);
    for (const o of owners) {
      if ((hasTypes.get(o.id) as { n: number }).n > 0) continue;
      insType.run(newId(), o.id, 'workday', 'Workday');
      insType.run(newId(), o.id, 'weekend', 'Weekend');
      for (let dow = 0; dow < 7; dow++) {
        insMap.run(o.id, dow, dow === 0 || dow === 6 ? 'weekend' : 'workday');
      }
    }
  })();
}
