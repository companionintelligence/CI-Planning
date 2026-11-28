---
name: tasks-and-inbox
description: Capture, find, edit, schedule, complete, archive, or delete Companion Planning tasks and their subtasks, notes, timers, and review state.
version: 1.0.0
---

# Tasks and inbox

Use `tasks_list` to locate existing work before changing it. Use `task_quick_parse` when the user gives a natural-language task, and `task_quick_capture` for simple inbox capture. Use `task_create` for structured creation, then report any interpreted dates, priorities, tags, or duration that matter.

Use `task_update` for edits, `task_complete` for completion, `task_archive` to move an item out of active work, and `task_delete` only when the user explicitly wants deletion. A completed task may remain visible on planner/calendar history even when removed from the active task log. Do not infer deletion from completion.

Use `task_place` or the calendar/planning workflow to schedule. Distinguish a task's scheduled state from whether its calendar block is currently visible: inspect the task and its calendar blocks before saying it is unscheduled. Use `task_reschedule` when moving a task, and confirm before changing a set of tasks in bulk.

Use subtasks, task notes, timer, streak, promote/suggest/enrich, auto-tag, and approval tools only when they fit the request. Confirm before archive/delete when the scope is ambiguous; always confirm deletion and bulk destructive actions. Report the final task state clearly.
