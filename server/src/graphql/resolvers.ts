import { currentOwnerId } from '../lib/context.js';
import { DateTimeScalar, JSONScalar } from './scalars.js';
import { tagResolvers } from './tag-resolvers.js';
import { taskResolvers } from './task-resolvers.js';
import { blockResolvers } from './block-resolvers.js';
import { flightPlanResolvers } from './flight-plan-resolvers.js';
import { patternResolvers } from './pattern-resolvers.js';
import { patternBlockResolvers } from './pattern-block-resolvers.js';
import { dayTypeResolvers } from './daytype-resolvers.js';
import { objectiveResolvers } from './objective-resolvers.js';
import { blockTemplateResolvers } from './block-template-resolvers.js';

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
    ...blockResolvers.Query,
    ...flightPlanResolvers.Query,
    ...patternResolvers.Query,
    ...patternBlockResolvers.Query,
    ...dayTypeResolvers.Query,
    ...objectiveResolvers.Query,
    ...blockTemplateResolvers.Query,
  },
  Mutation: {
    ...tagResolvers.Mutation,
    ...taskResolvers.Mutation,
    ...blockResolvers.Mutation,
    ...flightPlanResolvers.Mutation,
    ...patternResolvers.Mutation,
    ...patternBlockResolvers.Mutation,
    ...dayTypeResolvers.Mutation,
    ...objectiveResolvers.Mutation,
    ...blockTemplateResolvers.Mutation,
  },
  TagType: tagResolvers.TagType,
  TaskType: taskResolvers.TaskType,
  TimeBlockType: blockResolvers.TimeBlockType,
  FlightPlanEntryType: flightPlanResolvers.FlightPlanEntryType,
  PatternKindType: patternResolvers.PatternKindType,
  PatternType: patternResolvers.PatternType,
  PatternBlockType: patternBlockResolvers.PatternBlockType,
  PatternPrefType: patternBlockResolvers.PatternPrefType,
  DayTypeType: dayTypeResolvers.DayTypeType,
  TagPrefType: dayTypeResolvers.TagPrefType,
  ObjectiveType: objectiveResolvers.ObjectiveType,
  BlockTemplateType: blockTemplateResolvers.BlockTemplateType,
  // W4b union: __resolveType for TagType.entities' Task ∪ TimeBlock members.
  TaggedEntity: tagResolvers.TaggedEntity,
};
