import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0037_pattern_blocks';

/**
 * Pattern-blocks: direction-scoped scheduling windows (noun 8 in the GLOSSARY).
 * Multiple rows per (owner, direction_tag_id, day_type) = multiple time ranges.
 * Additive + idempotent. Seeds default windows for the three brand-set directions
 * on any existing owner that has no pattern_blocks rows yet.
 */

const DEFAULTS: Record<string, Record<string, { start: string; end: string }[]>> = {
  workday: {
    home:      [{ start: '07:00', end: '08:00' }, { start: '18:00', end: '23:00' }],
    work:      [{ start: '09:00', end: '18:00' }],
    community: [{ start: '08:00', end: '09:00' }, { start: '18:00', end: '21:00' }],
  },
  weekend: {
    home:      [{ start: '08:00', end: '23:00' }],
    work:      [{ start: '10:00', end: '12:00' }],
    community: [{ start: '08:00', end: '22:00' }],
  },
};

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_blocks (
      id               TEXT PRIMARY KEY,
      owner_id         TEXT NOT NULL REFERENCES owners(id),
      direction_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      day_type         TEXT NOT NULL CHECK(day_type IN ('workday','weekend')),
      start_time       TEXT NOT NULL,
      end_time         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_pattern_blocks_owner_daytype
      ON pattern_blocks(owner_id, day_type);
  `);

  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
  const findDir = db.prepare(`SELECT id FROM tags WHERE name = ? AND kind = 'direction'`);
  const countRows = db.prepare(`SELECT COUNT(*) AS n FROM pattern_blocks WHERE owner_id = ?`);
  const ins = db.prepare(
    `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const owner of owners) {
    const { n } = countRows.get(owner.id) as { n: number };
    if (n > 0) continue;
    for (const [dayType, dirs] of Object.entries(DEFAULTS)) {
      for (const [dirName, ranges] of Object.entries(dirs)) {
        const dir = findDir.get(dirName) as { id: string } | undefined;
        if (!dir) continue;
        for (const r of ranges) ins.run(newId(), owner.id, dir.id, dayType, r.start, r.end);
      }
    }
  }
}
