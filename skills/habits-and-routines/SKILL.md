---
name: habits-and-routines
description: Explain and manage Companion Planning habits, routine templates, recurring patterns, schedule windows, and routine adherence.
version: 1.0.0
---

# Habits and routines

Inspect current definitions using `routine_*`, `pattern_types`, `pattern_windows`, and `block_templates` tools before editing. Use `routine_*` tools for routines and `flight_plan_manage` only for Flight Plan entities; do not treat a routine as an ordinary task unless the API represents it as one.

Use the narrowest create/update/archive/delete operation exposed by the MCP server. For recurrence changes, state the affected days, start/end bounds, and timezone before applying. Ask for confirmation before deleting routines, replacing a recurring pattern, or changing many future occurrences. After changes, reread the routine and relevant calendar blocks to confirm the resulting schedule.
