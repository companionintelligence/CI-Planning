import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { personToGraphql } from './people-resolvers.js';
import { broadcast } from '../routes/sse.js';
import { enqueueOutbound, pushOutboundDeletes } from '../agents/sync.js';
import { getTask } from '../services/tasks.js';
import { getOwnedTag, entityTagsFull, entityCategoryIds } from '../services/tags.js';
import {
  createBlock as createBlockService,
  updateBlock as updateBlockService,
  deleteBlock as deleteBlockService,
  moveBlockGroup as moveBlockGroupService,
  promoteBlockToScheduled as promoteBlockToScheduledService,
  getBlock, listBlockPage, blockCategoryNames, blockPeopleApi,
  type BlockRow, type CreateBlockInput as SvcCreateInput, type UpdateBlockInput as SvcUpdateInput,
} from '../services/blocks.js';
import { toNode } from './tag-resolvers.js';
import { clampFirst, decodeIdCursor, buildIdConnection } from './pagination.js';

/**
 * TimeBlockType resolvers (Phase W · W3.3c). Every resolver reuses services/blocks.ts
 * (Decision 3): the CRUD mutations call the SAME functions the REST /api/blocks routes
 * call, and the reads go through the owner-scoped getBlock/listBlockRows added for this
 * ticket. Owner-scoping is read from `currentOwnerId()` (bound by requireAuth), NEVER
 * trusted from the client — a cross-owner id is invisible (getBlock → undefined → null).
 *
 * The mutation resolvers reproduce the REST side-effect envelope exactly (routes/
 * blocks.ts): the same broadcast(...) events (block:created/updated/deleted + task:updated
 * for synced tasks) with the same payloads, and enqueueOutbound(id) on create/update.
 * Phase-L `stampRow` now lives INSIDE updateBlock (W3.3c commit 1), so the update
 * mutation versions on the same path a REST PATCH does — no stamping here.
 */
type ConnArgs = { first?: number | null; after?: string | null };

// DateTime inputs (startAt/endAt/…) arrive as normalized ISO-8601 strings — the DateTime
// scalar's parseValue/parseLiteral normalizes them (see graphql/scalars.ts), so resolvers
// hand them straight to the services (which store ISO-string TEXT columns).

/** Map a camelCase GraphQL CreateTimeBlockInput to the service's snake_case CreateBlockInput. */
function toSvcCreate(input: Record<string, unknown>): SvcCreateInput {
  return {
    title: input.title as string,
    task_id: input.taskId == null ? undefined : (input.taskId as string),
    block_kind: input.blockKind == null ? undefined : (input.blockKind as string),
    tag: input.tag == null ? undefined : (input.tag as string),
    secondary_tags: input.secondaryTags == null ? undefined : (input.secondaryTags as string[]),
    block_type: input.blockType == null ? undefined : (input.blockType as string),
    goal_start_date: input.goalStartDate == null ? undefined : (input.goalStartDate as string),
    duration_minutes: input.durationMinutes == null ? undefined : (input.durationMinutes as number),
    note: input.note == null ? undefined : (input.note as string),
    start_at: input.startAt as string,
    end_at: input.endAt as string,
    is_locked: input.isLocked == null ? undefined : (input.isLocked as boolean),
    all_day: input.allDay == null ? undefined : (input.allDay as boolean),
    parent_block_id: input.parentBlockId == null ? undefined : (input.parentBlockId as string),
    recurrence_rule: input.recurrenceRule == null ? undefined : (input.recurrenceRule as string),
    recurrence_dtstart: input.recurrenceDtstart == null ? undefined : (input.recurrenceDtstart as string),
    category_id: input.categoryId == null ? undefined : (input.categoryId as string),
    categories: input.categories == null ? undefined : (input.categories as string[]),
    color_token: input.colorToken == null ? undefined : (input.colorToken as string),
    texture_enabled: input.textureEnabled == null ? undefined : (input.textureEnabled as boolean),
    texture_color_token: input.textureColorToken == null ? undefined : (input.textureColorToken as string),
  };
}

/** Map a camelCase GraphQL UpdateTimeBlockInput to the service's UpdateBlockInput. Only
 *  keys the client actually sent are forwarded (an absent key stays absent = PATCH-preserve;
 *  an explicit null clears a nullable column, exactly as the REST PATCH body does). */
function toSvcUpdate(input: Record<string, unknown>): SvcUpdateInput {
  const out: SvcUpdateInput = {};
  if ('title' in input) {
    if (input.title === null) throw new GraphQLError('title cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.title = input.title as string;
  }
  if ('startAt' in input) {
    if (input.startAt === null) throw new GraphQLError('startAt cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.start_at = input.startAt as string;
  }
  if ('endAt' in input) {
    if (input.endAt === null) throw new GraphQLError('endAt cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.end_at = input.endAt as string;
  }
  // Non-nullable columns: an explicit null is rejected (not silently skipped), matching
  // TaskType's discipline for title/status/priority. `false` is a legitimate boolean value
  // and passes; only `null` errors.
  if ('isLocked' in input) {
    if (input.isLocked === null) throw new GraphQLError('isLocked cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.is_locked = input.isLocked as boolean;
  }
  if ('status' in input) {
    if (input.status === null) throw new GraphQLError('status cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.status = input.status as string;
  }
  if ('blockKind' in input) {
    if (input.blockKind === null) throw new GraphQLError('blockKind cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.block_kind = input.blockKind as string;
  }
  if ('tag' in input) out.tag = input.tag as string | null;
  if ('blockType' in input) out.block_type = input.blockType as string | null;
  if ('goalStartDate' in input) out.goal_start_date = input.goalStartDate as string | null;
  if ('durationMinutes' in input) out.duration_minutes = input.durationMinutes as number | null;
  if ('note' in input) out.note = input.note as string | null;
  if ('allDay' in input) {
    if (input.allDay === null) throw new GraphQLError('allDay cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.all_day = input.allDay as boolean;
  }
  if ('parentBlockId' in input) out.parent_block_id = input.parentBlockId as string | null;
  if ('secondaryTags' in input && input.secondaryTags != null) out.secondary_tags = input.secondaryTags as string[];
  if ('recurrenceRule' in input) out.recurrence_rule = input.recurrenceRule as string | null;
  if ('recurrenceDtstart' in input) out.recurrence_dtstart = input.recurrenceDtstart as string | null;
  if ('categoryId' in input) out.category_id = input.categoryId as string | null;
  // Phase B: categories NAMES (absent preserves; [] clears). null is treated as absent —
  // clearing is expressed by [], matching the REST body contract.
  if ('categories' in input && input.categories != null) out.categories = input.categories as string[];
  if ('textureEnabled' in input) {
    if (input.textureEnabled === null) throw new GraphQLError('textureEnabled cannot be null', { extensions: { code: 'BAD_USER_INPUT' } });
    out.texture_enabled = input.textureEnabled as boolean;
  }
  if ('textureColorToken' in input) out.texture_color_token = input.textureColorToken as string | null;
  return out;
}

export const blockResolvers = {
  Query: {
    timeBlock: async (_p: unknown, args: { id: string }) => {
      return (await getBlock(currentOwnerId(), args.id)) ?? null;
    },
    timeBlocks: async (
      _p: unknown,
      args: ConnArgs & { from?: string | null; to?: string | null; state?: string | null },
    ) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const after = decodeIdCursor(args.after);
      const q = { from: args.from ?? undefined, to: args.to ?? undefined, state: args.state ?? undefined };
      // Single materialize pass: page + totalCount from one service call (materialization
      // has side effects — must not run twice per query).
      const { rows, totalCount } = await listBlockPage(owner, { ...q, after: after || undefined, limit: limit + 1 });
      return buildIdConnection(rows, limit, totalCount);
    },
  },

  Mutation: {
    createTimeBlock: async (_p: unknown, args: { input: Record<string, unknown> }) => {
      const owner = currentOwnerId();
      const res = await createBlockService(owner, toSvcCreate(args.input));
      if (!res.ok) {
        if (res.error === 'missing_fields') throw new GraphQLError('title, startAt, and endAt are required', { extensions: { code: 'BAD_USER_INPUT' } });
        if (res.error === 'invalid_parent') throw new GraphQLError('parentBlockId must reference one of your Time Blocks', { extensions: { code: 'BAD_USER_INPUT' } });
        throw new GraphQLError('categoryId must reference a category tag', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      broadcast(owner, 'block:created', res.api);
      if (res.syncedTaskId) broadcast(owner, 'task:updated', { id: res.syncedTaskId });
      await enqueueOutbound(res.block.id);
      return { timeBlock: res.block, success: true };
    },

    updateTimeBlock: async (_p: unknown, args: { input: Record<string, unknown> & { id: string } }) => {
      const owner = currentOwnerId();
      const res = await updateBlockService(owner, args.input.id, toSvcUpdate(args.input));
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('block not found', { extensions: { code: 'NOT_FOUND' } });
        if (res.error === 'inbound_readonly') throw new GraphQLError('Calendar meeting blocks are read-only — edit the event in Google Calendar', { extensions: { code: 'CONFLICT' } });
        if (res.error === 'invalid_parent') throw new GraphQLError('parentBlockId must reference one of your Time Blocks', { extensions: { code: 'BAD_USER_INPUT' } });
        throw new GraphQLError('categoryId must reference a category tag', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      // stampRow already fired inside updateBlock (W3.3c commit 1).
      broadcast(owner, 'block:updated', res.api);
      if (res.syncedTaskId) broadcast(owner, 'task:updated', { id: res.syncedTaskId });
      await enqueueOutbound(args.input.id);
      return { timeBlock: res.block, success: true };
    },

    moveBlockGroup: async (_p: unknown, args: { input: { id: string; deltaMinutes: number } }) => {
      const owner = currentOwnerId();
      const res = await moveBlockGroupService(owner, args.input.id, args.input.deltaMinutes);
      if (!res.ok) throw new GraphQLError('block not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'block:updated', { moved_group: res.parentId, count: res.blocks.length });
      for (const t of res.movedTaskIds) broadcast(owner, 'task:updated', { id: t });
      // Re-read the moved rows as camelCase so the payload's TimeBlockType field resolvers
      // work (moveBlockGroup returns snake_case api dicts for REST); owner-scoped.
      const nodes = (await Promise.all(res.blocks.map((b) => getBlock(owner, b.id as string)))).filter((b): b is BlockRow => !!b);
      return { timeBlocks: nodes, parentId: res.parentId, success: true };
    },

    promoteBlockToScheduled: async (_p: unknown, args: { input: { id: string; startAt: string; endAt?: string | null; allDay?: boolean | null } }) => {
      const owner = currentOwnerId();
      const res = await promoteBlockToScheduledService(owner, args.input.id, {
        start_at: args.input.startAt,
        end_at: args.input.endAt ?? undefined,
        all_day: args.input.allDay ?? undefined,
      });
      if (!res.ok) {
        if (res.error === 'start_at_required') throw new GraphQLError('startAt is required to promote', { extensions: { code: 'BAD_USER_INPUT' } });
        throw new GraphQLError('block not found', { extensions: { code: 'NOT_FOUND' } });
      }
      broadcast(owner, 'block:updated', res.api);
      if (res.syncedTaskId) broadcast(owner, 'task:updated', { id: res.syncedTaskId });
      return { timeBlock: res.block, success: true };
    },

    deleteTimeBlock: async (_p: unknown, args: { input: { id: string; deleteChildren?: boolean | null } }) => {
      const owner = currentOwnerId();
      const id = args.input.id;
      // DELETE ordering (mirrors routes/blocks.ts): confirm ownership FIRST, then push
      // remote deletes BEFORE deleteBlock (which CASCADE-removes the block's
      // external_events rows) — but never fire pushOutboundDeletes for an unowned id.
      const existing = await getBlock(owner, id);
      if (!existing) throw new GraphQLError('block not found', { extensions: { code: 'NOT_FOUND' } });
      await pushOutboundDeletes(id);
      const res = await deleteBlockService(owner, id, { deleteChildren: args.input.deleteChildren ?? false });
      if (!res.ok) throw new GraphQLError('block not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'block:deleted', { id });
      for (const taskId of res.revertedTaskIds) broadcast(owner, 'task:updated', { id: taskId });
      return { deletedId: id, success: true };
    },
  },

  TimeBlockType: {
    // Non-null SDL scalars over nullable-with-default drizzle columns: coerce a stored
    // null to the column DEFAULT so serialization of a hand-inserted row can't throw
    // (mirrors TaskType.subtype coercing t.subtype ?? 'standard').
    blockKind: (b: BlockRow) => b.blockKind ?? 'task',
    allDay: (b: BlockRow) => !!b.allDay,
    isLocked: (b: BlockRow) => !!b.isLocked,
    isAuto: (b: BlockRow) => !!b.isAuto,
    status: (b: BlockRow) => b.status ?? 'planned',
    task: async (b: BlockRow) => (b.taskId ? (await getTask(currentOwnerId(), b.taskId)) ?? null : null),
    // 0151: own-else-inherit-from-task, each set independently — blockPeopleApi is the
    // single home for that rule, shared with the REST read path so the two can't drift.
    responsible: async (b: BlockRow) => (await blockPeopleApi(b.id, b.taskId, { responsible: !!b.responsiblePinned, beneficiaries: !!b.beneficiariesPinned })).responsible.map(personToGraphql),
    beneficiaries: async (b: BlockRow) => (await blockPeopleApi(b.id, b.taskId, { responsible: !!b.responsiblePinned, beneficiaries: !!b.beneficiariesPinned })).beneficiaries.map(personToGraphql),
    parentBlock: async (b: BlockRow) => (b.parentBlockId ? (await getBlock(currentOwnerId(), b.parentBlockId)) ?? null : null),
    // Phase B: first EFFECTIVE category — own entity_categories rows, else the task's,
    // else the legacy category_id column (pre-0135 rows the write path hasn't touched).
    category: async (b: BlockRow) => {
      const id = (await entityCategoryIds('time_block', b.id))[0]
        ?? (b.taskId ? (await entityCategoryIds('task', b.taskId))[0] : undefined)
        ?? b.categoryId;
      if (!id) return null;
      const row = await getOwnedTag(currentOwnerId(), id);
      return row ? toNode(row) : null;
    },
    // Phase B: effective category names (same derive rule as REST's `categories`).
    categories: async (b: BlockRow) => await blockCategoryNames(b.id, b.taskId),
    textureEnabled: (b: BlockRow) => b.textureEnabled ?? true,
    // W4a Taggable forward edge. Owner-safe: this resolver only runs on an
    // already-owner-scoped block (timeBlock/timeBlocks/parentBlock all go through
    // getBlock/listBlockPage), so its entity_tags are the owner's. id/label/taggedAt map
    // to EntityTagType's fields via default resolvers — no EntityTagType resolver needed.
    tags: async (b: BlockRow) => (await entityTagsFull('time_block', b.id)).map((e) => ({ id: e.tagId, label: e.name, taggedAt: e.createdAt })),
  },
};
