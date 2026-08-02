-- migrate:up
--
-- CI-Planning baseline: the end state of the 147 SQLite migrations (0001_baseline …
-- 0147_ingest_windows), collapsed into one Postgres schema. Collapsed rather than
-- ported one-for-one because this database is NEW — there is no SQLite history here to
-- replay, and 147 incremental steps would only be 147 chances to diverge. The SQLite
-- migrations remain the historical record for the old store.
--
-- Generated from a canonical SQLite DB built by replaying every migration, then
-- verified structurally against it: 56 tables, 505 columns, 81 foreign keys,
-- 3 CHECK constraints, 65 explicit indexes + 14 unique constraints + 56 primary keys.
--
-- TYPE MAPPING IS DELIBERATELY CONSERVATIVE — this is a port, not a retyping:
--
--   TEXT    -> TEXT              NOT timestamptz/date/jsonb. The app compares ISO
--                                timestamps as STRINGS throughout (`completed_at > ?`,
--                                `start < from`, `period_key` keys) and JSON.parses its
--                                own TEXT blobs. Retyping would hand back Date and
--                                object values and silently break ~46k LOC that treats
--                                them as strings — a separate, testable follow-up, not
--                                something to smuggle into a store swap.
--   INTEGER -> INTEGER           NOT boolean. 0/1 flags are written as `x ? 1 : 0` and
--                                read as `!!row.x`; BOOLEAN would reject the integer
--                                literal on write at every one of those call sites.
--   REAL    -> DOUBLE PRECISION
--
-- Defaults reproduce SQLite's exact BYTE FORMAT, not merely its meaning:
-- CURRENT_TIMESTAMP yields 'YYYY-MM-DD HH:MM:SS' (UTC, no zone marker) and the
-- day-boundary code parses precisely that spelling — see sqliteUtcToISO in lib/tz.ts.
-- Both spellings were verified byte-identical against SQLite before this landed.
--
-- Foreign keys are added after all tables exist, so creation order is irrelevant.

CREATE SCHEMA IF NOT EXISTS planning;

CREATE TABLE planning."api_keys" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "prefix" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "scopes" TEXT NOT NULL DEFAULT '[]',
  "expires_at" TEXT,
  "last_used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "revoked_at" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."app_config" (
  "key" TEXT,
  "value" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("key")
);

CREATE TABLE planning."audit_log" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."auth_states" (
  "id" TEXT,
  "state" TEXT NOT NULL,
  "code_verifier" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "redirect_uri" TEXT,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "expires_at" TEXT NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."block_templates" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT,
  "name" TEXT NOT NULL,
  "tag" TEXT,
  "default_minutes" INTEGER DEFAULT 60,
  "tasks" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."calibration_combo_pins" (
  "owner_id" TEXT NOT NULL,
  "scope_ref" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("owner_id", "scope_ref")
);

CREATE TABLE planning."calibration_history" (
  "owner_id" TEXT NOT NULL,
  "scope_kind" TEXT NOT NULL,
  "scope_ref" TEXT NOT NULL DEFAULT '',
  "computed_date" TEXT NOT NULL,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "bias_ratio" DOUBLE PRECISION,
  "p25" DOUBLE PRECISION,
  "p50" DOUBLE PRECISION,
  "p75" DOUBLE PRECISION,
  PRIMARY KEY ("owner_id", "scope_kind", "scope_ref", "computed_date")
);

CREATE TABLE planning."category_direction_optouts" (
  "category_tag_id" TEXT NOT NULL,
  "direction_tag_id" TEXT NOT NULL,
  PRIMARY KEY ("category_tag_id", "direction_tag_id")
);

CREATE TABLE planning."connection_prefs" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "color_token" TEXT NOT NULL DEFAULT 'primary',
  "texture" TEXT NOT NULL DEFAULT 'none',
  PRIMARY KEY ("id")
);

CREATE TABLE planning."connection_tokens" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "auth_tag" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "key_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "updated_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "status" TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY ("id")
);

CREATE TABLE planning."copy_history" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."daily_plan" (
  "owner_id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "rationale" TEXT,
  "source" TEXT NOT NULL DEFAULT 'deterministic',
  "block_id" TEXT,
  "outcome" TEXT,
  PRIMARY KEY ("owner_id", "date", "task_id")
);

CREATE TABLE planning."daily_recap" (
  "owner_id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "prose" TEXT,
  "stats" TEXT,
  "focus" TEXT,
  "llm" INTEGER,
  "inputs_hash" TEXT,
  "star_objective" INTEGER,
  "star_habits" INTEGER,
  "star_tasks" INTEGER,
  "star_bonus" INTEGER,
  "star_note" INTEGER,
  "total" INTEGER,
  "frozen_at" TEXT,
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "updated_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("owner_id", "date")
);

CREATE TABLE planning."day_assignments" (
  "owner_id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "day_type_key" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "date")
);

CREATE TABLE planning."day_of_week_map" (
  "owner_id" TEXT NOT NULL,
  "dow" INTEGER NOT NULL,
  "day_type_key" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "dow")
);

CREATE TABLE planning."day_types" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "is_builtin" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."entity_categories" (
  "entity_kind" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "category_tag_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("entity_kind", "entity_id", "category_tag_id")
);

CREATE TABLE planning."entity_tags" (
  "entity_kind" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  "level" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("entity_kind", "entity_id", "tag_id")
);

CREATE TABLE planning."estimate_calibration" (
  "owner_id" TEXT NOT NULL,
  "scope_kind" TEXT NOT NULL DEFAULT 'global',
  "scope_ref" TEXT NOT NULL DEFAULT '',
  "computed_at" TEXT NOT NULL,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "bias_ratio" DOUBLE PRECISION,
  "p25" DOUBLE PRECISION,
  "p50" DOUBLE PRECISION,
  "p75" DOUBLE PRECISION,
  PRIMARY KEY ("owner_id", "scope_kind", "scope_ref")
);

CREATE TABLE planning."external_events" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "block_id" TEXT,
  "etag" TEXT,
  "direction" TEXT NOT NULL DEFAULT 'inbound',
  "last_synced_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."flight_plan" (
  "owner_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "selected" INTEGER DEFAULT 1,
  "position" INTEGER DEFAULT 0,
  "added_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "source_kind" TEXT NOT NULL DEFAULT 'manual',
  "source_ref" TEXT,
  PRIMARY KEY ("owner_id", "task_id")
);

CREATE TABLE planning."job_runs" (
  "id" TEXT NOT NULL,
  "job_id" TEXT,
  "started_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "finished_at" TEXT,
  "status" TEXT DEFAULT 'running',
  "items_created" INTEGER DEFAULT 0,
  "items_updated" INTEGER DEFAULT 0,
  "log" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."life_priorities" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "satisfaction" INTEGER NOT NULL DEFAULT 5,
  "importance" INTEGER NOT NULL DEFAULT 5,
  "target_hours_per_week" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "updated_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."oauth_states" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'google',
  "state" TEXT NOT NULL,
  "code_verifier" TEXT NOT NULL,
  "nonce" TEXT,
  "redirect_uri" TEXT,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "expires_at" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."objective_tasks" (
  "objective_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "id" TEXT,
  "linked" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TEXT,
  "field_ts" TEXT,
  PRIMARY KEY ("objective_id", "task_id")
);

CREATE TABLE planning."objectives" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "parent_id" TEXT,
  "level" TEXT NOT NULL DEFAULT 'goal',
  "horizon" TEXT NOT NULL DEFAULT 'none',
  "title" TEXT NOT NULL,
  "description" TEXT,
  "target_date" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "category_id" TEXT,
  "progress_cache" DOUBLE PRECISION,
  "cadence" TEXT NOT NULL DEFAULT 'none',
  "last_advanced_at" TEXT,
  "priority" INTEGER DEFAULT 3,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "completed_at" TEXT,
  "source_task_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "field_ts" TEXT,
  "archived_at" TEXT,
  "archive_root_id" TEXT,
  "purge_after" TEXT,
  "color_token" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."outbound_queue" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "block_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."owners" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "last_auto_run_id" TEXT,
  "external_subject" TEXT,
  "username" TEXT,
  "password_hash" TEXT,
  "backup_email" TEXT,
  "session_epoch" INTEGER NOT NULL DEFAULT 0,
  "role" TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY ("id")
);

CREATE TABLE planning."password_reset_tokens" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "used_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."pattern_blocks" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "direction_tag_id" TEXT NOT NULL,
  "day_type" TEXT NOT NULL,
  "start_time" TEXT NOT NULL,
  "end_time" TEXT NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."pattern_day_optouts" (
  "owner_id" TEXT NOT NULL,
  "pattern_id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "pattern_id", "date")
);

CREATE TABLE planning."pattern_tasks" (
  "pattern_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "position" INTEGER DEFAULT 0,
  PRIMARY KEY ("pattern_id", "task_id")
);

CREATE TABLE planning."pattern_types" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT,
  "name" TEXT NOT NULL,
  "icon_shape" TEXT NOT NULL,
  "reminder_config" TEXT,
  "is_builtin" INTEGER DEFAULT 0,
  "color_token" TEXT,
  "texture" TEXT,
  "default_est_minutes" INTEGER,
  "notify" INTEGER DEFAULT 0,
  "catch_all" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."patterns" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT,
  "type_id" TEXT,
  "name" TEXT NOT NULL,
  "tag" TEXT,
  "notes" TEXT,
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "recurrence_rule" TEXT,
  "recurrence_dtstart" TEXT,
  "color_token" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."plan_hints" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "time" TEXT,
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."planning_sessions" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "started_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "ended_at" TEXT,
  "entry_branch" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "llm_used" INTEGER NOT NULL DEFAULT 0,
  "transcript" TEXT NOT NULL DEFAULT '[]',
  "summary" TEXT,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."possible_task_tags" (
  "possible_task_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  PRIMARY KEY ("possible_task_id", "tag_id")
);

CREATE TABLE planning."possible_tasks" (
  "id" TEXT NOT NULL,
  "raw_title" TEXT NOT NULL,
  "raw_summary" TEXT,
  "proposed_due_at" TEXT,
  "proposed_priority" INTEGER,
  "proposed_owner_id" TEXT,
  "source_kind" TEXT,
  "source_ref" TEXT,
  "source_payload" TEXT,
  "confidence" DOUBLE PRECISION,
  "status" TEXT DEFAULT 'pending',
  "promoted_task_id" TEXT,
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "proposed_estimated_minutes" INTEGER,
  "proposed_scheduled_for" TEXT,
  "proposed_task_time" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."push_subscriptions" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "user_agent" TEXT,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."reflections" (
  "owner_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "period_key" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "body" TEXT NOT NULL DEFAULT '',
  "category_id" TEXT,
  "done_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL DEFAULT 'manual',
  "source_ref" TEXT,
  PRIMARY KEY ("owner_id", "kind", "period_key", "position")
);

CREATE TABLE planning."reminders" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "task_id" TEXT,
  "block_id" TEXT,
  "fire_at" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "fired_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "source" TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY ("id"),
  CHECK ((task_id IS NULL) <> (block_id IS NULL))
);

CREATE TABLE planning."replan_suggestions" (
  "owner_id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "at_risk" INTEGER NOT NULL,
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("owner_id")
);

CREATE TABLE planning."scheduled_jobs" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "cron" TEXT NOT NULL,
  "enabled" INTEGER DEFAULT 1,
  "last_run_at" TEXT,
  "next_run_at" TEXT,
  "config" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."scheduling_prefs" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT,
  "workday_start" TEXT DEFAULT '09:00',
  "workday_end" TEXT DEFAULT '18:00',
  "deep_work_windows" TEXT,
  "max_focus_block_minutes" INTEGER DEFAULT 90,
  "min_break_minutes" INTEGER DEFAULT 10,
  "day_theme" TEXT,
  "planning_mode" TEXT DEFAULT 'basic',
  "timezone" TEXT,
  "planning_horizon_days" INTEGER DEFAULT 7,
  "fast_model" TEXT,
  "quality_model" TEXT,
  "embed_model" TEXT,
  "memory_sync_enabled" INTEGER DEFAULT 0,
  "memory_sync_completed" INTEGER DEFAULT 1,
  "memory_sync_habits" INTEGER DEFAULT 1,
  "memory_sync_reflections" INTEGER DEFAULT 1,
  "memory_account" TEXT,
  "memory_last_synced_at" TEXT,
  "max_time_block_minutes" INTEGER DEFAULT 240,
  "min_time_block_minutes" INTEGER DEFAULT 15,
  "plan_allday_always" INTEGER DEFAULT 0,
  "plan_daylong_for_promoted" INTEGER DEFAULT 0,
  "plan_autofill_gaps" INTEGER DEFAULT 1,
  "concept_default_minutes" INTEGER DEFAULT 60,
  "concept_autosurface" INTEGER DEFAULT 1,
  "concept_horizon_days" INTEGER DEFAULT 30,
  "concept_tags" TEXT,
  "enable_rituals" INTEGER DEFAULT 0,
  "auto_fill_workday" INTEGER DEFAULT 1,
  "recall_keeps_pattern" INTEGER DEFAULT 0,
  "fill_order" TEXT NOT NULL DEFAULT 'priority',
  "auto_defense_enabled" INTEGER NOT NULL DEFAULT 1,
  "trust_mode" TEXT NOT NULL DEFAULT 'balanced',
  "default_time_block_minutes" INTEGER DEFAULT 60,
  "enable_routines" INTEGER DEFAULT 0,
  "recurrence_horizon_days" INTEGER DEFAULT 7,
  "time_sense_enabled" INTEGER DEFAULT 0,
  "focus_ritual_enabled" INTEGER DEFAULT 1,
  "haptic_cues_enabled" INTEGER DEFAULT 1,
  "ambient_color_enabled" INTEGER DEFAULT 1,
  "calibration_loop_enabled" INTEGER DEFAULT 1,
  "z_experiment_arm" TEXT,
  "view_prefs" TEXT,
  "memory_pull_enabled" INTEGER DEFAULT 0,
  "sleep_hours_per_week" INTEGER NOT NULL DEFAULT 63,
  "onboarded_at" TEXT,
  "triality_enabled" INTEGER DEFAULT 0,
  "memory_window_days" INTEGER NOT NULL DEFAULT 2,
  "email_lookback_days" INTEGER NOT NULL DEFAULT 7,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."sync_events" (
  "seq" INTEGER,
  "owner_id" TEXT NOT NULL,
  "entity" TEXT NOT NULL DEFAULT '',
  "entity_id" TEXT NOT NULL DEFAULT '',
  "version" INTEGER,
  "event" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "at" TEXT NOT NULL,
  PRIMARY KEY ("seq")
);

CREATE TABLE planning."sync_state" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "cursor" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."tag_categories" (
  "intention_tag_id" TEXT NOT NULL,
  "category_tag_id" TEXT NOT NULL,
  PRIMARY KEY ("intention_tag_id", "category_tag_id")
);

CREATE TABLE planning."tag_directions" (
  "intention_tag_id" TEXT NOT NULL,
  "direction_tag_id" TEXT NOT NULL,
  PRIMARY KEY ("intention_tag_id", "direction_tag_id")
);

CREATE TABLE planning."tag_prefs" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "auto_fill" INTEGER,
  "reminder_offsets" TEXT,
  "icon_shape" TEXT,
  "color_token" TEXT NOT NULL DEFAULT 'primary',
  "default_minutes" INTEGER NOT NULL DEFAULT 60,
  PRIMARY KEY ("id"),
  CHECK (kind IN ('direction','category'))
);

CREATE TABLE planning."tags" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'intention',
  "muted" INTEGER NOT NULL DEFAULT 0,
  "is_base" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."task_dependencies" (
  "task_id" TEXT NOT NULL,
  "depends_on_id" TEXT NOT NULL,
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("task_id", "depends_on_id"),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE planning."tasks" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "notes" TEXT,
  "due_at" TEXT,
  "task_time" TEXT,
  "estimated_minutes" INTEGER,
  "priority" INTEGER DEFAULT 3,
  "status" TEXT DEFAULT 'open',
  "parent_id" TEXT,
  "owner_id" TEXT,
  "source_kind" TEXT DEFAULT 'manual',
  "source_ref" TEXT,
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "completed_at" TEXT,
  "scheduled_for" TEXT,
  "defer_until" TEXT,
  "actual_minutes" INTEGER NOT NULL DEFAULT 0,
  "recurrence_rule" TEXT,
  "recurrence_parent_id" TEXT,
  "recurrence_dtstart" TEXT,
  "recurrence_exdates" TEXT,
  "occurrence_date" TEXT,
  "defer_count" INTEGER DEFAULT 0,
  "subtype" TEXT DEFAULT 'standard',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TEXT,
  "field_ts" TEXT,
  "texture_enabled" INTEGER NOT NULL DEFAULT 1,
  "texture_color_token" TEXT,
  "completion_mood" TEXT,
  "completion_note" TEXT,
  "reaction_at" TEXT,
  "motivation" TEXT,
  "motivation_source" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."time_blocks" (
  "id" TEXT NOT NULL,
  "task_id" TEXT,
  "owner_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "block_kind" TEXT DEFAULT 'task',
  "start_at" TEXT NOT NULL,
  "end_at" TEXT NOT NULL,
  "is_locked" INTEGER DEFAULT 0,
  "is_auto" INTEGER DEFAULT 1,
  "source_kind" TEXT DEFAULT 'manual',
  "source_ref" TEXT,
  "status" TEXT DEFAULT 'planned',
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  "all_day" INTEGER DEFAULT 0,
  "tag" TEXT,
  "block_type" TEXT,
  "goal_start_date" TEXT,
  "duration_minutes" INTEGER,
  "note" TEXT,
  "parent_block_id" TEXT,
  "recurrence_rule" TEXT,
  "recurrence_dtstart" TEXT,
  "recurrence_parent_id" TEXT,
  "occurrence_date" TEXT,
  "auto_run_id" TEXT,
  "last_moved_at" TEXT,
  "category_id" TEXT,
  "color_token" TEXT,
  "recurrence_exdates" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TEXT,
  "field_ts" TEXT,
  "texture_enabled" INTEGER NOT NULL DEFAULT 1,
  "texture_color_token" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."time_entries" (
  "id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "block_id" TEXT,
  "started_at" TEXT NOT NULL,
  "ended_at" TEXT,
  "source" TEXT DEFAULT 'timer',
  "created_at" TEXT DEFAULT to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY ("id")
);

CREATE TABLE planning."triality_log" (
  "id" TEXT,
  "owner_id" TEXT NOT NULL,
  "shown_at" TEXT NOT NULL,
  "local_date" TEXT NOT NULL,
  "slot" TEXT NOT NULL,
  "action_kind" TEXT NOT NULL,
  "action_ref" TEXT NOT NULL,
  "scores" TEXT NOT NULL,
  "outcome" TEXT NOT NULL DEFAULT 'shown',
  "outcome_at" TEXT,
  "confidence" TEXT,
  PRIMARY KEY ("id")
);

CREATE TABLE planning."triality_weights" (
  "owner_id" TEXT NOT NULL,
  "slot" TEXT NOT NULL,
  "weights" TEXT NOT NULL,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "computed_date" TEXT NOT NULL,
  PRIMARY KEY ("owner_id", "slot")
);

-- UNIQUE constraints (inline in the SQLite DDL)
ALTER TABLE planning."auth_states" ADD CONSTRAINT "ux_auth_states_state" UNIQUE ("state");
ALTER TABLE planning."connection_prefs" ADD CONSTRAINT "ux_connection_prefs_owner_id_provider_account" UNIQUE ("owner_id", "provider", "account");
ALTER TABLE planning."connection_tokens" ADD CONSTRAINT "ux_connection_tokens_owner_id_provider_account" UNIQUE ("owner_id", "provider", "account");
ALTER TABLE planning."day_types" ADD CONSTRAINT "ux_day_types_owner_id_key" UNIQUE ("owner_id", "key");
ALTER TABLE planning."external_events" ADD CONSTRAINT "ux_external_events_provider_account_external_id" UNIQUE ("provider", "account", "external_id");
ALTER TABLE planning."life_priorities" ADD CONSTRAINT "ux_life_priorities_owner_id_category" UNIQUE ("owner_id", "category");
ALTER TABLE planning."oauth_states" ADD CONSTRAINT "ux_oauth_states_state" UNIQUE ("state");
ALTER TABLE planning."outbound_queue" ADD CONSTRAINT "ux_outbound_queue_block_id_provider_account" UNIQUE ("block_id", "provider", "account");
ALTER TABLE planning."possible_tasks" ADD CONSTRAINT "ux_possible_tasks_proposed_owner_id_source_kind_source_ref" UNIQUE ("proposed_owner_id", "source_kind", "source_ref");
ALTER TABLE planning."push_subscriptions" ADD CONSTRAINT "ux_push_subscriptions_endpoint" UNIQUE ("endpoint");
ALTER TABLE planning."scheduled_jobs" ADD CONSTRAINT "ux_scheduled_jobs_name" UNIQUE ("name");
ALTER TABLE planning."sync_state" ADD CONSTRAINT "ux_sync_state_owner_id_provider_account_resource" UNIQUE ("owner_id", "provider", "account", "resource");
ALTER TABLE planning."tag_prefs" ADD CONSTRAINT "ux_tag_prefs_owner_id_tag_id" UNIQUE ("owner_id", "tag_id");
ALTER TABLE planning."tags" ADD CONSTRAINT "ux_tags_owner_id_name" UNIQUE ("owner_id", "name");

-- Explicit indexes (partial predicates carry over unchanged)
CREATE INDEX copy_history_owner_surface_id ON planning."copy_history" (owner_id, surface, id DESC);
CREATE INDEX idx_entity_tags_tag ON planning."entity_tags" (tag_id);
CREATE INDEX idx_tag_categories_cat_int ON planning."tag_categories" (category_tag_id, intention_tag_id);
CREATE INDEX idx_tag_directions_dir_int ON planning."tag_directions" (direction_tag_id, intention_tag_id);
CREATE INDEX idx_tags_owner_kind_name_id ON planning."tags" (owner_id, kind, name, id);
CREATE INDEX idx_taskdeps_depends_on ON planning."task_dependencies" (depends_on_id);
CREATE INDEX idx_tasks_owner_status_sched ON planning."tasks" (owner_id, status, scheduled_for);
CREATE INDEX ix_api_keys_owner ON planning."api_keys" (owner_id);
CREATE INDEX ix_api_keys_prefix ON planning."api_keys" (prefix);
CREATE INDEX ix_audit_owner_at ON planning."audit_log" (owner_id, at);
CREATE INDEX ix_block_templates_owner ON planning."block_templates" (owner_id);
CREATE INDEX ix_calibration_history_scope ON planning."calibration_history" (owner_id, scope_kind, scope_ref, computed_date);
CREATE INDEX ix_connection_tokens_owner ON planning."connection_tokens" (owner_id);
CREATE INDEX ix_daily_plan_block ON planning."daily_plan" (block_id);
CREATE INDEX ix_daily_plan_owner_date ON planning."daily_plan" (owner_id, date, position);
CREATE INDEX ix_entity_categories_entity ON planning."entity_categories" (entity_kind, entity_id);
CREATE INDEX ix_entity_categories_tag ON planning."entity_categories" (category_tag_id);
CREATE INDEX ix_external_events_block ON planning."external_events" (block_id);
CREATE INDEX ix_external_events_owner ON planning."external_events" (owner_id, provider, account);
CREATE INDEX ix_job_runs_job ON planning."job_runs" (job_id);
CREATE INDEX ix_oauth_states_state ON planning."oauth_states" (state);
CREATE UNIQUE INDEX ix_objective_tasks_id ON planning."objective_tasks" (id);
CREATE INDEX ix_objective_tasks_task ON planning."objective_tasks" (task_id);
CREATE INDEX ix_objectives_owner ON planning."objectives" (owner_id);
CREATE INDEX ix_objectives_parent ON planning."objectives" (owner_id, parent_id);
CREATE INDEX ix_objectives_purge_after ON planning."objectives" (purge_after);
CREATE INDEX ix_objectives_source_task ON planning."objectives" (source_task_id);
CREATE INDEX ix_outbound_queue_owner ON planning."outbound_queue" (owner_id, provider, account);
CREATE INDEX ix_pattern_blocks_owner_daytype ON planning."pattern_blocks" (owner_id, day_type);
CREATE INDEX ix_pattern_tasks_task ON planning."pattern_tasks" (task_id);
CREATE INDEX ix_patterns_owner_type ON planning."patterns" (owner_id, type_id);
CREATE INDEX ix_plan_hints_owner_date ON planning."plan_hints" (owner_id, date);
CREATE INDEX ix_planning_sessions_owner ON planning."planning_sessions" (owner_id, started_at);
CREATE INDEX ix_possible_tasks_promoted_task ON planning."possible_tasks" (promoted_task_id);
CREATE INDEX ix_possible_tasks_proposed_owner ON planning."possible_tasks" (proposed_owner_id);
CREATE INDEX ix_push_subscriptions_owner ON planning."push_subscriptions" (owner_id);
CREATE INDEX ix_reflections_owner_kind_period ON planning."reflections" (owner_id, kind, period_key);
CREATE INDEX ix_reminders_block ON planning."reminders" (block_id);
CREATE INDEX ix_reminders_due ON planning."reminders" (status, fire_at);
CREATE INDEX ix_reminders_task ON planning."reminders" (task_id);
CREATE INDEX ix_reset_tokens_hash ON planning."password_reset_tokens" (token_hash);
CREATE INDEX ix_reset_tokens_owner ON planning."password_reset_tokens" (owner_id);
CREATE INDEX ix_sync_state_owner ON planning."sync_state" (owner_id);
CREATE INDEX ix_tag_prefs_owner ON planning."tag_prefs" (owner_id);
CREATE INDEX ix_task_owner_status_due ON planning."tasks" (owner_id, status, due_at);
CREATE INDEX ix_tasks_owner_mood ON planning."tasks" (owner_id, completion_mood) WHERE completion_mood IS NOT NULL;
CREATE INDEX ix_tasks_parent ON planning."tasks" (parent_id);
CREATE INDEX ix_tasks_recurrence_parent ON planning."tasks" (recurrence_parent_id);
CREATE INDEX ix_time_blocks_category ON planning."time_blocks" (category_id);
CREATE INDEX ix_time_blocks_owner_start ON planning."time_blocks" (owner_id, start_at);
CREATE INDEX ix_time_blocks_parent ON planning."time_blocks" (parent_block_id);
CREATE INDEX ix_time_blocks_pattern_source ON planning."time_blocks" (source_ref, start_at) WHERE source_kind = 'pattern';
CREATE INDEX ix_time_blocks_task ON planning."time_blocks" (task_id);
CREATE INDEX ix_time_entries_task ON planning."time_entries" (task_id);
CREATE INDEX ix_triality_log_owner_date ON planning."triality_log" (owner_id, local_date);
CREATE INDEX sync_events_owner_seq ON planning."sync_events" (owner_id, seq);
CREATE UNIQUE INDEX ux_block_occurrence ON planning."time_blocks" (recurrence_parent_id, occurrence_date) WHERE recurrence_parent_id IS NOT NULL;
CREATE UNIQUE INDEX ux_owners_external_subject ON planning."owners" (external_subject) WHERE external_subject IS NOT NULL;
CREATE UNIQUE INDEX ux_owners_username ON planning."owners" (username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX ux_pattern_types_owner_name ON planning."pattern_types" (owner_id, name);
CREATE UNIQUE INDEX ux_plan_hints_dedupe ON planning."plan_hints" (owner_id, date, kind, tag, COALESCE(time, ''));
CREATE UNIQUE INDEX ux_task_occurrence ON planning."tasks" (recurrence_parent_id, occurrence_date) WHERE recurrence_parent_id IS NOT NULL;
CREATE UNIQUE INDEX ux_tasks_ingest_source ON planning."tasks" (source_kind, source_ref) WHERE source_kind IN ('gmail','gcal') AND source_ref IS NOT NULL;
CREATE UNIQUE INDEX ux_time_blocks_ingest_source ON planning."time_blocks" (source_kind, source_ref) WHERE source_kind IN ('gmail','gcal') AND source_ref IS NOT NULL;
CREATE UNIQUE INDEX ux_time_entries_one_running ON planning."time_entries" (owner_id) WHERE ended_at IS NULL;

-- Foreign keys (added last so table creation order does not matter)
ALTER TABLE planning."api_keys" ADD CONSTRAINT "fk_api_keys_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."audit_log" ADD CONSTRAINT "fk_audit_log_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."block_templates" ADD CONSTRAINT "fk_block_templates_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."calibration_combo_pins" ADD CONSTRAINT "fk_calibration_combo_pins_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."calibration_history" ADD CONSTRAINT "fk_calibration_history_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."category_direction_optouts" ADD CONSTRAINT "fk_category_direction_optouts_direction_tag_id" FOREIGN KEY ("direction_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."category_direction_optouts" ADD CONSTRAINT "fk_category_direction_optouts_category_tag_id" FOREIGN KEY ("category_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."connection_prefs" ADD CONSTRAINT "fk_connection_prefs_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."connection_tokens" ADD CONSTRAINT "fk_connection_tokens_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."copy_history" ADD CONSTRAINT "fk_copy_history_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."daily_plan" ADD CONSTRAINT "fk_daily_plan_block_id" FOREIGN KEY ("block_id") REFERENCES planning."time_blocks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE planning."daily_plan" ADD CONSTRAINT "fk_daily_plan_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."daily_plan" ADD CONSTRAINT "fk_daily_plan_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."daily_recap" ADD CONSTRAINT "fk_daily_recap_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."day_assignments" ADD CONSTRAINT "fk_day_assignments_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."day_of_week_map" ADD CONSTRAINT "fk_day_of_week_map_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."day_types" ADD CONSTRAINT "fk_day_types_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."entity_categories" ADD CONSTRAINT "fk_entity_categories_category_tag_id" FOREIGN KEY ("category_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."entity_tags" ADD CONSTRAINT "fk_entity_tags_tag_id" FOREIGN KEY ("tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."estimate_calibration" ADD CONSTRAINT "fk_estimate_calibration_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."external_events" ADD CONSTRAINT "fk_external_events_block_id" FOREIGN KEY ("block_id") REFERENCES planning."time_blocks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."external_events" ADD CONSTRAINT "fk_external_events_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."flight_plan" ADD CONSTRAINT "fk_flight_plan_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."flight_plan" ADD CONSTRAINT "fk_flight_plan_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."job_runs" ADD CONSTRAINT "fk_job_runs_job_id" FOREIGN KEY ("job_id") REFERENCES planning."scheduled_jobs" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."life_priorities" ADD CONSTRAINT "fk_life_priorities_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."oauth_states" ADD CONSTRAINT "fk_oauth_states_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."objective_tasks" ADD CONSTRAINT "fk_objective_tasks_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."objective_tasks" ADD CONSTRAINT "fk_objective_tasks_objective_id" FOREIGN KEY ("objective_id") REFERENCES planning."objectives" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."objectives" ADD CONSTRAINT "fk_objectives_category_id" FOREIGN KEY ("category_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE planning."objectives" ADD CONSTRAINT "fk_objectives_parent_id" FOREIGN KEY ("parent_id") REFERENCES planning."objectives" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE planning."objectives" ADD CONSTRAINT "fk_objectives_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."outbound_queue" ADD CONSTRAINT "fk_outbound_queue_block_id" FOREIGN KEY ("block_id") REFERENCES planning."time_blocks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."outbound_queue" ADD CONSTRAINT "fk_outbound_queue_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."password_reset_tokens" ADD CONSTRAINT "fk_password_reset_tokens_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."pattern_blocks" ADD CONSTRAINT "fk_pattern_blocks_direction_tag_id" FOREIGN KEY ("direction_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."pattern_blocks" ADD CONSTRAINT "fk_pattern_blocks_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."pattern_day_optouts" ADD CONSTRAINT "fk_pattern_day_optouts_pattern_id" FOREIGN KEY ("pattern_id") REFERENCES planning."patterns" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."pattern_day_optouts" ADD CONSTRAINT "fk_pattern_day_optouts_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."pattern_tasks" ADD CONSTRAINT "fk_pattern_tasks_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."pattern_tasks" ADD CONSTRAINT "fk_pattern_tasks_pattern_id" FOREIGN KEY ("pattern_id") REFERENCES planning."patterns" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."pattern_types" ADD CONSTRAINT "fk_pattern_types_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."patterns" ADD CONSTRAINT "fk_patterns_type_id" FOREIGN KEY ("type_id") REFERENCES planning."pattern_types" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."patterns" ADD CONSTRAINT "fk_patterns_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."plan_hints" ADD CONSTRAINT "fk_plan_hints_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."planning_sessions" ADD CONSTRAINT "fk_planning_sessions_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."possible_task_tags" ADD CONSTRAINT "fk_possible_task_tags_tag_id" FOREIGN KEY ("tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."possible_task_tags" ADD CONSTRAINT "fk_possible_task_tags_possible_task_id" FOREIGN KEY ("possible_task_id") REFERENCES planning."possible_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."possible_tasks" ADD CONSTRAINT "fk_possible_tasks_promoted_task_id" FOREIGN KEY ("promoted_task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."possible_tasks" ADD CONSTRAINT "fk_possible_tasks_proposed_owner_id" FOREIGN KEY ("proposed_owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."push_subscriptions" ADD CONSTRAINT "fk_push_subscriptions_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."reflections" ADD CONSTRAINT "fk_reflections_category_id" FOREIGN KEY ("category_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE planning."reflections" ADD CONSTRAINT "fk_reflections_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."reminders" ADD CONSTRAINT "fk_reminders_block_id" FOREIGN KEY ("block_id") REFERENCES planning."time_blocks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."reminders" ADD CONSTRAINT "fk_reminders_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."reminders" ADD CONSTRAINT "fk_reminders_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."replan_suggestions" ADD CONSTRAINT "fk_replan_suggestions_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."scheduling_prefs" ADD CONSTRAINT "fk_scheduling_prefs_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."sync_events" ADD CONSTRAINT "fk_sync_events_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."sync_state" ADD CONSTRAINT "fk_sync_state_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."tag_categories" ADD CONSTRAINT "fk_tag_categories_category_tag_id" FOREIGN KEY ("category_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."tag_categories" ADD CONSTRAINT "fk_tag_categories_intention_tag_id" FOREIGN KEY ("intention_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."tag_directions" ADD CONSTRAINT "fk_tag_directions_direction_tag_id" FOREIGN KEY ("direction_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."tag_directions" ADD CONSTRAINT "fk_tag_directions_intention_tag_id" FOREIGN KEY ("intention_tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."tag_prefs" ADD CONSTRAINT "fk_tag_prefs_tag_id" FOREIGN KEY ("tag_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."tag_prefs" ADD CONSTRAINT "fk_tag_prefs_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."tags" ADD CONSTRAINT "fk_tags_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."task_dependencies" ADD CONSTRAINT "fk_task_dependencies_depends_on_id" FOREIGN KEY ("depends_on_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."task_dependencies" ADD CONSTRAINT "fk_task_dependencies_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."tasks" ADD CONSTRAINT "fk_tasks_recurrence_parent_id" FOREIGN KEY ("recurrence_parent_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."tasks" ADD CONSTRAINT "fk_tasks_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."tasks" ADD CONSTRAINT "fk_tasks_parent_id" FOREIGN KEY ("parent_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."time_blocks" ADD CONSTRAINT "fk_time_blocks_category_id" FOREIGN KEY ("category_id") REFERENCES planning."tags" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE planning."time_blocks" ADD CONSTRAINT "fk_time_blocks_parent_block_id" FOREIGN KEY ("parent_block_id") REFERENCES planning."time_blocks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE planning."time_blocks" ADD CONSTRAINT "fk_time_blocks_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."time_blocks" ADD CONSTRAINT "fk_time_blocks_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."time_entries" ADD CONSTRAINT "fk_time_entries_block_id" FOREIGN KEY ("block_id") REFERENCES planning."time_blocks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE planning."time_entries" ADD CONSTRAINT "fk_time_entries_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE planning."time_entries" ADD CONSTRAINT "fk_time_entries_task_id" FOREIGN KEY ("task_id") REFERENCES planning."tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."triality_log" ADD CONSTRAINT "fk_triality_log_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;
ALTER TABLE planning."triality_weights" ADD CONSTRAINT "fk_triality_weights_owner_id" FOREIGN KEY ("owner_id") REFERENCES planning."owners" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

-- migrate:down
DROP SCHEMA IF EXISTS planning CASCADE;
