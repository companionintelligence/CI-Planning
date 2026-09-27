# X — MCP intent vocabulary: source-verified audit

**Status:** Audit complete. **No code changed.** This supersedes the "current state" section of `X-mcp-intent-vocabulary.md`, which was written from `docs/CLAUDE_COWORK.md` rather than from `server/src` directly. Read against the actual source, the premise of that section doesn't hold: the "36-tool MCP server" it describes isn't part of the current application. Real alignment against CI-Server's vocabulary spec is still blocked (spec not in hand) — that part of X is unchanged.

## Headline finding

`docs/CLAUDE_COWORK.md` and, by inheritance, `docs/X-mcp-intent-vocabulary.md` describe Companion Planning as currently running an MCP **server** exposing 36 planning tools (`list_todos`, `add_todo`, `find_slot`, `capacity_report`, etc.) over stdio and HTTP/Tailscale. That surface does not exist in the codebase today.

Verified via git history:

- The 36-tool MCP server (`server/src/mcp.ts`, `server/src/mcp-stdio.ts`) belonged to the **pre-rebuild** app — the markdown-file-backed, MCP-native todo tool from `c1619c2` ("v2: SQLite-indexed, MCP-native, LLM-augmented private todo system") through `5136d71` (V4.1). `docs/CLAUDE_COWORK.md` was written in that era (`3c39226`, 2026-05-29).
- `1510cd8` ("Rebuild from scratch: Koa + SolidJS + Drizzle (v0.2 architecture)", 2026-05-30) replaced the entire backend. `server/src/mcp.ts` and `server/src/mcp-stdio.ts` did not carry over. Everything downstream of that commit — the app the rest of this ROADMAP describes (B0 through N) — is the Koa/SolidJS/Drizzle rebuild.
- `docs/CLAUDE_COWORK.md` was never updated after the rebuild (last touched 2026-05-29, one day before `1510cd8`) and still describes the dead app as live. It has since been cited as current by at least one other planning doc (`U-oidc-local-auth.md` references its Tailscale MCP HTTP endpoint as existing precedent).
- Confirmed by direct inspection, not just git history: `server/package.json` has no `build` script and no `mcp-stdio` entry point; there is no `server/dist/` in the tree; there is no `server/src/mcp-stdio.ts`; `grep` for any of the 36 tool names (`list_todos`, `add_todo`, `find_slot`, `capacity_report`, …) across `server/src` returns nothing. `ops/scripts/mcp-smoke.mjs`, which the docs point to as the thing that "verified 36 tools," spawns `server/dist/mcp-stdio.js` — a file that cannot exist given the current build. It would fail if run today.
- There is no `/mcp` HTTP route anywhere in `server/src` (checked directly), so the documented Option B (`http://100.x.x.x:3847/mcp` over Tailscale) is also not live.

Practically: **Companion Planning does not currently expose itself as an MCP tool server to anything** (Claude Cowork, Claude Desktop, or otherwise). `docs/CLAUDE_COWORK.md` should be marked stale/historical or removed — that's a documentation fix, not code, but it's the most consequential thing this audit found, so it's flagged here rather than silently worked around.

## What MCP surface actually exists today

The current app uses MCP in exactly one place, and in the opposite direction from what the docs describe: **Companion Planning is an MCP client**, not a server, for its own Google Calendar/Gmail connector (Phase J / the Google-connector track, `#130–#139`).

- `server/src/mcp/client.ts` — `McpGoogleSession`, which spawns a child process (`CP_MCP_COMMAND`) over stdio and drives it with `@modelcontextprotocol/sdk`'s `Client`.
- `server/src/mcp/google-server.ts` + `server/src/scripts/mcp-google-server.ts` — the counterpart MCP **server** CP spawns, exposing Google Calendar over the SDK's `Server`. Import-safe/unit-testable logic lives in `google-server.ts`; the executable stdio entry is the thin `scripts/mcp-google-server.ts`.
- `server/src/mcp/google.ts` — `createFixtureGoogleClient` / `createLiveGoogleClient`, switched by `GOOGLE_MODE` (`fixture` default, `live` for the real connector). Fixture mode never touches MCP at all.

### The real tool inventory (7 tools, not 36)

Pinned in `client.ts`'s `REQUIRED_TOOLS` and implemented in `google-server.ts`:

| Tool | Verb-noun shape | Surface | Implemented? |
|---|---|---|---|
| `calendar_list_events` | `domain_verb_object` | Calendar | ✅ `google-server.ts` |
| `calendar_create_event` | `domain_verb_object` | Calendar | ✅ |
| `calendar_update_event` | `domain_verb_object` | Calendar | ✅ |
| `calendar_delete_event` | `domain_verb_object` | Calendar | ✅ |
| `gmail_list_messages` | `domain_verb_object` | Gmail | Pinned in `REQUIRED_TOOLS`, required only when `config.google.enableGmail` — no in-repo Gmail MCP server implementation (only the calendar one exists; see `google-server.ts` header comment: "Gmail tools are intentionally absent... gmail.readonly is a restricted scope needing a CASA assessment") |
| `gmail_get_message` | `domain_verb_object` | Gmail | same as above |
| `gmail_modify_labels` | `domain_verb_object` | Gmail | same as above |

**Naming pattern — and this is the one clean finding in CP's favor:** all 7 names follow a single, consistent `domain_verb_object` shape (`calendar_list_events`, not `list_calendar_events` or `events_list`). There's no `verb_noun`/`noun_verb` inconsistency here the way the old 36-tool list had (`add_todo` vs. `task_history`). If CI-Server's vocabulary spec turns out to prefer a different order (e.g. `verb_domain_object`), this is a 7-name rename, not a 36-name one, and it touches exactly two call sites: the `REQUIRED_TOOLS` map in `client.ts` and the `TOOL_DESCRIPTORS` array in `google-server.ts` (both files, same repo, both editable together — no cross-repo coordination needed for the naming itself).

### Response / error envelope (verified against `google-server.ts` + `client.ts`)

- Success: `{ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }` — the `ok()` helper. `structuredContent` is what the client actually reads (`structuredOf()` in `client.ts`); `content[0].text` is a JSON-stringified duplicate for any consumer that only reads text.
- Error: `{ content: [{ type: 'text', text: '<tool> failed: HTTP <status> <detail>' }], isError: true }` — the `fail()` helper. The numeric HTTP status is embedded in the text string, not a structured field; `McpGoogleSession` regex-matches it back out (`statusOf()` in the connector) to distinguish 409 (duplicate create → idempotent read-back), 412 (etag conflict), 410 (expired sync token), 404 (already-gone delete). This is a homegrown convention specific to this integration, not something derived from an MCP standard — worth flagging as a candidate for standardization if CI-Server's spec defines one, since a generic MCP client has no way to parse it without CP-specific regex.
- `inputSchema` on every tool descriptor is `{ type: 'object' }` — maximally permissive, no per-field schema. Validation happens entirely on the client side of the argument-building code in `client.ts` (e.g. `String(a.title ?? '')`). If CI-Server's convention expects real JSON-Schema `inputSchema`s per tool, that's a gap on CP's side today, independent of naming.

### Auth / transport (verified against `client.ts`, `google-server.ts`, `scripts/mcp-google-server.ts`)

- Transport is stdio-only, locally spawned (`CP_MCP_COMMAND`), never network-exposed. There is no HTTP/Streamable MCP transport in the current app (see Headline finding above) — the doc's Tailscale-reachable `/mcp` endpoint doesn't exist, so the "HTTP-transport auth reconciliation with Phase U" dependency the planning doc calls out is currently moot; there's nothing to reconcile until (if) an HTTP MCP surface is built.
- Auth into the spawned child is a single bearer token injected via a deliberately minimal env (`minimalEnv()`: just `GOOGLE_ACCESS_TOKEN` + `PATH`, no other env vars forwarded — the child never sees `CP_KEK_B64`, `DB_PATH`, etc.). The token comes from `connection_tokens` (encrypted at rest, refreshed as needed) and is never passed via argv or logged.
- Resilience: a circuit breaker opens after 5 consecutive MCP failures (30s cooldown), retries get 3 attempts with a `CP_MCP_TIMEOUT_MS` deadline (default 30s) — all client-side, in `client.ts`, unrelated to naming/vocabulary.

## Corrected gap analysis (replaces X's original §"Proposed approach" step 1)

The original doc's step 1 ("map all 36 current tools against CI-Server's vocabulary") can't be executed — 33 of the 36 named tools don't exist in the current server, and the 3 that might loosely resemble them (`sync_calendar`, `list_calendar`, `find_slot`) are REST routes in the current app (`/api/calendar/*`, per `ARCHITECTURE.md`), not MCP tools. Revised framing:

1. **In scope for a future CI-Server vocabulary alignment pass:** the 7 real tool names above (`calendar_*` × 4, `gmail_*` × 3). Small surface, single naming pattern already, low risk either way.
2. **Not in scope, because it doesn't exist:** anything from the 36-tool list. If Companion Planning is meant to expose a planning-brain MCP server to Cowork/Claude Desktop again, that's new tool-server development against the current v0.2+ schema (tasks, time_blocks, patterns, objectives, etc.) — not a rename of dead code. Worth a separate roadmap item if the Cowork-attachment use case (described in the now-stale `CLAUDE_COWORK.md`) is still wanted; it would need to be designed against today's data model, not resurrected from the pre-rebuild one.
3. **Documentation debt, independent of CI-Server's spec:** `docs/CLAUDE_COWORK.md` should be corrected or archived so it stops presenting a dead architecture as current (and so other docs, like `U-oidc-local-auth.md`, stop citing it as precedent).
4. **Still genuinely blocked on the external spec:** whether `domain_verb_object` is the right shape for the 7 real tools, whether the `isError`+regex-status convention should become a structured field, and whether `inputSchema: { type: 'object' }` needs to tighten to real per-field schemas — all of this needs CI-Server's convention to answer, same as the original doc said.

## Dependencies & parallelization (unchanged from X, confirmed still accurate)

Fully independent of T/U/V/W schema/auth work — this only touches `server/src/mcp/` and `server/src/connectors/`, not the database. The HTTP-transport-auth line item is now lower priority than X originally scored it, since there's no HTTP MCP transport to reconcile yet.

## Effort estimate

**S** (down from X's S-M) — the real surface is 7 tools in 2 files, not "up to 36 tools, unknown backward-compat cost." The larger unknown is no longer sizing the rename; it's whether anyone still wants the 36-tool Cowork-facing server rebuilt, which is a product decision, not a vocabulary one.

## Definition of done

- [ ] CI-Server's vocabulary spec obtained.
- [ ] Gap analysis of the **7 real** `calendar_*`/`gmail_*` tools against it (match / CP-specific / CI-Server gap).
- [ ] Decision on whether the error envelope's embedded-status-in-text convention should change.
- [ ] `docs/CLAUDE_COWORK.md` corrected or archived (separate from CI-Server alignment, but surfaced by this audit).
- [ ] If a Cowork-facing planning-tool MCP server is still wanted, scope it as new work against the current schema — not folded into X's rename scope.
