import { store } from '../db/store.js';
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
 * Reads/writes go through the store facade, so these are async. The 44 statements that
 * used to be prepared at MODULE level are now module-scope SQL strings prepared inside
 * their functions: a module-level `store().prepare` throws "store not initialised" for
 * any module that loads before db/index installs the backend, and whether it does is a
 * function of test import order — so it fails intermittently rather than honestly.
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

const findTag_SQL =
  `SELECT id FROM tags WHERE owner_id = ? AND name = ?`;
const makeTag_SQL =
  `INSERT INTO tags (id, owner_id, name) VALUES (uuid7(), ?, ?) RETURNING id`;
// W4a: entity_tags.created_at carries a DB-level `NOT NULL DEFAULT CURRENT_TIMESTAMP`
// (migration 0110), so this — and every OTHER insert path (auto-tag, blocks-recur,
// possibles, recall clone, groom) — gets a value automatically without stamping it here.
// That structural default is what guarantees GraphQL's EntityTagType.taggedAt (DateTime!)
// is never null; deliberately NO per-call-site stamp (a partial one is the trap 0110 fixes).
const insertAssoc_SQL =
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES (?, ?, ?, ?)`;
const deleteEntity_SQL =
  `DELETE FROM entity_tags WHERE entity_kind = ? AND entity_id = ?`;
const selectNames_SQL =
  `SELECT tags.name FROM tags
     JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = ? AND entity_tags.entity_id = ?
    ORDER BY entity_tags.level, tags.name`;

/**
 * Resolve a tag id by (normalized) name within an owner's namespace, creating the
 * tag for that owner if absent. Owner-scoped since T2: `name` is unique PER-OWNER
 * (UNIQUE(owner_id, name)), so the same name resolves to a DIFFERENT tag per owner.
 */
export async function resolveTagId(name: string, owner: string): Promise<string> {
  const norm = normalizeTagName(name);
  const existing = await store().prepare(findTag_SQL).get(owner, norm) as { id: string } | undefined;
  return existing ? existing.id : (await store().prepare(makeTag_SQL).get(owner, norm) as { id: string }).id;
}

/**
 * Replace an entity's tag set with the given **tag ids** at `level`. The low-level
 * primitive; callers that already hold resolved ids (e.g. the task path, which
 * mirrors `task_tags`) use this to guarantee identical ids across both stores.
 */
export async function setEntityTagIds(kind: EntityKind, entityId: string, tagIds: string[], level = 1): Promise<void> {
  await store().prepare(deleteEntity_SQL).run(kind, entityId);
  for (const tagId of tagIds) await store().prepare(insertAssoc_SQL).run(kind, entityId, tagId, level);
}

/**
 * Replace an entity's tag set with the given **names** at `level` (resolve-or-create
 * each, then replace). Used by the time-block / routine write paths, whose tags
 * arrive as a denormalized string.
 */
export async function syncEntityTags(kind: EntityKind, entityId: string, names: string[], owner: string, level = 1): Promise<void> {
  // Promise.all, not a bare `.map`: resolveTagId is async, so the map yields promises and
  // setEntityTagIds would receive Promise<string>[] where it expects tag ids.
  await setEntityTagIds(kind, entityId, await Promise.all(names.map((n) => resolveTagId(n, owner))), level);
}

/**
 * Remove all of an entity's tag associations — the cascade primitive every HARD
 * delete path must call (soft deletes leave the entity row, so they don't).
 */
const delEntityCatsCleanup_SQL =
  `DELETE FROM entity_categories WHERE entity_kind = ? AND entity_id = ?`;
export async function removeEntityTags(kind: EntityKind, entityId: string): Promise<void> {
  await store().prepare(deleteEntity_SQL).run(kind, entityId);
  // Phase B (0134): entity_categories is the same spans-tables shape as entity_tags,
  // so the hard-delete doctrine above covers BOTH stores through this ONE seam —
  // no delete site can clean tags but orphan categories. (Matches nothing for kinds
  // that never carry categories, e.g. 'routine'.)
  await store().prepare(delEntityCatsCleanup_SQL).run(kind, entityId);
}

/** An entity's associated tag names (level-then-name ordered). */
export async function entityTagNames(kind: EntityKind, entityId: string): Promise<string[]> {
  return (await store().prepare(selectNames_SQL).all(kind, entityId) as { name: string }[]).map((r) => r.name);
}

// ── Task tag read-path (CON-3 finish, Wave 1) ────────────────────────────────
// Tasks have no `.tag` mirror — their tags live in entity_tags. Read **level 1**
// (top-level) so the result exactly matches the dropped `task_tags` set; secondary
// (level>1) tags are Phase-5 only and must not leak into the primary tag list.
// ORDER BY tag_id reproduces the OLD `task_tags` read order: that JOIN was driven by
// the `task_tags` PRIMARY KEY (task_id, tag_id), so it returned tags in tag_id order.
// Preserving it keeps `tags[0]` (the client's "primary" tag — persisted onto dropped
// blocks / saved templates) stable across the read-flip. Do NOT order by name.
const selectTaskNames_SQL =
  `SELECT tags.name FROM tags
     JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = 'task' AND entity_tags.entity_id = ? AND entity_tags.level = 1
    ORDER BY entity_tags.tag_id`;
/** A task's top-level tag names — the read replacing the `task_tags` JOIN. */
export async function taskTagNames(id: string): Promise<string[]> {
  return (await store().prepare(selectTaskNames_SQL).all(id) as { name: string }[]).map((r) => r.name);
}

/** Bound-parameter chunk size — kept well under SQLITE_MAX_VARIABLE_NUMBER (even the legacy 999). */
const TASK_TAG_CHUNK = 500;

/**
 * Batched variant for list endpoints (no N+1). Returns a Map keyed by task id; every
 * requested id is present (empty array if untagged). The IN-list is **chunked** so an
 * unbounded task list can't blow SQLite's bound-parameter limit. Per-task tag order
 * matches `taskTagNames` (tag_id = old PK order).
 */
export async function taskTagNamesByIds(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += TASK_TAG_CHUNK) {
    const chunk = ids.slice(i, i + TASK_TAG_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await store()
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
export async function taskSecondaryTagNamesByIds(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += TASK_TAG_CHUNK) {
    const chunk = ids.slice(i, i + TASK_TAG_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await store()
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

const selectLevels_SQL =
  `SELECT tags.name AS name, entity_tags.level AS level FROM tags
     JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = ? AND entity_tags.entity_id = ?
    ORDER BY entity_tags.level, tags.name`;

/** An entity's tags with their levels (cockpit-v2 Phase 5: top=1, secondary>1). */
export async function entityTagLevels(kind: EntityKind, entityId: string): Promise<{ name: string; level: number }[]> {
  return await store().prepare(selectLevels_SQL).all(kind, entityId) as { name: string; level: number }[];
}

// ── AF-11 (D2) — routine tags DERIVED from member tasks ──────────────────────
// A routine authors NO tags of its own: its displayed tags are the UNION of its
// member tasks' tags (pattern_tasks ⋈ entity_tags ⋈ tags), classified by tag kind.
// Multiple directions per routine are expected and legal (members can span
// directions). Derived at read time — never stored — so a task-tag edit needs no
// fan-out hook to owning routines. Level-agnostic on purpose: classification is
// by tags.kind, so the union is stable across the AF-11 intention level move.

export interface DerivedRoutineTags {
  directions: string[]; // member tags with kind='direction', name-sorted
  intentions: string[]; // member tags with kind='intention', name-sorted
}

/**
 * Batched derived tag union for a set of routines (no N+1 on the list read).
 * Returns a Map keyed by pattern id; every requested id is present (empty arrays
 * when untagged/memberless). Chunked like `taskTagNamesByIds`. Category-kind tags
 * never appear in entity_tags (guarded at every write path), so only direction/
 * intention rows can surface; anything else is dropped defensively.
 */
export async function routineDerivedTagsByIds(ids: string[]): Promise<Map<string, DerivedRoutineTags>> {
  const out = new Map<string, DerivedRoutineTags>();
  for (const id of ids) out.set(id, { directions: [], intentions: [] });
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += TASK_TAG_CHUNK) {
    const chunk = ids.slice(i, i + TASK_TAG_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await store()
      .prepare(
        `SELECT DISTINCT pt.pattern_id AS id, tg.name AS name, tg.kind AS kind
           FROM pattern_tasks pt
           JOIN patterns p ON p.id = pt.pattern_id
           JOIN tasks tk ON tk.id = pt.task_id AND tk.owner_id = p.owner_id
           JOIN entity_tags et ON et.entity_kind = 'task' AND et.entity_id = tk.id
           JOIN tags tg ON tg.id = et.tag_id AND tg.owner_id = p.owner_id
          WHERE pt.pattern_id IN (${placeholders})
          ORDER BY pt.pattern_id, tg.kind, tg.name`,
      )
      .all(...chunk) as { id: string; name: string; kind: string }[];
    for (const r of rows) {
      const bucket = out.get(r.id);
      if (!bucket) continue;
      if (r.kind === 'direction') bucket.directions.push(r.name);
      else if (r.kind === 'intention') bucket.intentions.push(r.name);
    }
  }
  return out;
}

/** Single-routine variant (single reads / mutation responses / SSE payloads). */
export async function routineDerivedTags(patternId: string): Promise<DerivedRoutineTags> {
  return (await routineDerivedTagsByIds([patternId])).get(patternId)!;
}

// ── AD2 — container → task direction inheritance ─────────────────────────────
const taskLevel1DirectionStmt_SQL =
  `SELECT 1 FROM entity_tags et JOIN tags tg ON tg.id = et.tag_id
    WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1
      AND tg.kind = 'direction' AND tg.owner_id = ? LIMIT 1`;
const findDirectionByNameStmt_SQL =
  `SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`;

/** True if the task already carries a level-1 direction tag (a user-set primary direction). */
export async function taskHasLevel1Direction(taskId: string, owner: string): Promise<boolean> {
  return !!await store().prepare(taskLevel1DirectionStmt_SQL).get(taskId, owner);
}

/**
 * AD2 — when a task lands in a direction-tagged container, inherit that direction as the
 * task's level-1 primary UNLESS the task already has one (never override a user's choice).
 * `containerTag` is the container's denormalized `time_blocks.tag` string (base
 * work/home/community). No-op when the tag is empty, resolves to no known direction, or
 * the task already has a level-1 direction. Returns the applied PRIMARY direction NAME so
 * the caller can mirror it onto the created task-block's `tag` column, or null when
 * nothing was inherited.
 *
 * AF-11 (Slice 5) multi-direction guard: a container tag can be a comma-joined union
 * (legacy wizard rows; routine containers stamp only their first derived direction, but
 * legacy data persists). Previously the WHOLE string was normalized and looked up as ONE
 * direction — "work,home" matched nothing and inheritance silently no-opped. Now each
 * split name is resolved: the FIRST known direction becomes the level-1 primary (the
 * task model keeps ONE primary direction), and every subsequent known direction is
 * inherited at level 2 so no direction is dropped.
 */
export async function inheritContainerDirection(
  taskId: string,
  containerTag: string | null | undefined,
  owner: string,
): Promise<string | null> {
  const names = splitTagString(containerTag);
  if (names.length === 0) return null;
  if (await taskHasLevel1Direction(taskId, owner)) return null;
  let primary: string | null = null;
  for (const name of names) {
    const dir = await store().prepare(findDirectionByNameStmt_SQL).get(owner, name) as { id: string } | undefined;
    if (!dir) continue;
    if (primary == null) {
      await store().prepare(insertAssoc_SQL).run('task', taskId, dir.id, 1);
      primary = name;
    } else {
      await store().prepare(insertAssoc_SQL).run('task', taskId, dir.id, 2);
    }
  }
  return primary;
}

/**
 * AF-11 — split tag NAMES by whether they name one of the owner's direction tags.
 * For write paths that receive a FLAT name list (quick-add enrichment) and must level
 * it: known directions → level 1 (the primary axis), everything else — intentions AND
 * brand-new names, which resolve-or-create with the column default kind='intention' —
 * → level 2. Mirrors carryPossibleTags' kind-keyed leveling (services/possibles.ts).
 * Names are matched normalized but returned as given (the sync path normalizes again).
 */
export async function splitNamesByDirection(owner: string, names: string[]): Promise<{ directions: string[]; others: string[] }> {
  const directions: string[] = [];
  const others: string[] = [];
  for (const raw of names) {
    const norm = normalizeTagName(raw);
    if (!norm) continue;
    (await store().prepare(findDirectionByNameStmt_SQL).get(owner, norm) ? directions : others).push(raw);
  }
  return { directions, others };
}

// ── Suggestible vocabulary — ONE definition of "tags we may propose" ─────────

/** The owner's suggestible tag names, split by axis. Every list excludes muted tags. */
export interface TagVocabulary {
  /** kind='direction' — Work / Home / Community. */
  directions: string[];
  /** kind='category' — the six Balance dimensions (entity_categories axis). */
  categories: string[];
  /** Everything else (intentions, and any future kind). */
  others: string[];
}

const selectSuggestibleTags_SQL =
  `SELECT name, kind FROM tags WHERE owner_id = ? AND muted = 0 ORDER BY name`;

/**
 * The tag vocabulary any SUGGESTER may draw from — the quick-add classifier, the
 * Auto-tag sweep, the /suggest-tags endpoint, and the memory enrichment pass.
 *
 * `muted = 0` is the whole point. Muting is the user saying "set this aside": the Tags
 * manager collapses muted tags into a hidden section, and the nightly sweep has always
 * honoured it. Quick-add, /suggest-tags and the wizard's ranking did NOT — so muting a
 * tag stopped the cron applying it while the interactive surfaces kept proposing it, and
 * the same gesture meant different things depending on where you were standing. One
 * query, one meaning.
 *
 * Muting is NOT deletion: existing applications are untouched, an explicitly typed name
 * still resolves, and the taxonomy pickers still list muted tags. This governs only what
 * the app volunteers on its own.
 */
export async function suggestibleVocabulary(owner: string): Promise<TagVocabulary> {
  const rows = await store().prepare(selectSuggestibleTags_SQL).all(owner) as { name: string; kind: string }[];
  return {
    directions: rows.filter((r) => r.kind === 'direction').map((r) => r.name),
    categories: rows.filter((r) => r.kind === 'category').map((r) => r.name),
    others: rows.filter((r) => r.kind !== 'direction' && r.kind !== 'category').map((r) => r.name),
  };
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
const selectEntityTagsFull_SQL =
  `SELECT tags.id AS tagId, tags.name AS name, entity_tags.created_at AS createdAt
     FROM tags JOIN entity_tags ON tags.id = entity_tags.tag_id
    WHERE entity_tags.entity_kind = ? AND entity_tags.entity_id = ?
    ORDER BY entity_tags.level, tags.name`;
/** Full tag rows for a single entity (GraphQL Taggable). tagId + name + createdAt. */
export async function entityTagsFull(
  kind: EntityKind,
  entityId: string,
): Promise<{ tagId: string; name: string; createdAt: string }[]> {
  return await store().prepare(selectEntityTagsFull_SQL).all(kind, entityId) as { tagId: string; name: string; createdAt: string }[];
}

/**
 * Replace an entity's tags across MULTIPLE levels in one shot (Phase 5). `groups`
 * is processed in order, so pass the top level (1) FIRST: a tag named at two
 * levels keeps its first (highest) level, since the PK makes the later INSERT a
 * no-op. Empty `names` at a level contributes nothing.
 */
export async function syncLeveledEntityTags(
  kind: EntityKind,
  entityId: string,
  groups: { level: number; names: string[] }[],
  owner: string,
): Promise<void> {
  await store().prepare(deleteEntity_SQL).run(kind, entityId);
  for (const g of groups) {
    for (const name of g.names) {
      const norm = normalizeTagName(name);
      if (norm) await store().prepare(insertAssoc_SQL).run(kind, entityId, await resolveTagId(norm, owner), g.level);
    }
  }
}

// ── Tag taxonomy (0036/0043): direction ▸ intention ───────────────────────

const usedStmt_SQL =
  `SELECT 1 FROM entity_tags WHERE tag_id = ? LIMIT 1`;
/** Has this tag ever been applied to an entity? Used tags can't be deleted. */
export async function tagIsUsed(tagId: string): Promise<boolean> {
  return !!await store().prepare(usedStmt_SQL).get(tagId);
}

const delDirs_SQL =
  `DELETE FROM tag_directions WHERE intention_tag_id = ?`;
const insDir_SQL =
  `INSERT OR IGNORE INTO tag_directions (intention_tag_id, direction_tag_id) VALUES (?, ?)`;
/** Replace an intention tag's direction membership (drag-move = a single target). */
export async function setTagDirections(intentionTagId: string, directionTagIds: string[]): Promise<void> {
  await store().prepare(delDirs_SQL).run(intentionTagId);
  for (const d of directionTagIds) await store().prepare(insDir_SQL).run(intentionTagId, d);
}

const dirsOfStmt_SQL =
  `SELECT d.name AS name FROM tag_directions tp
     JOIN tags d ON d.id = tp.direction_tag_id
    WHERE tp.intention_tag_id = ? ORDER BY d.name`;
/** The direction names an intention tag belongs to (empty = Unsorted). */
export async function directionsOf(intentionTagId: string): Promise<string[]> {
  return (await store().prepare(dirsOfStmt_SQL).all(intentionTagId) as { name: string }[]).map((r) => r.name);
}

// ── Tag taxonomy (0069): intention ▸ category (a SECOND grouping axis) ───────
// Mirror of the tag_directions membership trio above, on tag_categories.

const delCats_SQL =
  `DELETE FROM tag_categories WHERE intention_tag_id = ?`;
const insCat_SQL =
  `INSERT OR IGNORE INTO tag_categories (intention_tag_id, category_tag_id) VALUES (?, ?)`;
/** Replace an intention tag's category membership (drag-move = a single target). */
export async function setCategoryMemberships(intentionTagId: string, categoryTagIds: string[]): Promise<void> {
  await store().prepare(delCats_SQL).run(intentionTagId);
  for (const c of categoryTagIds) await store().prepare(insCat_SQL).run(intentionTagId, c);
}

const catsOfStmt_SQL =
  `SELECT c.name AS name FROM tag_categories tc
     JOIN tags c ON c.id = tc.category_tag_id
    WHERE tc.intention_tag_id = ? ORDER BY c.name`;
/** The category names an intention tag belongs to (empty = Unsorted on the Category tab). */
export async function categoriesOf(intentionTagId: string): Promise<string[]> {
  return (await store().prepare(catsOfStmt_SQL).all(intentionTagId) as { name: string }[]).map((r) => r.name);
}

// ── Category ▸ direction SCOPE (0069), opt-out polarity ──────────────────────
// A row = this pattern (direction) tag is OFF for this category; empty = all on.

const delOptOut_SQL =
  `DELETE FROM category_direction_optouts WHERE category_tag_id = ? AND direction_tag_id = ?`;
const insOptOut_SQL =
  `INSERT OR IGNORE INTO category_direction_optouts (category_tag_id, direction_tag_id) VALUES (?, ?)`;
/** Toggle a direction on/off for a category (delete the opt-out row to enable, insert to disable). */
export async function setDirectionEnabled(categoryTagId: string, directionTagId: string, enabled: boolean): Promise<void> {
  if (enabled) await store().prepare(delOptOut_SQL).run(categoryTagId, directionTagId);
  else await store().prepare(insOptOut_SQL).run(categoryTagId, directionTagId);
}

const optOutsOfStmt_SQL =
  `SELECT p.name AS name FROM category_direction_optouts cdo
     JOIN tags p ON p.id = cdo.direction_tag_id
    WHERE cdo.category_tag_id = ? ORDER BY p.name`;
/** The direction names turned OFF for a category (empty = all directions enabled). */
export async function directionOptoutsOf(categoryTagId: string): Promise<string[]> {
  return (await store().prepare(optOutsOfStmt_SQL).all(categoryTagId) as { name: string }[]).map((r) => r.name);
}

// A category's references live in time_blocks.category_id + tag_categories — NEITHER of
// which writes entity_tags, so tagIsUsed() (entity_tags-only) does NOT cover categories.
// Owner-correct since T2: a category tag id is owner-unique (UNIQUE(owner_id, name)) and
// block category-validation is owner-scoped, so only its own owner's blocks can reference
// it — callers pass an owner-validated category id (routes/tags.ts 404s a foreign one).
const catRefByBlock_SQL =
  `SELECT 1 FROM time_blocks WHERE category_id = ? LIMIT 1`;
const catRefByMember_SQL =
  `SELECT 1 FROM tag_categories WHERE category_tag_id = ? LIMIT 1`;
const catRefByEntity_SQL =
  `SELECT 1 FROM entity_categories WHERE category_tag_id = ? LIMIT 1`;
/** True if a category tag is assigned to any time block/task or has any member intention. */
export async function categoryIsReferenced(categoryTagId: string): Promise<boolean> {
  return !!await store().prepare(catRefByBlock_SQL).get(categoryTagId) || !!await store().prepare(catRefByMember_SQL).get(categoryTagId) || !!await store().prepare(catRefByEntity_SQL).get(categoryTagId);
}

// ── entity_categories (0134): 1–3 categories per task/time_block, position-ordered ──
// A second multi-select axis (like intentions), kept OUT of entity_tags. `position`
// (0-based, capped at 3 rows) preserves the user's category order → the even-stripe
// texture order. Owner-scoping rides on the caller: it passes category ids already
// validated against the current owner (a foreign id simply never matches on read).

const delEntityCats_SQL =
  `DELETE FROM entity_categories WHERE entity_kind = ? AND entity_id = ?`;
const insEntityCat_SQL =
  `INSERT OR IGNORE INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES (?, ?, ?, ?)`;
/** Replace an entity's category set (max 3, order preserved). Empty array clears it. */
export async function setEntityCategories(entityKind: 'task' | 'time_block', entityId: string, categoryTagIds: string[]): Promise<void> {
  await store().prepare(delEntityCats_SQL).run(entityKind, entityId);
  const seen = new Set<string>();
  let pos = 0;
  for (const id of categoryTagIds) {
    if (pos >= 3 || seen.has(id)) continue;
    seen.add(id);
    await store().prepare(insEntityCat_SQL).run(entityKind, entityId, id, pos++);
  }
}

const entityCatNamesStmt_SQL =
  `SELECT c.name AS name FROM entity_categories ec
     JOIN tags c ON c.id = ec.category_tag_id
    WHERE ec.entity_kind = ? AND ec.entity_id = ? ORDER BY ec.position, c.name`;
/** An entity's category names, in position order (empty = none). */
export async function entityCategoryNames(entityKind: 'task' | 'time_block', entityId: string): Promise<string[]> {
  return (await store().prepare(entityCatNamesStmt_SQL).all(entityKind, entityId) as { name: string }[]).map((r) => r.name);
}

const entityCatIdsStmt_SQL =
  `SELECT category_tag_id AS id FROM entity_categories
    WHERE entity_kind = ? AND entity_id = ? ORDER BY position`;
/** An entity's category tag IDS, in position order (the names twin above). */
export async function entityCategoryIds(entityKind: 'task' | 'time_block', entityId: string): Promise<string[]> {
  return (await store().prepare(entityCatIdsStmt_SQL).all(entityKind, entityId) as { id: string }[]).map((r) => r.id);
}

/**
 * Batched variant for list endpoints (no N+1) — same chunking + Map shape as
 * `taskTagNamesByIds`: every requested id is present (empty array = no categories).
 * Names come back in `position` order (the stripe order).
 */
export async function entityCategoryNamesByIds(entityKind: 'task' | 'time_block', ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += TASK_TAG_CHUNK) {
    const chunk = ids.slice(i, i + TASK_TAG_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await store()
      .prepare(
        `SELECT ec.entity_id AS id, c.name AS name
           FROM entity_categories ec JOIN tags c ON c.id = ec.category_tag_id
          WHERE ec.entity_kind = ? AND ec.entity_id IN (${placeholders})
          ORDER BY ec.entity_id, ec.position, c.name`,
      )
      .all(entityKind, ...chunk) as { id: string; name: string }[];
    for (const r of rows) out.get(r.id)?.push(r.name);
  }
  return out;
}

/** Resolve category NAMES to the owner's category-tag ids (skips unknown / other owners'). */
export async function categoryIdsForOwner(names: string[], owner: string): Promise<string[]> {
  return await categoryIds(names, owner);
}

// ── Tag CRUD orchestration (extracted from routes/tags.ts so REST + GraphQL share ONE
//    implementation — no duplicated business logic or owner-scoping; Phase W Decision 3) ──

/** Resolve direction (direction) NAMES to the OWNER's direction ids (skips unknown / non-direction / other owners'). */
async function directionIds(names: string[], owner: string): Promise<string[]> {
  const out: string[] = [];
  const find = store().prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction'`);
  for (const n of names) {
    const row = await find.get<{ id: string }>(owner, normalizeTagName(n));
    if (row) out.push(row.id);
  }
  return out;
}

/** Resolve category NAMES to the OWNER's category-tag ids (skips unknown / non-category / other owners'). */
async function categoryIds(names: string[], owner: string): Promise<string[]> {
  const out: string[] = [];
  const find = store().prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`);
  for (const n of names) {
    const row = await find.get<{ id: string }>(owner, normalizeTagName(n));
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

const ownedTagStmt_SQL =
  `SELECT * FROM tags WHERE id = ? AND owner_id = ?`;
/** Fetch one of the owner's tags (never another owner's), or undefined. */
export async function getOwnedTag(owner: string, id: string): Promise<FullTagRow | undefined> {
  return await store().prepare(ownedTagStmt_SQL).get(id, owner) as FullTagRow | undefined;
}

export type CreateTagInput = { name?: string; kind?: string; directions?: string[]; categories?: string[] };
export type CreateTagResult = { ok: true; tag: FullTagRow } | { ok: false; error: 'name_required' };

/**
 * Create (or return the existing same-named) tag for an owner, wiring direction/category
 * membership. Identical to the old POST /api/tags body — extracted verbatim so the REST
 * route and the GraphQL createTag mutation cannot drift.
 */
export async function createTag(owner: string, input: CreateTagInput): Promise<CreateTagResult> {
  if (!input.name?.trim()) return { ok: false, error: 'name_required' };
  const name = normalizeTagName(input.name);
  if (!name) return { ok: false, error: 'name_required' };
  const kind = input.kind === 'direction' || input.kind === 'pattern' ? 'direction' : input.kind === 'category' ? 'category' : 'intention';

  let tag = await store().prepare(`SELECT * FROM tags WHERE owner_id = ? AND name = ?`).get(owner, name) as FullTagRow | undefined;
  if (!tag) {
    tag = await store()
      .prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (?, ?, ?, ?) RETURNING *`)
      .get(newId(), owner, name, kind) as FullTagRow;
  }
  // A new category gets a default category_prefs row so a block created against it always
  // has a colour-stamp source (forward-only never falls through).
  if (tag.kind === 'category') setCategoryPref(owner, tag.id, {});
  if (tag.kind === 'intention' && Array.isArray(input.directions) && input.directions.length) {
    await setTagDirections(tag.id, await directionIds(input.directions, owner));
  }
  if (tag.kind === 'intention' && Array.isArray(input.categories) && input.categories.length) {
    await setCategoryMemberships(tag.id, await categoryIds(input.categories, owner));
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
export async function updateTag(owner: string, id: string, patch: UpdateTagInput): Promise<UpdateTagResult> {
  const tag = await store().prepare(`SELECT id, kind FROM tags WHERE id = ? AND owner_id = ?`).get(id, owner) as
    | { id: string; kind: string }
    | undefined;
  if (!tag) return { ok: false, error: 'not_found' };

  if (Array.isArray(patch.directions) && tag.kind === 'intention') {
    await setTagDirections(id, await directionIds(patch.directions, owner));
  }
  if (Array.isArray(patch.categories) && tag.kind === 'intention') {
    await setCategoryMemberships(id, await categoryIds(patch.categories, owner));
  }
  if (
    patch.direction_toggle &&
    tag.kind === 'category' &&
    typeof patch.direction_toggle.directionTagId === 'string' &&
    typeof patch.direction_toggle.enabled === 'boolean' &&
    // The toggled pattern tag is a RAW id — verify it's THIS owner's before linking.
    await store().prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ?`).get(patch.direction_toggle.directionTagId, owner)
  ) {
    await setDirectionEnabled(id, patch.direction_toggle.directionTagId, patch.direction_toggle.enabled);
  }
  if (typeof patch.name === 'string' && patch.name.trim()) {
    const newName = normalizeTagName(patch.name);
    if (newName) {
      const clash = await store().prepare(`SELECT 1 FROM tags WHERE owner_id = ? AND name = ? AND id != ?`).get(owner, newName, id);
      if (clash) return { ok: false, error: 'name_conflict' };
      await store().prepare(`UPDATE tags SET name = ? WHERE id = ? AND owner_id = ?`).run(newName, id, owner);
    }
  }
  if (typeof patch.muted === 'boolean') {
    await store().prepare(`UPDATE tags SET muted = ? WHERE id = ? AND owner_id = ?`).run(patch.muted ? 1 : 0, id, owner);
  }
  const out = await store()
    .prepare(`SELECT id, name, kind, is_base AS isBase, muted FROM tags WHERE id = ? AND owner_id = ?`)
    .get(id, owner) as { id: string; name: string; kind: string; isBase: number; muted: number };
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `tag:${id}` });
  return { ok: true, tag: out };
}

// 'category_in_use' vs 'in_use' are kept distinct so the REST route can surface its two
// original messages verbatim (category refs live outside entity_tags).
export type DeleteTagResult = { ok: true } | { ok: false; error: 'not_found' | 'base' | 'in_use' | 'category_in_use' };

/** Delete a tag (guarding base + in-use). Extracted from DELETE /api/tags/:id. Owner-scoped. */
export async function deleteTag(owner: string, id: string): Promise<DeleteTagResult> {
  const tag = await store().prepare(`SELECT id, kind, is_base AS isBase FROM tags WHERE id = ? AND owner_id = ?`).get(id, owner) as
    | { id: string; kind: string; isBase: number }
    | undefined;
  if (!tag) return { ok: false, error: 'not_found' };
  if (tag.isBase) return { ok: false, error: 'base' };
  if (tag.kind === 'category') {
    if (await categoryIsReferenced(id)) return { ok: false, error: 'category_in_use' };
  } else if (await tagIsUsed(id)) {
    return { ok: false, error: 'in_use' };
  }
  await store().prepare(`DELETE FROM tags WHERE id = ? AND owner_id = ?`).run(id, owner); // tag_directions/categories/optouts cascade via FK
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
const pageParentDirectionsStmt_SQL =
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_directions tp ON t.id = tp.direction_tag_id
    WHERE tp.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'direction' ${KEYSET_TAIL}`;
const countParentDirectionsStmt_SQL =
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_directions tp ON t.id = tp.direction_tag_id
    WHERE tp.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'direction'`;
// intention → its parent category-tags
const pageParentCategoriesStmt_SQL =
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_categories tc ON t.id = tc.category_tag_id
    WHERE tc.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'category' ${KEYSET_TAIL}`;
const countParentCategoriesStmt_SQL =
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_categories tc ON t.id = tc.category_tag_id
    WHERE tc.intention_tag_id = ? AND t.owner_id = ? AND t.kind = 'category'`;
// direction → its child intentions
const pageDirectionChildrenStmt_SQL =
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_directions tp ON t.id = tp.intention_tag_id
    WHERE tp.direction_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention' ${KEYSET_TAIL}`;
const countDirectionChildrenStmt_SQL =
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_directions tp ON t.id = tp.intention_tag_id
    WHERE tp.direction_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention'`;
// category-tag → its child intentions
const pageCategoryChildrenStmt_SQL =
  `SELECT ${KEYSET_COLS} FROM tags t JOIN tag_categories tc ON t.id = tc.intention_tag_id
    WHERE tc.category_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention' ${KEYSET_TAIL}`;
const countCategoryChildrenStmt_SQL =
  `SELECT COUNT(*) AS n FROM tags t JOIN tag_categories tc ON t.id = tc.intention_tag_id
    WHERE tc.category_tag_id = ? AND t.owner_id = ? AND t.kind = 'intention'`;
// owner's tags (optionally kind-filtered) — the top-level `tags` connection
const pageOwnerTagsStmt_SQL =
  `SELECT ${KEYSET_COLS} FROM tags t WHERE t.owner_id = ? ${KEYSET_TAIL}`;
const pageOwnerTagsByKindStmt_SQL =
  `SELECT ${KEYSET_COLS} FROM tags t WHERE t.owner_id = ? AND t.kind = ? ${KEYSET_TAIL}`;
const countOwnerTagsStmt_SQL =
  `SELECT COUNT(*) AS n FROM tags WHERE owner_id = ?`;
const countOwnerTagsByKindStmt_SQL =
  `SELECT COUNT(*) AS n FROM tags WHERE owner_id = ? AND kind = ?`;

const n = (row: unknown) => (row as { n: number }).n;

export async function pageParentDirections(intentionId: string, owner: string, afterName: string, afterId: string, limit: number): Promise<TagRow[]> {
  return await store().prepare(pageParentDirectionsStmt_SQL).all(intentionId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export async function countParentDirections(intentionId: string, owner: string): Promise<number> {
  return n(await store().prepare(countParentDirectionsStmt_SQL).get(intentionId, owner));
}
export async function pageParentCategories(intentionId: string, owner: string, afterName: string, afterId: string, limit: number): Promise<TagRow[]> {
  return await store().prepare(pageParentCategoriesStmt_SQL).all(intentionId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export async function countParentCategories(intentionId: string, owner: string): Promise<number> {
  return n(await store().prepare(countParentCategoriesStmt_SQL).get(intentionId, owner));
}
export async function pageDirectionChildren(directionId: string, owner: string, afterName: string, afterId: string, limit: number): Promise<TagRow[]> {
  return await store().prepare(pageDirectionChildrenStmt_SQL).all(directionId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export async function countDirectionChildren(directionId: string, owner: string): Promise<number> {
  return n(await store().prepare(countDirectionChildrenStmt_SQL).get(directionId, owner));
}
export async function pageCategoryChildren(categoryId: string, owner: string, afterName: string, afterId: string, limit: number): Promise<TagRow[]> {
  return await store().prepare(pageCategoryChildrenStmt_SQL).all(categoryId, owner, afterName, afterName, afterId, limit) as TagRow[];
}
export async function countCategoryChildren(categoryId: string, owner: string): Promise<number> {
  return n(await store().prepare(countCategoryChildrenStmt_SQL).get(categoryId, owner));
}
export async function pageOwnerTags(owner: string, kind: string | undefined, afterName: string, afterId: string, limit: number): Promise<TagRow[]> {
  return kind
    ? (await store().prepare(pageOwnerTagsByKindStmt_SQL).all(owner, kind, afterName, afterName, afterId, limit) as TagRow[])
    : (await store().prepare(pageOwnerTagsStmt_SQL).all(owner, afterName, afterName, afterId, limit) as TagRow[]);
}
export async function countOwnerTags(owner: string, kind: string | undefined): Promise<number> {
  return kind ? n(await store().prepare(countOwnerTagsByKindStmt_SQL).get(owner, kind)) : n(await store().prepare(countOwnerTagsStmt_SQL).get(owner));
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

const pageEntitiesStmt_SQL =
  `SELECT entityKind, entityId FROM (${ENTITIES_UNION})
    WHERE (entityKind > ? OR (entityKind = ? AND entityId > ?))
    ORDER BY entityKind, entityId LIMIT ?`;
const countEntitiesStmt_SQL =
  `SELECT COUNT(*) AS n FROM (${ENTITIES_UNION})`;

/** One keyset page of the (owner-scoped) entities a tag is applied to. `kind` is the DB
 *  entity_kind ('task' | 'time_block') or '' for both. `after*` is the last-seen
 *  (entity_kind, entity_id); fetch `limit + 1` to detect a next page. */
export async function pageEntitiesForTag(
  tagId: string,
  owner: string,
  kind: string,
  afterKind: string,
  afterId: string,
  limit: number,
): Promise<EntityRef[]> {
  return await store().prepare(pageEntitiesStmt_SQL).all(
    tagId, owner, kind, kind, // task branch
    tagId, owner, kind, kind, // time_block branch
    afterKind, afterKind, afterId, limit,
  ) as EntityRef[];
}

/** Total (owner-scoped, deduped) entities a tag is applied to, kind-filtered as above. */
export async function countEntitiesForTag(tagId: string, owner: string, kind: string): Promise<number> {
  return n(await store().prepare(countEntitiesStmt_SQL).get(tagId, owner, kind, kind, tagId, owner, kind, kind));
}
