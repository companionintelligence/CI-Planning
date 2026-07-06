import { GraphQLError } from 'graphql';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from '../routes/sse.js';
import {
  listBlockTemplates,
  getBlockTemplate,
  createBlockTemplate,
  updateBlockTemplate,
  deleteBlockTemplate,
  parseTasks,
  serializeTemplate,
  type TemplateRow,
  type TemplateTask,
} from '../services/block-templates.js';

/**
 * BlockTemplateType resolvers (Phase W). Every resolver reuses services/block-templates.ts
 * (Decision 3): the SAME owner-scoped functions the REST /api/block-templates routes call.
 * Owner comes from `currentOwnerId()` (requireAuth), never the client — a cross-owner id is
 * invisible (get → undefined → null; update/delete → not_found).
 *
 * Mutations reproduce the REST SSE envelope (block_template:created/updated/deleted with
 * the serialized-template payload). writeAudit already fires INSIDE the service, so none
 * here. instantiate + apply-to-block stay REST-only (they materialize the calendar).
 */

/** Map the camelCase GraphQL task input to the service's snake_case TemplateTask. */
function toTemplateTask(t: { title: string; tag?: string | null; estimatedMinutes?: number | null; offsetMinutes?: number | null }): TemplateTask {
  return {
    title: t.title,
    tag: t.tag ?? null,
    estimated_minutes: t.estimatedMinutes ?? null,
    offset_minutes: t.offsetMinutes ?? 0,
  };
}

export const blockTemplateResolvers = {
  Query: {
    blockTemplates: () => listBlockTemplates(currentOwnerId()),
    blockTemplate: (_p: unknown, args: { id: string }) => getBlockTemplate(currentOwnerId(), args.id) ?? null,
  },

  Mutation: {
    createBlockTemplate: (
      _p: unknown,
      args: { input: { name: string; tag?: string | null; defaultMinutes?: number | null; tasks?: { title: string; tag?: string | null; estimatedMinutes?: number | null; offsetMinutes?: number | null }[] | null } },
    ) => {
      const owner = currentOwnerId();
      const res = createBlockTemplate(owner, {
        name: args.input.name,
        tag: args.input.tag ?? null,
        default_minutes: args.input.defaultMinutes ?? null,
        tasks: args.input.tasks ? args.input.tasks.map(toTemplateTask) : null,
      });
      if (!res.ok) throw new GraphQLError('name is required', { extensions: { code: 'BAD_USER_INPUT' } });
      const out = serializeTemplate(res.row);
      broadcast(owner, 'block_template:created', out);
      return { blockTemplate: res.row, success: true };
    },

    updateBlockTemplate: (
      _p: unknown,
      args: { input: { id: string; name?: string | null; tag?: string | null; defaultMinutes?: number | null } },
    ) => {
      const owner = currentOwnerId();
      // Only forward keys the client sent (absent = PATCH-preserve in the service).
      const patch: { name?: string; tag?: string | null; default_minutes?: number } = {};
      if (args.input.name != null) patch.name = args.input.name;
      if (args.input.tag !== undefined) patch.tag = args.input.tag;
      if (args.input.defaultMinutes != null) patch.default_minutes = args.input.defaultMinutes;
      const res = updateBlockTemplate(owner, args.input.id, patch);
      if (!res.ok) {
        if (res.error === 'not_found') throw new GraphQLError('block template not found', { extensions: { code: 'NOT_FOUND' } });
        throw new GraphQLError('name is required', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const out = serializeTemplate(res.row);
      broadcast(owner, 'block_template:updated', out);
      return { blockTemplate: res.row, success: true };
    },

    deleteBlockTemplate: (_p: unknown, args: { input: { id: string } }) => {
      const owner = currentOwnerId();
      const res = deleteBlockTemplate(owner, args.input.id);
      if (!res.ok) throw new GraphQLError('block template not found', { extensions: { code: 'NOT_FOUND' } });
      broadcast(owner, 'block_template:deleted', { id: args.input.id });
      return { deletedId: args.input.id, success: true };
    },
  },

  BlockTemplateType: {
    defaultMinutes: (t: TemplateRow) => t.default_minutes,
    tasks: (t: TemplateRow) => parseTasks(t.tasks),
    // id, name, tag map by name via the default resolver.
  },
};
