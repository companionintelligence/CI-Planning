import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0036_tag_directions';

/**
 * Tag taxonomy: Direction tags ▸ Intention tags. A SECOND axis, orthogonal to the
 * Phase-5 `entity_tags.level` (per-entity dilution). A 'direction' is a top-level
 * category — brand-set Home/Work/Community (is_base, undeletable) plus user-added —
 * and every other tag is an 'intention' grouped under one or more directions.
 *
 * **Additive + idempotent.** Existing tags become intentions (column default); the
 * heuristic below assigns the obvious ones to a direction and leaves the rest
 * Unsorted (no membership). Ids minted via newId() (the runner may use a bare conn).
 */
// Direction names are stored NORMALIZED (lowercase) like every other tag, so a user
// tagging "work" (which normalizeTagName lowercases) round-trips to the same row.
// The UI capitalizes them for display.
const BASE_DIRECTIONS = ['home', 'work', 'community'];

// Heuristic intention→direction backfill. Keys that equal a direction name are
// skipped (those tags get promoted to the direction itself).
const HEURISTIC: Record<string, string> = {
  'yard-work': 'home', 'house-work': 'home', 'meal-prep': 'home', relax: 'home', 'me-time': 'home',
  product: 'work', bizdev: 'work', partnerships: 'work', submissions: 'work', investment: 'work', focus: 'work',
  socialize: 'community', 'family-time': 'community',
};

export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(tags)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('kind'))    db.exec(`ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'intention'`);
  if (!cols.includes('muted'))   db.exec(`ALTER TABLE tags ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`);
  if (!cols.includes('is_base')) db.exec(`ALTER TABLE tags ADD COLUMN is_base INTEGER NOT NULL DEFAULT 0`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_directions (
      intention_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      direction_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (intention_tag_id, direction_tag_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tag_directions_dir ON tag_directions(direction_tag_id);`);

  // Seed the three brand directions (insert-if-absent by name). A pre-existing tag of
  // the same name is promoted to a base direction.
  const findByName = db.prepare(`SELECT id FROM tags WHERE name = ?`);
  const insDir = db.prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES (?, ?, 'direction', 1)`);
  const promote = db.prepare(`UPDATE tags SET kind = 'direction', is_base = 1 WHERE id = ?`);
  const dirId: Record<string, string> = {};
  for (const name of BASE_DIRECTIONS) {
    const existing = findByName.get(name) as { id: string } | undefined;
    if (existing) { promote.run(existing.id); dirId[name] = existing.id; }
    else { const nid = newId(); insDir.run(nid, name); dirId[name] = nid; }
  }

  // Heuristic backfill: map obvious intention tags to a direction; the rest stay Unsorted.
  const assoc = db.prepare(
    `INSERT OR IGNORE INTO tag_directions (intention_tag_id, direction_tag_id) VALUES (?, ?)`,
  );
  for (const t of db.prepare(`SELECT id, name FROM tags WHERE kind = 'intention'`).all() as {
    id: string;
    name: string;
  }[]) {
    const dir = HEURISTIC[t.name];
    if (dir && dirId[dir]) assoc.run(t.id, dirId[dir]);
  }
}
