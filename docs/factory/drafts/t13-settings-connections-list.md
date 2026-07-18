> **Type:** Frontend + Backend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/settings-connections-list`
> **Commit style:** `feat(settings): per-account connection list`
> **Design:** this ticket is the spec (FTUE framing: `docs/ftue-plan.md`)
> **Dependencies:** None (supports T12 + Wave-5 sharing)

> ### 🚧 LIVE — issue #349, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.

## Goal

Give the Settings → **Connections** tab a provider-agnostic **per-account connection list**: one row per `connection_tokens` record the current owner holds, showing **provider + account + status**, with **Connect** (Google) and **Disconnect** controls. Back it with a new leak-safe read endpoint `GET /api/connections` → `{ connections: [{ provider, account, status, createdAt }] }` (it selects only those four columns — **never** any token material), and a generic `DELETE /api/connections/:provider/:account` that best-effort revokes (Google) and hard-deletes the stored connection. This is the stable connection surface T12 and Wave-5 sharing build on.

## Non-goals (fence off adjacent work)

- **Do not** expose any token material. The list must never carry `iv` / `auth_tag` / `ciphertext` / `key_version` / `access_token` / `refresh_token` / `expires_at` — only `provider`, `account`, `status`, `created_at`. Mirror the leak-safe posture already asserted in `server/test/connections.test.ts`.
- **Do not** add a new provider connector or a new "connect" flow for anything other than Google. Connecting a **new** provider needs a connector (out of scope); the **Connect** button stays Google-only via the existing `GET /api/oauth/google/start`. `DELETE` works generically for any stored provider row (revoke is Google-only; other providers are just deleted).
- **Do not** build sharing UI — that is Wave 5. This ticket is **visibility + disconnect** only.
- **Do not** change `GET /api/integrations` or its `google.connections` (WP7 health) shape. It stays as-is; `aiAvailable()` and the Ollama/Google/push status rendering must not regress.
- **Do not** add a migration. `connection_tokens` already has `provider`, `account`, `status`, and `created_at`; no schema change is needed.

## Pinned conventions

- **`connection_tokens` shape** (`server/src/db/schema.ts:545-557`, migration `0050`): `owner_id` (FK owners, NOT NULL), `provider` (`'google' | 'outlook' | 'icloud'`), `account`, plus sealed columns `iv` / `auth_tag` / `ciphertext` / `key_version`, `status` (`'active' | 'revoked' | 'error'`, default `'active'`), and ISO-8601 TEXT `created_at` / `updated_at` (default `CURRENT_TIMESTAMP`). One row per `(owner, provider, account)`.
- **Leak-safe read pattern to mirror** (`server/src/lib/connections.ts`): `connectionHealth(ownerId)` (WP7) is the reference for a minimal, secret-free connection shape. The new `listConnections(ownerId)` is simpler still — it needs **no decrypt** (status comes straight from the `status` column), so it does **not** call `open()`/`loadKek()` at all.
- **Owner scoping**: every read/write filters by `currentOwnerId()` (`server/src/lib/context.ts` — **throws if unscoped**). `listConnections` and `disconnectConnection` take `ownerId` and scope every query by `owner_id = ?`; another owner's rows are never listed, revoked, or deleted.
- **Auth**: routes are gated globally by `requireAuth()` (mounted in `server/src/app.ts`); the required scope is derived from the HTTP method (`hasScope(claims.scopes, ctx.method)` in `server/src/lib/auth/scopes.ts`) — `GET` needs `planning:read`, `DELETE` needs `planning:write`. **No per-route guard** and **no `PUBLIC_PREFIXES` change**; `/api/connections` sits behind the global gate like every other `/api/*` route.
- **Existing Google disconnect to reuse** (`server/src/routes/oauth.ts:316-354`, `DELETE /api/oauth/google/accounts/:account`): best-effort `revoke()` of the decrypted refresh/access token, then hard-`DELETE` the `connection_tokens` row **and** any `outbound_queue` rows for `(owner, 'google', account)`; `404` when nothing was deleted. This logic is **extracted** into a shared `disconnectConnection()` so the new generic route and the existing Google route share one implementation.
- **Migration slot**: **None consumed.** For reference only, the next free slot on main is `0127`; this ticket claims nothing (no migration).
- **Route registration**: new router `connectionsRouter()` in `server/src/routes/connections.ts`, added to the `mountRoutes` array in `server/src/routes/index.ts` (import `{ connectionsRouter }`, append `connectionsRouter()`).
- **Client API**: add methods via the `request<T>(method, path, body?)` helper in `client/src/lib/api.ts` (path relative to the `/api` base, e.g. `request<...>('GET', '/connections')`). Add a store resource in `client/src/stores/index.ts` as a module-scope `createResource` (declare it **after** the `integrations` resource; no memo reads it, so no TDZ concern).
- **Settings tabs**: the Connections tab is `activeTab() === 'connections'` in `client/src/views/Settings.tsx` (`activeTab` is `'preferences' | 'connections'`). The existing WP7 per-account render lives inside the **Integrations** card at `Settings.tsx:1341-1419`.

## Before implementation

Read, in order, and bind the ticket to the real handles:

1. `server/src/lib/connections.ts` — the `connectionHealth` leak-safe shape and query style; this file gains `listConnections` + `disconnectConnection`.
2. `server/src/routes/oauth.ts:316-354` — the `DELETE /accounts/:account` revoke+delete+`outbound_queue`-cleanup+`404` logic to extract; and `revoke` imported from `../connectors/index.js`, `open`/`loadKek` from `../lib/crypto/index.js`.
3. `server/src/connectors/index.ts` — the `provider` switch (`'google'` only today); the generic disconnect revokes **only** for `'google'`, deletes the row for any provider.
4. `server/src/db/schema.ts:545-557` (`connection_tokens`) and `:627-634` (`outbound_queue` — columns `owner_id`, `block_id`, `provider`, `account`).
5. `server/src/routes/llm.ts:17-45` — `GET /api/integrations` (leave untouched); confirm `google.connections` stays the WP7 health source.
6. `server/src/routes/index.ts` — the `mountRoutes` array to register `connectionsRouter()`.
7. `client/src/lib/api.ts:900-919` — the `ConnectionHealth` / `Integrations` mirror types (add `ConnectionSummary` alongside); the `request` helper.
8. `client/src/stores/index.ts:297-302` — the `integrations` resource + `refetchIntegrations`; add the `connections` resource right after.
9. `client/src/views/Settings.tsx:408-443` (`connectGoogle` / `disconnectGoogle` helpers + the `?google=connected` effect at `:398-414`) and `:1341-1419` (the WP7 per-account block being moved).
10. `server/test/connections.test.ts` and `server/test/oauth.test.ts` — the no-leak-guard test and the `startTestServer` / `api` / `realApi` route-driving harness to reuse.

## Files impacted

**New:**

- `server/src/routes/connections.ts` — `connectionsRouter()`: `GET /api/connections` + `DELETE /api/connections/:provider/:account`.
- `server/test/connections-route.test.ts` — `listConnections` leak-safety/ordering + route-level GET/DELETE + owner-scoping tests (uses `startTestServer` + `api`/`realApi` like `oauth.test.ts`).

**Changed:**

- `server/src/lib/connections.ts` — add `ConnectionSummary` interface, `listConnections(ownerId): ConnectionSummary[]`, and `disconnectConnection(ownerId, provider, account): boolean` (shared revoke+delete).
- `server/src/routes/oauth.ts` — refactor `DELETE /accounts/:account` to delegate to `disconnectConnection(ownerId, 'google', account)`; preserve its `{ disconnected: account }` / `404 { error: 'account_not_found' }` response contract.
- `server/src/routes/index.ts` — import + register `connectionsRouter()`.
- `client/src/lib/api.ts` — add `ConnectionSummary` type and `api.connections = { list, disconnect }`.
- `client/src/stores/index.ts` — add `connections` resource + `refetchConnections`.
- `client/src/views/Settings.tsx` — add the **Connected accounts** card on the Connections tab (provider-agnostic list + status pill + Disconnect + Google Connect); move the per-account inventory out of the WP7 Integrations block; repoint `disconnectGoogle` to `api.connections.disconnect`.

## Schema required

**None.** No migration. `connection_tokens` (migration `0050`, `server/src/db/schema.ts:545-557`) already provides `provider`, `account`, `status` (default `'active'`), and `created_at` (ISO-8601 TEXT). `outbound_queue` (`:627-634`) already has `owner_id` / `provider` / `account` for the disconnect cleanup. No new table, column, index, or Drizzle change. (For reference only: the next free migration slot on main is `0127` — this ticket does not claim it.)

## Definition of Done

- [ ] `listConnections(ownerId)` in `server/src/lib/connections.ts` returns `ConnectionSummary[]` via `SELECT provider, account, status, created_at FROM connection_tokens WHERE owner_id = ? ORDER BY provider, account` — **only** those four columns; returns `[]` (never null) when the owner has none. No `open()`/`loadKek()` call.
- [ ] `ConnectionSummary = { provider: string; account: string; status: string; createdAt: string }` is exported and its `createdAt` maps from the `created_at` column.
- [ ] `disconnectConnection(ownerId, provider, account)` best-effort `revoke()`s **only** when `provider === 'google'` (JIT-decrypt the stored `refreshToken || accessToken`, swallow decrypt/revoke errors with a redacted warn), then hard-`DELETE`s the `connection_tokens` row **and** the `(owner, provider, account)` `outbound_queue` rows; returns `true` iff a `connection_tokens` row was deleted, `false` otherwise.
- [ ] `GET /api/connections` returns `200 { connections: listConnections(currentOwnerId()) }`; no ciphertext/iv/auth_tag/key_version/token appears anywhere in the body.
- [ ] `DELETE /api/connections/:provider/:account` returns `200 { disconnected: { provider, account } }` when a row was removed, or `404 { error: 'connection_not_found' }` when none matched (owner-scoped). `:account` is read via `ctx.params.account` (URL-decoded by the router).
- [ ] `connectionsRouter()` is registered in `server/src/routes/index.ts`'s `mountRoutes` array.
- [ ] `oauth.ts` `DELETE /accounts/:account` now calls `disconnectConnection(ownerId, 'google', account)` and keeps returning `{ disconnected: account }` on success and `404 { error: 'account_not_found' }` on miss — no behavior change for existing callers/tests.
- [ ] `GET /api/integrations` and its `google.connections` (WP7) payload are unchanged; `aiAvailable()` still works.
- [ ] Client: `api.connections.list()` → `{ connections: ConnectionSummary[] }`; `api.connections.disconnect(provider, account)` → `DELETE /connections/{provider}/{encoded account}`. `ConnectionSummary` mirrors the server type.
- [ ] Client store: a `connections` resource + `refetchConnections` exist in `stores/index.ts`, declared after `integrations`.
- [ ] Client: the Connections tab shows a **Connected accounts** card listing every `connections()` row as `provider · account` + a status pill (`connected`/`expired`/`inactive`/`active`/`revoked`/`error` styled) + a **Disconnect** button; a **Connect** (Google) button appears in the card header when `integrations().google.liveEnabled` and no `google` account is present. For `google` rows, the existing health sub-line (last sync / mapped-event count / last error) is preserved by matching `integrations().google.connections` on `account`.
- [ ] Client: the WP7 per-account inventory `<For>` + its Connect/Disconnect controls are **removed** from the Integrations card (`Settings.tsx:1341-1419`); the Integrations card keeps only the Ollama + Google **mode/status** lines. Google appears in exactly **one** list (no duplicate rows across cards).
- [ ] Client: disconnect calls `api.connections.disconnect(...)` then `refetchConnections()` **and** `refetchIntegrations()`; the `?google=connected` return and `connectGoogle` fallback also call `refetchConnections()`.

## Tests

Server tests are vitest (shared sequential DB, migration-on-import; **tests live in `server/test/**/*.test.ts`**, included via `server/vitest.config.ts` `include: ['test/**/*.test.ts']`). The suite runs with `GOOGLE_MODE=fixture` and no reachable Ollama; seed `connection_tokens` rows directly (no KEK needed for the list — it doesn't decrypt). Reuse `resetDb`, `startTestServer`, `api`, `realApi`, and `SYSTEM_OWNER` from `./helpers.js`.

- [ ] **list shape + ordering** — seed 2+ `connection_tokens` rows for `SYSTEM_OWNER` (e.g. `google`/`a@x`, `google`/`b@x`) with distinct `status`; `listConnections(SYSTEM_OWNER)` returns them ordered by `provider, account`, each `{ provider, account, status, createdAt }`.
- [ ] **no-leak guard** — seed a sealed token row; `JSON.stringify(listConnections(...))` (and the `GET /api/connections` body) contains **no** `iv` / `auth_tag` / `ciphertext` / `key_version` / `ya29.` / `1//` substrings (mirror `connections.test.ts`).
- [ ] **owner scoping** — seed rows for two owners; `listConnections(ownerA)` returns only A's rows; `GET /api/connections` as A never shows B's accounts.
- [ ] **route GET** — `GET /api/connections` returns `200 { connections: [...] }` for the seeded owner and `{ connections: [] }` for an owner with none.
- [ ] **route DELETE + `disconnectConnection`** — seed a `google` row (+ an `outbound_queue` row for it); `DELETE /api/connections/google/<account>` returns `200 { disconnected: { provider:'google', account } }`, the `connection_tokens` and `outbound_queue` rows are gone, and `revoke` is invoked (assert via a stubbed `fetch`, as `oauth.test.ts` does); a second delete (or an unknown provider/account) returns `404 { error: 'connection_not_found' }`.
- [ ] **oauth regression** — the existing `DELETE /api/oauth/google/accounts/:account` test still passes (revoke + row/queue deletion + `404` on miss) after the refactor to `disconnectConnection`.
- [ ] **client (typecheck/build-gated)** — `api.connections.list` / `.disconnect` and `ConnectionSummary` typecheck; the Connections tab compiles with the new card and no duplicate Google list. If no isolated unit exists, client `typecheck` + `build` are the gate.

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client build
pnpm --filter client test
```

## Acceptance Criteria

- [ ] **Given** an owner with one connected Google account, **when** they open Settings → Connections, **then** the **Connected accounts** card lists `google · <email>` with a status pill and a Disconnect button, and Google appears in **only** that one list.
- [ ] **Given** an owner with no connected accounts and Google in live mode, **when** they view the card, **then** it shows an empty-state line and an enabled **Connect** (Google) button; in `off`/`fixture` mode the Connect button is disabled with an explanatory title.
- [ ] **Given** a connected Google account, **when** the owner clicks **Disconnect**, **then** `DELETE /api/connections/google/<account>` revokes at Google and removes the token + queued rows, the list refetches empty, and no error toast fires.
- [ ] **Given** a request for `GET /api/connections`, **then** the JSON body contains only `{ provider, account, status, createdAt }` per row and **no** token material — verified by the no-leak test.
- [ ] **Given** a `DELETE` for a provider/account the owner does not hold, **then** the response is `404 { error: 'connection_not_found' }` and nothing else is mutated.
- [ ] **Given** the existing `DELETE /api/oauth/google/accounts/:account` caller, **then** its behavior and response are unchanged after the shared-helper refactor.
- [ ] `pnpm --filter server typecheck`, `pnpm --filter server test`, `pnpm --filter client typecheck`, `pnpm --filter client build`, and `pnpm --filter client test` all pass.

## Subtasks

1. [ ] In `server/src/lib/connections.ts`: add `ConnectionSummary`, `listConnections(ownerId)` (columns-only, ordered, no decrypt), and `disconnectConnection(ownerId, provider, account)` (Google-only `revoke()`, then delete `connection_tokens` + `outbound_queue`; return whether a row was deleted).
2. [ ] Add `server/src/routes/connections.ts` with `connectionsRouter()`: `GET /api/connections` → `{ connections }`; `DELETE /api/connections/:provider/:account` → `{ disconnected }` / `404`. Register it in `server/src/routes/index.ts`.
3. [ ] Refactor `server/src/routes/oauth.ts` `DELETE /accounts/:account` to delegate to `disconnectConnection(ownerId, 'google', account)`, preserving its response contract.
4. [ ] Add `ConnectionSummary` + `api.connections = { list, disconnect }` to `client/src/lib/api.ts`; add the `connections` resource + `refetchConnections` to `client/src/stores/index.ts` (after `integrations`).
5. [ ] In `client/src/views/Settings.tsx`: add the **Connected accounts** card (provider-agnostic list + status pill + Disconnect + Google Connect; Google rows keep the health sub-line via `integrations().google.connections`); remove the WP7 per-account inventory from the Integrations card; repoint `disconnectGoogle` to `api.connections.disconnect` and refetch `connections` + `integrations` on connect/disconnect returns.
6. [ ] Write `server/test/connections-route.test.ts` (list shape/ordering, no-leak, owner scoping, GET, DELETE + revoke + `404`); confirm the oauth DELETE regression test still passes; run the five verification commands green.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
