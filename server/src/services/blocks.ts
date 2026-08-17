import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { store } from '../db/store.js';
import { REFLOW_CANDIDATE_SQL } from '../engine/mobility.js';
import { timeBlocks } from '../db/schema.js';
import { toApi, toApiList, toBlockApi } from '../lib/serialize.js';
import { localISODate } from '../lib/dates.js';
import { serverTimezone, utcDayBounds, localDateInTZ } from '../lib/tz.js';
import { writeAudit } from '../lib/audit.js';
import { stampRow } from '../sync/apply.js';
import { ensurePatternsForRange } from '../engine/patterns-place.js';
import { ensureRecurringBlocksForRange, excludeBlockOccurrence } from '../engine/blocks-recur.js';
import { truncateSeriesFrom } from '../engine/series-scope.js';
import { placeTasksInBlock, type PlaceTasksResult } from '../engine/blocks-place.js';
import { removeEntityTags, splitTagString, syncLeveledEntityTags, entityTagLevels, setEntityCategories, categoryIdsForOwner, entityCategoryNames, entityCategoryNamesByIds } from './tags.js';
import { setEntityPeople, getEntityPeople, getEntityPeopleBulk, type EntityPeople, type PersonRole } from './people.js';
import { getCategoryPrefs } from './category-prefs.js';
import { syncTaskFromBlock, mirrorBlockStatusToTask, applyTaskPlacementStatus, revertTaskPlacementStatus, TERMINAL_BLOCK_STATUS_SQL } from './block-task-sync.js';
import { resolveAutoNestParent } from './auto-nest.js';

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
export async function applyBlockTagLevels(
  ownerId: string,
  blockId: string,
  opts: { tag?: string | null; secondary?: string[] },
): Promise<void> {
  const existing = await entityTagLevels('time_block', blockId);
  const top = opts.tag !== undefined ? splitTagString(opts.tag) : existing.filter((t) => t.level === 1).map((t) => t.name);
  const secondary = opts.secondary !== undefined ? opts.secondary : existing.filter((t) => t.level > 1).map((t) => t.name);
  await syncLeveledEntityTags('time_block', blockId, [
    { level: 1, names: top },
    { level: 2, names: secondary },
  ], ownerId);
}

/** A block's secondary (level>1) tag names, for the read surface. */
export async function secondaryTagsOf(blockId: string): Promise<string[]> {
  return (await entityTagLevels('time_block', blockId)).filter((t) => t.level > 1).map((t) => t.name);
}

/** §A3: the "why now" rationale for a placed block, joined from daily_plan via block_id (null when none). */
export async function rationaleOf(blockId: string): Promise<string | null> {
  const row = await store()
    .prepare(`SELECT rationale FROM daily_plan WHERE block_id = ? LIMIT 1`)
    .get<{ rationale: string | null }>(blockId);
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
    // Awaited as of the patterns-place port — it was the one call site left deliberately
    // sync back in part 8, when the engine was still synchronous. It MUST complete before
    // the select below: it materializes the very rows that select is about to read, so a
    // floated promise would let the day view return without the routines it just placed
    // and only show them on a later refetch.
    await ensurePatternsForRange(ownerId, from, to);
    await ensureRecurringBlocksForRange(ownerId, from, to);
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

/** A block's effective categories: its OWN entity_categories rows, else (task-backed,
 *  none of its own) its task's — the single-row twin of enrichApi's batched derive.
 *  Exported for the GraphQL TimeBlockType.categories resolver (same rule, one home). */
export async function blockCategoryNames(blockId: string, taskId: string | null): Promise<string[]> {
  const own = await entityCategoryNames('time_block', blockId);
  if (own.length || !taskId) return own;
  return await entityCategoryNames('task', taskId);
}

/**
 * A block's effective people: its OWN entity_people rows, else (task-backed, none of
 * its own) its task's — the same derive rule as categories above, for the same reason.
 * An auto-placed block never copies people rows, so re-assigning a task re-labels its
 * blocks with zero engine writes.
 *
 * The two sets derive INDEPENDENTLY: a meeting block can carry its own attendee list
 * while still inheriting who the underlying task is for.
 */
export async function blockPeopleApi(
  blockId: string,
  taskId: string | null,
  pinned: { responsible?: boolean; beneficiaries?: boolean } = {},
): Promise<{ responsible: EntityPeople['responsible']; beneficiaries: EntityPeople['beneficiaries'] }> {
  const own = await getEntityPeople('time_block', blockId);
  // Nothing to inherit FROM, or nothing that could inherit: skip the second read
  // entirely. Restructuring for per-role pins had moved this above the pin checks, so a
  // fully pinned block paid for a lookup whose result was always discarded.
  const canInherit =
    !!taskId &&
    ((!pinned.responsible && !own.responsible.length) || (!pinned.beneficiaries && !own.beneficiaries.length));
  if (!canInherit) return { responsible: own.responsible, beneficiaries: own.beneficiaries };
  const fromTask = await getEntityPeople('task', taskId!);
  // PINNED (0153/0154) means this block's own set for that ROLE is authoritative even
  // when EMPTY — the only way "nobody is on this" can be said at all, since "no rows"
  // otherwise reads as "never set, inherit". Resolved per role so a meeting can carry
  // its own attendees while still inheriting who the underlying task is for.
  const pick = (role: 'responsible' | 'beneficiaries', isPinned: boolean | undefined) =>
    isPinned || own[role].length ? own[role] : fromTask[role];
  return {
    responsible: pick('responsible', pinned.responsible),
    beneficiaries: pick('beneficiaries', pinned.beneficiaries),
  };
}

/**
 * Apply one role's people write to a block, and set that role's pin accordingly.
 *
 * THREE states, which is what the inherit rule needs and a plain array cannot express:
 *   undefined → not mentioned; leave the role exactly as it is
 *   null      → resume INHERITING from the backing task (unpin, and drop own rows)
 *   []        → NOBODY is on this block for this role (pin to empty)
 *   [ids]     → these people (pin)
 *
 * Without the `null` arm a block could be pinned but never un-pinned, so a block that
 * once had people could never go back to tracking its task again.
 */
async function applyBlockRole(
  ownerId: string,
  blockId: string,
  role: PersonRole,
  ids: string[] | null | undefined,
): Promise<boolean> {
  if (ids === undefined) return false;
  const column = role === 'responsible' ? 'responsible_pinned' : 'beneficiaries_pinned';
  await setEntityPeople(ownerId, 'time_block', blockId, role, ids ?? []);
  await store()
    .prepare(`UPDATE time_blocks SET ${column} = ? WHERE id = ? AND owner_id = ?`)
    .run(ids === null ? 0 : 1, blockId, ownerId);
  return true;
}

/** Serialize + enrich raw block rows into the snake_case API dicts (secondary tags +
 *  the "why now" rationale + categories + people). The shared tail of
 *  listBlocks/fetchBlocksForRange. */
async function enrichApi(rows: BlockRow[]): Promise<Record<string, unknown>[]> {
  // Phase B: batched category attach (no N+1), with the derive rule: a block's OWN
  // entity_categories rows win; a task-backed block with none inherits its task's LIVE
  // categories. Auto-placed blocks therefore never copy category rows — they derive,
  // so re-categorizing a task re-stripes its blocks with zero engine writes.
  const ownCats = await entityCategoryNamesByIds('time_block', rows.map((r) => r.id));
  const backingTaskIds = [...new Set(rows.map((r) => r.taskId).filter((t): t is string => t != null))];
  const taskCats = await entityCategoryNamesByIds('task', backingTaskIds);
  // 0151: people attach batched over the whole page, with the same own-else-inherit
  // derive as categories (blockPeopleApi is the single-row twin of this).
  const ownPeople = await getEntityPeopleBulk('time_block', rows.map((r) => r.id));
  const taskPeople = await getEntityPeopleBulk('task', backingTaskIds);
  const source = await externalSourceByBlockId(rows.map((r) => r.id));
  // `rationale` is still a per-row read, so the body has to await. An async `.map`
  // callback would assign a Promise to every field and serialize `{}` — explicit loop.
  const out: Record<string, unknown>[] = [];
  for (const b of toApiList(rows)) {
    const own = ownCats.get(b.id as string);
    const src = source.get(b.id as string);
    const mine = ownPeople.get(b.id as string);
    const theirs = b.task_id ? taskPeople.get(b.task_id as string) : undefined;
    // 0154: per-role — a pinned role never inherits, its own (possibly empty) set wins.
    const inherit = (role: 'responsible' | 'beneficiaries', isPinned: unknown) =>
      (isPinned || mine?.[role].length ? mine?.[role] : theirs?.[role]) ?? [];
    out.push({
      ...b,
      secondary_tags: await secondaryTagsOf(b.id as string),
      rationale: await rationaleOf(b.id as string),
      categories: (own?.length ? own : taskCats.get(b.task_id as string)) ?? [],
      // Each set derives independently — a meeting block may carry its own attendees
      // while still inheriting who the backing task is for.
      responsible: inherit('responsible', b.responsible_pinned),
      beneficiaries: inherit('beneficiaries', b.beneficiaries_pinned),
      // Which connection mirrored this block in, so the client can colour/texture it
      // per source and tell a synced event apart from a local one. null for anything
      // the owner created here. `source_kind` already says 'google', but NOT which
      // account — and per-connection styling is meaningless without the account.
      source_provider: src?.provider ?? null,
      source_account: src?.account ?? null,
    });
  }
  return out;
}

/**
 * Batched block_id → (provider, account) lookup over external_events. One query for the
 * whole page rather than a per-row join, matching how categories are attached above.
 * Blocks with no external row simply don't appear in the map.
 */
async function externalSourceByBlockId(blockIds: string[]): Promise<Map<string, { provider: string; account: string }>> {
  const out = new Map<string, { provider: string; account: string }>();
  if (!blockIds.length) return out;
  // Chunked to stay clear of SQLite's variable limit on very wide ranges.
  const CHUNK = 500;
  for (let i = 0; i < blockIds.length; i += CHUNK) {
    const slice = blockIds.slice(i, i + CHUNK);
    const rows = await store()
      .prepare(
        `SELECT block_id, provider, account FROM external_events
          WHERE block_id IN (${slice.map(() => '?').join(',')})`,
      )
      .all<{ block_id: string; provider: string; account: string }>(...slice);
    for (const r of rows) out.set(r.block_id, { provider: r.provider, account: r.account });
  }
  return out;
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
async function isValidParent(ownerId: string, parentId: string, self?: string): Promise<boolean> {
  if (!parentId || parentId === self) return false;
  return !!(await store()
    .prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ? AND block_kind = 'timeblock' LIMIT 1`)
    .get(parentId, ownerId));
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
  /** LEGACY single category (a tag id). Bridged into `entity_categories` (position 0);
   *  the `time_blocks.category_id` column itself is no longer written (0135). */
  category_id?: string;
  color_token?: string;
  // Phase B (0134/0135): 1–3 category NAMES (array order = position = stripe order).
  // Canonical going forward; wins over the legacy `category_id` when both are sent.
  categories?: string[];
  // Phase B (0135): per-element texture override (omitted ⇒ column defaults).
  texture_enabled?: boolean;
  texture_color_token?: string | null;
  // People on work (0151/0154): person ids, array order = position. Blocks carry BOTH
  // sets natively (entity_people is keyed by entity_kind) — no motivation projection
  // here, that axis is tasks-only. `null` means "inherit from the backing task".
  responsible_ids?: string[] | null;
  beneficiary_ids?: string[] | null;
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
  //
  // Phase B (0135): categories live in `entity_categories` (1–3, position-ordered);
  // the `time_blocks.category_id` column is retired from the write path. The canonical
  // input is `categories` (names); the legacy single `category_id` (an id) bridges to
  // a one-element set with its original validation (invalid_category) intact.
  const hasCat = input.category_id != null && input.category_id !== '';
  if (hasCat) {
    const ok = await store().prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ? AND kind = 'category' LIMIT 1`).get(input.category_id, ownerId);
    if (!ok) return { ok: false, error: 'invalid_category' };
  }
  const categoryIds = input.categories !== undefined
    ? await categoryIdsForOwner(input.categories, ownerId)
    : hasCat ? [input.category_id!] : undefined;
  const colorToken = categoryIds?.length
    ? (input.color_token ?? (await getCategoryPrefs(ownerId))[categoryIds[0]]?.color_token ?? 'primary')
    : undefined;

  // Attach-at-create (PR-C): validated BEFORE the insert, so a bad parent yields a clean
  // `invalid_parent` and no row — rather than the FK throwing mid-insert (a 500), or, as
  // before, the field being silently dropped and the caller told 201 with a null parent.
  if (input.parent_block_id != null && !(await isValidParent(ownerId, input.parent_block_id))) {
    return { ok: false, error: 'invalid_parent' };
  }

  // Auto-nest (Phase 5): a task block created inside a matching Time Block's span
  // becomes its member. Explicit intent always wins — a caller that passes a parent
  // attaches there, and an explicit `parent_block_id: null` means "keep it loose".
  //
  // The opt-in test is `=== undefined`, NOT `'parent_block_id' in input`: the GraphQL
  // mapper (`toSvcCreate`) builds a full object and sets every unsent field to
  // undefined, so a key-presence test would silently disable auto-nest for every
  // GraphQL caller while working fine over REST. The cost is that GraphQL cannot
  // express "definitely loose" — it collapses null to undefined before we see it —
  // which is unchanged from before: both already meant the same thing there.
  //
  // Restricted to timed, scheduled task blocks: containment is a time relation
  // (all-day blocks are off the minute axis), a container cannot nest in a container,
  // and a recurrence template is never rendered.
  const wantsAutoNest =
    input.parent_block_id === undefined &&
    (input.block_kind ?? 'task') === 'task' &&
    !input.all_day &&
    !input.recurrence_rule &&
    input.block_type !== 'someday';
  const autoParent = wantsAutoNest
    ? await resolveAutoNestParent(ownerId, {
        startAt: input.start_at,
        endAt: input.end_at,
        taskId: input.task_id,
        tag: input.tag,
        categories: input.categories,
      })
    : null;

  const [block] = await db
    .insert(timeBlocks)
    .values({
      taskId: input.task_id,
      ownerId,
      title: input.title,
      parentBlockId: input.parent_block_id ?? autoParent,
      blockKind: input.block_kind ?? 'task',
      tag: input.tag,
      // category_id is NOT written (0135 retired it); categories go to entity_categories below.
      colorToken,
      ...(input.texture_enabled !== undefined ? { textureEnabled: input.texture_enabled } : {}),
      ...(input.texture_color_token !== undefined ? { textureColorToken: input.texture_color_token } : {}),
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
    await applyBlockTagLevels(ownerId, block.id, { tag: input.tag, secondary: input.secondary_tags });
  }

  // Phase B: category axis (entity_categories, position-ordered).
  if (categoryIds !== undefined) await setEntityCategories('time_block', block.id, categoryIds);

  // People on work (0151/0154) — position-ordered like categories, pinned PER ROLE so
  // stating a block's attendees never silently stops its beneficiaries inheriting.
  if (await applyBlockRole(ownerId, block.id, 'responsible', input.responsible_ids))
    block.responsiblePinned = input.responsible_ids !== null;
  if (await applyBlockRole(ownerId, block.id, 'beneficiary', input.beneficiary_ids))
    block.beneficiariesPinned = input.beneficiary_ids !== null;

  const out = toBlockApi(block, await secondaryTagsOf(block.id));
  out.categories = await blockCategoryNames(block.id, block.taskId);
  Object.assign(out, await blockPeopleApi(block.id, block.taskId,
    { responsible: !!block.responsiblePinned, beneficiaries: !!block.beneficiariesPinned }));

  // REQ2: a placed task IS scheduled — on create (not just PATCH), mirror the
  // placement onto the task's scheduling-intent fields and flip open → scheduled.
  let syncedTaskId: string | null = null;
  if (block.blockKind === 'task' && block.taskId) {
    await syncTaskFromBlock(block.id, ownerId);
    await applyTaskPlacementStatus(block.taskId, ownerId);
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
  /** LEGACY single category (a tag id; null clears). Bridged into `entity_categories`. */
  category_id: string | null;
  // Phase B: category NAMES. `undefined` = don't touch; `[]` = clear (mirrors tags).
  categories: string[];
  // Phase B (0135): per-element texture override columns.
  texture_enabled: boolean;
  texture_color_token: string | null;
  // People on work (0151/0154). undefined = don't touch; [] = nobody (pins);
  // null = resume inheriting from the backing task (unpins).
  responsible_ids: string[] | null;
  beneficiary_ids: string[] | null;
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
  // instead of 404, an existence oracle across owners).
  if (!(await store().prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(id, ownerId))) {
    return { ok: false, error: 'not_found' };
  }

  // I10: inbound calendar mirrors are authoritative — the owner may not directly
  // edit their title or time. The next sync cycle will overwrite any local change
  // anyway; rejecting here prevents silent drift and a confusing UX. Scoped by
  // owner_id too (defense-in-depth; the ownership check above already gates this).
  //
  // Phase 1 (decision 1): nor may they UNLOCK one. A synced event is L00 — its
  // calendar owns its time and the scheduler only routes around it. The client
  // renders its source in place of a lock toggle, and this makes that a real
  // invariant rather than a UI convention: without it, "cannot be unlocked" would
  // hold only for callers that happen to use our UI. Re-LOCKING stays allowed, since
  // it is a no-op on a row that is already locked.
  if (
    input.title !== undefined || input.start_at !== undefined || input.end_at !== undefined ||
    input.is_locked === false
  ) {
    const isInboundBlock = await store()
      .prepare(`SELECT 1 FROM external_events WHERE block_id = ? AND owner_id = ? AND direction = 'inbound'`)
      .get(id, ownerId);
    if (isInboundBlock) return { ok: false, error: 'inbound_readonly' };
  }

  // AF-4: the 0069 tag-XOR-category partition is relaxed (Phase AD coexist contract —
  // a block may carry a direction tag AND a category). Only the category kind is
  // validated here. (color re-stamp is handled below, only when category_id changes.)
  if (input.category_id != null && input.category_id !== '') {
    const ok = await store().prepare(`SELECT 1 FROM tags WHERE id = ? AND owner_id = ? AND kind = 'category' LIMIT 1`).get(input.category_id, ownerId);
    if (!ok) return { ok: false, error: 'invalid_category' };
  }

  // Attach (PR-C): the same parent rule the create path uses. This closes a real hole —
  // the FK alone let a PATCH point one of your blocks at ANOTHER owner's block (the row
  // exists, so the constraint passed), grafting your tree onto theirs. `null` still
  // detaches, so the Alt-drag pull-out is untouched.
  if (input.parent_block_id != null && !(await isValidParent(ownerId, input.parent_block_id, id))) {
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
  // Phase B (0135): the category write path is entity_categories. The canonical input
  // is `categories` (names); the legacy `category_id` (id / null-to-clear) bridges to a
  // one-element set. Any category-bearing PATCH also NULLs the retired column so the
  // two stores can never diverge, and re-stamps the frozen colour from the FIRST
  // category (an explicit category edit is a deliberate re-assignment — the 0069
  // freeze still protects blocks from category re-colours, not from their own edits).
  const categoryIds = input.categories !== undefined
    ? await categoryIdsForOwner(input.categories, ownerId)
    : input.category_id !== undefined
      ? (input.category_id != null && input.category_id !== '' ? [input.category_id] : [])
      : undefined;
  if (categoryIds !== undefined) {
    update.categoryId = null; // retired column — cleared on touch (0135 backfilled it)
    update.colorToken = categoryIds.length
      ? ((await getCategoryPrefs(ownerId))[categoryIds[0]]?.color_token ?? 'primary')
      : null;
  }
  if (input.texture_enabled !== undefined) update.textureEnabled = input.texture_enabled;
  if (input.texture_color_token !== undefined) update.textureColorToken = input.texture_color_token;
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
    await applyBlockTagLevels(ownerId, id, { tag: input.tag, secondary: input.secondary_tags });
  }

  // Phase B: category axis — `undefined` preserves, `[]` clears (mirrors tags).
  if (categoryIds !== undefined) await setEntityCategories('time_block', id, categoryIds);

  // People on work (0151/0154). Three states, per role: absent preserves, `[]` pins to
  // NOBODY, `null` resumes inheriting from the backing task. An empty array does NOT
  // re-enable inheritance — that ambiguity was the bug 0153 existed to fix.
  if (await applyBlockRole(ownerId, id, 'responsible', input.responsible_ids))
    block.responsiblePinned = input.responsible_ids !== null;
  if (await applyBlockRole(ownerId, id, 'beneficiary', input.beneficiary_ids))
    block.beneficiariesPinned = input.beneficiary_ids !== null;

  // CON-4 series edit: a rule (or anchor) change drops future-or-today instances
  // of this template + their tag rows; GET re-materializes under the new rule.
  if (input.recurrence_rule !== undefined || input.recurrence_dtstart !== undefined) {
    const today = localISODate();
    const dropped = await store()
      .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? AND occurrence_date >= ? AND owner_id = ? RETURNING id`)
      .all<{ id: string }>(id, today, ownerId);
    for (const inst of dropped) {
      await removeEntityTags('time_block', inst.id); // also purges entity_categories (Phase B)
    }
  }

  const out = toBlockApi(block, await secondaryTagsOf(id));
  out.categories = await blockCategoryNames(id, block.taskId);
  Object.assign(out, await blockPeopleApi(id, block.taskId,
    { responsible: !!block.responsiblePinned, beneficiaries: !!block.beneficiariesPinned }));

  // REQ2: a placed task IS scheduled — keep the linked task's scheduling-intent
  // fields (and its done-state) in lockstep with the block. A time change mirrors
  // start → scheduled_for/task_time; a status change mirrors done ⇄ open.
  let syncedTaskId: string | null = null;
  if (input.start_at !== undefined || input.end_at !== undefined) syncedTaskId = await syncTaskFromBlock(id, ownerId);
  if (input.status !== undefined) syncedTaskId = await mirrorBlockStatusToTask(id, ownerId) ?? syncedTaskId;

  // Phase L: stamp version/field_ts for sync versioning (W3.3 — moved IN from the
  // route so a GraphQL updateBlock mutation, which calls the service directly, versions
  // on the same path a REST PATCH does; skipping it would break multi-device sync).
  // Only the success path writes, so there is exactly one stamp site (updateTask's
  // error-path stamp has no analogue here — the guards above all return before any write).
  if (updatedKeys.length > 0) await stampRow('block', id, updatedKeys);

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

  const anchor = await store()
    .prepare(`SELECT id, block_kind, parent_block_id FROM time_blocks WHERE id = ? AND owner_id = ?`)
    .get<{ id: string; block_kind: string; parent_block_id: string | null }>(id, ownerId);
  if (!anchor) return { ok: false, error: 'not_found' };

  // The group's parent: the container itself, the member's parent, or (a loose
  // block) itself alone.
  const parentId = anchor.block_kind === 'timeblock' ? anchor.id : anchor.parent_block_id ?? anchor.id;
  const members = await store()
    .prepare(`SELECT id, start_at, end_at FROM time_blocks WHERE (id = ? OR parent_block_id = ?) AND owner_id = ?`)
    .all<{ id: string; start_at: string; end_at: string }>(parentId, parentId, ownerId);

  const deltaMs = delta * 60_000;
  const shift = (iso: string) => new Date(Date.parse(iso) + deltaMs).toISOString();
  const upd = store().prepare(`UPDATE time_blocks SET start_at = ?, end_at = ? WHERE id = ? AND owner_id = ?`);
  await store().transaction(async () => {
    for (const m of members) {
      // Phase L: same stamp updateBlock does — a group drag is an owner edit, so a queued
      // op holding the pre-drag times must lose LWW rather than snap the group back. Gated
      // on the owner-scoped UPDATE landing (stampRow keys on id alone; see
      // cascadeArchiveToDescendants) even though `members` is already owner-scoped.
      const info = await upd.run(shift(m.start_at), shift(m.end_at), m.id, ownerId);
      if (info.changes > 0) await stampRow('block', m.id, ['startAt', 'endAt']);
    }
  });

  const ids = members.map((m) => m.id);
  const rows = ids.length ? await db.select().from(timeBlocks).where(and(inArray(timeBlocks.id, ids), eq(timeBlocks.ownerId, ownerId))) : [];

  // REQ2: mirror each moved task member's new placement onto its task (non-task
  // members — focus/break/meeting/the container — are skipped by the helper).
  const movedTasks = new Set<string>();
  for (const m of members) { const t = await syncTaskFromBlock(m.id, ownerId); if (t) movedTasks.add(t); }

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
  await stampRow('block', id, ['blockType', 'allDay', 'startAt', 'endAt', 'goalStartDate']);
  const out = toApi(block);
  // REQ2: a promoted concept linked to a task gets concrete times — mirror them.
  const syncedTaskId = await syncTaskFromBlock(id, ownerId);
  writeAudit({ ownerId, actor: 'owner', action: 'promote', entity: `block:${id}` });
  return { ok: true, block, api: out, syncedTaskId };
}

export type DeleteBlockOpts = {
  deleteChildren?: boolean;
  /**
   * Recurring instances only. 'instance' (default) removes just this occurrence via the
   * template's EXDATE — the long-standing behaviour. 'following' additionally truncates
   * the series at this occurrence, so nothing recurs from this day onward. Occurrences
   * BEFORE it are never touched.
   */
  scope?: 'instance' | 'following';
};

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
  if (!(await store().prepare(`SELECT 1 FROM time_blocks WHERE id = ? AND owner_id = ?`).get(id, ownerId))) {
    return { ok: false, error: 'not_found' };
  }

  // REQ2: collect the task ids of every task-block about to be removed (the block
  // itself + cascade-deleted children + recurring instances) BEFORE deletion, so we
  // can return their tasks to the open backlog afterward. This handler isn't
  // transactional, so gather up front.
  const affectedTaskIds = new Set<string>();
  const collectTaskId = async (blockId: string) => {
    const row = await store()
      .prepare(`SELECT task_id, block_kind FROM time_blocks WHERE id = ? AND owner_id = ?`)
      .get<{ task_id: string | null; block_kind: string }>(blockId, ownerId);
    if (row?.task_id && row.block_kind === 'task') affectedTaskIds.add(row.task_id);
  };
  await collectTaskId(id);
  if (opts.deleteChildren) {
    // CON-3 cascade: members are HARD-deleted here — drop their tag rows first.
    const members = await store()
      .prepare(`SELECT id FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`)
      .all<{ id: string }>(id, ownerId);
    for (const m of members) { await collectTaskId(m.id); await removeEntityTags('time_block', m.id); }
    await store().prepare(`DELETE FROM time_blocks WHERE parent_block_id = ? AND owner_id = ?`).run(id, ownerId);
  }
  // CON-4: deleting a recurring template also removes its materialized instances
  // (+ their tag rows) — otherwise orphan instances would linger with a dead parent.
  const droppedInstances = await store()
    .prepare(`DELETE FROM time_blocks WHERE recurrence_parent_id = ? AND owner_id = ? RETURNING id, task_id, block_kind`)
    .all<{ id: string; task_id: string | null; block_kind: string }>(id, ownerId);
  for (const inst of droppedInstances) {
    if (inst.task_id && inst.block_kind === 'task') affectedTaskIds.add(inst.task_id);
    await removeEntityTags('time_block', inst.id);
  }
  const [block] = await db.delete(timeBlocks).where(and(eq(timeBlocks.id, id), eq(timeBlocks.ownerId, ownerId))).returning();
  if (!block) return { ok: false, error: 'not_found' };
  // CON-3 cascade: the block itself is HARD-deleted — drop its tag rows.
  await removeEntityTags('time_block', id);
  // 0074: deleting a lazily-placed recurring-pattern CONTAINER opts that
  // (pattern, local-day) out, so the next GET /api/blocks read won't regenerate
  // it. Without this the marker-based idempotency re-places it immediately and
  // the block can never be removed. Scoped to containers (block_kind='timeblock')
  // — a single child task block deletion is a partial edit, not a day opt-out.
  if (block.sourceKind === 'pattern' && block.blockKind === 'timeblock' && block.sourceRef && block.startAt) {
    const tzRow = await store()
      .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
      .get<{ timezone: string | null }>(ownerId);
    const tz = tzRow?.timezone || serverTimezone();
    await store()
      .prepare(`INSERT OR IGNORE INTO pattern_day_optouts (owner_id, pattern_id, date) VALUES (?, ?, ?)`)
      .run(ownerId, String(block.sourceRef), localDateInTZ(block.startAt, tz));
  }
  // CON-4 sibling of the opt-out above: deleting a recurring Time-Block INSTANCE
  // records its day in the template's EXDATE, so ensureRecurringBlocksForRange
  // won't re-materialize it on the next read. Without this, recurring blocks with
  // no tasks inside (e.g. a "Deep-focus" block) were impossible to delete.
  if (block.recurrenceParentId && block.occurrenceDate) {
    if (opts.scope === 'following') {
      // Truncate the series here. The EXDATE below is still written for THIS day: the
      // bounded rule already excludes it, but the exdate keeps the intent explicit and
      // makes the operation idempotent if the rule is later widened by hand.
      await truncateSeriesFrom(ownerId, 'time_blocks', block.recurrenceParentId, block.occurrenceDate);
    }
    await excludeBlockOccurrence(ownerId, block.recurrenceParentId, block.occurrenceDate);
  }
  // REQ2: a task with no remaining active placement returns to the open backlog.
  const revertedTaskIds: string[] = [];
  for (const taskId of affectedTaskIds) {
    if (await revertTaskPlacementStatus(taskId, ownerId)) revertedTaskIds.push(taskId);
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
export async function clearDayAutoBlocks(ownerId: string, date: string): Promise<ClearDayAutoBlocksResult> {
  const tzRow = await store()
    .prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ timezone?: string }>(ownerId);
  const tz = tzRow?.timezone || serverTimezone();
  // Same day window as clearPriorAuto/dayPlans (utcDayBounds — DST-aware, end is
  // next-day midnight, not start+24h): on a DST-transition day a start+24h window
  // is off by an hour, sweeping the next day's first block or missing the last one.
  const { start: dayStartISO, end: dayEndISO } = utcDayBounds(date, tz);
  const removed = await store()
    .prepare(
      `DELETE FROM time_blocks
        WHERE owner_id = ?
          AND ${REFLOW_CANDIDATE_SQL}
          AND status NOT IN (${TERMINAL_BLOCK_STATUS_SQL})
          AND start_at < ? AND end_at > ?
        RETURNING id, task_id`,
    )
    .all<{ id: string; task_id: string | null }>(ownerId, dayEndISO, dayStartISO);
  for (const r of removed) await removeEntityTags('time_block', r.id);
  // REQ2: a task whose last active placement was just cleared returns to the open
  // backlog — otherwise it's stranded at status='scheduled' with no block.
  const revertedTaskIds: string[] = [];
  for (const taskId of new Set(removed.map((r) => r.task_id).filter((t): t is string => !!t))) {
    if (await revertTaskPlacementStatus(taskId, ownerId)) revertedTaskIds.push(taskId);
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
export async function addTasksToBlock(ownerId: string, id: string, taskIds: string[]): Promise<PlaceTasksResult> {
  const result = await placeTasksInBlock(ownerId, id, taskIds);
  if (result.blocksCreated > 0) {
    writeAudit({ ownerId, actor: 'owner', action: 'add-tasks', entity: `block:${id}` });
  }
  return result;
}
