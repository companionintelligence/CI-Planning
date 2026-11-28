---
name: settings-and-account
description: Read or change Companion Planning preferences, priorities, integrations, reminders, sharing, backups, demo data, jobs, and operator accounts.
version: 1.0.0
---

# Settings and account workflows

Use `preferences`, `priorities`, `connections`, `reminders`, `shared_planning`, `owner_profile`, `jobs`, and `app_status` to inspect the relevant state before changing it. Use `integration_setup` to begin a supported setup flow; never request or expose provider secrets in chat.

Browser-only settings such as theme, text size, navigation layout, notification permission, device lock, login/password reset, and OAuth consent require their dedicated app or browser flow. The MCP server does not bypass those boundaries.

Treat backup export and demo sample data operations as sensitive. Confirm before changing sharing/access, creating or deleting operator accounts, resetting learning, restoring or replacing data, or loading demo data. Give a concise preview of scope and reread status after the operation.
