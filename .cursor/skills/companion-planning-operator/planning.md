# Today, Focus, calendar, and weekly planning

## Today

- Confirm the displayed date before changing the plan. Use previous/next day or the date picker; the server's planner timezone may differ from the computer timezone.
- The header exposes due items, notes, focus, and (when a block is underway) the Focus Ritual. The day includes goals, briefing, schedule/capacity, open-time windows, habits/routines, and scheduled tasks.
- A day note is a reflection, not a task. Save or edit it only when asked. Day stars are derived signals; they are not manually toggled.
- Direction filters change what is shown. Check active filters before reporting a task missing.

## Focus

- Use Focus for a narrow, current-day work session. Confirm the selected date/task and any active timer before starting or stopping work.
- A Focus Ritual is optional completion feedback (duration, note, reaction); do not invent a reflection or elapsed time.
- The task assistant can retrieve task notes, place a task, or propose a plan. Read any proposed changes and apply only the user's requested scope.

## Calendar and scheduling

1. Choose day, week, or month and navigate to the exact date range.
2. Inspect existing blocks/events, overlays, direction filters, and availability before creating or moving a block.
3. To place one item, use its schedule action or the empty calendar slot. Retain its original task identity and requested time. To move a block, verify both its new date/time and linked task intent.
4. To schedule multiple tasks, use **Schedule selected day** or the Flight Plan flow. Review the proposed/staged list before committing it; report tasks that remain unscheduled and why if shown.
5. Use day/week review and reflow preview when the user asks to resolve conflicts or optimize a day. Inspect the proposed diff before apply; fixed events, in-progress blocks, and user-moved blocks may be protected.
6. Export only the requested range as `.ics`. This exports calendar data; it does not mean the items were synced to Google.

- A due date is a deadline; scheduled day/time is start intent; a calendar block is a placement. Do not convert one into another without user intent.
- Auto-scheduling is deterministic and constrained by availability, estimates, existing/locked blocks, and preferences. Do not promise a specific slot until the UI shows it.
- Google write-back is a separate external action and is normally off. Do not turn it on or write to an external calendar as an unstated side effect.

## Plan my week

- Open the assistant from Calendar. Identify whether the user wants to fill gaps, review past data, or schedule specific tasks. The assistant's available branch is explicit in the UI.
- Review the suggestions and session branch before accepting. It may use a local AI model for wording/order, but placement remains app-controlled. Do not assume the assistant completed a sync or wrote to Google.
- Weekly focus goals in Today are separate from calendar blocks and from the assistant's planning session.

See [tasks.md](tasks.md) for task-specific fields and [interaction.md](interaction.md) for verifying changes.
