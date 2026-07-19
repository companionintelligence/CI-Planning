import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { timeBlocks } from '../db/schema.js';
import { toApi, toApiList, toBlockApi } from '../lib/serialize.js';
import { localISODate } from '../lib/dates.js';
import { serverTimezone, zonedWallTimeToUTC, localDateInTZ } from '../lib/tz.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';
import { ensurePatternsForRange } from '../engine/patterns-place.js';
import { ensureRecurringBlocksForRange, excludeBlockOccurrence } from '../engine/blocks-recur.js';
import { placeTasksInBlock, type PlaceTasksResult } from '../engine/blocks-place.js';
import { removeEntityTags, splitTagString, syncLeveledEntityTags, entityTagLevels } from './tags.js';
import { getCategoryPrefs } from './category-prefs.js';
import { syncTaskFromBlock, mirrorBlockStatusToTask, applyTaskPlacementStatus, revertTaskPlacementStatus, TERMINAL_BLOCK_STATUS_SQL } from './block-task-sync.js';

/**
 * Time-Block CRUD orchestration (Phase W step 3.2) — extracted from routes/blocks.ts so
 * REST + GraphQL (the coming TimeBlockType resolver, W3.3) share ONE implementation.
 * Mirrors the services/tasks.ts extraction (W3.1): discriminated results, `writeAudit`
 * inside the service, and side effects the caller still needs to fire — SSE broadcasts
 * and `enqueueOutbound`/`pushOutboundDeletes` — left to the route (each `ok` result
 * carries the row / affected task ids / changed columns the route needs to emit the
 * exact same events as before). Phase-L `stampRow` moved INSIDE updateBlock at W3.3
 * (mirroring updateTask) so the GraphQL mutation versions on the same path.
 * Docs: docs/W-graphql-crud.md (Addendum 2) / docs/W-step3-extraction-audit.md.
 *
 * Every mutator here is OWNER-SCOPED exactly as the routes were (verified clean before
 * extraction — no latent IDOR to fix, unlike W3.1a/W3.1b for tasks): each read/write
 * filters by `(id, owner_id)`, so a cross-owner id resolves to nothing → `not_found`
 * (REST still 404s, unchanged for the legit owner). `blocks-service.test.ts` adds direct
 * regression coverage for this (defense-in-depth — blocks had none before).
 *
 * `applyBlockTagLevels` / `secondaryTagsOf` / `rationaleOf` — the three module-level
 * helpers the route used to keep locally — moved in here (mirrors `applyTaskTagLevels`
 * in services/tasks.ts). `fetchBlocksForRange` (the shared GET + export.ics fetch) moved
 * in too, unchanged, and is exported so the export route can call it directly.
 */

/** A full drizzle `time_blocks` row (camelCase) — the shape `toBlockApi` serializes. */
export type BlockRow = typeof timeBlocks.$inferSelect;

/**
 * cockpit-v2 Phase 5: sync a block's leveled tags. `time_blocks.tag` stays the
 * top-level mirror; secondary tags live only in entity_tags at level 2. A field
 * left `undefined` (a partial PATCH) preserves that level's existing tags.
 */
export function applyBlockTagLevels(
  ownerId: string,
  blockId: string,
  opts: { tag?: string | null; secondary?: string[] },
): void {
  const existing = entityTagLevels('time_block', blockId);
  const top = opts.tag !== undefined ? splitTagString(opts.tag) : existing.filter((t) => t.level === 1).map((t) => t.name);
  const secondary = opts.secondary !== undefined ? opts.secondary : existing.filter((t) => t.level > 1).map((t) => t.name);
  syncLeveledEntityTags('time_block', blockId, [
    { level: 1, names: top },
    { level: 2, names: secondary },
  ], ownerId);
}

/** A block's secondary (level>1) tag names, for the read surface. */
export function secondaryTagsOf(blockId: string): string[] {
  return entityTagLevels('time_block', blockId).filter((t) => t.level > 1).map((t) => t.name);
}

/** §A3: the "why now" rationale for a placed block, joined from daily_plan via block_id (null when none). */
export function rationaleOf(blockId: string): string | null {
  const row = sqlite.prepare(`SELECT rationale FROM daily_plan WHERE block_id = ? LIMIT 1`).get(blockId) as
    | { rationale: string | null }
    | undefined;
  return row?.rationale ?? null;
}

/** The GET /api/blocks query shape. `state='someday'` (no range) returns all someday
 *  Time Blocks regardless of date — the horizon lane reads them this way. */
export type ListBlocksQuery = { from?: string; to?: string; state?: string };

/**
 * Shared read CORE (W3.3): lazily materialize recurring patterns + Time-Block instances
 * for the range, select the owner-scoped rows, and drop recurrence *templates* (rule set,
 * no parent — never rendered directly, CON-4). Returns RAW camelCase drizzle rows.
 *
 * This is the single materialization + template-drop path both the snake_case API reads
 * (`listBlocks`/`fetchBlocksForRange`, which then serialize + enrich) and the camelCase
 * GraphQL reads (`getBlocksForQuery`, feeding the TimeBlockType field resolvers) build on,
 * so the two surfaces can never drift on which rows exist.
 *
 * A full `from`+`to` range (no `state`) materializes patterns AND recurring instances (the
 * historical GET-full-range / .ics-export path); `state`/partial-range reads keep the
 * conditional select without pattern materialization, matching the prior behavior exactly.
 */
async function blockRowsForQuery(ownerId: string, query: ListBlocksQuery): Promise<BlockRow[]> {
  const { from, to, state } = query;

  if (from && to && !state) {
    ensurePatternsForRange(ownerId, from, to);
    ensureRecurringBlocksForRange(ownerId, from, to);
    const fetched = await db.select().from(timeBlocks)
      .where(and(eq(timeBlocks.ownerId, ownerId), gte(timeBlocks.startAt, from), lte(timeBlocks.endAt, to)));
    return fetched.filter((b) => !(b.recurrenceRule && !b.recurrenceParentId));
  }

  const conditions = [eq(timeBlocks.ownerId, ownerId)];
  if (from) conditions.push(gte(timeBlocks.startAt, from));
  if (to) conditions.push(lte(timeBlocks.endAt, to));
  if (state) conditions.push(eq(timeBlocks.blockType, state));

  const fetched = await db.select().from(timeBlocks).where(and(...conditions));
  // CON-4: recurrence *templates* (rule set, no parent) are never rendered — only
  // their materialized instances are. Drop them from the read surface.
  return fetched.filter((b) => !(b.recurrenceRule && !b.recurrenceParentId));
}

/** Serialize + enrich raw block rows into the snake_case API dicts (secondary tags +
 *  the "why now" rationale). The shared tail of listBlocks/fetchBlocksForRange. */
function enrichApi(rows: BlockRow[]): Record<string, unknown>[] {
  return toApiList(rows).map((b) => ({
    ...b,
    secondary_tags: secondaryTagsOf(b.id as string),
    rationale: rationaleOf(b.id as string),
  }));
}

/**
 * Shared block fetch for a date range — the single source of truth for both the JSON
 * read (`GET /api/blocks`) and the `.ics` export, so the two never drift. Lazily
 * materializes recurring patterns + Time-Block instances, selects the range, drops
 * recurrence *templates* (rule set, no parent — never rendered), and enriches with
 * secondary tags + the "why now" rationale.
 */
export async function fetchBlocksForRange(ownerId: string, from: string, to: string): Promise<Record<string, unknown>[]> {
  return enrichApi(await blockRowsForQuery(ownerId, { from, to }));
}

/**
 * List blocks for the range/state query. A full `from`+`to` range (no `state`) shares
 * the pattern/recurrence materialization with the .ics export; `state=someday` and
 * partial-range reads keep the conditional select (CON-2/CON-4 filtering: recurrence
 * templates are dropped, each row enriched with secondary tags + rationale).
 */
export async function listBlocks(ownerId: string, query: ListBlocksQuery): Promise<Record<string, unknown>[]> {
  return enrichApi(await blockRowsForQuery(ownerId, query));
}

/**
 * Owner-scoped camelCase READ surface (Phase W · W3.3c) for the GraphQL TimeBlockType
 * resolvers. Unlike listBlocks (which serializes to snake_case API dicts + enriches with
 * secondary_tags/rationale), these return the RAW camelCase drizzle rows the field
 * resolvers read (blockKind/startAt/parentBlockId/categoryId/taskId) — exactly as
 * getTask does for tasks. Every read filters by owner_id, so a cross-owner id is
 * invisible (getBlock → undefined → resolver null; absent from every listing).
 */

/** A single owned block (camelCase drizzle row). undefined = not found OR not this
 *  owner's — indistinguishable to the caller (no existence leak). */
export async function getBlock(ownerId: string, id: string): Promise<BlockRow | undefined> {
  const [block] = await db.select().from(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, ownerId)));
  return block;
}

/** GraphQL `timeBlocks` connection filters (mirror REST GET /api/blocks). */
export type BlockConnectionQuery = { from?: string; to?: string; state?: string };

/**
 * One keyset page of the owner's blocks for the GraphQL connection AND its totalCount,
 * from a SINGLE materialize pass. Ordered by id ascending — deterministic and stable for
 * pagination (no dupes/skips across pages), though NOT necessarily insertion order:
 * uuid7 is time-ordered across milliseconds but has random within-ms bytes (no monotonic
 * counter — see lib/ids.ts), so same-ms rows sort by those random bytes.
 *
 * Runs the shared materialize → template-drop core ONCE (it has side effects —
 * `ensurePatternsForRange`/`ensureRecurringBlocksForRange` write materialized instances —
 * so page + count must NOT each re-run it), then derives both the page and the total in
 * memory: `totalCount` is the full filtered set size; the page is the `after`-keyset slice
 * of `limit` rows. Pass `limit + 1` so the resolver can report `hasNextPage`. The
 * materialization is range-bounded and small; instances persist with stable ids once
 * materialized (marker-idempotent), so the in-memory sort/slice keeps cursors correct. */
export async function listBlockPage(
  ownerId: string,
  query: BlockConnectionQuery & { after?: string; limit: number },
): Promise<{ rows: BlockRow[]; totalCount: number }> {
  const all = await blockRowsForQuery(ownerId, { from: query.from, to: query.to, state: query.state });
  const ordered = all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const afterFiltered = query.after ? ordered.filter((r) => r.id > query.after!) : ordered;
  return { rows: afterFiltered.slice(0, query.limit), totalCount: ordered.length };
}

/**
 * A block may only hang off a REAL container of YOURS. The self-referential FK
 * (`0023_block_parent`) proves only that the row EXISTS — it does not prove you own it
 * (a cross-owner id would graft your block onto someone else's tree) and it does not
 * prove it can hold children (the Plan-as-container model gives that role to
 * `block_kind = 'timeblock'` alone — `containerAt`/`resolveGroup` only ever treat a
 * timeblock as a parent, so a chip parented to a chip is a state the UI cannot render).
 *
 * `self` excludes a block from parenting itself (only reachable on update; on create the
 * id does not exist yet). Shared by createBlock + updateBlock so create and attach, REST
 * and GraphQL, all answer identically — the create path used to answer nothing at all.
 */
function isValidParent(ownerId: string, parentId: string, self?: string): boolean {
  if (!parentId || parentId === self) return false;
  return !!sqlite
    .prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ? AND block_kind = 'timeblock' LIMIT 1`)
    .get(parentId, ownerId);
}

/** The POST /api/blocks body shape (snake_case API convention). */
export type CreateBlockInput = {
  task_id?: string;
  title: string;
  block_kind?: string;
  tag?: string;
  secondary_tags?: string[];
  block_type?: string;
  goal_start_date?: string;
  duration_minutes?: number;
  note?: string;
  start_at: string;
  end_at: string;
  is_locked?: boolean;
  all_day?: boolean;
  /** Attach to a Plan container in the same call (PR-C). null/absent = loose. */
  parent_block_id?: string | null;
  recurrence_rule?: string;
  recurrence_dtstart?: string;
  category_id?: string;
  color_token?: string;
};

export type CreateBlockResult =
  | { ok: true; block: BlockRow; api: Record<string, unknown>; syncedTaskId: string | null }
  | { ok: false; error: 'missing_fields' }
  | { ok: false; error: 'invalid_category' }
  | { ok: false; error: 'invalid_parent' };

/**
 * Create a time block: insert + tag-level sync + (for a task placement) the REQ2
 * forward sync onto the linked task. Identical to the old POST /api/blocks path,
 * including the frozen color-token stamp.
 */
export async function createBlock(ownerId: string, input: CreateBlockInput): Promise<CreateBlockResult> {
  if (!input.title || !input.start_at || !input.end_at) return { ok: false, error: 'missing_fields' };

  // AF-4: the 0069 tag-XOR-category guard is relaxed — a block may carry a direction
  // tag AND a category simultaneously (the documented Phase AD coexist contract; the
  // split is a convention, not a DB CHECK). color_token remains the forward-only
  // stamp copied from category_prefs at create-time; when both are set, the
  // category-frozen color wins.
  const hasCat = input.category_id != null && input.category_id !== '';
  if (hasCat) {
    const ok = sqlite.prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ? AND kind = 'category' LIMIT 1`).get(input.category_id, ownerId);
    if (!ok) return { ok: false, error: 'invalid_category' };
  }
  const colorToken = hasCat
    ? (input.color_token ?? getCategoryPrefs(ownerId)[input.category_id!]?.color_token ?? 'primary')
    : undefined;

  // Attach-at-create (PR-C): validated BEFORE the insert, so a bad parent yields a clean
  // `invalid_parent` and no row — rather than the FK throwing mid-insert (a 500), or, as
  // before, the field being silently dropped and the caller told 201 with a null parent.
  if (input.parent_block_id != null && !isValidParent(ownerId, input.parent_block_id)) {
    return { ok: false, error: 'invalid_parent' };
  }

  const [block] = await db
    .insert(timeBlocks)
    .values({
      taskId: input.task_id,
      ownerId,
      title: input.title,
      parentBlockId: input.parent_block_id ?? null,
      blockKind: input.block_kind ?? 'task',
      tag: input.tag,
      categoryId: input.category_id,
      colorToken,
      blockType: input.block_type,
      goalStartDate: input.goal_start_date,
      durationMinutes: input.duration_minutes,
      note: input.note,
      startAt: input.start_at,
      endAt: input.end_at,
      isLocked: input.is_locked ?? false,
      allDay: input.all_day ?? false,
      isAuto: false,
      sourceKind: 'manual',
      // CON-4: a recurrence_rule makes this a template (anchor defaults to start_at).
      // It is never rendered directly; GET materializes its instances.
      recurrenceRule: input.recurrence_rule,
      recurrenceDtstart: input.recurrence_rule ? (input.recurrence_dtstart ?? input.start_at) : undefined,
    })
    .returning();

  // CON-3 + Phase 5: mirror the top-level tag string and any secondary tags
  // into the normalized store.
  if (input.tag !== undefined || input.secondary_tags !== undefined) {
    applyBlockTagLevels(ownerId, block.id, { tag: input.tag, secondary: input.secondary_tags });
  }

  const out = toBlockApi(block, secondaryTagsOf(block.id));

  // REQ2: a placed task IS scheduled — on create (not just PATCH), mirror the
  // placement onto the task's scheduling-intent fields and flip open → scheduled.
  let syncedTaskId: string | null = null;
  if (block.blockKind === 'task' && block.taskId) {
    syncTaskFromBlock(block.id, ownerId);
    applyTaskPlacementStatus(block.taskId, ownerId);
    syncedTaskId = block.taskId;
  }

  writeAudit({ ownerId, actor: 'owner', action: 'create', entity: `block:${block.id}` });
  return { ok: true, block, api: out, syncedTaskId };
}

/** The PATCH /api/blocks/:id body shape (snake_case API convention). */
export type UpdateBlockInput = Partial<{
  title: string;
  start_at: string;
  end_at: string;
  is_locked: boolean;
  status: string;
  block_kind: string;
  tag: string | null;
  block_type: string | null;
  goal_start_date: string | null;
  duration_minutes: number | null;
  note: string | null;
  all_day: boolean;
  parent_block_id: string | null;
  secondary_tags: string[];
  recurrence_rule: string | null;
  recurrence_dtstart: string | null;
  category_id: string | null;
}>;

export type UpdateBlockResult =
  | {
      ok: true;
      block: BlockRow;
      api: Record<string, unknown>;
      /** camelCase column names written. Phase-L versioning is stamped INSIDE this
       *  service (W3.3, mirroring updateTask) — the caller no longer stamps. Still
       *  returned so REST/GraphQL callers can see which columns changed. */
      updatedKeys: string[];
      /** Task id synced by the REQ2 forward mirror (time/status change), for the
       *  caller's task:updated broadcast. */
      syncedTaskId: string | null;
    }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'inbound_readonly' }
  | { ok: false; error: 'invalid_category' }
  | { ok: false; error: 'invalid_parent' };

/**
 * Update a block. Carries the full PATCH pipeline extracted from the route: the I10
 * inbound-calendar read-only guard → category validation + color re-stamp
 * → column UPDATE → tag re-sync (partial PATCH preserves unset levels) → CON-4 series
 * re-anchor (drops + lets GET re-materialize future instances) → REQ2 reverse task sync.
 *
 * I10 moved IN from the route (a data-integrity rule, not an HTTP concern — a future
 * GraphQL mutation must hit it too): inbound calendar mirrors are authoritative, so a
 * title/time edit on one is rejected with a discriminated `inbound_readonly` the route
 * maps to its existing 422, byte-identical to before.
 */
export async function updateBlock(ownerId: string, id: string, input: UpdateBlockInput): Promise<UpdateBlockResult> {
  // Ownership FIRST: a cross-owner (or absent) id must resolve to `not_found` before any
  // guard below can run — otherwise the I10 guard leaks a foreign block's existence/state
  // (a title/time edit on someone else's inbound-mirrored block would 422 `inbound_readonly`
  // instead of 404, an existence oracle across owners). This SELECT also fetches
  // category_id for the color re-stamp check below.
  const existing = sqlite.prepare(`SELECT category_id FROM time_blocks WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId) as { category_id: string | null } | undefined;
  if (!existing) return { ok: false, error: 'not_found' };

  // I10: inbound calendar mirrors are authoritative — the owner may not directly
  // edit their title or time. The next sync cycle will overwrite any local change
  // anyway; rejecting here prevents silent drift and a confusing UX. Scoped by
  // owner_id too (defense-in-depth; the ownership check above already gates this).
  if (input.title !== undefined || input.start_at !== undefined || input.end_at !== undefined) {
    const isInboundBlock = sqlite
      .prepare(`SELECT 1 FROM external_events WHERE block_id = ? AND owner_id = ? AND direction = 'inbound'`)
      .get(id, ownerId);
    if (isInboundBlock) return { ok: false, error: 'inbound_readonly' };
  }

  // AF-4: the 0069 tag-XOR-category partition is relaxed (Phase AD coexist contract —
  // a block may carry a direction tag AND a category). Only the category kind is
  // validated here. (color re-stamp is handled below, only when category_id changes.)
  if (input.category_id != null && input.category_id !== '') {
    const ok = sqlite.prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ? AND kind = 'category' LIMIT 1`).get(input.category_id, ownerId);
    if (!ok) return { ok: false, error: 'invalid_category' };
  }

  // Attach (PR-C): the same parent rule the create path uses. This closes a real hole —
  // the FK alone let a PATCH point one of your blocks at ANOTHER owner's block (the row
  // exists, so the constraint passed), grafting your tree onto theirs. `null` still
  // detaches, so the Alt-drag pull-out is untouched.
  if (input.parent_block_id != null && !isValidParent(ownerId, input.parent_block_id, id)) {
    return { ok: false, error: 'invalid_parent' };
  }

  const update: Partial<typeof timeBlocks.$inferInsert> = {};
  if (input.title !== undefined) update.title = input.title;
  if (input.start_at !== undefined) update.startAt = input.start_at;
  if (input.end_at !== undefined) update.endAt = input.end_at;
  // A manual timing change promotes an auto block to manual so clearPriorAuto
  // won't reclaim it on the next Auto Schedule run.
  if (input.start_at !== undefined || input.end_at !== undefined) update.isAuto = false;
  if (input.is_locked !== undefined) update.isLocked = input.is_locked;
  if (input.status !== undefined) update.status = input.status;
  if (input.block_kind !== undefined) update.blockKind = input.block_kind;
  if (input.tag !== undefined) update.tag = input.tag;
  if (input.block_type !== undefined) update.blockType = input.block_type;
  if (input.goal_start_date !== undefined) update.goalStartDate = input.goal_start_date;
  if (input.duration_minutes !== undefined) update.durationMinutes = input.duration_minutes;
  if (input.all_day !== undefined) update.allDay = input.all_day;
  // Attach to / detach from a Plan (PR-C): a number attaches, null detaches.
  if (input.parent_block_id !== undefined) update.parentBlockId = input.parent_block_id;
  // 0069: re-stamp the frozen color ONLY when the category actually changes (a
  // deliberate re-assignment); detaching (null) clears it, a no-op patch keeps it.
  if (input.category_id !== undefined) {
    update.categoryId = input.category_id;
    if (input.category_id !== existing.category_id) {
      update.colorToken = input.category_id != null && input.category_id !== ''
        ? (getCategoryPrefs(ownerId)[input.category_id]?.color_token ?? 'primary')
        : null;
    }
  }
  // CON-4 series edit: changing the rule on a template re-anchors + re-materializes.
  if (input.recurrence_rule !== undefined) {
    update.recurrenceRule = input.recurrence_rule;
    update.recurrenceDtstart = input.recurrence_rule
      ? (input.recurrence_dtstart ?? undefined)
      : null; // clearing the rule turns the template back into a one-off
  } else if (input.recurrence_dtstart !== undefined) {
    update.recurrenceDtstart = input.recurrence_dtstart;
  }

  // A tags-only PATCH (e.g. secondary_tags) has no column changes; drizzle
  // rejects an empty .set(), so fetch the row instead of updating it.
  const updatedKeys = Object.keys(update);
  const [block] = updatedKeys.length
    ? await db.update(timeBlocks).set(update).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, ownerId))).returning()
    : await db.select().from(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, ownerId)));
  if (!block) return { ok: false, error: 'not_found' };

  // CON-3 + Phase 5: keep the normalized store in sync. A partial PATCH that
  // omits `tag` or `secondary_tags` preserves that level (null/'' clears top).
  if (input.tag !== undefined || input.secondary_tags !== undefined) {
    applyBlockTagLevels(ownerId, id, { tag: input.tag, secondary: input.secondary_tags });
  }

  // CON-4 series edit: a rule (or anchor) change drops future-or-today instances
  // of this template + their tag rows; GET re-materializes under the new rule.
  if (input.recurrence_rule !== undefined || input.recurrence_dtstart !== undefined) {
    const today = localISODate();
    for (const inst of sqlite
      .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? AND occurrence_date >= ? AND owner_id = ? RETURNING id`)
      .all(id, today, ownerId) as { id: string }[]) {
      removeEntityTags('time_block', inst.id);
    }
  }

  const out = toBlockApi(block, secondaryTagsOf(id));

  // REQ2: a placed task IS scheduled — keep the linked task's scheduling-intent
  // fields (and its done-state) in lockstep with the block. A time change mirrors
  // start → scheduled_for/task_time; a status change mirrors done ⇄ open.
  let syncedTaskId: string | null = null;
  if (input.start_at !== undefined || input.end_at !== undefined) syncedTaskId = syncTaskFromBlock(id, ownerId);
  if (input.status !== undefined) syncedTaskId = mirrorBlockStatusToTask(id, ownerId) ?? syncedTaskId;

  // Phase L: stamp version/field_ts for sync versioning (W3.3 — moved IN from the
  // route so a GraphQL updateBlock mutation, which calls the service directly, versions
  // on the same path a REST PATCH does; skipping it would break multi-device sync).
  // Only the success path writes, so there is exactly one stamp site (updateTask's
  // error-path stamp has no analogue here — the guards above all return before any write).
  if (updatedKeys.length > 0) stampRow(sqlite, 'block', id, updatedKeys);

  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `block:${id}` });
  return { ok: true, block, api: out, updatedKeys, syncedTaskId };
}

export type MoveBlockGroupResult =
  | { ok: true; blocks: Record<string, unknown>[]; parentId: string; movedTaskIds: string[] }
  | { ok: false; error: 'not_found' };

/**
 * Shift a Plan + all its members by one delta, atomically (PR-C). `id` may be the
 * Plan (block_kind='timeblock') OR any member; the group is resolved the same way.
 * The shift is pure elapsed-ms math on each UTC instant, so it is tz/DST-correct.
 */
export async function moveBlockGroup(ownerId: string, id: string, deltaMinutes: number): Promise<MoveBlockGroupResult> {
  const delta = Math.round(Number(deltaMinutes || 0));

  const anchor = sqlite
    .prepare(`SELECT id, block_kind, parent_block_id FROM time_blocks WHERE id = ? AND owner_id = ?`)
    .get(id, ownerId) as { id: string; block_kind: string; parent_block_id: string | null } | undefined;
  if (!anchor) return { ok: false, error: 'not_found' };

  // The group's parent: the container itself, the member's parent, or (a loose
  // block) itself alone.
  const parentId = anchor.block_kind === 'timeblock' ? anchor.id : anchor.parent_block_id ?? anchor.id;
  const members = sqlite
    .prepare(`SELECT id, start_at, end_at FROM time_blocks WHERE (id = ? OR parent_block_id = ?) AND owner_id = ?`)
    .all(parentId, parentId, ownerId) as { id: string; start_at: string; end_at: string }[];

  const deltaMs = delta * 60_000;
  const shift = (iso: string) => new Date(Date.parse(iso) + deltaMs).toISOString();
  const upd = sqlite.prepare(`UPDATE time_blocks SET start_at = ?, end_at = ? WHERE id = ? AND owner_id = ?`);
  sqlite.transaction(() => {
    for (const m of members) {
      // Phase L: same stamp updateBlock does — a group drag is an owner edit, so a queued
      // op holding the pre-drag times must lose LWW rather than snap the group back. Gated
      // on the owner-scoped UPDATE landing (stampRow keys on id alone; see
      // cascadeArchiveToDescendants) even though `members` is already owner-scoped.
      const info = upd.run(shift(m.start_at), shift(m.end_at), m.id, ownerId);
      if (info.changes > 0) stampRow(sqlite, 'block', m.id, ['startAt', 'endAt']);
    }
  })();

  const ids = members.map((m) => m.id);
  const rows = ids.length ? await db.select().from(timeBlocks).where(and(inArray(timeBlocks.id, ids), eq(timeBlocks.ownerId, ownerId))) : [];

  // REQ2: mirror each moved task member's new placement onto its task (non-task
  // members — focus/break/meeting/the container — are skipped by the helper).
  const movedTasks = new Set<string>();
  for (const m of members) { const t = syncTaskFromBlock(m.id, ownerId); if (t) movedTasks.add(t); }

  writeAudit({ ownerId, actor: 'owner', action: 'update', entity: `block:${parentId}` });
  return { ok: true, blocks: toApiList(rows), parentId, movedTaskIds: [...movedTasks] };
}

export type PromoteBlockInput = { start_at?: string; end_at?: string; all_day?: boolean };

export type PromoteBlockResult =
  | { ok: true; block: BlockRow; api: Record<string, unknown>; syncedTaskId: string | null }
  | { ok: false; error: 'start_at_required' }
  | { ok: false; error: 'not_found' };

/**
 * Turn a Concept into a scheduled Plan. The client supplies the chosen start (and
 * all_day for day-long Plans); end defaults to start + the concept's duration_minutes.
 */
export async function promoteBlockToScheduled(ownerId: string, id: string, input: PromoteBlockInput): Promise<PromoteBlockResult> {
  if (!input.start_at) return { ok: false, error: 'start_at_required' };
  const [existing] = await db.select().from(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, ownerId)));
  if (!existing) return { ok: false, error: 'not_found' };
  const dur = existing.durationMinutes ?? 60;
  const endAt = input.end_at ?? new Date(Date.parse(input.start_at) + dur * 60_000).toISOString();
  const [block] = await db
    .update(timeBlocks)
    .set({ blockType: 'scheduled', allDay: input.all_day ?? false, startAt: input.start_at, endAt, goalStartDate: null })
    .where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, ownerId)))
    .returning();
  // Phase L: every field written here is mergeable, so without the stamp a queued op
  // still holding block_type='concept' would win LWW and un-promote the Plan. The
  // owner-scoped `existing` guard above means this row is ours.
  stampRow(sqlite, 'block', id, ['blockType', 'allDay', 'startAt', 'endAt', 'goalStartDate']);
  const out = toApi(block);
  // REQ2: a promoted concept linked to a task gets concrete times — mirror them.
  const syncedTaskId = syncTaskFromBlock(id, ownerId);
  writeAudit({ ownerId, actor: 'owner', action: 'promote', entity: `block:${id}` });
  return { ok: true, block, api: out, syncedTaskId };
}

export type DeleteBlockOpts = { deleteChildren?: boolean };

export type DeleteBlockResult =
  | { ok: true; block: BlockRow; affectedTaskIds: string[]; revertedTaskIds: string[] }
  | { ok: false; error: 'not_found' };

/**
 * Delete a block. Default: detaches its members (FK ON DELETE SET NULL) — they
 * survive as loose task blocks. `deleteChildren`: removes the members too (PR-C:
 * the "remove tasks" choice in the delete-Plan confirm dialog).
 *
 * NOTE: `pushOutboundDeletes` (the remote-delete push, which must run BEFORE the
 * block + its external_events rows are CASCADE-removed) stays in the route — same
 * reasoning as `broadcast`/`enqueueOutbound` (the brief's side-effect placement).
 * The route calls it before this function, exactly as the original handler did.
 */
export async function deleteBlock(ownerId: string, id: string, opts: DeleteBlockOpts = {}): Promise<DeleteBlockResult> {
  // Verify ownership before any side effects (e.g. remote deletes) — the route
  // checks this first via the same query before calling pushOutboundDeletes; this
  // internal existence check ensures the function itself is safe called standalone.
  if (!sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(id, ownerId)) {
    return { ok: false, error: 'not_found' };
  }

  // REQ2: collect the task ids of every task-block about to be removed (the block
  // itself + cascade-deleted children + recurring instances) BEFORE deletion, so we
  // can return their tasks to the open backlog afterward. This handler isn't
  // transactional, so gather up front.
  const affectedTaskIds = new Set<string>();
  const collectTaskId = (blockId: string) => {
    const row = sqlite
      .prepare(`SELECT task_id, block_kind FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get(blockId, ownerId) as { task_id: string | null; block_kind: string } | undefined;
    if (row?.task_id && row.block_kind === 'task') affectedTaskIds.add(row.task_id);
  };
  collectTaskId(id);
  if (opts.deleteChildren) {
    // CON-3 cascade: members are HARD-deleted here — drop their tag rows first.
    const members = sqlite
      .prepare(`SELECT id FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`)
      .all(id, ownerId) as { id: string }[];
    for (const m of members) { collectTaskId(m.id); removeEntityTags('time_block', m.id); }
    sqlite.prepare(`DELETE FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`).run(id, ownerId);
  }
  // CON-4: deleting a recurring template also removes its materialized instances
  // (+ their tag rows) — otherwise orphan instances would linger with a dead parent.
  for (const inst of sqlite
    .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? AND owner_id = ? RETURNING id, task_id, block_kind`)
    .all(id, ownerId) as { id: string; task_id: string | null; block_kind: string }[]) {
    if (inst.task_id && inst.block_kind === 'task') affectedTaskIds.add(inst.task_id);
    removeEntityTags('time_block', inst.id);
  }
  const [block] = await db.delete(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, ownerId))).returning();
  if (!block) return { ok: false, error: 'not_found' };
  // CON-3 cascade: the block itself is HARD-deleted — drop its tag rows.
  removeEntityTags('time_block', id);
  // 0074: deleting a lazily-placed recurring-pattern CONTAINER opts that
  // (pattern, local-day) out, so the next GET /api/blocks read won't regenerate
  // it. Without this the marker-based idempotency re-places it immediately and
  // the block can never be removed. Scoped to containers (block_kind='timeblock')
  // — a single child task block deletion is a partial edit, not a day opt-out.
  if (block.sourceKind === 'pattern' && block.blockKind === 'timeblock' && block.sourceRef && block.startAt) {
    const tz = (sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(ownerId) as { timezone: string | null } | undefined)?.timezone || serverTimezone();
    sqlite
      .prepare(`INSERT OR IGNORE INTO pattern_day_optouts (owner_id, pattern_id, date) VALUES (?, ?, ?)`)
      .run(ownerId, String(block.sourceRef), localDateInTZ(block.startAt, tz));
  }
  // CON-4 sibling of the opt-out above: deleting a recurring Time-Block INSTANCE
  // records its day in the template's EXDATE, so ensureRecurringBlocksForRange
  // won't re-materialize it on the next read. Without this, recurring blocks with
  // no tasks inside (e.g. a "Deep-focus" block) were impossible to delete.
  if (block.recurrenceParentId && block.occurrenceDate) {
    excludeBlockOccurrence(ownerId, block.recurrenceParentId, block.occurrenceDate);
  }
  // REQ2: a task with no remaining active placement returns to the open backlog.
  const revertedTaskIds: string[] = [];
  for (const taskId of affectedTaskIds) {
    if (revertTaskPlacementStatus(taskId, ownerId)) revertedTaskIds.push(taskId);
  }
  writeAudit({ ownerId, actor: 'owner', action: 'delete', entity: `block:${id}` });
  return { ok: true, block, affectedTaskIds: [...affectedTaskIds], revertedTaskIds };
}

export type ClearDayAutoBlocksResult = { removedCount: number; revertedTaskIds: string[] };

/**
 * Clear the day's AUTO-PLACED task blocks only. The predicate mirrors clearPriorAuto
 * (engine/autoplan.ts): only our own agent auto placements (`is_auto=1
 * AND is_locked=0 AND block_kind='task' AND source_kind='agent'`) that are not in a
 * terminal status ([[TERMINAL_BLOCK_STATUS_SQL]] — the shared vocabulary in
 * services/block-task-sync.ts). It therefore preserves — by construction —
 * user-placed blocks (is_auto=0 / source 'manual'), locked blocks, calendar meeting
 * mirrors (block_kind!='task'), pattern/habit placements (source_kind!='agent'),
 * and every terminal occurrence: completed/skipped outcomes AND the
 * cancelled/missed evidence the review surface reads (Phase AE status-vocabulary
 * alignment, docs/AE-reflow-correctness.md).
 */
export function clearDayAutoBlocks(ownerId: string, date: string): ClearDayAutoBlocksResult {
  const tzRow = sqlite
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get(ownerId) as { timezone?: string } | undefined;
  const tz = tzRow?.timezone || serverTimezone();
  const dayStartISO = zonedWallTimeToUTC(date, '00:00', tz);
  const dayEndISO = new Date(Date.parse(dayStartISO) + 24 * 60 * 60_000).toISOString();
  const removed = sqlite
    .prepare(
      `DELETE FROM time_blocks
        WHERE owner_id = ?
          AND is_auto = 1 AND is_locked = 0 AND block_kind = 'task' AND source_kind = 'agent'
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
          AND start_at < ? AND end_at > ?
        RETURNING id, task_id`,
    )
    .all(ownerId, dayEndISO, dayStartISO) as { id: string; task_id: string | null }[];
  for (const r of removed) removeEntityTags('time_block', r.id);
  // REQ2: a task whose last active placement was just cleared returns to the open
  // backlog — otherwise it's stranded at status='scheduled' with no block.
  const revertedTaskIds: string[] = [];
  for (const taskId of new Set(removed.map((r) => r.task_id).filter((t): t is string => !!t))) {
    if (revertTaskPlacementStatus(taskId, ownerId)) revertedTaskIds.push(taskId);
  }
  writeAudit({ ownerId, actor: 'owner', action: 'clear-day', entity: `day:${date}` });
  return { removedCount: removed.length, revertedTaskIds };
}

/**
 * Attach existing tasks to a Time-Block container, scattering them into its free
 * time as child blocks (parent_block_id set). Thin wrapper over the engine's
 * `placeTasksInBlock` (which already broadcasts its own `block:created` — see that
 * file) that adds the audit entry, gated on at least one block actually created,
 * exactly as the route did.
 */
export function addTasksToBlock(ownerId: string, id: string, taskIds: string[]): PlaceTasksResult {
  const result = placeTasksInBlock(ownerId, id, taskIds);
  if (result.blocksCreated > 0) {
    writeAudit({ ownerId, actor: 'owner', action: 'add-tasks', entity: `block:${id}` });
  }
  return result;
}
