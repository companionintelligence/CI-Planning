> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/connections-one-surface` · **Commit style:** `refactor(connections): one shape, one error contract, one disconnect` · **Design:** this ticket is the spec · **Dependencies:** llm-6 (config modes). Touches the same connector modules as llm-3, so land after it.

> **STATUS: READY. Re-verified against `main` @ `b110ff9` on 2026-08-14 (after llm-1/2/4/5/6 merged) by READING each cited file. Line anchors in §1 and §4 all still hold. Two corrections marked ⚠️ inline — one removes a work item entirely.**

## ⚠️ Corrections from the first draft (2026-08-14)

1. **`GET /api/oauth/google/accounts` is already gone** — removed in T13, with a tombstone comment
   at `routes/oauth.ts:312`. The first draft treated deleting it as in-scope and asked for an owner
   ruling against the July "document, don't delete" decision. **That whole question is moot; drop
   it.** What DOES remain is a stale doc bug: the route table in the file header
   (`routes/oauth.ts:25`) still advertises `GET /accounts → list connected accounts`. Fix that line
   as part of this ticket.
2. **llm-6 has landed and changed the memory connector's config surface.** `memoryMode()`
   (`connectors/memory.ts:134`) is now a thin delegate to `config.memory.mode`, and the CI-Server
   URL comes from `config.memory.serverUrl` (`connectors/memory.ts:187`). This ticket must read
   through those, never `process.env` — the standing reuse rule. Nothing else in llm-6 collides:
   it touched no file in this ticket's list.

## Goal

Three providers store credentials in **one** table (`connection_tokens`: `google`, `ci_memory`,
fixture) and each grew its own surface. A "connection" now has two shapes, two-and-a-half
disconnect paths, three near-identical error classes, and one provider that bypasses the generic
surface entirely.

### 1. Two shapes over one table

| | `ConnectionHealth` | `ConnectionSummary` |
|---|---|---|
| Site | `lib/connections.ts:15-23` | `lib/connections.ts:179-184` |
| Providers | `'google'` only (hardcoded, `:57`) | all |
| Decrypts | yes, for `expiresAt` | no |
| Extra | `mappedEventCount`, `lastSyncAt`, `lastError` | `createdAt` |
| Served by | `GET /api/integrations` → `google.connections` | `GET /api/connections` |

Both are documented as "the locked client/server contract" and "deliberately MINIMAL". Two minimal
contracts over the same rows is one contract too many.

### 2. Memory has a parallel, provider-specific surface

Despite storing `provider='ci_memory'` rows in the same table, memory ships its own trio
(`routes/memory.ts:62, 70, 110`): `GET /api/memory/status`, `POST /api/memory/connect`,
`POST /api/memory/disconnect` — instead of appearing in `GET /api/connections` and being dropped
via `DELETE /api/connections/ci_memory/:account`. The generic surface is already provider-agnostic
and `disconnectConnection` (`lib/connections.ts:221`) already handles non-Google providers
("`ci_memory` / fixture have none and are simply dropped locally", `:229-230`).

### 3. Two disconnect routes

`DELETE /api/connections/:provider/:account` (`routes/connections.ts:30`) and
`DELETE /api/oauth/google/accounts/:account` (`routes/oauth.ts:314`). Both now call
`disconnectConnection` — the implementation was correctly de-duplicated already
(`lib/connections.ts:221`), the *routes* were not. ⚠️ The companion `GET /accounts` route is
**already deleted** (see Corrections above); only its stale header-comment entry at
`routes/oauth.ts:25` survives.

### 4. Three hand-rolled error classes with one contract

- `OllamaUnavailable` — `mcp/ollama.ts:19-24`
- `McpUnavailable` — `mcp/client.ts:16` ("*Mirrors OllamaUnavailable so ingest/sync callers degrade*")
- `MemoryUnavailable` — `connectors/memory.ts:40-45` ("*the McpUnavailable / OllamaUnavailable contract*")

Each class is five identical lines whose own comment points at the other two.

## Non-goals

- **Do not change what the Settings UI can do.** Same connect flows, same OAuth callbacks, same
  toggles. Client changes are limited to the endpoints/shapes named below.
- **Do not touch the OAuth flows themselves** — `/api/oauth/google/{start,callback}`,
  `/api/memory/ciportal/{start,callback}`. Connect is provider-specific by nature; only
  **list / status / disconnect** unify.
- **Do not merge `connection_prefs` or `google-config`** into this surface. Prefs are per-connection
  settings and the Google client config is server-global — different nouns.
- **Do not change the encryption, KEK handling, or the no-leak guarantee.** The no-leak tests
  (`connections.test.ts`, the connections-route guard) must pass unedited — they are the reason
  this refactor is safe to do at all.
- Do not delete `POST /api/memory/connect` — memory's connect takes a pasted URL+key, which the
  generic surface has no shape for.

## Pinned conventions

- One shape in `lib/connections.ts`, replacing both:
  ```ts
  export interface ConnectionRecord {
    provider: string;                 // 'google' | 'ci_memory' | …
    account: string;
    status: 'connected' | 'expired' | 'inactive';
    createdAt: string;                // ISO-8601
    expiresAt: string | null;         // null when inactive/unknown/not applicable
    lastSyncAt: string | null;
    lastError: string | null;
    mappedEventCount?: number;        // google only — absent, never 0, for others
  }
  ```
  Field names and the `status` vocabulary come from `ConnectionHealth`; `createdAt` from
  `ConnectionSummary`. The **raw** `connection_tokens.status` string (`'active' | 'revoked' |
  'error'`) does NOT leak — `ConnectionSummary` exposed it directly today; the unified shape maps
  it, as `ConnectionHealth` already does.
- Decryption stays opt-in: `listConnections(owner, { withExpiry?: boolean })`. `/api/connections`
  calls it without; `/api/integrations` calls it with. Same cost profile as today.
- The SELECT still names only safe columns. Never `iv` / `auth_tag` / `ciphertext` / `key_version`.
- One error base in a new `server/src/lib/connector-error.ts`:
  ```ts
  export class ConnectorUnavailable extends Error { constructor(public readonly connector: string, message: string) }
  ```
  The three existing classes become one-line subclasses that keep their **exact current names and
  `.name` values** — every `instanceof` check and every log key is unchanged. This is additive
  typing, not a rename.
- `GET /api/memory/status` stays (it reports pull/sync flags and creds source, which are not
  connection facts) but its connection block is sourced from `listConnections`.

## Before implementation

1. `server/src/lib/connections.ts` — the whole file.
2. `server/src/routes/{connections,oauth,memory}.ts` — every route listed above.
3. `server/test/connections.test.ts` — the no-leak guard; understand exactly what it asserts
   before changing any SELECT.
4. `client/src/stores/index.ts:336-360, 603-604` and `client/src/views/Settings.tsx:1481-1590` —
   the two client readers of connection state.
5. `server/src/routes/oauth.ts:20-30` — the header route table, which still lists the removed
   `GET /accounts`. (⚠️ The first draft pointed here for an owner ruling on deleting that route;
   it was already deleted in T13, so only the comment needs fixing.)

## Files impacted

**New:**
- `server/src/lib/connector-error.ts`
- `server/test/connections-unified.test.ts`

**Changed:**
- `server/src/lib/connections.ts` — `ConnectionRecord`, `listConnections(owner, opts)`; `ConnectionHealth`/`ConnectionSummary` deleted
- `server/src/routes/connections.ts` — serves `ConnectionRecord[]` for all providers
- `server/src/routes/oauth.ts` — delete `DELETE /accounts/:account`; fix the stale `GET /accounts` line in the header table at :25
- `server/src/routes/llm.ts:45-50` — `google.connections` from the unified list
- `server/src/routes/memory.ts` — `status` sources its connection block from `listConnections`; `disconnect` delegates
- `server/src/mcp/ollama.ts`, `server/src/mcp/client.ts`, `server/src/connectors/memory.ts` — the three error classes extend `ConnectorUnavailable`
- `client/src/lib/api.ts`, `client/src/stores/index.ts`, `client/src/views/Settings.tsx` — shape reads; memory disconnect points at the generic route
- `ARCHITECTURE.md` — one paragraph: one table, one shape, one disconnect

## Schema required

**None.** No migration. `connection_tokens` is unchanged; this ticket only changes how its rows
are shaped on the way out.

## Definition of Done

- [ ] `ConnectionHealth` and `ConnectionSummary` no longer exist; one `ConnectionRecord` does.
- [ ] `GET /api/connections` lists Google **and** `ci_memory` rows.
- [ ] Exactly one disconnect route; the memory Settings card uses it.
- [ ] The three unavailable errors share a base; every existing `instanceof` and `.name` still
      matches (this is the highest-risk item — grep and list every site in the PR body).
- [ ] `connections.test.ts` no-leak assertions pass **unedited**; the raw `'active'` status string
      is no longer returned anywhere.
- [ ] Settings → Connections renders the same states for Google and Memory as before.

## Tests

- [ ] `connections-unified.test.ts`: a `ci_memory` row appears in `GET /api/connections`; a Google
      row carries `mappedEventCount` and a `ci_memory` row does not; an expired Google token
      reports `status: 'expired'`; a token that fails to decrypt reports `'inactive'` and logs
      redacted (all four already asserted somewhere — this file is where they consolidate).
- [ ] No-leak: response JSON never contains `iv`, `auth_tag`, `ciphertext`, `key_version`,
      `accessToken`, `refreshToken`, or a raw `'active'`.
- [ ] `DELETE /api/connections/ci_memory/:account` drops the row and its `outbound_queue` rows.
- [ ] `err instanceof OllamaUnavailable`, `McpUnavailable`, `MemoryUnavailable` all still narrow;
      `err instanceof ConnectorUnavailable` narrows all three.
- [ ] `memory-connector.test.ts`, `memory-ciportal.test.ts`, `memory-push.test.ts` unchanged.

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] Given a user with a Google account and a CI-Server memory connection, when they open
      Settings → Connections, then both appear from one endpoint with one shape.
- [ ] Given any connector goes down, when a caller catches, then one `instanceof ConnectorUnavailable`
      covers all three — and each specific class still narrows for callers that want one.
- [ ] Given the no-leak guard, then it passes without edits.

## Subtasks

1. [ ] Add `connector-error.ts`; reparent the three classes; grep + verify every `instanceof`.
2. [ ] Define `ConnectionRecord`; rewrite `listConnections(owner, opts)`; delete both old shapes.
3. [ ] Repoint `/api/connections`, `/api/integrations`, `/api/memory/status`.
4. [ ] Repoint the client (`api.ts`, `stores/index.ts`, `Settings.tsx`) at the unified shape.
5. [ ] Delete `DELETE /api/oauth/google/accounts/:account`, and fix the stale `GET /accounts` entry
      in the `routes/oauth.ts:25` header table. (⚠️ The `GET` route itself is already gone — no
      owner ruling needed, contrary to the first draft.)
6. [ ] Consolidate the connection tests into `connections-unified.test.ts`.
7. [ ] Update `ARCHITECTURE.md`.
