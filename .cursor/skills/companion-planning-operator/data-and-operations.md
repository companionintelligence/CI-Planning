# Data, learning, logs, and jobs

## Export, import, backup, and restore

- **Export** creates an owner-scoped data file or a calendar `.ics` file, depending on the chosen action. Confirm which format and date/account scope the user wants; do not export other owners' data.
- **Import/restore** can create or replace many records. Confirm the selected file, target account, and whether existing data will be merged or replaced from the UI before proceeding. Afterward verify the completion summary and a few representative restored records.
- Built-in snapshots are backups, not a substitute for exporting when the user needs a portable file. Never manipulate the live SQLite file with file sync tools.
- Date-range clear tools may delete blocks or records and can create a backup snapshot first. Check exact date bounds and record count from the UI; a broad “clear my data” request needs scope clarification.

## Learning and logs

- **Learning** summarizes classification accuracy, dismissal, placement, and other per-owner calibration. Compare the visible date/window and sample counts before reporting a trend.
- Clear/reset actions can delete learned exemplars or preferences. Do not clear merely because a metric looks poor; only perform a requested reset and preserve evidence/logs when the control says they remain.
- **Logs** contains this owner's planning sessions. Users can inspect, export, consolidate, or delete sessions. Never copy private prompt/task content outside the user-requested report. Deletion may be irreversible.

## Jobs and sync

- Jobs are run for the current owner; scheduled cron work may run for every account. Open the job's description/history and verify the owner-specific effect before using **Run**.
- A job may call Google, Memory, email, AI, or change schedules. Inspect its kind and enabled integrations first. Don't run a batch just to “check” the app.
- **Sync** may mean sync tasks between devices, ingest Google/Memory, or write to an external calendar. Resolve which flow the user means before starting it.
- For task/calendar device sync, allow the app's live updates or sync action to finish, then confirm the displayed record. Do not replay a mutation if its result is uncertain; inspect first to avoid duplicates.

## Metrics and summaries

- **Balance** and Today derive metrics from saved tasks, reflections, goals, and schedule history. State the date window and distinguish a missing measure from zero.
- Stars, completion totals, placement trends, and objective progress are derived; do not edit underlying task state to force a metric.

See [settings.md](settings.md) for controls that live in Settings and [interaction.md](interaction.md) for post-action verification.
