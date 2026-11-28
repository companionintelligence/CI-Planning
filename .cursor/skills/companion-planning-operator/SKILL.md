---
name: companion-planning-operator
description: Operate the user's Companion Planning app: capture, find, edit, schedule, complete, and review tasks; manage calendars, routines, objectives, priorities, tags, settings, integrations, accounts, backups, and learning. Use for any request to view or change app data.
---

# Companion Planning Operator

Use this skill whenever the user asks to use Companion Planning, inspect their plan, or change data in the app. It is an operation guide, not a code-change guide.

## Operating loop

1. **Find the active app.** Reuse the user's current Companion Planning browser tab when available. Use its current URL and signed-in session; never guess a server URL, switch accounts, or ask for a password in chat. If no app is available, ask for the app URL or help start it. If the app asks the user to sign in, let them complete sign-in and resume.
2. **Inspect before acting.** Read the current page and filters. Identify the exact task, date, account, and scope. Use the user's app timezone for dates and times. Preserve fields the user did not ask to change.
3. **Choose the matching workflow.** Read the direct reference below for the relevant surface. Prefer the visible app controls and wait for save, navigation, and reactive updates to finish.
4. **Make only requested changes.** Avoid sample-data seeding, external sync, email, invites, deletion, or bulk operations unless the user requested that action. Existing explicit user authorization covers the app's own confirmation dialog; do not add another confirmation step for a clear, bounded request.
5. **Verify the result.** Re-read the changed control or row and confirm the saved state. If the app reports an error or the result cannot be observed, say exactly what remains unverified; do not claim success.
6. **Report briefly.** State what changed, the relevant date/scope, and any action the user still needs to take.

## Safety and data boundaries

- Operate only in the currently signed-in owner's scope. Respect the visible role and access controls; Jobs and account administration may be operator-only, and shared tasks may be read-only.
- Use the app UI for data changes. Do not write to SQLite, local storage, or internal APIs to bypass validation, permissions, confirmation flows, or UI semantics. Use an authenticated documented API only when the user requests an API workflow or the UI cannot perform the requested supported action.
- Ask one concise clarification when the target or scope is materially ambiguous (for example, two matching tasks, an unclear date, or which recurring instances to change). Do not ask about details that can be read from the app.
- Treat external effects separately: Google write-back, sending an invitation, connecting a source, and running an ingest/sync can affect another service or person. Inspect the active setting and explain the effect if the request does not clearly include it.
- Deleting a task normally cancels it rather than erasing its audit history. Account deletion, date-range clearing, log deletion, and backup restore can affect many records; verify the scope from the UI before proceeding.
- Do not reveal, copy into files, or send passwords, reset links, OAuth tokens, API keys, or private task details. Never use real user data in test accounts, fixtures, or screenshots.

## References

- [App surface and user-task map](capabilities.md)
- [Tasks, habits, routines, and objectives](tasks.md)
- [Today, Focus, calendar, and weekly planning](planning.md)
- [Settings, connections, accounts, and people](settings.md)
- [Data, learning, logs, and jobs](data-and-operations.md)
- [Interaction and verification checklist](interaction.md)
