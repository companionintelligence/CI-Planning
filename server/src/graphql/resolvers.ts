import { currentOwnerId } from '../lib/context.js';
import { DateTimeScalar, JSONScalar } from './scalars.js';
import { tagResolvers } from './tag-resolvers.js';
import { taskResolvers } from './task-resolvers.js';

/**
 * Root resolver map. Entity resolvers live in per-type modules (e.g. tag-resolvers.ts)
 * and are merged here; each MUST call the existing `services/*.ts` functions (Decision 3)
 * rather than re-implement business logic or owner-scoping.
 */
export const resolvers = {
  DateTime: DateTimeScalar,
  JSON: JSONScalar,
  Query: {
    // `currentOwnerId()` reads the owner bound by requireAuth (AsyncLocalStorage), the
    // same source every REST handler uses — so GraphQL never re-derives auth (Decision 5).
    viewer: () => ({ ownerId: currentOwnerId(), serverTime: new Date() }),
    ...tagResolvers.Query,
    ...taskResolvers.Query,
  },
  Mutation: {
    ...tagResolvers.Mutation,
    ...taskResolvers.Mutation,
  },
  TagType: tagResolvers.TagType,
  TaskType: taskResolvers.TaskType,
};
