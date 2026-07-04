import { sqlite } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { writeAudit } from '../lib/audit.js';
import { setCategoryPref } from './category-prefs.js';

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
// W4a: entity_tags.created_at carries a DB-level `NOT NULL DEFAULT CURRENT_TIMESTAMP`
// (migration 0110), so this — and every OTHER insert path (auto-tag, blocks-recur,
// possibles, recall clone, groom) — gets a value automatically without stamping it here.
// That structural default is what guarantees GraphQL's EntityTagType.taggedAt (DateTime!)
// is never null; deliberately NO per-call-site stamp (a partial one is the trap 0110 fixes).
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

// ── GraphQL Taggable forward edge (Phase W · W4a) ─────────────────────────────
// The full EntityTagType shape (id + name + application time) for ONE entity. Returns
// ALL levels — the honest "every tag applied to this entity"; the level distinction is
// planner-internal and EntityTagType doesn't expose it. Deterministically ordered
// (level, name) so the connection is stable. Owner-safe: the caller only resolves this
// on an already-owner-scoped Task/TimeBlock (fetched via getTask/getBlock), so the joined
// tags are that owner's. `created_at` is non-null by construction — migration 0110 gave the
// column a DB-level `NOT NULL DEFAULT CURRENT_TIMESTAMP`, so every insert path fills it; no
// COALESCE and no app-side stamp are needed here.
const selectEntityTagsFull = sqlite.prepare(
  `SELECT tags.id AS tagId, tags.name AS name, entity_tags.created_at AS createdAt
     FROM tags JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = ? AND entity_tags.entity_id = ?
    ORDER BY entity_tags.level, tags.name`,
);
/** Full tag rows for a single entity (GraphQL Taggable). tagId + name + createdAt. */
export function entityTagsFull(
  kind: EntityKind,
  entityId: string,
): { tagId: string; name: string; createdAt: string }[] {
  return selectEntityTagsFull.all(kind, entityId) as { tagId: string; name: string; createdAt: string }[];
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

// ── Tag taxonomy (0036/0043): direction ▸ intention ───────────────────────

const usedStmt = sqlite.prepare(`SELECT 1 FROM entity_tags WHERE tag_id = ? LIMIT 1`);
/** Has this tag ever been applied to an entity? Used tags can't be deleted. */
export function tagIsUsed(tagId: string): boolean {
  return !!usedStmt.get(tagId);
}

const delDirs = sqlite.prepare(`DELETE FROM tag_directions WHERE intention_tag_id = ?`);
const insDir = sqlite.prepare(
  `INSERT OR IGNORE INTO tag_directions (intention_tag_id, direction_tag_id) VALUES (?, ?)`,
);
/** Replace an intention tag's direction membership (drag-move = a single target). */
export function setTagDirections(intentionTagId: string, directionTagIds: string[]): void {
  delDirs.run(intentionTagId);
  for (const d of directionTagIds) insDir.run(intentionTagId, d);
}

const dirsOfStmt = sqlite.prepare(
  `SELECT d.name AS name FROM tag_directions tp
     JOIN tags d ON d.id = tp.direction_tag_id
    WHERE tp.intention_tag_id = ? ORDER BY d.name`,
);
/** The direction names an intention tag belongs to (empty = Unsorted). */
export function directionsOf(intentionTagId: string): string[] {
  return (dirsOfStmt.all(intentionTagId) as { name: string }[]).map((r) => r.name);
}

// ── Tag taxonomy (0069): intention ▸ category (a SECOND grouping axis) ───────
// Mirror of the tag_directions membership trio above, on tag_categories.

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

const delOptOut = sqlite.prepare(`DELETE FROM category_direction_optouts WHERE category_tag_id = ? AND direction_tag_id = ?`);
const insOptOut = sqlite.prepare(`INSERT OR IGNORE INTO category_direction_optouts (category_tag_id, direction_tag_id) VALUES (?, ?)`);
/** Toggle a direction on/off for a category (delete the opt-out row to enable, insert to disable). */
export function setDirectionEnabled(categoryTagId: string, directionTagId: string, enabled: boolean): void {
  if (enabled) delOptOut.run(categoryTagId, directionTagId);
  else insOptOut.run(categoryTagId, directionTagId);
}

const optOutsOfStmt = sqlite.prepare(
  `SELECT p.name AS name FROM category_direction_optouts cdo
     JOIN tags p ON p.id = cdo.direction_tag_id
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

// ── Tag CRUD orchestration (extracted from routes/tags.ts so REST + GraphQL share ONE
//    implementation — no duplicated business logic or owner-scoping; Phase W Decision 3) ──

/** Resolve direction (direction) NAMES to the OWNER's direction ids (skips unknown / non-direction / other owners'). */
function directionIds(names: string[], owner: string): string[] {
  const out: string[] = [];
  const find = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`);
  for (const n of names) {
    const row = find.get(owner, normalizeTagName(n)) as { id: string } | undefined;
    if (row) out.push(row.id);
  }
  return out;
}

/** Resolve category NAMES to the OWNER's category-tag ids (skips unknown / non-category / other owners'). */
function categoryIds(names: string[], owner: string): string[] {
  const out: string[] = [];
  const find = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`);
  for (const n of names) {
    const row = find.get(owner, normalizeTagName(n)) as { id: string } | undefined;
    if (row) out.push(row.id);
  }
  return out;
}

/** Full `tags` row (raw: muted/is_base are 0/1). The shape both REST + GraphQL read. */
export interface FullTagRow {
  id: string;
  owner_id: string;
  name: string;
  kind: string;
  muted: number;
  is_base: number;
}

const ownedTagStmt = sqlite.prepare(`SELECT * FROM tags WHERE id = ? AND owner_id = ?`);
/** Fetch one of the owner's tags (never another owner's), or undefined. */
export function getOwnedTag(owner: string, id: string): FullTagRow | undefined {
  return ownedTagStmt.get(id, owner) as FullTagRow | undefined;
}

export type CreateTagInput = { name?: string; kind?: string; directions?: string[]; categories?: string[] };
export type CreateTagResult = { ok: true; tag: FullTagRow } | { ok: false; error: 'name_required' };

/**
 * Create (or return the existing same-named) tag for an owner, wiring direction/category
 * membership. Identical to the old POST /api/tags body — extracted verbatim so the REST
 * route and the GraphQL createTag mutation cannot drift.
 */
export function createTag(owner: string, input: CreateTagInput): CreateTagResult {
  if (!input.name?.trim()) return { ok: false, error: 'name_required' };
  const name = normalizeTagName(input.name);
  if (!name) return { ok: false, error: 'name_required' };
  const kind = input.kind === 'direction' || input.kind === 'pattern' ? 'direction' : input.kind === 'category' ? 'category' : 'intention';

  let tag = sqlite.prepare(`SELECT * FROM tags WHERE owner_id = ? AND name = ?`).get(owner, name) as FullTagRow | undefined;
  if (!tag) {
    tag = sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (?, ?, ?, ?) RETURNING *`)
      .get(newId(), owner, name, kind) as FullTagRow;
  }
  // A new category gets a default category_prefs row so a block created against it always
  // has a colour-stamp source (forward-only never falls through).
  if (tag.kind === 'category') setCategoryPref(owner, tag.id, {});
  if (tag.kind === 'intention' && Array.isArray(input.directions) && input.directions.length) {
    setTagDirections(tag.id, directionIds(input.directions, owner));
  }
  if (tag.kind === 'intention' && Array.isArray(input.categories) && input.categories.length) {
    setCategoryMemberships(tag.id, categoryIds(input.categories, owner));
  }
  writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `tag:${tag.id}` });
  return { ok: true, tag };
}

export type UpdateTagInput = {
  name?: string;
  muted?: boolean;
  directions?: string[];
  categories?: string[];
  direction_toggle?: { directionTagId?: string; enabled?: boolean };
};
export type UpdateTagResult =
  | { ok: true; tag: { id: string; name: string; kind: string; isBase: number; muted: number } }
  | { ok: false; error: 'not_found' | 'name_conflict' };

/** Update a tag (rename / mute / membership / category-direction toggle). Extracted from
 *  PATCH /api/tags/:id so REST + GraphQL share it. Owner-scoped throughout. */
export function updateTag(owner: string, id: string, patch: UpdateTagInput): UpdateTagResult {
  const tag = sqlite.prepare(`SELECT id, kind FROM tags WHERE id = ? AND owner_id = ?`).get(id, owner) as
    | { id: string; kind: string }
    | undefined;
  if (!tag) return { ok: false, error: 'not_found' };

  if (Array.isArray(patch.directions) && tag.kind === 'intention') {
    setTagDirections(id, directionIds(patch.directions, owner));
  }
  if (Array.isArray(patch.categories) && tag.kind === 'intention') {
    setCategoryMemberships(id, categoryIds(patch.categories, owner));
  }
  if (
    patch.direction_toggle &&
    tag.kind === 'category' &&
    typeof patch.direction_toggle.directionTagId === 'string' &&
    typeof patch.direction_toggle.enabled === 'boolean' &&
    // The toggled pattern tag is a RAW id — verify it's THIS owner's before linking.
    sqlite.prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ?`).get(patch.direction_toggle.directionTagId, owner)
  ) {
    setDirectionEnabled(id, patch.direction_toggle.directionTagId, patch.direction_toggle.enabled);
  }
  if (typeof patch.name === 'string' && patch.name.trim()) {
    const newName = normalizeTagName(patch.name);
    if (newName) {
      const clash = sqlite.prepare(`SELECT 1 FROM tags WHERE owner_id = ? AND name = ? AND id != ?`).get(owner, newName, id);
      if (clash) return { ok: false, error: 'name_conflict' };
      sqlite.prepare(`UPDATE tags SET name = ? WHERE id = ? AND owner_id = ?`).run(newName, id, owner);
    }
  }
  if (typeof patch.muted === 'boolean') {
    sqlite.prepare(`UPDATE tags SET muted = ? WHERE id = ? AND owner_id = ?`).run(patch.muted ? 1 : 0, id, owner);
  }
  const out = sqlite
    .prepare(`SELECT id, name, kind, is_base AS isBase, muted FROM tags WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as { id: string; name: string; kind: string; isBase: number; muted: number };
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `tag:${id}` });
  return { ok: true, tag: out };
}

// 'category_in_use' vs 'in_use' are kept distinct so the REST route can surface its two
// original messages verbatim (category refs live outside entity_tags).
export type DeleteTagResult = { ok: true } | { ok: false; error: 'not_found' | 'base' | 'in_use' | 'category_in_use' };

/** Delete a tag (guarding base + in-use). Extracted from DELETE /api/tags/:id. Owner-scoped. */
export function deleteTag(owner: string, id: string): DeleteTagResult {
  const tag = sqlite.prepare(`SELECT id, kind, is_base AS isBase FROM tags WHERE id = ? AND owner_id = ?`).get(id, owner) as
    | { id: string; kind: string; isBase: number }
    | undefined;
  if (!tag) return { ok: false, error: 'not_found' };
  if (tag.isBase) return { ok: false, error: 'base' };
  if (tag.kind === 'category') {
    if (categoryIsReferenced(id)) return { ok: false, error: 'category_in_use' };
  } else if (tagIsUsed(id)) {
    return { ok: false, error: 'in_use' };
  }
  sqlite.prepare(`DELETE FROM tags WHERE id = ? AND owner_id = ?`).run(id, owner); // tag_directions/categories/optouts cascade via FK
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `tag:${id}` });
  return { ok: true };
}

// ── Relay keyset pagination over the tag taxonomy (Phase W — GraphQL TagType) ──────────
// Each query is owner-scoped, kind-filtered, and ordered by the stable composite key
// (name, id). The caller passes the last-seen (name, id) as the "after" cursor; a first
// page passes ('', '') — every tag name is non-empty (createTag rejects empty), so
// `name > ''` admits all rows. Callers request limit+1 rows to detect a next page.

export interface TagRow {
  id: string;
  name: string;
  kind: string;
  muted: number;
  isBase: number;
}

const KEYSET_COLS = `t.id, t.name, t.kind, t.muted, t.is_base AS isBase`;
const KEYSET_TAIL = `AND (t.name > ? OR (t.name = ? AND t.id > ?)) ORDER BY t.name, t.id LIMIT ?`;

// intention → its parent directions (the direction axis)
const pageParentDirectionsStmt = sqlite.prepare(
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_directions tp ON t.id = tp.direction_tag_id
    WHERE tp.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'direction' ${KEYSET_TAIL}`,
);
const countParentDirectionsStmt = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_directions tp ON t.id = tp.direction_tag_id
    WHERE tp.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'direction'`,
);
// intention → its parent category-tags
const pageParentCategoriesStmt = sqlite.prepare(
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_categories tc ON t.id = tc.category_tag_id
    WHERE tc.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'category' ${KEYSET_TAIL}`,
);
const countParentCategoriesStmt = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_categories tc ON t.id = tc.category_tag_id
    WHERE tc.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'category'`,
);
// direction → its child intentions
const pageDirectionChildrenStmt = sqlite.prepare(
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_directions tp ON t.id = tp.intention_tag_id
    WHERE tp.direction_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention' ${KEYSET_TAIL}`,
);
const countDirectionChildrenStmt = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_directions tp ON t.id = tp.intention_tag_id
    WHERE tp.direction_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention'`,
);
// category-tag → its child intentions
const pageCategoryChildrenStmt = sqlite.prepare(
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_categories tc ON t.id = tc.intention_tag_id
    WHERE tc.category_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention' ${KEYSET_TAIL}`,
);
const countCategoryChildrenStmt = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_categories tc ON t.id = tc.intention_tag_id
    WHERE tc.category_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention'`,
);
// owner's tags (optionally kind-filtered) — the top-level `tags` connection
const pageOwnerTagsStmt = sqlite.prepare(
  `SELECT ${KEYSET_COLS} FROM tags t WHERE t.owner_id = ? ${KEYSET_TAIL}`,
);
const pageOwnerTagsByKindStmt = sqlite.prepare(
  `SELECT ${KEYSET_COLS} FROM tags t WHERE t.owner_id = ? AND t.kind = ? ${KEYSET_TAIL}`,
);
const countOwnerTagsStmt = sqlite.prepare(`SELECT COUNT(*) AS n FROM tags WHERE owner_id = ?`);
const countOwnerTagsByKindStmt = sqlite.prepare(`SELECT COUNT(*) AS n FROM tags WHERE owner_id = ? AND kind = ?`);

const n = (row: unknown) => (row as { n: number }).n;

export function pageParentDirections(intentionId: string, owner: string, afterName: string, afterId: string, limit: number): TagRow[] {
  return pageParentDirectionsStmt.all(intentionId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export function countParentDirections(intentionId: string, owner: string): number {
  return n(countParentDirectionsStmt.get(intentionId, owner));
}
export function pageParentCategories(intentionId: string, owner: string, afterName: string, afterId: string, limit: number): TagRow[] {
  return pageParentCategoriesStmt.all(intentionId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export function countParentCategories(intentionId: string, owner: string): number {
  return n(countParentCategoriesStmt.get(intentionId, owner));
}
export function pageDirectionChildren(directionId: string, owner: string, afterName: string, afterId: string, limit: number): TagRow[] {
  return pageDirectionChildrenStmt.all(directionId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export function countDirectionChildren(directionId: string, owner: string): number {
  return n(countDirectionChildrenStmt.get(directionId, owner));
}
export function pageCategoryChildren(categoryId: string, owner: string, afterName: string, afterId: string, limit: number): TagRow[] {
  return pageCategoryChildrenStmt.all(categoryId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export function countCategoryChildren(categoryId: string, owner: string): number {
  return n(countCategoryChildrenStmt.get(categoryId, owner));
}
export function pageOwnerTags(owner: string, kind: string | undefined, afterName: string, afterId: string, limit: number): TagRow[] {
  return kind
    ? (pageOwnerTagsByKindStmt.all(owner, kind, afterName, afterName, afterId, limit) as TagRow[])
    : (pageOwnerTagsStmt.all(owner, afterName, afterName, afterId, limit) as TagRow[]);
}
export function countOwnerTags(owner: string, kind: string | undefined): number {
  return kind ? n(countOwnerTagsByKindStmt.get(owner, kind)) : n(countOwnerTagsStmt.get(owner));
}

// ── GraphQL reverse tagging edge (Phase W · W4b): TagType.entities ────────────
// The Tasks and TimeBlocks a tag is applied to, over entity_tags — the mirror of the
// W4a forward `tags` edge. Two things this read MUST get right:
//   1. Owner-scoping. entity_tags.entity_id has NO FK and spans task/time_block/routine,
//      so integrity lives in app code (see the header). We do NOT trust that a tag's
//      entity_tags rows point only at the owner's entities: each branch INNER-JOINs the
//      concrete owner-scoped table (tasks/time_blocks) and filters `owner_id`, so a row
//      pointing at another owner's (or a deleted) entity is dropped, not leaked.
//   2. `routine`-kind rows are EXCLUDED — RoutineType doesn't exist until W6, so a
//      routine node would have no GraphQL type. This union is Task ∪ TimeBlock only.
// UNION (not UNION ALL) collapses the duplicate a multi-level tag produces (same tag
// applied at level 1 AND 2 to one entity = one entity here). Stable keyset order is
// (entity_kind, entity_id): 'task' sorts before 'time_block', then uuid7 within a kind.
// `kind` filters to one branch by comparing the passed value inside each branch ('' = all).

export interface EntityRef {
  entityKind: string;
  entityId: string;
}

// The inner owner-scoped union, reused by the page + count statements. Params per branch:
// tagId, owner, kind, kind (the kind gate is `? = '' OR ? = '<branch>'`).
const ENTITIES_UNION = `
  SELECT et.entity_kind AS entityKind, et.entity_id AS entityId
    FROM entity_tags et JOIN tasks t ON t.id = et.entity_id
   WHERE et.tag_id = ? AND et.entity_kind = 'task' AND t.owner_id = ? AND (? = '' OR ? = 'task')
  UNION
  SELECT et.entity_kind, et.entity_id
    FROM entity_tags et JOIN time_blocks b ON b.id = et.entity_id
   WHERE et.tag_id = ? AND et.entity_kind = 'time_block' AND b.owner_id = ? AND (? = '' OR ? = 'time_block')
`;

const pageEntitiesStmt = sqlite.prepare(
  `SELECT entityKind, entityId FROM (${ENTITIES_UNION})
    WHERE (entityKind > ? OR (entityKind = ? AND entityId > ?))
    ORDER BY entityKind, entityId LIMIT ?`,
);
const countEntitiesStmt = sqlite.prepare(`SELECT COUNT(*) AS n FROM (${ENTITIES_UNION})`);

/** One keyset page of the (owner-scoped) entities a tag is applied to. `kind` is the DB
 *  entity_kind ('task' | 'time_block') or '' for both. `after*` is the last-seen
 *  (entity_kind, entity_id); fetch `limit + 1` to detect a next page. */
export function pageEntitiesForTag(
  tagId: string,
  owner: string,
  kind: string,
  afterKind: string,
  afterId: string,
  limit: number,
): EntityRef[] {
  return pageEntitiesStmt.all(
    tagId, owner, kind, kind, // task branch
    tagId, owner, kind, kind, // time_block branch
    afterKind, afterKind, afterId, limit,
  ) as EntityRef[];
}

/** Total (owner-scoped, deduped) entities a tag is applied to, kind-filtered as above. */
export function countEntitiesForTag(tagId: string, owner: string, kind: string): number {
  return n(countEntitiesStmt.get(tagId, owner, kind, kind, tagId, owner, kind, kind));
}
