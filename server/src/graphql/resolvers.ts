import { currentOwnerId } from '../lib/context.js';
import { DateTimeScalar, JSONScalar } from './scalars.js';

/**
 * Root resolver map for the base schema (bootstrap). Entity resolvers are added per
 * type in later Phase W slices; each MUST call the existing `services/*.ts` functions
 * (Decision 3) rather than re-implement business logic or owner-scoping.
 */
export const resolvers = {
  DateTime: DateTimeScalar,
  JSON: JSONScalar,
  Query: {
    // `currentOwnerId()` reads the owner bound by requireAuth (AsyncLocalStorage), the
    // same source every REST handler uses — so GraphQL never re-derives auth (Decision 5).
    viewer: () => ({ ownerId: currentOwnerId(), serverTime: new Date() }),
  },
};
