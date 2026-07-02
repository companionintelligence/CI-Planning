# X — MCP intent tool vocabulary alignment — planning doc

**Status:** Planning only. **Depends on:** external input (CI-Server's vocabulary/naming spec — not in hand). Can be audited today regardless; alignment work is blocked on that spec.

> **Needs external input:** I don't have CI-Server's MCP intent vocabulary documentation. Everything below is an honest audit of what Companion Planning's MCP server does *today* — it can't yet tell you where it diverges from CI-Server's convention, because I don't know what that convention is. Send the spec (or point me at CI-Server's source) and this doc gets a real "gap list" section.

## Current state (verified via `docs/CLAUDE_COWORK.md` and the MCP entrypoint)

Companion Planning already runs an MCP server with two transports (stdio for local Cowork/Claude Desktop attachment, HTTP/Streamable over Tailscale for remote — `server/dist/mcp-stdio.js` built from `npm run build`, verified via `ops/scripts/mcp-smoke.mjs`, "36 tools, real-data round-trip"). This is a real, working, documented surface — not a stub.

**The current 36 tools, verbatim from the docs:**

```
list_files, read_file, write_file, append_section,
list_todos, add_todo, complete_todo, uncomplete_todo, search, stats, triage_inbox,
summarize_day, rescan, extract_todos_from_text, project_rollup, propose_archive,
apply_suggestion, llm_status, extract_from_source, list_suggestions,
accept_suggestion, dismiss_suggestion, task_history, set_estimate, capacity_report,
lookahead, list_calendar, memory_set, memory_get, memory_list, sync_calendar,
schedule_task, generate_summary, reconcile_past, last_summaries, find_slot
```

**Observed naming pattern (my own read, not a confirmed standard):** mostly `verb_noun` (`add_todo`, `complete_todo`, `list_calendar`), a few `noun_verb` outliers (`task_history`, not `history_task`), a few that don't fit either (`rescan`, `stats`, `search` — bare verbs/nouns with no object), and a few that read as full sentences (`extract_todos_from_text`, `extract_from_source`). This inconsistency is exactly the kind of thing a shared "intent vocabulary" would standardize — but I can't tell you the *right* pattern without CI-Server's spec.

## What "aligning with CI-Server" likely means (to confirm)

A shared MCP intent vocabulary across CI-Server, CI-Import Tools, CI-Hub, and Companion Planning probably standardizes some subset of:

- **A fixed verb set** (e.g., always `create`/`get`/`list`/`update`/`delete`/`search`, never synonyms like `add`/`fetch`/`find` scattered per-tool).
- **A fixed verb-noun order** (`create_task` vs `task_create` — pick one, everywhere).
- **A standard error/response envelope** shared across all CI MCP servers (so a client written against CI-Server's shape doesn't need per-server special-casing).
- **A standard auth header/handshake for the HTTP transport** (relevant since Companion Planning's HTTP transport already runs over Tailscale — if CI-Server's MCP tools expect a specific bearer/session convention, that should reconcile with whatever U lands on for the app's own auth).
- **Naming for cross-cutting intents** (e.g., is "search" one universal tool with a `kind` parameter across all CI apps, or does each app get its own `search`? Companion Planning's `search` today is presumably scoped to its own data only.)

## Proposed approach once the spec is in hand

1. **Audit pass:** map all 36 current tools against CI-Server's vocabulary — for each, is it (a) a direct match needing only a rename, (b) a concept CI-Server doesn't have (Companion-Planning-specific, e.g. `find_slot`, `capacity_report` — scheduling concepts unlikely to exist in a generic CI vocabulary), or (c) a gap where CI-Server has a standard intent Companion Planning doesn't yet expose?
2. **Rename plan** for (a) — low-risk, mechanical, but note this is a **breaking change for any existing MCP client config** (the `claude mcp add` examples in `CLAUDE_COWORK.md` reference exact tool names) — needs a deprecation/dual-naming window if any external consumer already depends on current names.
3. **Keep (b) as-is**, documented as intentionally Companion-Planning-specific vocabulary layered on top of the shared CI convention, not a violation of it.
4. **Scope (c)** as new tool development, likely lower priority than T-V.

## Dependencies & parallelization

- Fully independent of T, U, V, W schema/auth work — this only touches the MCP tool layer (`server/src/mcp/`), not the database.
- Can start the audit (section above) immediately; the rename/alignment work is blocked purely on receiving CI-Server's spec.
- The HTTP-transport auth reconciliation point has a soft dependency on U (once U decides how request auth works, confirm the MCP HTTP transport's existing auth story is consistent with it — worth a quick check regardless of X's main scope).

## Effort estimate
**S-M** — mostly a naming/mapping exercise once the spec exists; the size driver is entirely "how many of the 36 tools need renaming" and "how much backward-compat shimming is needed for existing configs," both unknown until the spec is in hand.

## Definition of done
- [ ] CI-Server's vocabulary spec obtained.
- [ ] Full 36-tool gap analysis against it (match / Companion-specific / CI-Server gap).
- [ ] Rename plan with a compat window for existing MCP client configs.
- [ ] HTTP-transport auth reconciled with whatever U ships.
