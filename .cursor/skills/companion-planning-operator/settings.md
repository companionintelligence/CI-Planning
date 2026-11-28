# Settings, connections, accounts, and people

## Profile and preferences

- **Profile** holds the signed-in owner's name, email, username (when local auth allows it), backup reset email, account administration, first-run replay, data export/import, and date-range maintenance. Read the visible owner/account context before editing.
- **Preferences** controls planner display/collapse, reminders, task behavior, routines/rituals, scheduling and other per-owner options. Read the existing value before toggling; explain effects for broad behavior changes.
- Profile identity is edited here, not in the FTUE.
- Theme can be changed from the navigation toggle. Theme preference is local UI state, not a task edit.

## Connections

- **Google Calendar** can be off, fixture/demo, or live. User may connect via OAuth or configure an OAuth client, depending on deployment. Inspect the visible connection mode and account before starting a flow. Respect read-only versus write-back settings; never assume calendar events are writable.
- **Companion Memory** is optional and can provide upcoming events/suggestions or task enrichment. Enabling pull/sync can move data between services. Explain direction and scope before changing those switches.
- **AI models** may be local Ollama or configured provider models. Check availability and selected model before a user-requested AI operation. Do not send private task text to an external provider unless configured and intended.
- **Email suggestions** are reviewed in Tasks. Approve or dismiss only the specific suggestion the user names.
- **Push notifications** are opt-in. Only enable after the user asks and the relevant server keys/device permission are available. Never trigger a permission prompt just by opening the app.
- Connected accounts can be disconnected from Connections. Confirm the selected provider/account and note what capability will stop.

## People and shared work

- **People** manages the directory attached as Responsible or Beneficiary on tasks/blocks. Detected calendar/email people may need confirmation; rename, merge, or delete only on explicit instruction and verify affected references.
- Shared tasks can be read-only. Use the visible owner/account controls and access scopes; do not reproduce private task contents in another owner's account.
- **Accounts** is operator-only: roles, invitations, sign-up codes, and account deletion. Invites send a message/link to another person; account deletion removes all account data. Use exact email/name and role, and state the scope before consequential actions.
- Never set, ask for, or reveal another user's password. Use supported invite/reset flows. A reset link may be logged instead of emailed when SMTP is absent; the browser cannot reveal an existing password.

## Privacy

- The **Privacy** tab describes server boundaries and controls. Do not promise that a server operator cannot access data stored on that server.
- Do not change sign-in mode, sharing, retention, or telemetry preferences unless requested. Verify the resulting setting and any session/login effect.

See [capabilities.md](capabilities.md) for all Settings tabs and [interaction.md](interaction.md) for authorization boundaries.
