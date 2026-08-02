// Barrel for the generated planning-schema entities.
// Regenerate with scripts/gen-entities (see db/postgres/README.md); do not hand-edit.

import { ApiKeysEntity } from './ApiKeysEntity.js';
import { AppConfigEntity } from './AppConfigEntity.js';
import { AuditLogEntity } from './AuditLogEntity.js';
import { AuthStatesEntity } from './AuthStatesEntity.js';
import { BlockTemplatesEntity } from './BlockTemplatesEntity.js';
import { CalibrationComboPinsEntity } from './CalibrationComboPinsEntity.js';
import { CalibrationHistoryEntity } from './CalibrationHistoryEntity.js';
import { CategoryDirectionOptoutsEntity } from './CategoryDirectionOptoutsEntity.js';
import { ConnectionPrefsEntity } from './ConnectionPrefsEntity.js';
import { ConnectionTokensEntity } from './ConnectionTokensEntity.js';
import { CopyHistoryEntity } from './CopyHistoryEntity.js';
import { DailyPlanEntity } from './DailyPlanEntity.js';
import { DailyRecapEntity } from './DailyRecapEntity.js';
import { DayAssignmentsEntity } from './DayAssignmentsEntity.js';
import { DayOfWeekMapEntity } from './DayOfWeekMapEntity.js';
import { DayTypesEntity } from './DayTypesEntity.js';
import { EntityCategoriesEntity } from './EntityCategoriesEntity.js';
import { EntityTagsEntity } from './EntityTagsEntity.js';
import { EstimateCalibrationEntity } from './EstimateCalibrationEntity.js';
import { ExternalEventsEntity } from './ExternalEventsEntity.js';
import { FlightPlanEntity } from './FlightPlanEntity.js';
import { JobRunsEntity } from './JobRunsEntity.js';
import { LifePrioritiesEntity } from './LifePrioritiesEntity.js';
import { OauthStatesEntity } from './OauthStatesEntity.js';
import { ObjectiveTasksEntity } from './ObjectiveTasksEntity.js';
import { ObjectivesEntity } from './ObjectivesEntity.js';
import { OutboundQueueEntity } from './OutboundQueueEntity.js';
import { OwnersEntity } from './OwnersEntity.js';
import { PasswordResetTokensEntity } from './PasswordResetTokensEntity.js';
import { PatternBlocksEntity } from './PatternBlocksEntity.js';
import { PatternDayOptoutsEntity } from './PatternDayOptoutsEntity.js';
import { PatternTasksEntity } from './PatternTasksEntity.js';
import { PatternTypesEntity } from './PatternTypesEntity.js';
import { PatternsEntity } from './PatternsEntity.js';
import { PlanHintsEntity } from './PlanHintsEntity.js';
import { PlanningSessionsEntity } from './PlanningSessionsEntity.js';
import { PossibleTaskTagsEntity } from './PossibleTaskTagsEntity.js';
import { PossibleTasksEntity } from './PossibleTasksEntity.js';
import { PushSubscriptionsEntity } from './PushSubscriptionsEntity.js';
import { ReflectionsEntity } from './ReflectionsEntity.js';
import { RemindersEntity } from './RemindersEntity.js';
import { ReplanSuggestionsEntity } from './ReplanSuggestionsEntity.js';
import { ScheduledJobsEntity } from './ScheduledJobsEntity.js';
import { SchedulingPrefsEntity } from './SchedulingPrefsEntity.js';
import { SyncEventsEntity } from './SyncEventsEntity.js';
import { SyncStateEntity } from './SyncStateEntity.js';
import { TagCategoriesEntity } from './TagCategoriesEntity.js';
import { TagDirectionsEntity } from './TagDirectionsEntity.js';
import { TagPrefsEntity } from './TagPrefsEntity.js';
import { TagsEntity } from './TagsEntity.js';
import { TaskDependenciesEntity } from './TaskDependenciesEntity.js';
import { TasksEntity } from './TasksEntity.js';
import { TimeBlocksEntity } from './TimeBlocksEntity.js';
import { TimeEntriesEntity } from './TimeEntriesEntity.js';
import { TrialityLogEntity } from './TrialityLogEntity.js';
import { TrialityWeightsEntity } from './TrialityWeightsEntity.js';

export * from './ApiKeysEntity.js';
export * from './AppConfigEntity.js';
export * from './AuditLogEntity.js';
export * from './AuthStatesEntity.js';
export * from './BlockTemplatesEntity.js';
export * from './CalibrationComboPinsEntity.js';
export * from './CalibrationHistoryEntity.js';
export * from './CategoryDirectionOptoutsEntity.js';
export * from './ConnectionPrefsEntity.js';
export * from './ConnectionTokensEntity.js';
export * from './CopyHistoryEntity.js';
export * from './DailyPlanEntity.js';
export * from './DailyRecapEntity.js';
export * from './DayAssignmentsEntity.js';
export * from './DayOfWeekMapEntity.js';
export * from './DayTypesEntity.js';
export * from './EntityCategoriesEntity.js';
export * from './EntityTagsEntity.js';
export * from './EstimateCalibrationEntity.js';
export * from './ExternalEventsEntity.js';
export * from './FlightPlanEntity.js';
export * from './JobRunsEntity.js';
export * from './LifePrioritiesEntity.js';
export * from './OauthStatesEntity.js';
export * from './ObjectiveTasksEntity.js';
export * from './ObjectivesEntity.js';
export * from './OutboundQueueEntity.js';
export * from './OwnersEntity.js';
export * from './PasswordResetTokensEntity.js';
export * from './PatternBlocksEntity.js';
export * from './PatternDayOptoutsEntity.js';
export * from './PatternTasksEntity.js';
export * from './PatternTypesEntity.js';
export * from './PatternsEntity.js';
export * from './PlanHintsEntity.js';
export * from './PlanningSessionsEntity.js';
export * from './PossibleTaskTagsEntity.js';
export * from './PossibleTasksEntity.js';
export * from './PushSubscriptionsEntity.js';
export * from './ReflectionsEntity.js';
export * from './RemindersEntity.js';
export * from './ReplanSuggestionsEntity.js';
export * from './ScheduledJobsEntity.js';
export * from './SchedulingPrefsEntity.js';
export * from './SyncEventsEntity.js';
export * from './SyncStateEntity.js';
export * from './TagCategoriesEntity.js';
export * from './TagDirectionsEntity.js';
export * from './TagPrefsEntity.js';
export * from './TagsEntity.js';
export * from './TaskDependenciesEntity.js';
export * from './TasksEntity.js';
export * from './TimeBlocksEntity.js';
export * from './TimeEntriesEntity.js';
export * from './TrialityLogEntity.js';
export * from './TrialityWeightsEntity.js';

/** Every entity, for DataSource registration.
 *  Registered explicitly rather than by glob so a bundled build (tsx/rolldown)
 *  cannot silently drop an entity the way a runtime path glob would. */
export const PLANNING_ENTITIES = [
  ApiKeysEntity,
  AppConfigEntity,
  AuditLogEntity,
  AuthStatesEntity,
  BlockTemplatesEntity,
  CalibrationComboPinsEntity,
  CalibrationHistoryEntity,
  CategoryDirectionOptoutsEntity,
  ConnectionPrefsEntity,
  ConnectionTokensEntity,
  CopyHistoryEntity,
  DailyPlanEntity,
  DailyRecapEntity,
  DayAssignmentsEntity,
  DayOfWeekMapEntity,
  DayTypesEntity,
  EntityCategoriesEntity,
  EntityTagsEntity,
  EstimateCalibrationEntity,
  ExternalEventsEntity,
  FlightPlanEntity,
  JobRunsEntity,
  LifePrioritiesEntity,
  OauthStatesEntity,
  ObjectiveTasksEntity,
  ObjectivesEntity,
  OutboundQueueEntity,
  OwnersEntity,
  PasswordResetTokensEntity,
  PatternBlocksEntity,
  PatternDayOptoutsEntity,
  PatternTasksEntity,
  PatternTypesEntity,
  PatternsEntity,
  PlanHintsEntity,
  PlanningSessionsEntity,
  PossibleTaskTagsEntity,
  PossibleTasksEntity,
  PushSubscriptionsEntity,
  ReflectionsEntity,
  RemindersEntity,
  ReplanSuggestionsEntity,
  ScheduledJobsEntity,
  SchedulingPrefsEntity,
  SyncEventsEntity,
  SyncStateEntity,
  TagCategoriesEntity,
  TagDirectionsEntity,
  TagPrefsEntity,
  TagsEntity,
  TaskDependenciesEntity,
  TasksEntity,
  TimeBlocksEntity,
  TimeEntriesEntity,
  TrialityLogEntity,
  TrialityWeightsEntity,
];
