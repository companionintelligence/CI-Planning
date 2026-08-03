import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import {
  getOwnedTag,
  createTag as createTagService,
  updateTag as updateTagService,
  deleteTag as deleteTagService,
  pageParentDirections, countParentDirections,
  pageParentCategories, countParentCategories,
  pageDirectionChildren, countDirectionChildren,
  pageCategoryChildren, countCategoryChildren,
  pageOwnerTags, countOwnerTags,
  pageEntitiesForTag, countEntitiesForTag,
  type TagRow,
} from '../services/tags.js';
import { getTask } from '../services/tasks.js';
import { getBlock } from '../services/blocks.js';
import { clampFirst, decodeAfter, encodeCursor, buildTagConnection } from './pagination.js';

/** GraphQL EntityKindFilter enum → DB entity_kind; absent ⇒ '' (both kinds). */
const dbEntityKind = (k?: string | null): string =>
  k === 'TASK' ? 'task' : k === 'TIME_BLOCK' ? 'time_block' : '';

/**
 * TagType resolvers (Phase W, Decision 6). Every resolver reuses `services/tags.ts`
 * (Decision 3) — the CRUD mutations call the SAME functions the REST routes call, and
 * the connections use the keyset-paginated reverse-lookups. Owner-scoping is read from
 * `currentOwnerId()` (bound by requireAuth), never trusted from the client.
 */
type ConnArgs = { first?: number | null; after?: string | null };

/** Normalize any tag row (keyset `TagRow` with isBase, or a full row with is_base) into
 *  the shape the TagType field resolvers read. Exported so the TimeBlockType `category`
 *  resolver (block-resolvers.ts) returns the SAME source shape TagType's resolvers expect. */
export function toNode(r: { id: string; name: string; kind: string; muted: number; isBase?: number; is_base?: number }): TagRow {
  return { id: r.id, name: r.name, kind: r.kind, muted: r.muted, isBase: r.isBase ?? r.is_base ?? 0 };
}

/** GraphQL TagKind enum value → DB `tags.kind` value. */
const dbKind = (k?: string | null): string | undefined => (k ? String(k).toLowerCase() : undefined);

export const tagResolvers = {
  Query: {
    tag: async (_p: unknown, args: { id: string }) => {
      const row = await getOwnedTag(currentOwnerId(), args.id);
      return row ? toNode(row) : null;
    },
    tags: async (_p: unknown, args: ConnArgs & { kind?: string | null }) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      const kind = dbKind(args.kind);
      const rows = await pageOwnerTags(owner, kind, afterName, afterId, limit + 1);
      return buildTagConnection(rows, limit, await countOwnerTags(owner, kind));
    },
  },

  Mutation: {
    createTag: async (_p: unknown, args: { input: { label: string; kind?: string | null } }) => {
      const res = await createTagService(currentOwnerId(), { name: args.input.label, kind: dbKind(args.input.kind) });
      if (!res.ok) throw new GraphQLError('name is required', { extensions: { code: 'BAD_USER_INPUT' } });
      return { tag: toNode(res.tag), success: true };
    },
    updateTag: async (_p: unknown, args: { input: { id: string; label?: string | null; muted?: boolean | null } }) => {
      const patch: { name?: string; muted?: boolean } = {};
      if (args.input.label != null) patch.name = args.input.label;
      if (args.input.muted != null) patch.muted = args.input.muted;
      const res = await updateTagService(currentOwnerId(), args.input.id, patch);
      if (!res.ok) {
        throw new GraphQLError(res.error === 'not_found' ? 'tag not found' : 'a tag with that name already exists', {
          extensions: { code: res.error === 'not_found' ? 'NOT_FOUND' : 'CONFLICT' },
        });
      }
      return { tag: toNode(res.tag), success: true };
    },
    deleteTag: async (_p: unknown, args: { input: { id: string } }) => {
      const res = await deleteTagService(currentOwnerId(), args.input.id);
      if (!res.ok) {
        const msg =
          res.error === 'not_found' ? 'tag not found'
            : res.error === 'base' ? 'base tags cannot be deleted'
              : res.error === 'category_in_use' ? 'category has members or is used by a time block'
                : 'tags in use cannot be deleted';
        throw new GraphQLError(msg, { extensions: { code: res.error === 'not_found' ? 'NOT_FOUND' : 'CONFLICT' } });
      }
      return { deletedId: args.input.id, success: true };
    },
  },

  TagType: {
    label: (r: TagRow) => r.name,
    description: () => null,
    kind: (r: TagRow) => r.kind.toUpperCase(),
    muted: (r: TagRow) => !!r.muted,
    isBase: (r: TagRow) => !!r.isBase,
    // Which edges populate depends on kind; a wrong-kind lookup naturally returns empty
    // (e.g. a direction tag has no rows on the intention side of tag_directions).
    parentDirections: async (r: TagRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      const rows = await pageParentDirections(r.id, owner, afterName, afterId, limit + 1);
      return buildTagConnection(rows, limit, await countParentDirections(r.id, owner));
    },
    parentCategories: async (r: TagRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      const rows = await pageParentCategories(r.id, owner, afterName, afterId, limit + 1);
      return buildTagConnection(rows, limit, await countParentCategories(r.id, owner));
    },
    childIntentions: async (r: TagRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      let rows: TagRow[] = [];
      let total = 0;
      if (r.kind === 'direction') {
        rows = await pageDirectionChildren(r.id, owner, afterName, afterId, limit + 1);
        total = await countDirectionChildren(r.id, owner);
      } else if (r.kind === 'category') {
        rows = await pageCategoryChildren(r.id, owner, afterName, afterId, limit + 1);
        total = await countCategoryChildren(r.id, owner);
      }
      return buildTagConnection(rows, limit, total);
    },
    // W4b reverse edge. Owner-scoped twice over: the service's UNION joins the owned
    // tasks/time_blocks tables (a cross-owner or deleted entity_id is dropped there), and
    // each node is re-materialized through getTask/getBlock (owner-scoped) — so a stale
    // row can't leak another owner's entity. N+1 within a bounded page (≤100) is
    // acceptable and mirrors the per-entity forward `tags` edge. `__entityKind` on the
    // node drives the union's __resolveType; GraphQL ignores the extra property.
    entities: async (r: TagRow, args: ConnArgs & { kind?: string | null }) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName: afterKind, afterId } = decodeAfter(args.after);
      const kind = dbEntityKind(args.kind);
      const refsPlusOne = await pageEntitiesForTag(r.id, owner, kind, afterKind, afterId, limit + 1);
      const hasNextPage = refsPlusOne.length > limit;
      const refs = hasNextPage ? refsPlusOne.slice(0, limit) : refsPlusOne;
      const nodes = await Promise.all(
        refs.map((ref) => (ref.entityKind === 'task' ? getTask(owner, ref.entityId) : getBlock(owner, ref.entityId))),
      );
      const edges = refs
        .map((ref, i) => {
          const node = nodes[i];
          return node
            ? { cursor: encodeCursor(ref.entityKind, ref.entityId), node: { ...node, __entityKind: ref.entityKind } }
            : null;
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      return {
        edges,
        pageInfo: {
          hasNextPage,
          hasPreviousPage: false, // forward-only, matching the tag connections
          startCursor: edges.length ? edges[0].cursor : null,
          // endCursor tracks the last SCANNED keyset position (last ref), not the last
          // surviving edge: if a node was dropped (concurrent delete between the UNION and
          // re-materialize), the client's `after` must still advance past it, or it re-
          // fetches the same dropped row forever.
          endCursor: refs.length ? encodeCursor(refs[refs.length - 1].entityKind, refs[refs.length - 1].entityId) : null,
        },
        totalCount: await countEntitiesForTag(r.id, owner, kind),
      };
    },
  },

  // Union type-discrimination for the W4b reverse edge. The `entities` resolver stamps
  // each node with `__entityKind` (the DB entity_kind), read here to pick the concrete type.
  TaggedEntity: {
    // Map only the known kinds; anything unexpected returns null so GraphQL raises a clear
    // "unresolved union type" error rather than silently mis-typing a node as TaskType.
    __resolveType: (obj: { __entityKind?: string }) =>
      obj.__entityKind === 'task' ? 'TaskType' : obj.__entityKind === 'time_block' ? 'TimeBlockType' : null,
  },
};
