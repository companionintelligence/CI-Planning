# companion.db — Data Dictionary v2 (EXPECTED state after Phase Q)

This is a **reconstructed reference schema**, not a live database dump. It represents what `server/src/db/schema.ts` + all migrations (`0001`-`0091`, current `main`) PLUS the planned Phase Q migrations (`0092`-`0094`, per [`docs/Q-schema-hygiene.md`](Q-schema-hygiene.md)) should produce once implemented. Built by reading `schema.ts` and every migration file directly (no live `companion.db` was queried — see note in chat). Use this to check the Q implementation against: table/column shape should match; row data is not modeled here (fresh installs only get the deterministic seed rows migrations insert, e.g. one `owners` row, builtin `pattern_types`, builtin `tags`, and the cron rows in `scheduled_jobs`).

**48 tables** (47 business tables + `schema_migrations`). Compare against **v1** (`companion_db_data_dictionary.md`), which reflects a stale database snapshot only 46 migrations deep (through `0047`).

## Q-phase changes reflected here

| Ticket | Change | Table(s) |
|---|---|---|
| Q1 | FK enforcement (`foreign_keys = ON`) guaranteed on every connection — code-only, no schema change | n/a |
| Q2 | 10 new covering indexes on previously-unindexed FK columns (additive, `0092`) | see index table below |
| Q3 | `owner_id` rebuilt to `TEXT NOT NULL` (was nullable) — composite PK can no longer admit a NULL/duplicate owner (`0093`) | `flight_plan` |
| Q4 | `owner_id` rebuilt to `TEXT NOT NULL`, bogus `DEFAULT 1` (integer, pre-UUID) dropped (`0094`) | `daily_summaries` |
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

## `audit_log`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| actor | TEXT | yes |  |  |
| action | TEXT | yes |  |  |
| entity | TEXT | yes |  |  |
| at | TEXT | yes |  |  |

## `block_templates`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| name | TEXT | yes |  |  |
| tag | TEXT |  |  |  |
| default_minutes | INTEGER |  | 60 |  |
| tasks | TEXT |  |  |  |

## `category_direction_optouts`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| category_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| pattern_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

## `category_prefs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| category_tag_id | TEXT | yes |  | FK→tags.id (ON DELETE CASCADE) |
| color_token | TEXT | yes | primary |  |
| default_minutes | INTEGER | yes | 60 |  |

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
| status | TEXT | yes | active |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| updated_at | TEXT | yes | CURRENT_TIMESTAMP |  |

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

## `daily_summaries`

 — **Q4 rebuild**: `owner_id` is now `TEXT NOT NULL` with no default (previously `INTEGER DEFAULT 1`, a stale pre-UUID artifact).

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE NO ACTION) |
| date | TEXT | yes |  | PK |
| prose | TEXT | yes |  |  |
| stats | TEXT | yes |  |  |
| focus | TEXT | yes | [] |  |
| llm | INTEGER | yes | 0 |  |
| inputs_hash | TEXT | yes |  |  |
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

## `day_stars`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| date | TEXT | yes |  | PK |
| star_objective | INTEGER | yes | 0 |  |
| star_habits | INTEGER | yes | 0 |  |
| star_tasks | INTEGER | yes | 0 |  |
| star_bonus | INTEGER | yes | 0 |  |
| star_note | INTEGER | yes | 0 |  |
| total | INTEGER | yes | 0 |  |
| frozen_at | TEXT | yes |  |  |

## `day_types`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE CASCADE) |
| key | TEXT | yes |  |  |
| name | TEXT | yes |  |  |
| is_builtin | INTEGER | yes | 0 |  |

## `entity_tags`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| entity_kind | TEXT | yes |  | PK |
| entity_id | TEXT | yes |  | PK |
| tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| level | INTEGER | yes | 1 |  |

## `estimate_calibration`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
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
| last_synced_at | TEXT | yes | now |  |

## `flight_plan`

 — **Q3 rebuild**: `owner_id` is now `TEXT NOT NULL` (composite PK column, previously nullable).

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE NO ACTION) |
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| source_kind | TEXT |  | manual |  |
| source_ref | TEXT |  |  |  |
| selected | INTEGER |  | 1 |  |
| position | INTEGER |  | 0 |  |
| added_at | TEXT |  | CURRENT_TIMESTAMP |  |

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
| created_at | TEXT | yes | now |  |
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

## `pattern_blocks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| pattern_tag_id | TEXT | yes |  | FK→tags.id (ON DELETE CASCADE) |
| day_type | TEXT | yes |  |  |
| start_time | TEXT | yes |  |  |
| end_time | TEXT | yes |  |  |

## `pattern_day_optouts`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE NO ACTION) |
| pattern_id | TEXT | yes |  | PK + FK→patterns.id (ON DELETE CASCADE) |
| date | TEXT | yes |  | PK |

## `pattern_prefs`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| pattern_tag_id | TEXT | yes |  | FK→tags.id (ON DELETE CASCADE) |
| auto_fill | INTEGER | yes | 1 |  |
| reminder_offsets | TEXT | yes | [] |  |
| icon_shape | TEXT | yes | circle |  |
| color_token | TEXT | yes | primary |  |
| default_minutes | INTEGER | yes | 60 |  |

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
| recurrence_rule | TEXT |  |  |  |
| recurrence_dtstart | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

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

## `plan_outcomes`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes |  | PK + FK→owners.id (ON DELETE CASCADE) |
| date | TEXT | yes |  | PK |
| planned | INTEGER | yes | 0 |  |
| completed | INTEGER | yes | 0 |  |

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

## `push_subscriptions`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| endpoint | TEXT | yes |  |  |
| p256dh | TEXT | yes |  |  |
| auth | TEXT | yes |  |  |
| user_agent | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

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
| source | TEXT | yes | manual |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

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
| recurrence_horizon_days | INTEGER |  | 7 |  |
| max_time_block_minutes | INTEGER |  | 240 |  |
| min_time_block_minutes | INTEGER |  | 15 |  |
| default_time_block_minutes | INTEGER |  | 60 |  |
| plan_allday_always | INTEGER |  | 0 |  |
| plan_daylong_for_promoted | INTEGER |  | 0 |  |
| plan_autofill_gaps | INTEGER |  | 1 |  |
| auto_fill_workday | INTEGER |  | 1 |  |
| auto_mode | TEXT | yes | suggest |  |
| trust_mode | TEXT | yes | balanced |  |
| fill_order | TEXT | yes | priority |  |
| concept_default_minutes | INTEGER |  | 60 |  |
| concept_autosurface | INTEGER |  | 1 |  |
| concept_horizon_days | INTEGER |  | 30 |  |
| concept_tags | TEXT |  |  |  |
| enable_rituals | INTEGER |  | 0 |  |
| enable_routines | INTEGER |  | 0 |  |
| recall_keeps_pattern | INTEGER |  | 0 |  |
| fast_model | TEXT |  |  |  |
| quality_model | TEXT |  |  |  |
| embed_model | TEXT |  |  |  |
| memory_sync_enabled | INTEGER |  | 0 |  |
| memory_sync_completed | INTEGER |  | 1 |  |
| memory_sync_habits | INTEGER |  | 1 |  |
| memory_sync_reflections | INTEGER |  | 1 |  |
| memory_account | TEXT |  |  |  |
| memory_last_synced_at | TEXT |  |  |  |
| auto_defense_enabled | INTEGER | yes | 1 |  |

## `schema_migrations`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| applied_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| checksum | TEXT |  |  |  |

## `sync_events`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| seq | INTEGER | yes |  | PK |
| owner_id | TEXT | yes |  |  |
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
| updated_at | TEXT | yes | now |  |

## `tag_categories`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| intention_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| category_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

## `tag_patterns`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| intention_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| pattern_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

## `tags`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
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
| scheduled_for | TEXT |  |  |  |
| defer_until | TEXT |  |  |  |
| task_time | TEXT |  |  |  |
| estimated_minutes | INTEGER |  |  |  |
| actual_minutes | INTEGER | yes | 0 |  |
| priority | INTEGER |  | 3 |  |
| status | TEXT |  | open |  |
| parent_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| recurrence_rule | TEXT |  |  |  |
| recurrence_parent_id | TEXT |  |  | FK→tasks.id (ON DELETE NO ACTION) |
| recurrence_dtstart | TEXT |  |  |  |
| recurrence_exdates | TEXT |  |  |  |
| occurrence_date | TEXT |  |  |  |
| subtype | TEXT |  | standard |  |
| defer_count | INTEGER | yes | 0 |  |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| source_kind | TEXT |  | manual |  |
| source_ref | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| completed_at | TEXT |  |  |  |
| version | INTEGER | yes | 1 |  |
| updated_at | TEXT |  |  |  |
| field_ts | TEXT |  |  |  |

## `time_blocks`

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| task_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| title | TEXT | yes |  |  |
| block_kind | TEXT |  | task |  |
| tag | TEXT |  |  |  |
| block_type | TEXT |  |  |  |
| goal_start_date | TEXT |  |  |  |
| duration_minutes | INTEGER |  |  |  |
| note | TEXT |  |  |  |
| start_at | TEXT | yes |  |  |
| end_at | TEXT | yes |  |  |
| is_locked | INTEGER |  | 0 |  |
| is_auto | INTEGER |  | 1 |  |
| all_day | INTEGER |  | 0 |  |
| source_kind | TEXT |  | manual |  |
| source_ref | TEXT |  |  |  |
| status | TEXT |  | planned |  |
| parent_block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE SET NULL) |
| category_id | TEXT |  |  | FK→tags.id (ON DELETE SET NULL) |
| color_token | TEXT |  |  |  |
| recurrence_rule | TEXT |  |  |  |
| recurrence_dtstart | TEXT |  |  |  |
| recurrence_parent_id | TEXT |  |  |  |
| recurrence_exdates | TEXT |  |  |  |
| occurrence_date | TEXT |  |  |  |
| auto_run_id | TEXT |  |  |  |
| last_moved_at | TEXT |  |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| version | INTEGER | yes | 1 |  |
| updated_at | TEXT |  |  |  |
| field_ts | TEXT |  |  |  |

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