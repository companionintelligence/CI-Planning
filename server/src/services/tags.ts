import { sqlite } from '../db/index.js';

/**
 * CON-3 tag-repo — the app-enforced integrity layer for the normalized
 * `entity_tags` store. `entity_tags.entity_id` has NO FK (it spans tasks /
 * time_blocks / patterns), so referential integrity lives HERE: every write path
 * routes through `syncEntityTags` / `setEntityTagIds`, and **every HARD delete of
 * a tagged entity must call `removeEntityTags`** or its rows orphan. The
 * orphan-free tests are the gate.
 *
 * Behavior-preserving: this is written in parallel with the denormalized mirrors
 * (`task_tags`, `time_blocks.tag`, `patterns.tag`); no existing read consumes
 * `entity_tags` yet — Phase 5 (levels + dilution) is the first reader.
 *
 * better-sqlite3 is synchronous; these are plain sync functions.
 */

export type EntityKind = 'task' | 'time_block' | 'routine';

/**
 * Canonical tag-name normalization. Matches `routes/tasks.ts` attachTags and the
 * 0033 backfill — keep all three in lockstep. trim → strip leading '#' → lowercase
 * → spaces to dashes → cap at 32 chars.
 */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

/** Split a denormalized comma-separated tag string into normalized names. */
export function splitTagString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(normalizeTagName)
    .filter((n) => n.length > 0);
}

const findTag = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`);
const makeTag = sqlite.prepare(`INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id`);
const insertAssoc = sqlite.prepare(
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES (?, ?, ?, ?)`,
);
const deleteEntity = sqlite.prepare(`DELETE FROM entity_tags WHERE entity_kind = ? AND entity_id = ?`);
const selectNames = sqlite.prepare(
  `SELECT tags.name FROM tags
     JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = ? AND entity_tags.entity_id = ?
    ORDER BY entity_tags.level, tags.name`,
);

/** Resolve a tag id by (normalized) name, creating the `tags` row if absent. */
export function resolveTagId(name: string): string {
  const norm = normalizeTagName(name);
  const existing = findTag.get(norm) as { id: string } | undefined;
  return existing ? existing.id : (makeTag.get(norm) as { id: string }).id;
}

/**
 * Replace an entity's tag set with the given **tag ids** at `level`. The low-level
 * primitive; callers that already hold resolved ids (e.g. the task path, which
 * mirrors `task_tags`) use this to guarantee identical ids across both stores.
 */
export function setEntityTagIds(kind: EntityKind, entityId: string, tagIds: string[], level = 1): void {
  deleteEntity.run(kind, entityId);
  for (const tagId of tagIds) insertAssoc.run(kind, entityId, tagId, level);
}

/**
 * Replace an entity's tag set with the given **names** at `level` (resolve-or-create
 * each, then replace). Used by the time-block / routine write paths, whose tags
 * arrive as a denormalized string.
 */
export function syncEntityTags(kind: EntityKind, entityId: string, names: string[], level = 1): void {
  setEntityTagIds(kind, entityId, names.map(resolveTagId), level);
}

/**
 * Remove all of an entity's tag associations — the cascade primitive every HARD
 * delete path must call (soft deletes leave the entity row, so they don't).
 */
export function removeEntityTags(kind: EntityKind, entityId: string): void {
  deleteEntity.run(kind, entityId);
}

/** An entity's associated tag names (level-then-name ordered). */
export function entityTagNames(kind: EntityKind, entityId: string): string[] {
  return (selectNames.all(kind, entityId) as { name: string }[]).map((r) => r.name);
}
