import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.scheduling_prefs` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'scheduling_prefs' })
export class SchedulingPrefsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text', nullable: true })
  ownerId!: string | null;

  @Column({ name: 'workday_start', type: 'text', nullable: true })
  workdayStart!: string | null;

  @Column({ name: 'workday_end', type: 'text', nullable: true })
  workdayEnd!: string | null;

  @Column({ name: 'deep_work_windows', type: 'text', nullable: true })
  deepWorkWindows!: string | null;

  @Column({ name: 'max_focus_block_minutes', type: 'int', nullable: true })
  maxFocusBlockMinutes!: number | null;

  @Column({ name: 'min_break_minutes', type: 'int', nullable: true })
  minBreakMinutes!: number | null;

  @Column({ name: 'day_theme', type: 'text', nullable: true })
  dayTheme!: string | null;

  @Column({ name: 'planning_mode', type: 'text', nullable: true })
  planningMode!: string | null;

  @Column({ type: 'text', nullable: true })
  timezone!: string | null;

  @Column({ name: 'planning_horizon_days', type: 'int', nullable: true })
  planningHorizonDays!: number | null;

  @Column({ name: 'fast_model', type: 'text', nullable: true })
  fastModel!: string | null;

  @Column({ name: 'quality_model', type: 'text', nullable: true })
  qualityModel!: string | null;

  @Column({ name: 'embed_model', type: 'text', nullable: true })
  embedModel!: string | null;

  @Column({ name: 'memory_sync_enabled', type: 'int', nullable: true })
  memorySyncEnabled!: number | null;

  @Column({ name: 'memory_sync_completed', type: 'int', nullable: true })
  memorySyncCompleted!: number | null;

  @Column({ name: 'memory_sync_habits', type: 'int', nullable: true })
  memorySyncHabits!: number | null;

  @Column({ name: 'memory_sync_reflections', type: 'int', nullable: true })
  memorySyncReflections!: number | null;

  @Column({ name: 'memory_account', type: 'text', nullable: true })
  memoryAccount!: string | null;

  @Column({ name: 'memory_last_synced_at', type: 'text', nullable: true })
  memoryLastSyncedAt!: string | null;

  @Column({ name: 'max_time_block_minutes', type: 'int', nullable: true })
  maxTimeBlockMinutes!: number | null;

  @Column({ name: 'min_time_block_minutes', type: 'int', nullable: true })
  minTimeBlockMinutes!: number | null;

  @Column({ name: 'plan_allday_always', type: 'int', nullable: true })
  planAlldayAlways!: number | null;

  @Column({ name: 'plan_daylong_for_promoted', type: 'int', nullable: true })
  planDaylongForPromoted!: number | null;

  @Column({ name: 'plan_autofill_gaps', type: 'int', nullable: true })
  planAutofillGaps!: number | null;

  @Column({ name: 'concept_default_minutes', type: 'int', nullable: true })
  conceptDefaultMinutes!: number | null;

  @Column({ name: 'concept_autosurface', type: 'int', nullable: true })
  conceptAutosurface!: number | null;

  @Column({ name: 'concept_horizon_days', type: 'int', nullable: true })
  conceptHorizonDays!: number | null;

  @Column({ name: 'concept_tags', type: 'text', nullable: true })
  conceptTags!: string | null;

  @Column({ name: 'enable_rituals', type: 'int', nullable: true })
  enableRituals!: number | null;

  @Column({ name: 'auto_fill_workday', type: 'int', nullable: true })
  autoFillWorkday!: number | null;

  @Column({ name: 'recall_keeps_pattern', type: 'int', nullable: true })
  recallKeepsPattern!: number | null;

  @Column({ name: 'fill_order', type: 'text' })
  fillOrder!: string;

  @Column({ name: 'auto_defense_enabled', type: 'int' })
  autoDefenseEnabled!: number;

  @Column({ name: 'trust_mode', type: 'text' })
  trustMode!: string;

  @Column({ name: 'default_time_block_minutes', type: 'int', nullable: true })
  defaultTimeBlockMinutes!: number | null;

  @Column({ name: 'enable_routines', type: 'int', nullable: true })
  enableRoutines!: number | null;

  @Column({ name: 'recurrence_horizon_days', type: 'int', nullable: true })
  recurrenceHorizonDays!: number | null;

  @Column({ name: 'time_sense_enabled', type: 'int', nullable: true })
  timeSenseEnabled!: number | null;

  @Column({ name: 'focus_ritual_enabled', type: 'int', nullable: true })
  focusRitualEnabled!: number | null;

  @Column({ name: 'haptic_cues_enabled', type: 'int', nullable: true })
  hapticCuesEnabled!: number | null;

  @Column({ name: 'ambient_color_enabled', type: 'int', nullable: true })
  ambientColorEnabled!: number | null;

  @Column({ name: 'calibration_loop_enabled', type: 'int', nullable: true })
  calibrationLoopEnabled!: number | null;

  @Column({ name: 'balance_bias_enabled', type: 'int', nullable: true })
  balanceBiasEnabled!: number | null;

  @Column({ name: 'z_experiment_arm', type: 'text', nullable: true })
  zExperimentArm!: string | null;

  @Column({ name: 'view_prefs', type: 'text', nullable: true })
  viewPrefs!: string | null;

  @Column({ name: 'memory_pull_enabled', type: 'int', nullable: true })
  memoryPullEnabled!: number | null;

  @Column({ name: 'sleep_hours_per_week', type: 'int' })
  sleepHoursPerWeek!: number;

  @Column({ name: 'onboarded_at', type: 'text', nullable: true })
  onboardedAt!: string | null;

  @Column({ name: 'triality_enabled', type: 'int', nullable: true })
  trialityEnabled!: number | null;

  @Column({ name: 'memory_window_days', type: 'int' })
  memoryWindowDays!: number;

  @Column({ name: 'email_lookback_days', type: 'int' })
  emailLookbackDays!: number;
}

export type SchedulingPrefs = Readonly<SchedulingPrefsEntity>;
