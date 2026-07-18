> **Type:** DB Migration + Backend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/plan-week-session-log`
> **Commit style:** `feat(plan-week): session-level planning-session log`
> **Design:** this ticket is the spec (see also docs/ftue-plan.md)
> **Dependencies:** None

> ### 🚧 LIVE — issue #337, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.
>
> ⚠️ **Its migration slot is TAKEN.** `0127` is now `life_priorities` (PR #356) and the head is
> `0130`, so the `0127_planning_sessions` name appears in five places below that all need
> renumbering: the file, the `id` export, the `index.ts` import, the `MIGRATIONS` append, and the
> DoD line. **Use `0131`** — verified free on 2026-07-18 with no open PRs claiming a slot.
> (§Pinned conventions already anticipated this: *"the implementer confirms the next free integer
> at implementation time and renumbers if `0127` is taken."* This banner is that confirmation.)

## Goal

Persist each "Plan my week" session at the **session level only** — one `planning_sessions` row per session that stores the entire chat as a single transcript blob — behind an owner-scoped service and a REST CRUD API. This is the foundation the assistant shell (T2) and the per-branch flows write to, and the Logs tab (T6) reads. No per-turn event rows: the whole conversation is one JSON array on the session row.

## Non-goals (fence off adjacent work)

- **Do not** add a per-turn events table or any child table of `planning_sessions`. The transcript is one JSON column; that is the whole persistence model for this ticket.
- **Do not** build any UI — not the assistant shell (T2), not the Logs tab (T6). This ticket ends at the client `api.planWeek.session.*` methods + their TypeScript types.
- **Do not** add LLM summarization of the transcript (T10). The `summary` column is written verbatim from the request; nothing generates it here.
- **Do not** add branch-selection or branch-specific logic (fill-week / schedule-tasks / review / onboarding behaviors). `entry_branch` is stored as an opaque, code-validated string only.
- **Do not** add SSE `broadcast(...)` events for these routes. The Logs tab refetches; live streaming is out of scope for T1.
- **Do not** add a GraphQL type/resolver for `planning_sessions`. REST + service only.
- **Do not** wire `writeAudit(...)`. Planning sessions are operational chat logs, not audited domain writes, for this ticket.

## Pinned conventions

Verified against the repo at migration head `0126` on this branch. Restate/obey exactly:

- **Migration file** — `server/src/db/migrations/0127_planning_sessions.ts` exporting `export const id = '0127_planning_sessions';` and `export function up(db: Database): void`. `import type { Database } from 'better-sqlite3';`. This is a pure additive `CREATE TABLE` + `CREATE INDEX`, so use a single `db.exec(\`...\`)` with `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` (mirror `0109_copy_history.ts` exactly). **No `manual` export** — `manual?: true` is only for FK-toggling table rebuilds; this migration toggles nothing. Idempotent + forward-only. No `INSERT` in the migration (the service mints rows).
  - **Slot**: `0127` is the next free slot on this branch (head is `0126_default_categories`). Open PRs may also claim slots — the implementer confirms the next free integer at implementation time and renumbers if `0127` is taken.
  - **Register** in `server/src/db/migrations/index.ts`: add `import * as m0127 from './0127_planning_sessions.js';` immediately after the `m0126` import, and append `m0127` to the end of the `MIGRATIONS` array.
- **Drizzle mirror** (`server/src/db/schema.ts`) — add a `planningSessions` `sqliteTable('planning_sessions', {...})`. `id: text('id').primaryKey().$defaultFn(newId)`; `ownerId: text('owner_id').references(() => owners.id).notNull()` (owner refs specify **NO** `onDelete` in schema.ts — the migration DDL is what adds `ON DELETE CASCADE`); ISO-8601 TEXT timestamps via `text('...').notNull().default(sql\`CURRENT_TIMESTAMP\`)`. The status/entry-branch **enums are code-enforced, NOT CHECK constraints** — plain `text().notNull()`. `newId` is already imported in schema.ts; `sql` and `integer`/`text` too.
  - **The secondary index lives only in the migration DDL.** Do NOT add an `index(...)` to the schema.ts table's second-arg callback — repo convention is that schema.ts callbacks hold only `primaryKey`/`unique`, and `ix_*` indexes are created in migrations (grep confirms zero `index(` calls in schema.ts). This table needs neither `primaryKey` (it has a single-column PK) nor `unique`, so it takes **no second callback arg**.
- **Owner scoping** — `currentOwnerId()` from `server/src/lib/context.js` (THROWS outside a request/job context; returns SYSTEM_OWNER under `NODE_ENV=test`). T1's service signatures carry no `owner` argument, so **the service self-scopes**: every read/write calls `currentOwnerId()` internally and filters `WHERE owner_id = ?`. Use the `sqlite` handle from `server/src/db/index.js` with prepared statements (`.prepare(sql).get/all/run(...)`), matching `services/reflections.ts`.
- **Auth** — routes are auto-gated by the central `requireAuth()` mounted in `server/src/app.ts` before `mountRoutes`. `/api/plan-week/*` is **not** in `PUBLIC_PREFIXES`, so it inherits gating for free: `GET` needs `planning:read`, `POST`/`PATCH`/`DELETE` need `planning:write` (403 on mismatch). The route module does **not** reference scopes.
- **Client** — add methods to the `api` object in `client/src/lib/api.ts` via the module's `request<T>(method, path, body?)` helper (`BASE = '/api'`, so paths are `/plan-week/...`). Mirror the shape of the existing `objectives` block (list/create/update/delete returning typed envelopes).

## Before implementation

Read these to match reality:

- `server/src/db/migrations/0109_copy_history.ts` — the exact additive `db.exec` CREATE-TABLE-IF-NOT-EXISTS + `owner_id ... REFERENCES owners(id) ON DELETE CASCADE` + `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` + index pattern to clone.
- `server/src/db/migrations/index.ts` — the `import * as mNNNN` + `MIGRATIONS` array registration (lines 128 & 141 hold the `m0126` entries).
- `server/src/db/schema.ts` — `owners` (l.14), `reminders` (l.531), `connectionTokens` (l.545) for the `id`/`ownerId`/status-`text`/`createdAt` column idioms; note NO `onDelete` on owner refs in schema.ts.
- `server/src/services/reflections.ts` — the owner-scoped service idiom (prepared statements, discriminated `{ ok, error }` validation results, `sqlite` from `../db/index.js`).
- `server/src/routes/objectives.ts` — thin transport over a service: `currentOwnerId()`, `201` on create with `{ objective: row }`, `404`/`422` mapping, `{ ok: true }` on delete.
- `server/src/routes/index.ts` — the `import { xRouter } from './x.js'` + `mountRoutes` array (add the new router to both).
- `server/src/lib/context.ts` — `currentOwnerId()` contract.
- `server/src/lib/auth/requireAuth.ts` — confirms `/api/*` is gated centrally (nothing to add per-route).
- `client/src/lib/api.ts` — the `request` helper (l.1–8), the `objectives` block (l.448–457) to mirror, and where interfaces are declared.
- `server/test/helpers.ts` — `startTestServer`, `api(...)`, `resetDb()` (add a `DELETE`), `createOwner`/`SECOND_OWNER_ID`, `x-test-owner` header for isolation.
- `server/test/daily-recap.test.ts` — the in-memory `runMigrations` + `PRAGMA table_info` + `integrity_check`/`foreign_key_check` + idempotency migration-test pattern to clone.

## Files impacted

**New:**
- `server/src/db/migrations/0127_planning_sessions.ts` — the migration.
- `server/src/services/planning-sessions.ts` — owner-scoped service + types.
- `server/src/routes/plan-week.ts` — the REST router.
- `server/test/plan-week-sessions.test.ts` — migration + service/route tests.

**Changed:**
- `server/src/db/migrations/index.ts` — register `m0127`.
- `server/src/db/schema.ts` — add the `planningSessions` Drizzle table def.
- `server/src/routes/index.ts` — import + mount `planWeekRouter()`.
- `server/src/lib/context.ts` — **no change** (listed only to confirm it's read, not edited).
- `server/test/helpers.ts` — add `DELETE FROM planning_sessions;` to `resetDb()` (system-owner sessions otherwise leak across the shared sequential DB).
- `client/src/lib/api.ts` — add the `planWeek.session.*` methods + `PlanningSession` / `PlanWeekMessage` / `PlanWeekEntryBranch` / `PlanWeekSessionStatus` types.

## Schema required

New table `planning_sessions` (migration DDL — the authoritative shape):

```sql
CREATE TABLE IF NOT EXISTS planning_sessions (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at      TEXT,                                   -- NULL until the session closes
  entry_branch  TEXT NOT NULL,                          -- code enum: fill_week | schedule_tasks | review | onboarding
  status        TEXT NOT NULL DEFAULT 'open',           -- code enum: open | completed | abandoned
  llm_used      INTEGER NOT NULL DEFAULT 0,             -- 0/1 flag
  transcript    TEXT NOT NULL DEFAULT '[]',             -- JSON array of { role: 'system'|'user', text, ts }
  summary       TEXT,                                   -- NULL; written verbatim (no LLM here)
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ix_planning_sessions_owner
  ON planning_sessions (owner_id, started_at);
```

Notes:
- `ended_at` and `summary` are nullable (no `NOT NULL`); all others are `NOT NULL` with the defaults shown.
- No CHECK constraints — `entry_branch` and `status` enums are enforced in the service/route (see below).
- `id` is a bare `TEXT PRIMARY KEY`; the service mints it with `newId()` from `../lib/ids.js` (do not rely on the `uuid7()` SQL default — none is set on this column).

Drizzle mirror to add to `server/src/db/schema.ts`:

```ts
export const planningSessions = sqliteTable('planning_sessions', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  startedAt: text('started_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  endedAt: text('ended_at'),
  entryBranch: text('entry_branch').notNull(),          // fill_week | schedule_tasks | review | onboarding (code-enforced)
  status: text('status').notNull().default('open'),     // open | completed | abandoned (code-enforced)
  llmUsed: integer('llm_used', { mode: 'boolean' }).notNull().default(false), // INTEGER 0/1 at rest
  transcript: text('transcript').notNull().default('[]'), // JSON array of { role, text, ts }
  summary: text('summary'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

## Service contract (`server/src/services/planning-sessions.ts`)

Types (exported):

```ts
export type PlanWeekEntryBranch = 'fill_week' | 'schedule_tasks' | 'review' | 'onboarding';
export type PlanWeekSessionStatus = 'open' | 'completed' | 'abandoned';
export interface TranscriptMessage { role: 'system' | 'user'; text: string; ts: string }

export const ENTRY_BRANCHES: ReadonlySet<string>;   // the four values above
export const SESSION_STATUSES: ReadonlySet<string>; // the three values above

/** Hydrated shape every read/return goes through: transcript parsed to array, llm_used → boolean. */
export interface PlanningSession {
  id: string; owner_id: string; started_at: string; ended_at: string | null;
  entry_branch: PlanWeekEntryBranch; status: PlanWeekSessionStatus;
  llm_used: boolean; transcript: TranscriptMessage[]; summary: string | null; created_at: string;
}
```

Functions (all self-scope via `currentOwnerId()`; all reads/writes filter `owner_id = currentOwnerId()`):

- `openSession(entryBranch): PlanningSession` — validates `entryBranch ∈ ENTRY_BRANCHES` (throw a typed error, or return a discriminated result — pick one and let the route map it to 422; see route contract); inserts `id = newId()`, `owner_id`, `entry_branch`, defaults for the rest; returns the hydrated row.
- `appendTranscript(id, message): PlanningSession | undefined` — owner-scoped read; if missing return `undefined`; validate `message.role ∈ {'system','user'}` and coerce `message.ts` to `new Date().toISOString()` when absent; push onto the parsed transcript array and write the re-serialized JSON back; return the hydrated row.
- `setTranscript(id, arr): PlanningSession | undefined` — owner-scoped; replaces the whole transcript array; returns hydrated row or `undefined` if missing.
- `closeSession(id, { status, summary?, llmUsed? }): PlanningSession | undefined` — owner-scoped; validate `status ∈ SESSION_STATUSES`; set `ended_at = new Date().toISOString()`, `status`, and (only when provided) `summary` / `llm_used`; return hydrated row or `undefined` if missing.
- `listSessions(): PlanningSession[]` — owner-scoped; `ORDER BY started_at DESC` (newest first, for the Logs tab).
- `getSession(id): PlanningSession | undefined` — owner-scoped single fetch.
- `deleteSession(id): boolean` — owner-scoped `DELETE`; returns whether a row was removed (`result.changes > 0`).

A single private `hydrate(row)` parses `transcript` JSON and coerces `llm_used` to boolean; every returning function funnels through it so `transcript` is never leaked as a raw string.

## Route contract (`server/src/routes/plan-week.ts`)

Export `planWeekRouter()` returning a `@koa/router` `Router`, registered in `routes/index.ts` (import + add `planWeekRouter()` to the `mountRoutes` array). Thin transport over the service (`currentOwnerId()` need not be called in the route since the service self-scopes; the route only shapes requests, status codes, and JSON):

- `POST /api/plan-week/sessions` — body `{ entry_branch }`. Bad/missing enum → `422 { error }`. On success `ctx.status = 201; ctx.body = { session }`.
- `PATCH /api/plan-week/sessions/:id` — one endpoint, multiple optional ops applied in order: if body has `message` (`{ role, text, ts? }`) → `appendTranscript`; else if body has `transcript` (array) → `setTranscript`; if body has `status` → `closeSession({ status, summary?, llm_used? })`. A missing/owner-mismatched id (service returned `undefined`) → `404 { error }`. Bad `status`/`role` enum → `422 { error }`. On success `ctx.body = { session }` (the final hydrated row).
- `GET /api/plan-week/sessions` — `ctx.body = { sessions }` (newest first).
- `GET /api/plan-week/sessions/:id` — `{ session }`, or `404 { error }`.
- `DELETE /api/plan-week/sessions/:id` — `{ ok: true }`, or `404 { error }` when nothing was removed.

## Client contract (`client/src/lib/api.ts`)

```ts
// types (place with the other exported interfaces)
export type PlanWeekEntryBranch = 'fill_week' | 'schedule_tasks' | 'review' | 'onboarding';
export type PlanWeekSessionStatus = 'open' | 'completed' | 'abandoned';
export interface PlanWeekMessage { role: 'system' | 'user'; text: string; ts?: string }
export interface PlanningSession {
  id: string; owner_id: string; started_at: string; ended_at: string | null;
  entry_branch: PlanWeekEntryBranch; status: PlanWeekSessionStatus;
  llm_used: boolean; transcript: Required<PlanWeekMessage>[]; summary: string | null; created_at: string;
}

// inside the `api` object:
planWeek: {
  session: {
    open:   (entry_branch: PlanWeekEntryBranch) => request<{ session: PlanningSession }>('POST', '/plan-week/sessions', { entry_branch }),
    list:   () => request<{ sessions: PlanningSession[] }>('GET', '/plan-week/sessions'),
    get:    (id: string) => request<{ session: PlanningSession }>('GET', `/plan-week/sessions/${id}`),
    append: (id: string, message: PlanWeekMessage) => request<{ session: PlanningSession }>('PATCH', `/plan-week/sessions/${id}`, { message }),
    close:  (id: string, patch: { status: PlanWeekSessionStatus; summary?: string; llm_used?: boolean }) =>
              request<{ session: PlanningSession }>('PATCH', `/plan-week/sessions/${id}`, patch),
    remove: (id: string) => request<{ ok: boolean }>('DELETE', `/plan-week/sessions/${id}`),
  },
},
```

## Definition of Done

- [ ] `0127_planning_sessions.ts` creates `planning_sessions` + `ix_planning_sessions_owner` idempotently via `CREATE ... IF NOT EXISTS`; no `manual` export; registered in `migrations/index.ts` (import + `MIGRATIONS` append).
- [ ] `planningSessions` Drizzle def added to `schema.ts` with the columns/types above; owner ref carries NO `onDelete`; no index in the table callback.
- [ ] `services/planning-sessions.ts` exports the types, `ENTRY_BRANCHES`/`SESSION_STATUSES`, and the seven functions; every function self-scopes via `currentOwnerId()`; all returns hydrated (`transcript` array, `llm_used` boolean).
- [ ] `routes/plan-week.ts` implements the five endpoints with the status codes above; registered in `routes/index.ts`; inherits central auth (no per-route scope code).
- [ ] `client/src/lib/api.ts` exposes `api.planWeek.session.*` + the four exported types.
- [ ] `resetDb()` in `server/test/helpers.ts` includes `DELETE FROM planning_sessions;`.
- [ ] No per-turn events table, no UI, no LLM summarization, no SSE, no GraphQL, no audit added (per Non-goals).
- [ ] `pnpm --filter server typecheck`, `pnpm --filter server test`, `pnpm --filter client typecheck`, `pnpm --filter client build` all pass.

## Tests

New file `server/test/plan-week-sessions.test.ts`:

- [ ] **Migration (in-memory, mirrors `daily-recap.test.ts`)**: fresh `new BetterSqlite3(':memory:')` + `runMigrations(db)` creates table `planning_sessions`; `PRAGMA table_info` contains all ten columns; the index `ix_planning_sessions_owner` exists (`SELECT name FROM sqlite_master WHERE type='index' AND name='ix_planning_sessions_owner'`); `integrity_check` = `'ok'` and `foreign_key_check` = `[]`; re-running `runMigrations(db)` applies nothing (idempotent).
- [ ] **FK cascade**: inserting a session for a temp owner then deleting the owner (with `PRAGMA foreign_keys=ON`) removes the session row.
- [ ] **Round-trip (shared DB via `startTestServer` + `api` helper, `resetDb()` in `beforeEach`)**: `POST` open (`entry_branch:'fill_week'`) → `201` with `status:'open'`, `transcript:[]`, `llm_used:false`; `PATCH` append a `{role:'user',text}` message → transcript length 1 with a filled `ts`; `PATCH` close `{status:'completed', summary:'x', llm_used:true}` → `ended_at` set, `status:'completed'`, `llm_used:true`; `GET` list returns it newest-first; `GET` by id matches; `DELETE` → `{ok:true}` then `GET` by id → `404`.
- [ ] **Enum validation**: `POST` with `entry_branch:'bogus'` → `422`; `PATCH` close with `status:'bogus'` → `422`.
- [ ] **Not found**: `PATCH`/`GET`/`DELETE` on an unknown id → `404`.
- [ ] **Owner isolation**: owner A opens a session; a request as `SECOND_OWNER_ID` (`x-test-owner` header, owner created via `createOwner`) cannot `GET`-by-id (`404`), does not see it in `list`, and cannot `DELETE` it (`404`); A still sees it afterward.

```
# verification commands
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client build
```

## Acceptance Criteria

- [ ] Given a fresh DB, when migrations run, then `planning_sessions` and `ix_planning_sessions_owner` exist, `integrity_check` is `ok`, and a second migrate run is a no-op.
- [ ] Given an authenticated owner, when they `POST /api/plan-week/sessions {entry_branch:'review'}`, then a row is created `status='open'`, `transcript='[]'`, `llm_used=0`, and `201 { session }` is returned with `transcript` as an array.
- [ ] Given an open session, when the owner `PATCH`es a `message`, then it is appended to the transcript with an ISO `ts`; when they `PATCH` `{status:'completed', summary, llm_used:true}`, then `ended_at` is stamped and the fields persist.
- [ ] Given two owners, when owner B requests owner A's session by id, then B gets `404` and never sees A's row in `list` — proving owner scoping.
- [ ] Given an invalid `entry_branch` or `status`, when submitted, then the API responds `422` and writes nothing.
- [ ] No child/events table, UI, LLM summary, SSE, GraphQL, or audit was introduced.

## Subtasks

1. [ ] Write `0127_planning_sessions.ts` (additive `db.exec` CREATE TABLE + INDEX, no `manual`); register `m0127` in `migrations/index.ts`.
2. [ ] Add the `planningSessions` Drizzle table def to `schema.ts` (no index in callback, no `onDelete` on owner ref).
3. [ ] Implement `services/planning-sessions.ts` (types, enum sets, `hydrate`, the seven self-scoped functions).
4. [ ] Implement `routes/plan-week.ts` (five endpoints, status-code mapping) and register `planWeekRouter()` in `routes/index.ts`.
5. [ ] Add `api.planWeek.session.*` methods + types to `client/src/lib/api.ts`.
6. [ ] Add `DELETE FROM planning_sessions;` to `resetDb()` in `server/test/helpers.ts`.
7. [ ] Write `server/test/plan-week-sessions.test.ts` (migration + FK cascade + round-trip + enum + not-found + owner-isolation).
8. [ ] Run the four verification commands; fix until green.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
