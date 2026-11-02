# companion.db — Data Dictionary

> **Superseded.** This is a snapshot of an old database (migrations through `0047`, 25 tables). For the current schema (migration head `0172`, 75 tables) see [companion_db_data_dictionary_v2.md](companion_db_data_dictionary_v2.md).

Generated from live database. 25 tables.


## `audit_log`  (141 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT |  |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| actor | TEXT | yes |  |  |
| action | TEXT | yes |  |  |
| entity | TEXT | yes |  |  |
| at | TEXT | yes | strftime('%Y-%m-%dT%H:%M:%fZ','now') |  |

| id | owner_id | actor | action | entity | at |
|---|---|---|---|---|---|
| 019ef2f1-4a4a-76bb-903a-a98deb3a2401 | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:26:00.010Z |
| 019ef2f2-34a7-70a1-a26e-b2034adddefb | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:27:00.006Z |
| 019ef2f3-1f04-79ac-9ef5-f1fa5b2a3fbe | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:28:00.004Z |
| 019ef2f4-0966-7084-8fa1-55f427953393 | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:29:00.006Z |
| 019ef2f4-f3c1-7697-9a04-4150c3a981fa | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:30:00.000Z |
| 019ef2f5-de27-7479-a249-2a0e0f4af4ec | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:31:00.006Z |
| 019ef2f6-c88e-7f1c-a6d3-c7dbac11d0b6 | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:32:00.013Z |
| 019ef2f7-b2ec-7d34-8792-3127796fa8f2 | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:33:00.011Z |
| 019ef2f8-9d4e-7a71-992d-165509ed1ced | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:34:00.013Z |
| 019ef2f9-87a8-71a8-901a-6dd35d5c1e1f | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:35:00.008Z |
| 019ef2fa-7209-74e2-9b0e-51de5ad0920e | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:36:00.009Z |
| 019ef2fb-5c6d-7562-b366-3f90de1c018a | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:37:00.013Z |
| 019ef2fc-46ce-7215-aa84-f54c08f63dad | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:38:00.014Z |
| 019ef2fd-3128-7e39-ad5e-0a0a6c903f2b | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:39:00.007Z |
| 019ef2fe-1b8d-7e29-a834-d0fb07fc4737 | 00000000-0000-7000-8000-000000000001 | system | job | job:fire_reminders | 2026-06-23T05:40:00.013Z |

_...126 more row(s) not shown._


## `block_templates`  (0 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| name | TEXT | yes |  |  |
| tag | TEXT |  |  |  |
| default_minutes | INTEGER |  | 60 |  |
| tasks | TEXT |  |  |  |

_No rows._


## `daily_summaries`  (3 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT | yes | 1 | PK + FK→owners.id (ON DELETE NO ACTION) |
| date | TEXT | yes |  | PK |
| prose | TEXT | yes |  |  |
| stats | TEXT | yes |  |  |
| focus | TEXT | yes | '[]' |  |
| llm | INTEGER | yes | 0 |  |
| inputs_hash | TEXT | yes |  |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| updated_at | TEXT |  | CURRENT_TIMESTAMP |  |

| owner_id | date | prose | stats | focus | llm | inputs_hash | created_at | updated_at |
|---|---|---|---|---|---|---|---|---|
| 00000000-0000-7000-8000-000000000001 | 2026-06-22 | Plan for 2026-06-22: • 1 due today, starting with "Check ... | {"overdue":0,"dueToday":1,"open":25,"blocks":5} | [{"taskId":"019ef311-3c11-7b23-a4aa-d248dc4427fe","title"... | 0 | 45f704d14618cc9a67c44d31464f6620e8ba402f2d0b4babd5f130c01... | 2026-06-23 05:48:35 | 2026-06-23 06:52:44 |
| 00000000-0000-7000-8000-000000000001 | 2026-06-23 | Plan for 2026-06-23: • 1 overdue item(s) — top: "Check we... | {"overdue":1,"dueToday":1,"open":25,"blocks":1} | [{"taskId":"019ef311-3c11-7b23-a4aa-d248dc4427fe","title"... | 0 | 9d7ba3a033efa70bd9360fdacfc421a4ea2c912ebcb24ee36239ffbad... | 2026-06-23 06:45:21 | 2026-06-23 06:45:21 |
| 00000000-0000-7000-8000-000000000001 | 2026-06-24 | Plan for 2026-06-24: • 2 overdue item(s) — top: "Check we... | {"overdue":2,"dueToday":1,"open":25,"blocks":1} | [{"taskId":"019ef311-3c11-7b23-a4aa-d248dc4427fe","title"... | 0 | bbf6a15c253f69ef6c535ddb21b6ef4acbd3a6119867f69e2998ef09c... | 2026-06-23 06:45:28 | 2026-06-23 06:45:28 |

## `entity_tags`  (5 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| entity_kind | TEXT | yes |  | PK |
| entity_id | TEXT | yes |  | PK |
| tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| level | INTEGER | yes | 1 |  |

| entity_kind | entity_id | tag_id | level |
|---|---|---|---|
| task | 019ef311-3c0e-7175-8770-109ca0fc2fec | 019ef2f0-19ed-79ec-975a-8d52016d3c24 | 1 |
| task | 019ef30f-5808-7dfe-b5d7-ffa1f26dd00e | 019ef2f0-19ed-79ec-975a-8d52016d3c24 | 1 |
| routine | 019ef314-be29-73e2-87ac-38aee2e5bb30 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 | 1 |
| task | 019ef312-5cc3-7176-be48-69f3a1b3e548 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 | 1 |
| task | 019ef313-14fb-7bca-a483-6cfdfff0c0eb | 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 | 1 |

## `flight_plan`  (0 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| owner_id | TEXT |  |  | PK + FK→owners.id (ON DELETE NO ACTION) |
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| source_pattern_id | TEXT |  |  | FK→patterns.id (ON DELETE SET NULL) |
| selected | INTEGER |  | 1 |  |
| position | INTEGER |  | 0 |  |
| added_at | TEXT |  | CURRENT_TIMESTAMP |  |

_No rows._


## `job_runs`  (94 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| job_id | TEXT |  |  | FK→scheduled_jobs.id (ON DELETE NO ACTION) |
| started_at | TEXT |  | CURRENT_TIMESTAMP |  |
| finished_at | TEXT |  |  |  |
| status | TEXT |  | 'running' |  |
| items_created | INTEGER |  | 0 |  |
| items_updated | INTEGER |  | 0 |  |
| log | TEXT |  |  |  |

| id | job_id | started_at | finished_at | status | items_created | items_updated | log |
|---|---|---|---|---|---|---|---|
| 019ef2f1-4a49-77b5-8bf4-32bdd9dae087 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:26:00.008Z | 2026-06-23T05:26:00.010Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f2-34a6-7b0e-b197-f81924b992b3 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:27:00.006Z | 2026-06-23T05:27:00.007Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f3-1f04-7288-bc13-9cee8e02492d | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:28:00.004Z | 2026-06-23T05:28:00.004Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f4-0966-70a6-9812-4fb6b5965177 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:29:00.005Z | 2026-06-23T05:29:00.006Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f4-f3c0-7f28-9d05-8ab0169d96f8 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:30:00.000Z | 2026-06-23T05:30:00.001Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f4-f3ca-76df-b2d6-f2b2f90b16dc | 019ef2f0-19df-7112-8414-e8f8825a46b1 | 2026-06-23T05:30:00.010Z | 2026-06-23T05:30:00.020Z | error | 0 | 0 | Ollama generate failed: 404 {"error":"model 'gemma4:e4b' ... |
| 019ef2f4-f3ce-785f-9ca4-2aa0323f22c2 | 019ef2f0-19df-7728-b34e-76037c799c6b | 2026-06-23T05:30:00.014Z | 2026-06-23T05:30:00.022Z | error | 0 | 0 | Ollama generate failed: 404 {"error":"model 'gemma4:e4b' ... |
| 019ef2f5-de27-7b97-b0c3-3bfeb517c1cc | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:31:00.007Z | 2026-06-23T05:31:00.007Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f6-c88d-710f-99c9-c47a13f1f101 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:32:00.013Z | 2026-06-23T05:32:00.014Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f7-b2ec-780b-bf6c-95e4d971919b | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:33:00.011Z | 2026-06-23T05:33:00.012Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f8-9d4e-7ec7-954e-84fc1ecd1c4f | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:34:00.013Z | 2026-06-23T05:34:00.014Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2f9-87a8-77b8-8128-f152df3755d5 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:35:00.008Z | 2026-06-23T05:35:00.008Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2fa-7209-7dd4-8783-f811ebad8474 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:36:00.009Z | 2026-06-23T05:36:00.009Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2fb-5c6d-7aec-8dfc-7ae613869f71 | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:37:00.013Z | 2026-06-23T05:37:00.014Z | done | 0 | 0 | Fired 0 reminder(s) |
| 019ef2fc-46ce-7361-826b-945aed04bacc | 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | 2026-06-23T05:38:00.013Z | 2026-06-23T05:38:00.014Z | done | 0 | 0 | Fired 0 reminder(s) |

_...79 more row(s) not shown._


## `owners`  (1 row)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| name | TEXT | yes |  |  |
| email | TEXT |  |  |  |

| id | name | email |
|---|---|---|
| 00000000-0000-7000-8000-000000000001 | Liam | liam.broza@gmail.com |

## `pattern_blocks`  (8 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT |  |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| pattern_tag_id | TEXT | yes |  | FK→tags.id (ON DELETE CASCADE) |
| day_type | TEXT | yes |  |  |
| start_time | TEXT | yes |  |  |
| end_time | TEXT | yes |  |  |

| id | owner_id | pattern_tag_id | day_type | start_time | end_time |
|---|---|---|---|---|---|
| 019ef2f0-19ef-7aaa-a56e-a937766e6db4 | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 | workday | 07:00 | 08:00 |
| 019ef2f0-19ef-743d-861a-2fa4da134514 | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 | workday | 18:00 | 23:00 |
| 019ef2f0-19ef-76e1-bfab-6834f698cd30 | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ed-79ec-975a-8d52016d3c24 | workday | 09:00 | 18:00 |
| 019ef2f0-19ef-7e0a-8b3d-a86d1b5f3ede | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 | workday | 08:00 | 09:00 |
| 019ef2f0-19ef-78cb-b426-fad9bea53752 | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 | workday | 18:00 | 21:00 |
| 019ef2f0-19ef-7415-b197-9f553f6e431c | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 | weekend | 08:00 | 23:00 |
| 019ef2f0-19ef-7bec-a67a-27c68975611a | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ed-79ec-975a-8d52016d3c24 | weekend | 10:00 | 12:00 |
| 019ef2f0-19ef-7a5f-bf17-71bc9e82bffa | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 | weekend | 08:00 | 22:00 |

## `pattern_prefs`  (3 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT |  |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| pattern_tag_id | TEXT | yes |  | FK→tags.id (ON DELETE CASCADE) |
| auto_fill | INTEGER | yes | 1 |  |
| reminder_offsets | TEXT | yes | '[]' |  |
| icon_shape | TEXT | yes | 'circle' |  |
| color_token | TEXT | yes | 'primary' |  |
| default_minutes | INTEGER | yes | 60 |  |

| id | owner_id | pattern_tag_id | auto_fill | reminder_offsets | icon_shape | color_token | default_minutes |
|---|---|---|---|---|---|---|---|
| 019ef2f0-19f0-7afd-a243-fe91192e055d | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ed-79ec-975a-8d52016d3c24 | 1 | [] | square | primary | 60 |
| 019ef2f0-19f0-7052-b720-2e1c3e8e322e | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 | 1 | [] | circle | primary | 60 |
| 019ef2f0-19f0-75ce-ad2f-082c47ae687d | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 | 1 | [] | triangle | primary | 60 |

## `pattern_tasks`  (1 row)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| pattern_id | TEXT | yes |  | PK + FK→patterns.id (ON DELETE CASCADE) |
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| position | INTEGER |  | 0 |  |

| pattern_id | task_id | position |
|---|---|---|
| 019ef311-3c0f-7586-9415-871de3f02722 | 019ef311-3c0e-7175-8770-109ca0fc2fec | 0 |

## `pattern_types`  (4 rows)

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

| id | owner_id | name | icon_shape | reminder_config | is_builtin | color_token | texture | default_est_minutes | notify |
|---|---|---|---|---|---|---|---|---|---|
| 019ef2f0-19df-7e3a-aa6b-4e04bb54d7be | 00000000-0000-7000-8000-000000000001 | Routine | square |  | 1 | chart-4 |  | 30 | 0 |
| 019ef2f0-19df-7d5a-93e0-537eea60145a | 00000000-0000-7000-8000-000000000001 | Habit | circle |  | 1 | chart-1 |  | 15 | 0 |
| 019ef2f0-19df-7060-a76d-d2a472382367 | 00000000-0000-7000-8000-000000000001 | Ritual | triangle |  | 1 | chart-3 |  | 45 | 0 |
| 019ef33e-2ec6-7f8e-93e1-45e3723cd59a | 00000000-0000-7000-8000-000000000001 | Project | gear |  | 0 | tag-7 |  | 30 | 1 |

## `patterns`  (2 rows)

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

| id | owner_id | type_id | name | tag | notes | created_at | recurrence_rule | recurrence_dtstart |
|---|---|---|---|---|---|---|---|---|
| 019ef311-3c0f-7586-9415-871de3f02722 | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19df-7d5a-93e0-537eea60145a | Check website forms |  |  | 2026-06-23 06:00:53 |  |  |
| 019ef314-be29-73e2-87ac-38aee2e5bb30 | 00000000-0000-7000-8000-000000000001 | 019ef2f0-19df-7e3a-aa6b-4e04bb54d7be | Morning | home |  | 2026-06-23 06:04:43 |  |  |

## `possible_task_tags`  (0 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| possible_task_id | TEXT | yes |  | PK + FK→possible_tasks.id (ON DELETE CASCADE) |
| tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

_No rows._


## `possible_tasks`  (0 rows)

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
| status | TEXT |  | 'pending' |  |
| promoted_task_id | TEXT |  |  | FK→tasks.id (ON DELETE NO ACTION) |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

_No rows._


## `push_subscriptions`  (0 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT |  |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| endpoint | TEXT | yes |  |  |
| p256dh | TEXT | yes |  |  |
| auth | TEXT | yes |  |  |
| user_agent | TEXT |  |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |

_No rows._


## `reminders`  (0 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT |  |  | PK |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| task_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE CASCADE) |
| fire_at | TEXT | yes |  |  |
| status | TEXT | yes | 'pending' |  |
| fired_at | TEXT |  |  |  |
| created_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| source | TEXT | yes | 'manual' |  |

_No rows._


## `scheduled_jobs`  (9 rows)

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

| id | name | kind | cron | enabled | last_run_at | next_run_at | config |
|---|---|---|---|---|---|---|---|
| 019ef2f0-19df-7112-8414-e8f8825a46b1 | ingest_gmail | ingest_gmail | */30 * * * * | 1 | 2026-06-23T06:30:00.022Z |  |  |
| 019ef2f0-19df-7728-b34e-76037c799c6b | ingest_gcal | ingest_gcal | */30 * * * * | 1 | 2026-06-23T06:30:00.023Z |  |  |
| 019ef2f0-19df-7682-81a6-2b4110a21c27 | promote_possibles | promote_possibles | 0 2 * * * | 1 |  |  |  |
| 019ef2f0-19df-73c6-9d65-88f3f0a0f8cf | nightly_grooming | nightly_grooming | 0 2 * * * | 1 |  |  |  |
| 019ef2f0-19df-7b40-abe2-f1f32cd98708 | auto_schedule | auto_schedule | 0 3 * * * | 1 |  |  |  |
| 019ef2f0-19df-7f87-8e31-4db027b01887 | generate_recurrences | generate_recurrences | 45 2 * * * | 1 |  |  |  |
| 019ef2f0-19df-7abe-93cc-8017e7ccef9e | review_day | review_day | 0 1 * * * | 1 |  |  |  |
| 019ef2f0-19f5-7232-9fa4-a3bc832db8a0 | fire_reminders | fire_reminders | * * * * * | 1 | 2026-06-23T06:53:00.003Z |  |  |
| 019ef2f0-19f6-734b-8002-851fccae97da | snapshot_db | snapshot_db | 0 2 * * * | 1 |  |  |  |

## `scheduling_prefs`  (1 row)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| workday_start | TEXT |  | '09:00' |  |
| workday_end | TEXT |  | '18:00' |  |
| deep_work_windows | TEXT |  |  |  |
| max_focus_block_minutes | INTEGER |  | 90 |  |
| min_break_minutes | INTEGER |  | 10 |  |
| day_theme | TEXT |  |  |  |
| planning_mode | TEXT |  | 'ritual' |  |
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

| id | owner_id | workday_start | workday_end | deep_work_windows | max_focus_block_minutes | min_break_minutes | day_theme | planning_mode | timezone | planning_horizon_days | fast_model | quality_model | embed_model | memory_sync_enabled | memory_sync_completed | memory_sync_habits | memory_sync_reflections | memory_account | memory_last_synced_at | max_time_block_minutes | min_time_block_minutes | plan_allday_always | plan_daylong_for_promoted | plan_autofill_gaps | concept_default_minutes | concept_autosurface | concept_horizon_days | concept_tags | enable_rituals | auto_fill_workday | recall_keeps_pattern |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 019ef2f0-19df-79b4-8c75-687a034908af | 00000000-0000-7000-8000-000000000001 | 09:00 | 18:00 |  | 90 | 10 |  | ritual | America/Los_Angeles | 7 |  |  |  | 0 | 1 | 1 | 1 |  |  | 240 | 15 | 0 | 0 | 1 | 60 | 1 | 30 | [{"name":"Work","minutes":240},{"name":"Relax","minutes":... | 0 | 1 | 0 |

## `schema_migrations`  (46 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT |  |  | PK |
| applied_at | TEXT | yes | CURRENT_TIMESTAMP |  |
| checksum | TEXT |  |  |  |

| id | applied_at | checksum |
|---|---|---|
| 0001_baseline | 2026-06-23 05:24:42 |  |
| 0002_columns | 2026-06-23 05:24:42 |  |
| 0003_seed_defaults | 2026-06-23 05:24:42 |  |
| 0004_task_scheduling_columns | 2026-06-23 05:24:42 |  |
| 0005_task_dependencies | 2026-06-23 05:24:42 |  |
| 0006_actual_minutes | 2026-06-23 05:24:42 |  |
| 0007_time_entries | 2026-06-23 05:24:42 |  |
| 0008_recurrence | 2026-06-23 05:24:42 |  |
| 0010_block_all_day | 2026-06-23 05:24:42 |  |
| 0011_recurrence_job | 2026-06-23 05:24:42 |  |
| 0012_settings_models_memory | 2026-06-23 05:24:42 |  |
| 0013_patterns | 2026-06-23 05:24:42 |  |
| 0014_habit_patterns_backfill | 2026-06-23 05:24:42 |  |
| 0015_time_blocks | 2026-06-23 05:24:42 |  |
| 0016_flight_plan | 2026-06-23 05:24:42 |  |

_...31 more row(s) not shown._


## `tag_patterns`  (7 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| intention_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |
| pattern_tag_id | TEXT | yes |  | PK + FK→tags.id (ON DELETE CASCADE) |

| intention_tag_id | pattern_tag_id |
|---|---|
| 019ef2f0-19ed-7133-b3e7-6359b8f265fb | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 |
| 019ef2f0-19ed-79a6-98c3-161747257e05 | 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 |
| 019ef2f0-19ed-7b40-820d-fc4f8a82b7ec | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 |
| 019ef2f0-19ed-7dee-8ce5-8bd69f6bc60e | 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 |
| 019ef2f0-19ed-764c-81ef-abb3aa709394 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 |
| 019ef2f0-19ed-7f51-af11-dc9723f24789 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 |
| 019ef2f0-19ed-7c52-996c-8a1056ace6b7 | 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 |

## `tags`  (11 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| name | TEXT | yes |  |  |
| kind | TEXT | yes | 'intention' |  |
| muted | INTEGER | yes | 0 |  |
| is_base | INTEGER | yes | 0 |  |

| id | name | kind | muted | is_base |
|---|---|---|---|---|
| 019ef2f0-19ed-79ec-975a-8d52016d3c24 | work | pattern | 0 | 1 |
| 019ef2f0-19ed-7133-b3e7-6359b8f265fb | relax | intention | 0 | 0 |
| 019ef2f0-19ed-79a6-98c3-161747257e05 | family-time | intention | 0 | 0 |
| 019ef2f0-19ed-7b40-820d-fc4f8a82b7ec | me-time | intention | 0 | 0 |
| 019ef2f0-19ed-7dee-8ce5-8bd69f6bc60e | socialize | intention | 0 | 0 |
| 019ef2f0-19ed-764c-81ef-abb3aa709394 | house-work | intention | 0 | 0 |
| 019ef2f0-19ed-7f51-af11-dc9723f24789 | yard-work | intention | 0 | 0 |
| 019ef2f0-19ed-7ad1-8d37-4b2ad3b18ac1 | exercise | intention | 0 | 0 |
| 019ef2f0-19ed-7c52-996c-8a1056ace6b7 | meal-prep | intention | 0 | 0 |
| 019ef2f0-19ef-7a5c-99fd-1dbecd07dbc4 | home | pattern | 0 | 1 |
| 019ef2f0-19ef-75e0-92f8-d1a845ba0d80 | community | pattern | 0 | 1 |

## `task_dependencies`  (0 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| task_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| depends_on_id | TEXT | yes |  | PK + FK→tasks.id (ON DELETE CASCADE) |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

_No rows._


## `tasks`  (28 rows)

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
| status | TEXT |  | 'open' |  |
| parent_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| owner_id | TEXT |  |  | FK→owners.id (ON DELETE NO ACTION) |
| source_kind | TEXT |  | 'manual' |  |
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
| is_habit | INTEGER |  | 0 |  |
| is_fast_task | INTEGER |  | 0 |  |
| defer_count | INTEGER |  | 0 |  |
| subtype | TEXT |  | 'standard' |  |

| id | title | description | notes | due_at | task_time | estimated_minutes | priority | status | parent_id | owner_id | source_kind | source_ref | created_at | completed_at | scheduled_for | defer_until | actual_minutes | recurrence_rule | recurrence_parent_id | recurrence_dtstart | recurrence_exdates | occurrence_date | is_habit | is_fast_task | defer_count | subtype |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 019ef30f-5808-7dfe-b5d7-ffa1f26dd00e | Update Docs for Planner |  |  | 2026-06-26 |  | 60 | 2 | open |  | 00000000-0000-7000-8000-000000000001 | manual |  | 2026-06-23 05:58:49 |  | 2026-06-23 |  | 0 |  |  |  |  |  | 0 | 0 | 0 | standard |
| 019ef311-3c0e-7175-8770-109ca0fc2fec | Check website forms |  |  |  | 08:40 | 60 | 1 | recurring |  | 00000000-0000-7000-8000-000000000001 | manual |  | 2026-06-23 06:00:53 |  |  |  | 0 | FREQ=DAILY |  | 2026-06-22T07:00:00.000Z |  |  | 1 | 0 | 0 | habit |
| 019ef311-3c11-7b23-a4aa-d248dc4427fe | Check website forms |  |  | 2026-06-22T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-22 | 2026-06-22T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-22 | 1 | 0 | 0 | habit |
| 019ef311-3c11-7956-b9b1-94251867a026 | Check website forms |  |  | 2026-06-23T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-23 | 2026-06-23T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-23 | 1 | 0 | 0 | habit |
| 019ef311-3c12-7be6-bfa7-88d3360d813f | Check website forms |  |  | 2026-06-24T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-24 | 2026-06-24T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-24 | 1 | 0 | 0 | habit |
| 019ef311-3c12-785a-bfe4-3556ea5ca61f | Check website forms |  |  | 2026-06-25T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-25 | 2026-06-25T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-25 | 1 | 0 | 0 | habit |
| 019ef311-3c12-74aa-8ad5-9a2cdb1a3cf4 | Check website forms |  |  | 2026-06-26T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-26 | 2026-06-26T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-26 | 1 | 0 | 0 | habit |
| 019ef311-3c12-7552-8739-28e81da89756 | Check website forms |  |  | 2026-06-27T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-27 | 2026-06-27T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-27 | 1 | 0 | 0 | habit |
| 019ef311-3c12-7104-aab4-6adb099051a4 | Check website forms |  |  | 2026-06-28T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-28 | 2026-06-28T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-28 | 1 | 0 | 0 | habit |
| 019ef311-3c13-7354-83eb-8bc2dfee4b10 | Check website forms |  |  | 2026-06-29T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-29 | 2026-06-29T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-29 | 1 | 0 | 0 | habit |
| 019ef311-3c13-7492-b32b-0df665d65450 | Check website forms |  |  | 2026-06-30T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-06-30 | 2026-06-30T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-06-30 | 1 | 0 | 0 | habit |
| 019ef311-3c13-774a-8794-1845d4557d31 | Check website forms |  |  | 2026-07-01T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-07-01 | 2026-07-01T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-07-01 | 1 | 0 | 0 | habit |
| 019ef311-3c13-7d1d-b614-9d489961100e | Check website forms |  |  | 2026-07-02T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-07-02 | 2026-07-02T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-07-02 | 1 | 0 | 0 | habit |
| 019ef311-3c14-7896-99b8-acd4a8a9138e | Check website forms |  |  | 2026-07-03T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-07-03 | 2026-07-03T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-07-03 | 1 | 0 | 0 | habit |
| 019ef311-3c14-77be-8cf1-39334e793f24 | Check website forms |  |  | 2026-07-04T15:40:00.000Z | 08:40 | 60 | 1 | open |  | 00000000-0000-7000-8000-000000000001 | recurrence |  | 2026-06-23 06:00:53 |  | 2026-07-04 | 2026-07-04T07:00:00.000Z | 0 |  | 019ef311-3c0e-7175-8770-109ca0fc2fec |  |  | 2026-07-04 | 1 | 0 | 0 | habit |

_...13 more row(s) not shown._


## `time_blocks`  (8 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| task_id | TEXT |  |  | FK→tasks.id (ON DELETE CASCADE) |
| title | TEXT | yes |  |  |
| block_kind | TEXT |  | 'task' |  |
| start_at | TEXT | yes |  |  |
| end_at | TEXT | yes |  |  |
| is_locked | INTEGER |  | 0 |  |
| is_auto | INTEGER |  | 1 |  |
| source_kind | TEXT |  | 'manual' |  |
| source_ref | TEXT |  |  |  |
| status | TEXT |  | 'planned' |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |
| all_day | INTEGER | yes | 0 |  |
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

| id | task_id | title | block_kind | start_at | end_at | is_locked | is_auto | source_kind | source_ref | status | created_at | all_day | tag | block_type | goal_start_date | duration_minutes | note | parent_block_id | recurrence_rule | recurrence_dtstart | recurrence_parent_id | occurrence_date |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 019ef2f4-f3cf-7b72-adaa-4b214f7f48ed |  | Mighty Capital follow-on review | meeting | 2026-06-02T17:00:00.000Z | 2026-06-02T17:30:00.000Z | 1 | 0 | gcal | evt-001 | planned | 2026-06-23 05:30:00 | 0 |  |  |  |  |  |  |  |  |  |  |
| 019ef32e-709c-733d-bbca-b38910a3f362 | 019ef311-3c11-7b23-a4aa-d248dc4427fe | Check website forms | task | 2026-06-22T17:45:00.000Z | 2026-06-22T18:45:00.000Z | 0 | 1 | pattern | 019ef311-3c0f-7586-9415-871de3f02722 | planned | 2026-06-23 06:32:47 | 0 |  |  |  |  |  |  |  |  |  |  |
| 019ef337-fdfa-7cf0-abac-e3be095ea92e | 019ef30f-5808-7dfe-b5d7-ffa1f26dd00e | Update Docs for Planner | task | 2026-06-22T16:00:00.000Z | 2026-06-22T17:00:00.000Z | 0 | 1 | agent |  | planned | 2026-06-23 06:43:13 | 0 |  |  |  |  |  |  |  |  |  |  |
| 019ef337-fdfb-77ec-8645-35cae0d52ac6 | 019ef313-14fb-7bca-a483-6cfdfff0c0eb | Plan meeting with David Equinix | task | 2026-06-22T15:00:00.000Z | 2026-06-22T15:15:00.000Z | 0 | 1 | agent |  | planned | 2026-06-23 06:43:13 | 0 |  |  |  |  |  |  |  |  |  |  |
| 019ef337-fdfb-77fd-be8c-b5b9d4e2b86f | 019ef313-45d7-7445-902c-7d67ae3712d7 | Cat Litter | task | 2026-06-22T17:10:00.000Z | 2026-06-22T17:40:00.000Z | 0 | 1 | agent |  | planned | 2026-06-23 06:43:13 | 0 |  |  |  |  |  |  |  |  |  |  |
| 019ef339-f331-73f2-8141-c2199090c03e | 019ef311-3c11-7956-b9b1-94251867a026 | Check website forms | task | 2026-06-23T16:00:00.000Z | 2026-06-23T17:00:00.000Z | 0 | 1 | pattern | 019ef311-3c0f-7586-9415-871de3f02722 | planned | 2026-06-23 06:45:21 | 0 |  |  |  |  |  |  |  |  |  |  |
| 019ef33a-0cc9-7500-ba9d-26ea2c7c25a8 | 019ef311-3c12-7be6-bfa7-88d3360d813f | Check website forms | task | 2026-06-24T16:00:00.000Z | 2026-06-24T17:00:00.000Z | 0 | 1 | pattern | 019ef311-3c0f-7586-9415-871de3f02722 | planned | 2026-06-23 06:45:28 | 0 |  |  |  |  |  |  |  |  |  |  |
| 019ef33e-957c-799c-a807-02581fe395f7 |  | New block | timeblock | 2026-06-22T14:30:00.000Z | 2026-06-22T15:30:00.000Z | 0 | 0 | manual |  | planned | 2026-06-23 06:50:25 | 0 |  |  |  |  |  |  |  |  |  |  |

## `time_entries`  (0 rows)

| Column | Type | Not Null | Default | Key |
|---|---|---|---|---|
| id | TEXT | yes |  | PK |
| task_id | TEXT | yes |  | FK→tasks.id (ON DELETE CASCADE) |
| owner_id | TEXT | yes |  | FK→owners.id (ON DELETE NO ACTION) |
| block_id | TEXT |  |  | FK→time_blocks.id (ON DELETE SET NULL) |
| started_at | TEXT | yes |  |  |
| ended_at | TEXT |  |  |  |
| source | TEXT |  | 'timer' |  |
| created_at | TEXT |  | CURRENT_TIMESTAMP |  |

_No rows._
