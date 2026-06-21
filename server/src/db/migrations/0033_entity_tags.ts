import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0033_entity_tags';

/**
 * CON-3: the canonical normalized tag store `entity_tags(entity_kind, entity_id,
 * tag_id, level)` — ONE polymorphic association table for Task · Time Block ·
 * Routine. Gates #77 Phase 5 (tag levels + dilution).
 *
 * **Behavior-preserving + additive + idempotent.** `entity_tags` is populated in
 * parallel with the existing denormalized mirrors (`time_blocks.tag`,
 * `patterns.tag`, `task_tags`); NO existing read switches onto it here. `entity_id`
 * has no FK (it spans three tables) — integrity is app-enforced by the tag-repo
 * (services/tags.ts), which owns every entity-delete path.
 *
 * Backfill:
 *  - tasks: copy resolved associations straight from `task_tags` (same tag ids).
 *  - time blocks / routines: their tag is a denormalized comma-split string —
 *    split, normalize, resolve-or-create the tag (`uuid7()`), then associate.
 *  - concept-tag names from `scheduling_prefs.concept_tags` are folded into `tags`
 *    as definitions only (no `entity_tags` rows — they are not associations).
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_tags (
      entity_kind TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      level       INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (entity_kind, entity_id, tag_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id);`);

  // Same normalization as the tag-repo / attachTags: trim, strip leading '#',
  // lowercase, spaces→dashes, cap at 32 chars. Keep these in lockstep.
  const normalize = (raw: string): string =>
    raw.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);

  // Mint ids in TS (newId), not via the uuid7() UDF — the migration runner may run
  // on a bare connection without that function registered (see migrate.test.ts).
  const findTag = db.prepare(`SELECT id FROM tags WHERE name = ?`);
  const makeTag = db.prepare(`INSERT INTO tags (id, name) VALUES (?, ?) RETURNING id`);
  const resolveTagId = (name: string): string => {
    const existing = findTag.get(name) as { id: string } | undefined;
    return existing ? existing.id : (makeTag.get(newId(), name) as { id: string }).id;
  };

  const assoc = db.prepare(
    `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES (?, ?, ?, 1)`,
  );

  // tasks — copy resolved associations directly (guaranteed-consistent tag ids).
  db.exec(
    `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level)
     SELECT 'task', task_id, tag_id, 1 FROM task_tags`,
  );

  const splitAssoc = (kind: string, entityId: string, raw: string | null): void => {
    if (!raw) return;
    for (const part of raw.split(',')) {
      const name = normalize(part);
      if (!name) continue;
      assoc.run(kind, entityId, resolveTagId(name));
    }
  };

  // time blocks — denormalized `tag` string.
  for (const b of db.prepare(`SELECT id, tag FROM time_blocks WHERE tag IS NOT NULL AND tag <> ''`).all() as {
    id: string;
    tag: string;
  }[]) {
    splitAssoc('time_block', b.id, b.tag);
  }

  // routines (patterns) — denormalized `tag` string.
  for (const p of db.prepare(`SELECT id, tag FROM patterns WHERE tag IS NOT NULL AND tag <> ''`).all() as {
    id: string;
    tag: string;
  }[]) {
    splitAssoc('routine', p.id, p.tag);
  }

  // concept-tag definitions — fold names into `tags` only (no associations).
  for (const row of db.prepare(`SELECT concept_tags FROM scheduling_prefs WHERE concept_tags IS NOT NULL`).all() as {
    concept_tags: string;
  }[]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.concept_tags);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const ct of parsed) {
      const rawName = (ct as { name?: unknown })?.name;
      if (typeof rawName !== 'string') continue;
      const name = normalize(rawName);
      if (name) resolveTagId(name);
    }
  }
}
