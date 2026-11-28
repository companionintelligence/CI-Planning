# Local MCP access

Companion Planning includes a stdio MCP server and portable app workflow skills for local agents such as Hermes and OpenClaw. The MCP exposes tools across the server-backed app: tasks, calendar, planning, routines, objectives, tags, reviews, preferences, integrations, sharing, and operator workflows. The skills teach the chat agent how to select and safely sequence those tools. The MCP process calls the app's existing REST API, so API validation, access scopes, audit records, scheduling rules, and broadcasts remain in the app.

The MCP process is launched by the agent client. It is not an HTTP endpoint and does not bind a port. The app itself must be running and reachable at `CP_MCP_APP_URL` (default `http://127.0.0.1:3848`).

## Configure credentials

Copy the example to a local-only file:

```sh
cp server/mcp.local.env.example server/mcp.local.env
chmod 600 server/mcp.local.env
```

Then choose the credential that matches the app's auth mode:

| App auth mode | MCP credential |
|---|---|
| `sso` with local login enabled | Set `CP_MCP_APP_USERNAME` and `CP_MCP_APP_PASSWORD` for a local account. The MCP process signs in through `/api/auth/login` and keeps the signed session cookie in memory. A portal-only identity without a local password cannot use this path. |
| `standalone` | Set `CP_MCP_APP_API_KEY` to a scoped API key. The app's standalone keys are not accepted in `sso` mode. |
| `test` | No credential is needed. Use only with a private development instance; test mode is forbidden in production. |

For standalone, issue a short-lived key from the app's server directory and copy the one-time output into the ignored env file:

```sh
cd server
pnpm key:issue --scopes read,write --ttl-days 90
```

Do not put account passwords or API keys in this repo's tracked files, client config, shell history, or a commit. `server/mcp.local.env` is gitignored. The MCP process only reads it; `mcp.local.env.example` contains no secrets.

## Hermes

Run the installer from any directory:

```sh
bash /absolute/path/to/CI-Planning/ops/scripts/install-hermes-mcp.sh
```

It registers the stdio server and copies the namespaced skills into `~/.hermes/skills/companion-planning/`. Rerun the installer after updating the repo skills. The equivalent MCP configuration in `~/.hermes/config.yaml` is:

```yaml
mcp_servers:
  companion-planning:
    command: "/absolute/path/to/CI-Planning/server/node_modules/.bin/tsx"
    args:
      - "/absolute/path/to/CI-Planning/server/src/scripts/mcp-app-server.ts"
```

Use `hermes mcp test companion-planning` and `hermes skills list` to check discovery. The MCP tools and skills become available to new Hermes sessions (or after refreshing/restarting an existing session).

## OpenClaw

Run the installer from any directory:

```sh
bash /absolute/path/to/CI-Planning/ops/scripts/install-openclaw.sh
```

It writes the server definition using OpenClaw's MCP CLI and copies skills into `~/.openclaw/skills/companion-planning/`. Rerun it after updating repo skills. Check discovery with `openclaw mcp doctor companion-planning --probe` and `openclaw skills list`; start a new session or refresh the Gateway after changes.

If the Gateway runs in a container or under a different OS user, it must be able to read this checkout, its Node dependencies, and `mcp.local.env`. Keep that file readable only by the user that runs the Gateway.

## Shared app skills

The source skills live in `skills/` in this repository and use the standard `SKILL.md` format supported by both clients. They route common requests into the app's MCP tools, explain app-specific behavior, and set confirmation boundaries for destructive or wide-ranging changes. The current pack covers app navigation, tasks and inbox, calendar and planning, habits and routines, objectives and tags, reviews and insights, and settings and account workflows. Skills provide guidance; the typed MCP server performs the actual app operations.

## Available tools

| Area | Tools |
|---|---|
| Tasks | `tasks_list`, `task_create`, `task_update`, `task_complete`, `task_archive`, `task_delete`, `task_quick_capture`, `task_quick_parse`, `task_skip`, `task_reschedule`, `task_subtasks_list`, `task_streak`, `task_promote`, `task_suggest`, `task_enrich`, `tasks_auto_tag`, `task_notes_list`, `task_note_add`, `task_place`, `task_timer`, `task_timer_status`, `task_approve` |
| Planner and calendar | `calendar_list_blocks`, `calendar_create_block`, `calendar_update_block`, `calendar_delete_block`, `calendar_add_tasks_to_block`, `calendar_move_group`, `calendar_promote_someday`, `calendar_clear_day`, `calendar_block_extend`, `calendar_block_reschedule`, `calendar_focus_reminders`, `calendar_whats_next`, `calendar_day_conflicts`, `calendar_reflow`, `planner_clear_range`, `auto_planner`, `schedule_run`, `plan_assistance` |
| Flight Plan and routines | `flight_plan_list`, `flight_plan_stage_task`, `flight_plan_manage`, `flight_plan_schedule`, `routine_*`, `pattern_types`, `pattern_windows`, `block_templates` |
| Objectives and tags | `objectives_list`, `objective_manage`, `objective_task`, `objective_board`, `tags_list`, `tag_manage`, `tag_preferences` |
| Daily planning and review | `daily_brief`, `review_sweep`, `reflections`, `day_stars`, `day_types`, `plan_week` |
| Preferences and insights | `preferences`, `priorities`, `metrics_read`, `learning_reset`, `triality`, `calibration` |
| Tasks awaiting review | `possible_tasks_list`, `possible_task_review` |
| Connections and reminders | `connections`, `integration_setup`, `reminders` |
| People and administration | `owner_profile`, `shared_planning`, `operator_accounts`, `jobs` |
| Data portability and status | `backup`, `demo_sample_data`, `app_status` |

Tool arguments are routed to fixed API paths; there is no arbitrary HTTP request tool. Existing app routes continue to enforce owner scope, roles, validation, auditing, feature flags, and recurrence behavior. MCP read-only/destructive annotations help clients classify calls but do not enforce consent. The chat agent should preview bulk or schedule-changing operations and get confirmation for destructive, external, or hard-to-reverse actions.

This covers server-backed user workflows. It does not automate browser-local controls such as theme, text size, navigation layout, device lock, browser notification permission, or the OAuth consent screen. For literal screen control, run a browser/UI automation MCP (for example Playwright) alongside this data MCP. Authentication, password reset, and OAuth secrets should stay in their dedicated UI/secret-entry flows.

The in-app TaskAgent and this external MCP server are separate chat surfaces today. The external MCP exposes the app's typed operations; it does not invoke the in-app assistant's proposal model or carry the current browser selection.

## Notes and limits

- The server currently uses local stdio, which avoids opening an MCP network port. The app API stays on its existing local port.
- A client running on another machine cannot use `127.0.0.1` to reach this app. Run the MCP process on the app host or set `CP_MCP_APP_URL` to a trusted reachable app URL. For remote exposure, use HTTPS and the app's normal auth mode.
- Google OAuth consent and browser/device permissions still require a user-facing browser or native flow; the MCP can return authorization URLs but does not approve consent or expose stored provider credentials.
- The old Hermes routines script referred to a nonexistent `/mcp` endpoint and tool names not implemented by the app. Use the stdio setup above instead.
