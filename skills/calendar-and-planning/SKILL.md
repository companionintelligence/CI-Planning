---
name: calendar-and-planning
description: Inspect and manage Companion Planning calendar blocks, open time, scheduling, conflicts, daily planning, and plan reflow.
version: 1.0.0
---

# Calendar and planning

Read `calendar_list_blocks` for the requested date or range before modifying a schedule. Use `calendar_day_conflicts` and `calendar_whats_next` to explain the current plan. Use `calendar_create_block`, `calendar_update_block`, or `calendar_delete_block` for explicit block changes; use `calendar_add_tasks_to_block` to attach tasks.

For automated scheduling use `auto_planner`, `schedule_run`, or `plan_assistance` according to the requested operation. For existing plan adjustments use `calendar_reflow`, `calendar_block_reschedule`, `calendar_block_extend`, or `calendar_move_group`. Preview schedule consequences and ask before clearing days/ranges or applying broad reflows. Use `planner_clear_range` and `calendar_clear_day` only for a clearly scoped, confirmed request.

Treat date/time inputs in the user's timezone and preserve their intent. When an ambiguous date, time zone, or duration could change the result, ask a short clarification. After writes, reread the affected range and summarize what moved, what remains open, and any conflicts.
