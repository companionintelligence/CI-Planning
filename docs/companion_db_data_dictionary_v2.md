# companion.db — Data Dictionary v2 (schema at migration head 0172)

This is a **reference schema**, not a live database dump. It is what a fresh install produces: every migration listed in `server/src/db/migrations/index.ts` (`0001`-`0172`, 168 migrations; the numbers `0009`, `0119`, `0159` and `0160` are not used) applied in order to an empty SQLite database, then read back with `PRAGMA table_info` / `foreign_key_list` / `index_list`. `server/src/db/schema.ts` is the Drizzle model of only part of this (45 of the 75 tables), so it is not the source here; the migrations are. Row data is not modeled here (fresh installs only get the deterministic seed rows migrations insert, e.g. one `owners` row, builtin `pattern_types`, builtin `tags`, and the cron rows in `scheduled_jobs`). An existing database that was upgraded in place can list columns in a different order than a fresh one, because `ALTER TABLE ADD COLUMN` appends.

**75 tables** (74 business tables + `schema_migrations`). Primary-key columns are listed as not null. Compare against **v1** (`companion_db_data_dictionary.md`), which reflects a stale database snapshot only 46 migrations deep (through `0047`) and is superseded by this file.

## Q-phase changes (shipped: `0092`–`0094`)

| Ticket | Change | Table(s) |
|---|---|---|
| Q1 | FK enforcement (`foreign_keys = ON`) guaranteed on every connection — code-only, no schema change | n/a |
| Q2 | 10 new covering indexes on previously-unindexed FK columns (additive, `0092`) | see the Q2 table below; every index at head is in the full index table |
| Q3 | `owner_id` rebuilt to `TEXT NOT NULL` (was nullable) — composite PK can no longer admit a NULL/duplicate owner (`0093`) | `flight_plan` |
| Q4 | `owner_id` rebuilt to `TEXT NOT NULL`, bogus `DEFAULT 1` (integer, pre-UUID) dropped (`0094`) | `daily_summaries` (merged into `daily_recap` by `0096`, with `day_stars`) |
| Q5 | Post-migration `PRAGMA integrity_check` / `foreign_key_check` assertions + doc sync — test/doc-only | n/a |

## Q2 — new indexes (migration `0092`)

| Index | Table | Column(s) |
|---|---|---|
| `ix_time_blocks_task` | `time_blocks` | task_id |
| `ix_time_blocks_category` | `time_blocks` | category_id |
| `ix_reminders_task` | `reminders` | task_id |
| `ix_reminders_block` | `reminders` | block_id |
| `ix_tasks_parent` | `tasks` | parent_id |
| `ix_tasks_recurrence_parent` | `tasks` | recurrence_parent_id |
| `ix_job_runs_job` | `job_runs` | job_id |
| `ix_daily_plan_block` | `daily_plan` | block_id |
| `ix_possible_tasks_proposed_owner` | `possible_tasks` | proposed_owner_id |
| `ix_possible_tasks_promoted_task` | `possible_tasks` | promoted_task_id |

## Indexes at migration head `0172`

"(inline UNIQUE)" is a `UNIQUE` constraint declared in the `CREATE TABLE`; primary-key indexes are not listed.

| Index | Table | Column(s) | Unique | Partial (`WHERE`) |
|---|---|---|---|---|
| ix_api_keys_owner | api_keys | owner_id |  |  |
| ix_api_keys_prefix | api_keys | prefix |  |  |
| ix_audit_owner_at | audit_log | owner_id, at |  |  |
| (inline UNIQUE) | auth_states | state | yes |  |
| (inline UNIQUE) | balance_week_log | owner_id, week_start, category | yes |  |
| ix_block_templates_owner | block_templates | owner_id |  |  |
| ix_calibration_history_scope | calibration_history | owner_id, scope_kind, scope_ref, computed_date |  |  |
| ix_classification_log_owner_field_date | classification_log | owner_id, field, local_date |  |  |
| ix_classification_log_task | classification_log | task_id, field |  |  |
| (inline UNIQUE) | connection_prefs | owner_id, provider, account | yes |  |
| (inline UNIQUE) | connection_tokens | owner_id, provider, account | yes |  |
| ix_connection_tokens_owner | connection_tokens | owner_id |  |  |
| copy_history_owner_surface_id | copy_history | owner_id, surface, id |  |  |
| ix_daily_plan_block | daily_plan | block_id |  |  |
| ix_daily_plan_owner_date | daily_plan | owner_id, date, position |  |  |
| (inline UNIQUE) | day_types | owner_id, key | yes |  |
| ix_entity_categories_entity | entity_categories | entity_kind, entity_id |  |  |
| ix_entity_categories_tag | entity_categories | category_tag_id |  |  |
| ix_entity_people_entity | entity_people | entity_kind, entity_id, role |  |  |
| ix_entity_people_person | entity_people | person_id |  |  |
| idx_entity_tags_tag | entity_tags | tag_id |  |  |
| (inline UNIQUE) | external_events | provider, account, external_id | yes |  |
| ix_external_events_block | external_events | block_id |  |  |
| ix_external_events_owner | external_events | owner_id, provider, account |  |  |
| ix_job_runs_job | job_runs | job_id |  |  |
| (inline UNIQUE) | life_priorities | owner_id, category | yes |  |
| (inline UNIQUE) | oauth_states | state | yes |  |
| ix_oauth_states_state | oauth_states | state |  |  |
| ix_objective_tasks_id | objective_tasks | id | yes |  |
| ix_objective_tasks_task | objective_tasks | task_id |  |  |
| ix_objectives_owner | objectives | owner_id |  |  |
| ix_objectives_parent | objectives | owner_id, parent_id |  |  |
| ix_objectives_purge_after | objectives | purge_after |  |  |
| ix_objectives_source_task | objectives | source_task_id |  |  |
| (inline UNIQUE) | outbound_queue | block_id, provider, account | yes |  |
| ix_outbound_queue_owner | outbound_queue | owner_id, provider, account |  |  |
| ux_owners_external_subject | owners | external_subject | yes | `external_subject IS NOT NULL` |
| ux_owners_username | owners | username | yes | `username IS NOT NULL` |
| ix_reset_tokens_hash | password_reset_tokens | token_hash |  |  |
| ix_reset_tokens_owner | password_reset_tokens | owner_id |  |  |
| ix_pattern_blocks_owner_daytype | pattern_blocks | owner_id, day_type |  |  |
| ix_pattern_tasks_task | pattern_tasks | task_id |  |  |
| ux_pattern_types_owner_name | pattern_types | owner_id, name | yes |  |
| ix_patterns_owner_type | patterns | owner_id, type_id |  |  |
| ux_people_owner_account | people | owner_id, account_id | yes | `account_id IS NOT NULL` |
| ux_people_owner_name | people | owner_id, display_name | yes |  |
| ix_person_emails_person | person_emails | person_id |  |  |
| ix_placement_log_block | placement_log | block_id |  |  |
| ix_placement_log_owner_date | placement_log | owner_id, local_date, id |  |  |
| ix_plan_hints_owner_date | plan_hints | owner_id, date |  |  |
| ux_plan_hints_dedupe | plan_hints | owner_id, date, kind, tag, COALESCE(time, '') | yes |  |
| ix_plan_loop_runs_owner_at | plan_loop_runs | owner_id, at |  |  |
| ix_plan_revision_log_owner_at | plan_revision_log | owner_id, at |  |  |
| ix_plan_revision_log_run | plan_revision_log | run_id, iter |  |  |
| ix_planning_sessions_owner | planning_sessions | owner_id, started_at |  |  |
| ix_possible_outcome_log_owner_date | possible_outcome_log | owner_id, local_date |  |  |
| ix_possible_outcome_log_possible | possible_outcome_log | possible_task_id |  |  |
| ix_possible_task_people_possible | possible_task_people | possible_task_id |  |  |
| (inline UNIQUE) | possible_tasks | proposed_owner_id, source_kind, source_ref | yes |  |
| ix_possible_tasks_promoted_task | possible_tasks | promoted_task_id |  |  |
| ix_possible_tasks_proposed_owner | possible_tasks | proposed_owner_id |  |  |
| (inline UNIQUE) | push_subscriptions | endpoint | yes |  |
| ix_push_subscriptions_owner | push_subscriptions | owner_id |  |  |
| ix_reflections_owner_kind_period | reflections | owner_id, kind, period_key |  |  |
| ix_reminders_block | reminders | block_id |  |  |
| ix_reminders_due | reminders | status, fire_at |  |  |
| ix_reminders_task | reminders | task_id |  |  |
| (inline UNIQUE) | scheduled_jobs | name | yes |  |
| ix_scheduling_prefs_owner | scheduling_prefs | owner_id |  |  |
| (inline UNIQUE) | signup_codes | code_hash | yes |  |
| sync_events_owner_seq | sync_events | owner_id, seq |  |  |
| (inline UNIQUE) | sync_state | owner_id, provider, account, resource | yes |  |
| ix_sync_state_owner | sync_state | owner_id |  |  |
| idx_tag_categories_cat_int | tag_categories | category_tag_id, intention_tag_id |  |  |
| idx_tag_directions_dir_int | tag_directions | direction_tag_id, intention_tag_id |  |  |
| (inline UNIQUE) | tag_prefs | owner_id, tag_id | yes |  |
| ix_tag_prefs_owner | tag_prefs | owner_id |  |  |
| (inline UNIQUE) | tags | owner_id, name | yes |  |
| idx_tags_owner_kind_name_id | tags | owner_id, kind, name, id |  |  |
| idx_taskdeps_depends_on | task_dependencies | depends_on_id |  |  |
| idx_tasks_owner_status_sched | tasks | owner_id, status, scheduled_for |  |  |
| ix_task_owner_status_due | tasks | owner_id, status, due_at |  |  |
| ix_tasks_owner_score | tasks | owner_id, completion_score |  | `completion_score IS NOT NULL` |
| ix_tasks_parent | tasks | parent_id |  |  |
| ix_tasks_recurrence_parent | tasks | recurrence_parent_id |  |  |
| ux_task_occurrence | tasks | recurrence_parent_id, occurrence_date | yes | `recurrence_parent_id IS NOT NULL` |
| ux_tasks_ingest_source | tasks | source_kind, source_ref | yes | `source_kind IN ('gmail','gcal') AND source_ref IS NOT NULL` |
| ix_time_blocks_category | time_blocks | category_id |  |  |
| ix_time_blocks_owner_end | time_blocks | owner_id, end_at |  |  |
| ix_time_blocks_owner_start | time_blocks | owner_id, start_at |  |  |
| ix_time_blocks_parent | time_blocks | parent_block_id |  |  |
| ix_time_blocks_pattern_source | time_blocks | source_ref, start_at |  | `source_kind = 'pattern'` |
| ix_time_blocks_task | time_blocks | task_id |  |  |
| ux_block_occurrence | time_blocks | recurrence_parent_id, occurrence_date | yes | `recurrence_parent_id IS NOT NULL` |
| ux_time_blocks_ingest_source | time_blocks | source_kind, source_ref | yes | `source_kind IN ('gmail','gcal') AND source_ref IS NOT NULL` |
| ix_time_entries_task | time_entries | task_id |  |  |
| ux_time_entries_one_running | time_entries | owner_id | yes | `ended_at IS NULL` |
| ix_triality_log_owner_date | triality_log | owner_id, local_date |  |  |

## `api_keys`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| prefix | TEXT | yes |  |  |
| key_hash | TEXT | yes |  |  |
| scopes | TEXT | yes | [] |  |
| expires_at | TEXT |  |  |  |
| last_used_at | TEXT |  |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| revoked_at | TEXT |  |  |  |

## `app_config`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| key | TEXT | yes |  | PK |
| value | TEXT | yes |  |  |
| updated_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `audit_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| actor | TEXT | yes |  |  |
| action | TEXT | yes |  |  |
| entity | TEXT | yes |  |  |
| at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |

## `auth_states`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| state | TEXT | yes |  |  |
| code_verifier | TEXT | yes |  |  |
| nonce | TEXT | yes |  |  |
| redirect_uri | TEXT |  |  |  |
| created_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |
| expires_at | TEXT | yes |  |  |

## `balance_week_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| week_start | TEXT | yes |  |  |
| category | TEXT | yes |  |  |
| target_hours | INTEGER | yes |  |  |
| scheduled_minutes | INTEGER | yes |  |  |
| timed_minutes | INTEGER | yes |  |  |
| created_at | TEXT | yes |  |  |

## `block_templates`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| name | TEXT | yes |  |  |
| tag | TEXT |  |  |  |
| default_minutes | INTEGER |  | 60 |  |
| tasks | TEXT |  |  |  |

## `calibration_combo_pins`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| scope_ref | TEXT | yes |  | PK |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `calibration_history`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| scope_kind | TEXT | yes |  | PK |
| scope_ref | TEXT | yes |  | PK |
| computed_date | TEXT | yes |  | PK |
| sample_count | INTEGER | yes | 0 |  |
| bias_ratio | REAL |  |  |  |
| p25 | REAL |  |  |  |
| p50 | REAL |  |  |  |
| p75 | REAL |  |  |  |

## `category_direction_optouts`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| category_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| direction_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

## `classification_accuracy`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| field | TEXT | yes |  | PK |
| computed_date | TEXT | yes |  | PK |
| held_out | INTEGER | yes |  |  |
| correct | INTEGER | yes |  |  |
| accuracy | REAL |  |  |  |

## `classification_exemplars`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| field | TEXT | yes |  | PK |
| log_id | TEXT | yes |  | PK |
| input_text | TEXT | yes |  |  |
| llm_value | TEXT | yes |  |  |
| correct_value | TEXT | yes |  |  |
| embedding | BLOB |  |  |  |
| computed_date | TEXT | yes |  |  |

## `classification_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| task_id | TEXT |  |  |  |
| field | TEXT | yes |  |  |
| input_text | TEXT | yes |  |  |
| llm_value | TEXT | yes |  |  |
| final_value | TEXT |  |  |  |
| assigned_at | TEXT | yes |  |  |
| corrected_at | TEXT |  |  |  |
| local_date | TEXT | yes |  |  |

## `connection_prefs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| provider | TEXT | yes |  |  |
| account | TEXT | yes |  |  |
| color_token | TEXT | yes | primary |  |
| texture | TEXT | yes | none |  |

## `connection_tokens`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| provider | TEXT | yes |  |  |
| account | TEXT | yes |  |  |
| iv | TEXT | yes |  |  |
| auth_tag | TEXT | yes |  |  |
| ciphertext | TEXT | yes |  |  |
| key_version | INTEGER | yes | 1 |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| updated_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| status | TEXT | yes | active |  |

## `copy_history`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| surface | TEXT | yes |  |  |
| signature | TEXT | yes |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `daily_plan`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| date | TEXT | yes |  | PK |
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| position | INTEGER | yes |  |  |
| rationale | TEXT |  |  |  |
| source | TEXT | yes | deterministic |  |
| block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE SET NULL) |
| outcome | TEXT |  |  |  |

## `daily_recap`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| date | TEXT | yes |  | PK |
| prose | TEXT |  |  |  |
| stats | TEXT |  |  |  |
| focus | TEXT |  |  |  |
| llm | INTEGER |  |  |  |
| inputs_hash | TEXT |  |  |  |
| star_objective | INTEGER |  |  |  |
| star_habits | INTEGER |  |  |  |
| star_tasks | INTEGER |  |  |  |
| star_bonus | INTEGER |  |  |  |
| star_note | INTEGER |  |  |  |
| total | INTEGER |  |  |  |
| frozen_at | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| updated_at | TEXT |  | CURRENT_TIMESTAMP |  |

## `day_assignments`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| date | TEXT | yes |  | PK |
| day_type_key | TEXT | yes |  |  |

## `day_of_week_map`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| dow | INTEGER | yes |  | PK |
| day_type_key | TEXT | yes |  |  |

## `day_types`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| key | TEXT | yes |  |  |
| name | TEXT | yes |  |  |
| is_builtin | INTEGER | yes | 0 |  |

## `entity_categories`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| entity_kind | TEXT | yes |  | PK |
| entity_id | TEXT | yes |  | PK |
| category_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| position | INTEGER | yes | 0 |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `entity_people`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| entity_kind | TEXT | yes |  | PK |
| entity_id | TEXT | yes |  | PK |
| person_id | TEXT | yes |  | PK + FK→people.id (ON DELETE CASCADE) |
| role | TEXT | yes |  | PK |
| source | TEXT |  |  |  |
| position | INTEGER | yes | 0 |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `entity_tags`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| entity_kind | TEXT | yes |  | PK |
| entity_id | TEXT | yes |  | PK |
| tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| level | INTEGER | yes | 1 |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `estimate_calibration`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| scope_kind | TEXT | yes | global | PK |
| scope_ref | TEXT | yes |  | PK |
| computed_at | TEXT | yes |  |  |
| sample_count | INTEGER | yes | 0 |  |
| bias_ratio | REAL |  |  |  |
| p25 | REAL |  |  |  |
| p50 | REAL |  |  |  |
| p75 | REAL |  |  |  |

## `external_events`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| provider | TEXT | yes |  |  |
| account | TEXT | yes |  |  |
| external_id | TEXT | yes |  |  |
| block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE CASCADE) |
| etag | TEXT |  |  |  |
| direction | TEXT | yes | inbound |  |
| last_synced_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |

## `flight_plan`

 — **Q3 rebuild**: `owner_id` is `TEXT NOT NULL` (composite PK column; it was nullable before `0093`).

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE NO ACTION) |
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| selected | INTEGER |  | 1 |  |
| position | INTEGER |  | 0 |  |
| added_at | TEXT |  | CURRENT_TIMESTAMP |  |
| source_kind | TEXT | yes | manual |  |
| source_ref | TEXT |  |  |  |

## `job_runs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| job_id | TEXT |  |  | FK→scheduled_jobs.id (ON DELETE NO ACTION) |
| started_at | TEXT |  | CURRENT_TIMESTAMP |  |
| finished_at | TEXT |  |  |  |
| status | TEXT |  | running |  |
| items_created | INTEGER |  | 0 |  |
| items_updated | INTEGER |  | 0 |  |
| log | TEXT |  |  |  |

## `life_priorities`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| category | TEXT | yes |  |  |
| satisfaction | INTEGER | yes | 5 |  |
| importance | INTEGER | yes | 5 |  |
| target_hours_per_week | INTEGER | yes | 0 |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| updated_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `oauth_states`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| provider | TEXT | yes | google |  |
| state | TEXT | yes |  |  |
| code_verifier | TEXT | yes |  |  |
| nonce | TEXT |  |  |  |
| redirect_uri | TEXT |  |  |  |
| created_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |
| expires_at | TEXT |  |  |  |

## `objective_tasks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| objective_id | TEXT | yes |  | PK + FK→objectives.id (ON DELETE CASCADE) |
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| id | TEXT |  |  |  |
| linked | INTEGER | yes | 1 |  |
| version | INTEGER | yes | 1 |  |
| updated_at | TEXT |  |  |  |
| field_ts | TEXT |  |  |  |

## `objectives`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| parent_id | TEXT |  |  | FK→objectives.id (ON DELETE SET NULL) |
| level | TEXT | yes | goal |  |
| horizon | TEXT | yes | none |  |
| title | TEXT | yes |  |  |
| description | TEXT |  |  |  |
| target_date | TEXT |  |  |  |
| status | TEXT | yes | active |  |
| category_id | TEXT |  |  | FK→tags.id (ON DELETE SET NULL) |
| progress_cache | REAL |  |  |  |
| cadence | TEXT | yes | none |  |
| last_advanced_at | TEXT |  |  |  |
| priority | INTEGER |  | 3 |  |
| created_at | TEXT | yes |  |  |
| updated_at | TEXT | yes |  |  |
| completed_at | TEXT |  |  |  |
| source_task_id | TEXT |  |  |  |
| version | INTEGER | yes | 1 |  |
| field_ts | TEXT |  |  |  |
| archived_at | TEXT |  |  |  |
| archive_root_id | TEXT |  |  |  |
| purge_after | TEXT |  |  |  |
| color_token | TEXT |  |  |  |

## `outbound_queue`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| block_id | TEXT | yes |  | FK→time_blocks.id (ON DELETE CASCADE) |
| provider | TEXT | yes |  |  |
| account | TEXT | yes |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `owners`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| name | TEXT | yes |  |  |
| email | TEXT |  |  |  |
| last_auto_run_id | TEXT |  |  |  |
| external_subject | TEXT |  |  |  |
| username | TEXT |  |  |  |
| password_hash | TEXT |  |  |  |
| backup_email | TEXT |  |  |  |
| session_epoch | INTEGER | yes | 0 |  |
| role | TEXT | yes | member |  |

## `password_reset_tokens`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| token_hash | TEXT | yes |  |  |
| expires_at | TEXT | yes |  |  |
| used_at | TEXT |  |  |  |
| created_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |

## `pattern_blocks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| direction_tag_id | TEXT | yes |  | FK→tags.id (ON DELETE CASCADE) |
| day_type | TEXT | yes |  |  |
| start_time | TEXT | yes |  |  |
| end_time | TEXT | yes |  |  |

## `pattern_day_optouts`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE NO ACTION) |
| pattern_id | TEXT | yes |  | PK + FK→patterns.id (ON DELETE CASCADE) |
| date | TEXT | yes |  | PK |

## `pattern_tasks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| pattern_id | TEXT | yes |  | PK + FK→patterns.id (ON DELETE CASCADE) |
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| position | INTEGER |  | 0 |  |

## `pattern_types`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| name | TEXT | yes |  |  |
| icon_shape | TEXT | yes |  |  |
| reminder_config | TEXT |  |  |  |
| is_builtin | INTEGER |  | 0 |  |
| color_token | TEXT |  |  |  |
| texture | TEXT |  |  |  |
| default_est_minutes | INTEGER |  |  |  |
| notify | INTEGER |  | 0 |  |
| catch_all | INTEGER | yes | 0 |  |

## `patterns`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| type_id | TEXT |  |  | FK→pattern_types.id (ON DELETE NO ACTION) |
| name | TEXT | yes |  |  |
| tag | TEXT |  |  |  |
| notes | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| recurrence_rule | TEXT |  |  |  |
| recurrence_dtstart | TEXT |  |  |  |
| color_token | TEXT |  |  |  |

## `people`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| account_id | TEXT |  |  | FK→owners.id (ON DELETE SET NULL) |
| display_name | TEXT | yes |  |  |
| confirmed | INTEGER | yes | 1 |  |
| source | TEXT |  |  |  |
| notes | TEXT |  |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `person_emails`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| person_id | TEXT | yes |  | FK→people.id (ON DELETE CASCADE) |
| email | TEXT | yes |  | PK |

## `placement_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| block_id | TEXT |  |  |  |
| task_id | TEXT |  |  |  |
| slot_key | TEXT | yes |  |  |
| auto_run_id | TEXT |  |  |  |
| chosen_start_at | TEXT | yes |  |  |
| chosen_end_at | TEXT | yes |  |  |
| chosen_hour | INTEGER | yes |  |  |
| fit | INTEGER | yes |  |  |
| candidates | TEXT | yes |  |  |
| moved_start_at | TEXT |  |  |  |
| moved_end_at | TEXT |  |  |  |
| moved_hour | INTEGER |  |  |  |
| placed_at | TEXT | yes |  |  |
| moved_at | TEXT |  |  |  |
| local_date | TEXT | yes |  |  |

## `placement_preferences`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| slot_key | TEXT | yes |  | PK |
| p25_hour | REAL | yes |  |  |
| p75_hour | REAL | yes |  |  |
| corrections | INTEGER | yes |  |  |
| sample_count | INTEGER | yes |  |  |
| computed_date | TEXT | yes |  |  |

## `placement_survival`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| computed_date | TEXT | yes |  | PK |
| period_days | INTEGER | yes |  |  |
| decided | INTEGER | yes |  |  |
| accepted | INTEGER | yes |  |  |
| corrected | INTEGER | yes |  |  |
| survival_rate | REAL |  |  |  |
| keys_learned | INTEGER | yes |  |  |
| biased | INTEGER | yes |  |  |

## `plan_hints`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| date | TEXT | yes |  |  |
| kind | TEXT | yes |  |  |
| tag | TEXT | yes |  |  |
| time | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

## `plan_loop_runs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| stage | TEXT | yes |  |  |
| passed | INTEGER | yes |  |  |
| escaped | INTEGER | yes |  |  |
| escape_reason | TEXT |  |  |  |
| score | REAL | yes |  |  |
| iterations | INTEGER | yes |  |  |
| at | TEXT | yes |  |  |

## `plan_loop_stats`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| stage | TEXT | yes |  | PK |
| computed_date | TEXT | yes |  | PK |
| period_days | INTEGER | yes |  |  |
| runs | INTEGER | yes |  |  |
| passed | INTEGER | yes |  |  |
| escaped | INTEGER | yes |  |  |
| first_try_pass | INTEGER | yes |  |  |
| avg_iterations | REAL |  |  |  |
| pass_rate | REAL |  |  |  |

## `plan_revision_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| run_id | TEXT | yes |  |  |
| stage | TEXT | yes |  |  |
| iter | INTEGER | yes |  |  |
| score | REAL | yes |  |  |
| reason | TEXT | yes |  |  |
| defects | TEXT | yes |  |  |
| critique | TEXT | yes |  |  |
| candidate | TEXT |  |  |  |
| at | TEXT | yes |  |  |

## `planning_sessions`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| started_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |
| ended_at | TEXT |  |  |  |
| entry_branch | TEXT | yes |  |  |
| status | TEXT | yes | open |  |
| llm_used | INTEGER | yes | 0 |  |
| transcript | TEXT | yes | [] |  |
| summary | TEXT |  |  |  |
| created_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |

## `possible_dismissal_exemplars`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| log_id | TEXT | yes |  | PK |
| input_text | TEXT | yes |  |  |
| source_kind | TEXT |  |  |  |
| embedding | BLOB |  |  |  |
| computed_date | TEXT | yes |  |  |

## `possible_dismissal_rate`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| computed_date | TEXT | yes |  | PK |
| period_days | INTEGER | yes |  |  |
| created | INTEGER | yes |  |  |
| decided | INTEGER | yes |  |  |
| dismissed | INTEGER | yes |  |  |
| rate | REAL |  |  |  |
| exemplars | INTEGER | yes |  |  |
| hinted | INTEGER | yes |  |  |

## `possible_outcome_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| possible_task_id | TEXT |  |  |  |
| source_kind | TEXT |  |  |  |
| input_text | TEXT | yes |  |  |
| outcome | TEXT | yes |  |  |
| decided_at | TEXT | yes |  |  |
| local_date | TEXT | yes |  |  |

## `possible_task_people`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| possible_task_id | TEXT | yes |  | PK + FK→possible_tasks.id (ON DELETE CASCADE) |
| person_id | TEXT | yes |  | PK + FK→people.id (ON DELETE CASCADE) |
| role | TEXT | yes |  | PK |
| source | TEXT |  |  |  |
| confidence | REAL |  |  |  |

## `possible_task_tags`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| possible_task_id | TEXT | yes |  | PK + FK→possible_tasks.id (ON DELETE CASCADE) |
| tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

## `possible_tasks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| raw_title | TEXT | yes |  |  |
| raw_summary | TEXT |  |  |  |
| proposed_due_at | TEXT |  |  |  |
| proposed_priority | INTEGER |  |  |  |
| proposed_owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| source_kind | TEXT |  |  |  |
| source_ref | TEXT |  |  |  |
| source_payload | TEXT |  |  |  |
| confidence | REAL |  |  |  |
| status | TEXT |  | pending |  |
| promoted_task_id | TEXT |  |  | FK→tasks.id (ON DELETE NO ACTION) |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| proposed_estimated_minutes | INTEGER |  |  |  |
| proposed_scheduled_for | TEXT |  |  |  |
| proposed_task_time | TEXT |  |  |  |

## `push_subscriptions`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| endpoint | TEXT | yes |  |  |
| p256dh | TEXT | yes |  |  |
| auth | TEXT | yes |  |  |
| user_agent | TEXT |  |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

## `reflections`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| kind | TEXT | yes |  | PK |
| period_key | TEXT | yes |  | PK |
| position | INTEGER | yes | 0 | PK |
| body | TEXT | yes |  |  |
| category_id | TEXT |  |  | FK→tags.id (ON DELETE SET NULL) |
| done_at | TEXT |  |  |  |
| created_at | TEXT | yes |  |  |
| updated_at | TEXT | yes |  |  |
| source_kind | TEXT | yes | manual |  |
| source_ref | TEXT |  |  |  |

## `reminders`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| task_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE CASCADE) |
| fire_at | TEXT | yes |  |  |
| status | TEXT | yes | pending |  |
| fired_at | TEXT |  |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| source | TEXT | yes | manual |  |

## `replan_suggestions`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| date | TEXT | yes |  |  |
| reason | TEXT | yes |  |  |
| summary | TEXT | yes |  |  |
| at_risk | INTEGER | yes |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

## `scheduled_jobs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| name | TEXT | yes |  |  |
| kind | TEXT | yes |  |  |
| cron | TEXT | yes |  |  |
| enabled | INTEGER |  | 1 |  |
| last_run_at | TEXT |  |  |  |
| next_run_at | TEXT |  |  |  |
| config | TEXT |  |  |  |

## `scheduling_prefs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| workday_start | TEXT |  | 09:00 |  |
| workday_end | TEXT |  | 18:00 |  |
| deep_work_windows | TEXT |  |  |  |
| max_focus_block_minutes | INTEGER |  | 90 |  |
| min_break_minutes | INTEGER |  | 10 |  |
| day_theme | TEXT |  |  |  |
| planning_mode | TEXT |  | basic |  |
| timezone | TEXT |  |  |  |
| planning_horizon_days | INTEGER |  | 7 |  |
| fast_model | TEXT |  |  |  |
| quality_model | TEXT |  |  |  |
| embed_model | TEXT |  |  |  |
| memory_sync_enabled | INTEGER |  | 0 |  |
| memory_sync_completed | INTEGER |  | 1 |  |
| memory_sync_habits | INTEGER |  | 1 |  |
| memory_sync_reflections | INTEGER |  | 1 |  |
| memory_account | TEXT |  |  |  |
| memory_last_synced_at | TEXT |  |  |  |
| max_time_block_minutes | INTEGER |  | 240 |  |
| min_time_block_minutes | INTEGER |  | 15 |  |
| plan_allday_always | INTEGER |  | 0 |  |
| plan_daylong_for_promoted | INTEGER |  | 0 |  |
| plan_autofill_gaps | INTEGER |  | 1 |  |
| concept_default_minutes | INTEGER |  | 60 |  |
| concept_autosurface | INTEGER |  | 1 |  |
| concept_horizon_days | INTEGER |  | 30 |  |
| concept_tags | TEXT |  |  |  |
| enable_rituals | INTEGER |  | 0 |  |
| auto_fill_workday | INTEGER |  | 1 |  |
| recall_keeps_pattern | INTEGER |  | 0 |  |
| fill_order | TEXT | yes | priority |  |
| auto_defense_enabled | INTEGER | yes | 1 |  |
| trust_mode | TEXT | yes | balanced |  |
| default_time_block_minutes | INTEGER |  | 60 |  |
| enable_routines | INTEGER |  | 0 |  |
| recurrence_horizon_days | INTEGER |  | 7 |  |
| time_sense_enabled | INTEGER |  | 0 |  |
| focus_ritual_enabled | INTEGER |  | 1 |  |
| haptic_cues_enabled | INTEGER |  | 1 |  |
| ambient_color_enabled | INTEGER |  | 1 |  |
| calibration_loop_enabled | INTEGER |  | 1 |  |
| z_experiment_arm | TEXT |  |  |  |
| view_prefs | TEXT |  |  |  |
| memory_pull_enabled | INTEGER |  | 0 |  |
| sleep_hours_per_week | INTEGER | yes | 63 |  |
| onboarded_at | TEXT |  |  |  |
| triality_enabled | INTEGER |  | 0 |  |
| memory_window_days | INTEGER | yes | 2 |  |
| email_lookback_days | INTEGER | yes | 7 |  |
| llm_thinking_enabled | INTEGER |  | 0 |  |
| capacity_hours_per_week | INTEGER | yes | 56 |  |
| balance_bias_enabled | INTEGER | yes | 1 |  |

## `schema_migrations`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| applied_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| checksum | TEXT |  |  |  |

## `signup_codes`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| code_hash | TEXT | yes |  |  |
| note | TEXT |  |  |  |
| created_by | TEXT |  |  | FK→owners.id (ON DELETE SET NULL) |
| created_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |
| expires_at | TEXT | yes |  |  |
| used_at | TEXT |  |  |  |
| used_by | TEXT |  |  | FK→owners.id (ON DELETE SET NULL) |
| revoked_at | TEXT |  |  |  |

## `sync_events`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| seq | INTEGER | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| entity | TEXT | yes |  |  |
| entity_id | TEXT | yes |  |  |
| version | INTEGER |  |  |  |
| event | TEXT | yes |  |  |
| payload | TEXT | yes |  |  |
| at | TEXT | yes |  |  |

## `sync_state`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| provider | TEXT | yes |  |  |
| account | TEXT | yes |  |  |
| resource | TEXT | yes |  |  |
| cursor | TEXT |  |  |  |
| updated_at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |

## `tag_categories`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| intention_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| category_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

## `tag_directions`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| intention_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| direction_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

## `tag_prefs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| tag_id | TEXT | yes |  | FK→tags.id (ON DELETE CASCADE) |
| kind | TEXT | yes |  |  |
| auto_fill | INTEGER |  |  |  |
| reminder_offsets | TEXT |  |  |  |
| icon_shape | TEXT |  |  |  |
| color_token | TEXT | yes | primary |  |
| default_minutes | INTEGER | yes | 60 |  |
| show_open_time | INTEGER | yes | 1 |  |

## `tags`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| name | TEXT | yes |  |  |
| kind | TEXT | yes | intention |  |
| muted | INTEGER | yes | 0 |  |
| is_base | INTEGER | yes | 0 |  |

## `task_dependencies`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| depends_on_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

## `tasks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| title | TEXT | yes |  |  |
| description | TEXT |  |  |  |
| notes | TEXT |  |  |  |
| due_at | TEXT |  |  |  |
| task_time | TEXT |  |  |  |
| estimated_minutes | INTEGER |  |  |  |
| priority | INTEGER |  | 3 |  |
| status | TEXT |  | open |  |
| parent_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| source_kind | TEXT |  | manual |  |
| source_ref | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| completed_at | TEXT |  |  |  |
| scheduled_for | TEXT |  |  |  |
| defer_until | TEXT |  |  |  |
| actual_minutes | INTEGER | yes | 0 |  |
| recurrence_rule | TEXT |  |  |  |
| recurrence_parent_id | TEXT |  |  | FK→tasks.id (ON DELETE NO ACTION) |
| recurrence_dtstart | TEXT |  |  |  |
| recurrence_exdates | TEXT |  |  |  |
| occurrence_date | TEXT |  |  |  |
| defer_count | INTEGER |  | 0 |  |
| subtype | TEXT |  | standard |  |
| version | INTEGER | yes | 1 |  |
| updated_at | TEXT |  |  |  |
| field_ts | TEXT |  |  |  |
| texture_enabled | INTEGER | yes | 1 |  |
| texture_color_token | TEXT |  |  |  |
| completion_note | TEXT |  |  |  |
| reaction_at | TEXT |  |  |  |
| motivation | TEXT |  |  |  |
| motivation_source | TEXT |  |  |  |
| completion_score | INTEGER |  |  |  |

## `time_blocks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| task_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| title | TEXT | yes |  |  |
| block_kind | TEXT |  | task |  |
| start_at | TEXT | yes |  |  |
| end_at | TEXT | yes |  |  |
| is_locked | INTEGER |  | 0 |  |
| is_auto | INTEGER |  | 1 |  |
| source_kind | TEXT |  | manual |  |
| source_ref | TEXT |  |  |  |
| status | TEXT |  | planned |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| all_day | INTEGER |  | 0 |  |
| tag | TEXT |  |  |  |
| block_type | TEXT |  |  |  |
| goal_start_date | TEXT |  |  |  |
| duration_minutes | INTEGER |  |  |  |
| note | TEXT |  |  |  |
| parent_block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE SET NULL) |
| recurrence_rule | TEXT |  |  |  |
| recurrence_dtstart | TEXT |  |  |  |
| recurrence_parent_id | TEXT |  |  |  |
| occurrence_date | TEXT |  |  |  |
| auto_run_id | TEXT |  |  |  |
| last_moved_at | TEXT |  |  |  |
| category_id | TEXT |  |  | FK→tags.id (ON DELETE SET NULL) |
| color_token | TEXT |  |  |  |
| recurrence_exdates | TEXT |  |  |  |
| version | INTEGER | yes | 1 |  |
| updated_at | TEXT |  |  |  |
| field_ts | TEXT |  |  |  |
| texture_enabled | INTEGER | yes | 1 |  |
| texture_color_token | TEXT |  |  |  |
| responsible_pinned | INTEGER | yes | 0 |  |
| beneficiaries_pinned | INTEGER | yes | 0 |  |

## `time_entries`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| task_id | TEXT | yes |  | FK→tasks.id (ON DELETE CASCADE) |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE SET NULL) |
| started_at | TEXT | yes |  |  |
| ended_at | TEXT |  |  |  |
| source | TEXT |  | timer |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

## `triality_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| shown_at | TEXT | yes |  |  |
| local_date | TEXT | yes |  |  |
| slot | TEXT | yes |  |  |
| action_kind | TEXT | yes |  |  |
| action_ref | TEXT | yes |  |  |
| scores | TEXT | yes |  |  |
| outcome | TEXT | yes | shown |  |
| outcome_at | TEXT |  |  |  |
| confidence | TEXT |  |  |  |

## `triality_weights`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| slot | TEXT | yes |  | PK |
| weights | TEXT | yes |  |  |
| sample_count | INTEGER | yes | 0 |  |
| computed_date | TEXT | yes |  |  |
