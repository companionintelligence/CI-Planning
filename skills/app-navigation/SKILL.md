---
name: app-navigation
description: Explain Companion Planning features and choose the right MCP workflow for a request. Use when the user asks how the app works or gives a cross-feature request.
version: 1.0.0
---

# Companion Planning app navigation

Use the `companion-planning` MCP tools as the supported data and workflow interface. First inspect state with `app_status` or the relevant list/read tool. Select the narrowest domain skill for operational requests; use more than one when the request crosses domains.

Map requests to workflows:

- Tasks, inbox, completion, archive, due dates, subtasks, notes, timers: `tasks-and-inbox`.
- Day/week planning, calendar blocks, scheduling, conflicts, open time: `calendar-and-planning`.
- Habits, routines, recurring patterns and windows: `habits-and-routines`.
- Goals/objectives and their task links: `objectives-and-tags`.
- Daily brief, reflections, day ratings and weekly reviews: `reviews-and-insights`.
- Preferences, integrations, sharing, backup, operator accounts: `settings-and-account`.

Use only advertised MCP tools; do not invent endpoints or claim to control browser-only UI. For theme, responsive layout, browser permissions, authentication, or OAuth consent, explain that a browser/UI flow is required.

Before destructive actions, deleting data, bulk changes, clearing schedules, or external connection changes, summarize the exact scope and ask for confirmation. For schedule changes, show the proposed effect before applying when practical. Report the result and any items that could not be changed.
