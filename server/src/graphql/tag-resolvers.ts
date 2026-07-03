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
  type TagRow,
} from '../services/tags.js';
import { clampFirst, decodeAfter, buildTagConnection } from './pagination.js';

/**
 * TagType resolvers (Phase W, Decision 6). Every resolver reuses `services/tags.ts`
 * (Decision 3) — the CRUD mutations call the SAME functions the REST routes call, and
 * the connections use the keyset-paginated reverse-lookups. Owner-scoping is read from
 * `currentOwnerId()` (bound by requireAuth), never trusted from the client.
 */
type ConnArgs = { first?: number | null; after?: string | null };

/** Normalize any tag row (keyset `TagRow` with isBase, or a full row with is_base) into
 *  the shape the TagType field resolvers read. */
function toNode(r: { id: string; name: string; kind: string; muted: number; isBase?: number; is_base?: number }): TagRow {
  return { id: r.id, name: r.name, kind: r.kind, muted: r.muted, isBase: r.isBase ?? r.is_base ?? 0 };
}

/** GraphQL TagKind enum value → DB `tags.kind` value. */
const dbKind = (k?: string | null): string | undefined => (k ? String(k).toLowerCase() : undefined);

export const tagResolvers = {
  Query: {
    tag: (_p: unknown, args: { id: string }) => {
      const row = getOwnedTag(currentOwnerId(), args.id);
      return row ? toNode(row) : null;
    },
    tags: (_p: unknown, args: ConnArgs & { kind?: string | null }) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      const kind = dbKind(args.kind);
      const rows = pageOwnerTags(owner, kind, afterName, afterId, limit + 1);
      return buildTagConnection(rows, limit, countOwnerTags(owner, kind));
    },
  },

  Mutation: {
    createTag: (_p: unknown, args: { input: { label: string; kind?: string | null } }) => {
      const res = createTagService(currentOwnerId(), { name: args.input.label, kind: dbKind(args.input.kind) });
      if (!res.ok) throw new GraphQLError('name is required', { extensions: { code: 'BAD_USER_INPUT' } });
      return { tag: toNode(res.tag), success: true };
    },
    updateTag: (_p: unknown, args: { input: { id: string; label?: string | null; muted?: boolean | null } }) => {
      const patch: { name?: string; muted?: boolean } = {};
      if (args.input.label != null) patch.name = args.input.label;
      if (args.input.muted != null) patch.muted = args.input.muted;
      const res = updateTagService(currentOwnerId(), args.input.id, patch);
      if (!res.ok) {
        throw new GraphQLError(res.error === 'not_found' ? 'tag not found' : 'a tag with that name already exists', {
          extensions: { code: res.error === 'not_found' ? 'NOT_FOUND' : 'CONFLICT' },
        });
      }
      return { tag: toNode(res.tag), success: true };
    },
    deleteTag: (_p: unknown, args: { input: { id: string } }) => {
      const res = deleteTagService(currentOwnerId(), args.input.id);
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
    parentDirections: (r: TagRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      const rows = pageParentDirections(r.id, owner, afterName, afterId, limit + 1);
      return buildTagConnection(rows, limit, countParentDirections(r.id, owner));
    },
    parentCategories: (r: TagRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      const rows = pageParentCategories(r.id, owner, afterName, afterId, limit + 1);
      return buildTagConnection(rows, limit, countParentCategories(r.id, owner));
    },
    childIntentions: (r: TagRow, args: ConnArgs) => {
      const owner = currentOwnerId();
      const limit = clampFirst(args.first);
      const { afterName, afterId } = decodeAfter(args.after);
      let rows: TagRow[] = [];
      let total = 0;
      if (r.kind === 'direction') {
        rows = pageDirectionChildren(r.id, owner, afterName, afterId, limit + 1);
        total = countDirectionChildren(r.id, owner);
      } else if (r.kind === 'category') {
        rows = pageCategoryChildren(r.id, owner, afterName, afterId, limit + 1);
        total = countCategoryChildren(r.id, owner);
      }
      return buildTagConnection(rows, limit, total);
    },
  },
};
