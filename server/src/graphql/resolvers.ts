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
import { reflectionResolvers } from './reflection-resolvers.js';
import { blockTemplateResolvers } from './block-template-resolvers.js';
import { starsResolvers } from './stars-resolvers.js';
import { possibleTaskResolvers } from './possible-task-resolvers.js';
import { notificationResolvers } from './notification-resolvers.js';
import { prefsResolvers } from './prefs-resolvers.js';
import { jobResolvers } from './job-resolvers.js';

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
    ...reflectionResolvers.Query,
    ...blockTemplateResolvers.Query,
    ...starsResolvers.Query,
    ...possibleTaskResolvers.Query,
    ...notificationResolvers.Query,
    ...prefsResolvers.Query,
    ...jobResolvers.Query,
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
    ...reflectionResolvers.Mutation,
    ...blockTemplateResolvers.Mutation,
    ...possibleTaskResolvers.Mutation,
    ...notificationResolvers.Mutation,
    ...prefsResolvers.Mutation,
    ...jobResolvers.Mutation,
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
  ReflectionType: reflectionResolvers.ReflectionType,
  BlockTemplateType: blockTemplateResolvers.BlockTemplateType,
  DayStarsType: starsResolvers.DayStarsType,
  DailyRecapType: starsResolvers.DailyRecapType,
  PossibleTaskType: possibleTaskResolvers.PossibleTaskType,
  ReminderType: notificationResolvers.ReminderType,
  PushSubscriptionType: notificationResolvers.PushSubscriptionType,
  SchedulingPrefsType: prefsResolvers.SchedulingPrefsType,
  ScheduledJobType: jobResolvers.ScheduledJobType,
  JobRunType: jobResolvers.JobRunType,
  // W4b union: __resolveType for TagType.entities' Task ∪ TimeBlock members.
  TaggedEntity: tagResolvers.TaggedEntity,
};
