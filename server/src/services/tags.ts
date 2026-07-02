import { sqlite } from '../db/index.js';

/**
 * CON-3 tag-repo — the app-enforced integrity layer for the normalized
 * `entity_tags` store. `entity_tags.entity_id` has NO FK (it spans tasks /
 * time_blocks / patterns), so referential integrity lives HERE: every write path
 * routes through `syncEntityTags` / `setEntityTagIds`, and **every HARD delete of
 * a tagged entity must call `removeEntityTags`** or its rows orphan. The
 * orphan-free tests are the gate.
 *
 * As of CON-3 Wave 2, `entity_tags` is the **sole** task-tag store (`task_tags` was
 * dropped in migration 0041) and the task read path (`taskTagNames`). `time_blocks.tag`
 * / `patterns.tag` remain as denormalized top-level mirrors for blocks / routines.
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

const findTag = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ?`);
const makeTag = sqlite.prepare(`INSERT INTO tags (id, owner_id, name) VALUES (uuid7(), ?, ?) RETURNING id`);
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

/**
 * Resolve a tag id by (normalized) name within an owner's namespace, creating the
 * tag for that owner if absent. Owner-scoped since T2: `name` is unique PER-OWNER
 * (UNIQUE(owner_id, name)), so the same name resolves to a DIFFERENT tag per owner.
 */
export function resolveTagId(name: string, owner: string): string {
  const norm = normalizeTagName(name);
  const existing = findTag.get(owner, norm) as { id: string } | undefined;
  return existing ? existing.id : (makeTag.get(owner, norm) as { id: string }).id;
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
export function syncEntityTags(kind: EntityKind, entityId: string, names: string[], owner: string, level = 1): void {
  setEntityTagIds(kind, entityId, names.map((n) => resolveTagId(n, owner)), level);
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

// ── Task tag read-path (CON-3 finish, Wave 1) ────────────────────────────────
// Tasks have no `.tag` mirror — their tags live in entity_tags. Read **level 1**
// (top-level) so the result exactly matches the dropped `task_tags` set; secondary
// (level>1) tags are Phase-5 only and must not leak into the primary tag list.
// ORDER BY tag_id reproduces the OLD `task_tags` read order: that JOIN was driven by
// the `task_tags` PRIMARY KEY (task_id, tag_id), so it returned tags in tag_id order.
// Preserving it keeps `tags[0]` (the client's "primary" tag — persisted onto dropped
// blocks / saved templates) stable across the read-flip. Do NOT order by name.
const selectTaskNames = sqlite.prepare(
  `SELECT tags.name FROM tags
     JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = 'task' AND entity_tags.entity_id = ? AND entity_tags.level = 1
    ORDER BY entity_tags.tag_id`,
);
/** A task's top-level tag names — the read replacing the `task_tags` JOIN. */
export function taskTagNames(id: string): string[] {
  return (selectTaskNames.all(id) as { name: string }[]).map((r) => r.name);
}

/** Bound-parameter chunk size — kept well under SQLITE_MAX_VARIABLE_NUMBER (even the legacy 999). */
const TASK_TAG_CHUNK = 500;

/**
 * Batched variant for list endpoints (no N+1). Returns a Map keyed by task id; every
 * requested id is present (empty array if untagged). The IN-list is **chunked** so an
 * unbounded task list can't blow SQLite's bound-parameter limit. Per-task tag order
 * matches `taskTagNames` (tag_id = old PK order).
 */
export function taskTagNamesByIds(ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += TASK_TAG_CHUNK) {
    const chunk = ids.slice(i, i + TASK_TAG_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT entity_tags.entity_id AS id, tags.name AS name
           FROM tags JOIN entity_tags ON tags.id = entity_tags.tag_id
          WHERE entity_tags.entity_kind = 'task' AND entity_tags.level = 1
            AND entity_tags.entity_id IN (${placeholders})
          ORDER BY entity_tags.entity_id, entity_tags.tag_id`,
      )
      .all(...chunk) as { id: string; name: string }[];
    for (const r of rows) out.get(r.id)?.push(r.name);
  }
  return out;
}

/**
 * Batched secondary (level>1) task tags for list endpoints (no N+1) — the
 * companion to `taskTagNamesByIds` (level 1). Same chunking + Map shape: every
 * requested id is present (empty array if none). Ordered level-then-name.
 */
export function taskSecondaryTagNamesByIds(ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += TASK_TAG_CHUNK) {
    const chunk = ids.slice(i, i + TASK_TAG_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT entity_tags.entity_id AS id, tags.name AS name
           FROM tags JOIN entity_tags ON tags.id = entity_tags.tag_id
          WHERE entity_tags.entity_kind = 'task' AND entity_tags.level > 1
            AND entity_tags.entity_id IN (${placeholders})
          ORDER BY entity_tags.entity_id, entity_tags.level, tags.name`,
      )
      .all(...chunk) as { id: string; name: string }[];
    for (const r of rows) out.get(r.id)?.push(r.name);
  }
  return out;
}

const selectLevels = sqlite.prepare(
  `SELECT tags.name AS name, entity_tags.level AS level FROM tags
     JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = ? AND entity_tags.entity_id = ?
    ORDER BY entity_tags.level, tags.name`,
);

/** An entity's tags with their levels (cockpit-v2 Phase 5: top=1, secondary>1). */
export function entityTagLevels(kind: EntityKind, entityId: string): { name: string; level: number }[] {
  return selectLevels.all(kind, entityId) as { name: string; level: number }[];
}

/**
 * Replace an entity's tags across MULTIPLE levels in one shot (Phase 5). `groups`
 * is processed in order, so pass the top level (1) FIRST: a tag named at two
 * levels keeps its first (highest) level, since the PK makes the later INSERT a
 * no-op. Empty `names` at a level contributes nothing.
 */
export function syncLeveledEntityTags(
  kind: EntityKind,
  entityId: string,
  groups: { level: number; names: string[] }[],
  owner: string,
): void {
  deleteEntity.run(kind, entityId);
  for (const g of groups) {
    for (const name of g.names) {
      const norm = normalizeTagName(name);
      if (norm) insertAssoc.run(kind, entityId, resolveTagId(norm, owner), g.level);
    }
  }
}

// ── Tag taxonomy (0036/0043): pattern-tag ▸ intention ───────────────────────

const usedStmt = sqlite.prepare(`SELECT 1 FROM entity_tags WHERE tag_id = ? LIMIT 1`);
/** Has this tag ever been applied to an entity? Used tags can't be deleted. */
export function tagIsUsed(tagId: string): boolean {
  return !!usedStmt.get(tagId);
}

const delDirs = sqlite.prepare(`DELETE FROM tag_patterns WHERE intention_tag_id = ?`);
const insDir = sqlite.prepare(
  `INSERT OR IGNORE INTO tag_patterns (intention_tag_id, pattern_tag_id) VALUES (?, ?)`,
);
/** Replace an intention tag's pattern-tag membership (drag-move = a single target). */
export function setTagDirections(intentionTagId: string, directionTagIds: string[]): void {
  delDirs.run(intentionTagId);
  for (const d of directionTagIds) insDir.run(intentionTagId, d);
}

const dirsOfStmt = sqlite.prepare(
  `SELECT d.name AS name FROM tag_patterns tp
     JOIN tags d ON d.id = tp.pattern_tag_id
    WHERE tp.intention_tag_id = ? ORDER BY d.name`,
);
/** The direction names an intention tag belongs to (empty = Unsorted). */
export function directionsOf(intentionTagId: string): string[] {
  return (dirsOfStmt.all(intentionTagId) as { name: string }[]).map((r) => r.name);
}

// ── Tag taxonomy (0069): intention ▸ category (a SECOND grouping axis) ───────
// Mirror of the tag_patterns membership trio above, on tag_categories.

const delCats = sqlite.prepare(`DELETE FROM tag_categories WHERE intention_tag_id = ?`);
const insCat = sqlite.prepare(
  `INSERT OR IGNORE INTO tag_categories (intention_tag_id, category_tag_id) VALUES (?, ?)`,
);
/** Replace an intention tag's category membership (drag-move = a single target). */
export function setCategoryMemberships(intentionTagId: string, categoryTagIds: string[]): void {
  delCats.run(intentionTagId);
  for (const c of categoryTagIds) insCat.run(intentionTagId, c);
}

const catsOfStmt = sqlite.prepare(
  `SELECT c.name AS name FROM tag_categories tc
     JOIN tags c ON c.id = tc.category_tag_id
    WHERE tc.intention_tag_id = ? ORDER BY c.name`,
);
/** The category names an intention tag belongs to (empty = Unsorted on the Category tab). */
export function categoriesOf(intentionTagId: string): string[] {
  return (catsOfStmt.all(intentionTagId) as { name: string }[]).map((r) => r.name);
}

// ── Category ▸ direction SCOPE (0069), opt-out polarity ──────────────────────
// A row = this pattern (direction) tag is OFF for this category; empty = all on.

const delOptOut = sqlite.prepare(`DELETE FROM category_direction_optouts WHERE category_tag_id = ? AND pattern_tag_id = ?`);
const insOptOut = sqlite.prepare(`INSERT OR IGNORE INTO category_direction_optouts (category_tag_id, pattern_tag_id) VALUES (?, ?)`);
/** Toggle a direction on/off for a category (delete the opt-out row to enable, insert to disable). */
export function setDirectionEnabled(categoryTagId: string, patternTagId: string, enabled: boolean): void {
  if (enabled) delOptOut.run(categoryTagId, patternTagId);
  else insOptOut.run(categoryTagId, patternTagId);
}

const optOutsOfStmt = sqlite.prepare(
  `SELECT p.name AS name FROM category_direction_optouts cdo
     JOIN tags p ON p.id = cdo.pattern_tag_id
    WHERE cdo.category_tag_id = ? ORDER BY p.name`,
);
/** The direction names turned OFF for a category (empty = all directions enabled). */
export function directionOptoutsOf(categoryTagId: string): string[] {
  return (optOutsOfStmt.all(categoryTagId) as { name: string }[]).map((r) => r.name);
}

// A category's references live in time_blocks.category_id + tag_categories — NEITHER of
// which writes entity_tags, so tagIsUsed() (entity_tags-only) does NOT cover categories.
// Owner-correct since T2: a category tag id is owner-unique (UNIQUE(owner_id, name)) and
// block category-validation is owner-scoped, so only its own owner's blocks can reference
// it — callers pass an owner-validated category id (routes/tags.ts 404s a foreign one).
const catRefByBlock = sqlite.prepare(`SELECT 1 FROM time_blocks WHERE category_id = ? LIMIT 1`);
const catRefByMember = sqlite.prepare(`SELECT 1 FROM tag_categories WHERE category_tag_id = ? LIMIT 1`);
/** True if a category tag is assigned to any time block or has any member intention. */
export function categoryIsReferenced(categoryTagId: string): boolean {
  return !!catRefByBlock.get(categoryTagId) || !!catRefByMember.get(categoryTagId);
}
