> **Type:** Backend + Frontend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/logs-consolidate`
> **Commit style:** `feat(settings): consolidate planning logs`
> **Design:** this ticket is the spec (FTUE framing: `docs/ftue-plan.md`)
> **Dependencies:** T1 (`planning_sessions` table + `services/planning-sessions.ts` + `routes/plan-week.ts`), T6 (Settings **Logs** tab)

## Goal

Add a **"Consolidate (summarize)"** action to the Settings → **Logs** tab (T6) that collapses a user-selected set of planning sessions into ONE prose summary. A new endpoint `POST /api/plan-week/sessions/consolidate { ids: string[] }` returns `{ summary, source }`. When a reachable Ollama makes AI usable, the summary is generated through the `renderCopy` Voice loop (reusing the existing `weekly_review` surface); when Ollama is down, `renderCopy` degrades to a **deterministic digest** (session count, date range, branches used, and summed action / created-task counts) with **zero** raw model calls. The client shows an **"(AI)"** affordance on the result **only** when the returned `source === 'model'`.

## Non-goals (fence off adjacent work)

- **Do not delete** the source sessions on consolidate. Removal is the **Clear** action (T6) — consolidate is non-destructive.
- **Do not** build the Logs tab, the `planning_sessions` table, the `services/planning-sessions.ts` scaffolding, or the `plan-week.ts` router. Those are T1/T6 — this ticket adds ONE seam on top of them.
- **Do not** do per-turn / per-log-line analysis or call the model once per session. There is exactly one `renderCopy` call per consolidate request.
- **Do not** introduce a new LLM provider, raw `generate()`, tools, or websearch. All copy routes through `renderCopy` (Ollama-only invariant).
- **Do not** add a new `Surface` enum member and **do not** add a migration. Reuse the existing `weekly_review` surface and the existing `copy_history` table (migration `0109`); T1 already provides `planning_sessions.summary`.

## Pinned conventions

- **`renderCopy` medium-surface contract** (`server/src/agents/render-copy.ts`): call `renderCopy('weekly_review', { facts, fallback })`. The `weekly_review` surface already exists at `render-copy.ts:164-169` (`tier: 'medium'`, `maxLen: 900`, `historyK: 4`, `lengthHint: PARA_HINT`, `required: () => []`, `fallbacks: [(p) => str(p.fallback) || str(p.facts)]`). It returns `{ text, source: 'model' | 'fallback', surface }`, is **Ollama-down-safe (never throws)**, and emits the `fallback` string **verbatim** when the model is unavailable or the gate rejects every draft. `weekly_review` has **no other caller** today, so reusing it here is safe.
- **Summarizer pattern to mirror** (`server/src/agents/summarize.ts`): `summarizeEvening` (line 641) is the template — build a deterministic payload, pass a rich `facts` block AND a ready-to-show deterministic `fallback`, then `llm = copy.source === 'model'`. Owner timezone comes from `SELECT timezone FROM scheduling_prefs WHERE owner_id = ?` falling back to `serverTimezone()` (`summarize.ts:69-72`).
- **Owner scoping**: every read/write filters by `currentOwnerId()` (`server/src/lib/context.ts` — **throws if unscoped**). Resolve the selected `ids` **only** among the caller's own `planning_sessions` rows; ids belonging to another owner are silently ignored (never leaked, never mutated).
- **Auth**: routes are gated globally by `requireAuth()` mounted in `app.ts:55`; scope is derived from HTTP method (`hasScope(claims.scopes, ctx.method)`). A `POST` needs `planning:write`. **No per-route guard** and **no `PUBLIC_PREFIXES` change** — the handler just lives on T1's already-registered `plan-week.ts` router.
- **Route shape**: thin transport over the service (mirror `routes/reflections.ts`). Validate the body, call the service, shape the response; all SQL + `renderCopy` orchestration lives in `services/planning-sessions.ts`.
- **Client API**: add a method via the `request<T>(method, path, body?)` helper in `client/src/lib/api.ts` (path is relative to the `/api` base, e.g. `request<...>('POST', '/plan-week/sessions/consolidate', { ids })`). Align with T1's existing `api.planWeek` object.
- **AI gating**: `aiAvailable()` (`client/src/stores/index.ts:302`, fail-closed) governs whether AI *could* run, but the **"(AI)" badge on the consolidated result is gated on the returned `source` flag** (`source === 'model'`), because `renderCopy` may still fall back even when Ollama looked reachable. The Consolidate button itself is **always enabled** — it always produces at least the deterministic digest.

## Before implementation

Read, in order, and bind this ticket to the **as-merged** T1/T6 code (they are dependencies, not yet on this branch — confirm actual column/field/handle names before writing SQL):

1. `server/src/agents/render-copy.ts` — the `weekly_review` surface (lines 164-169) and the `renderCopy` return contract (lines 271-312).
2. `server/src/agents/summarize.ts` — `summarizeEvening` (line 630+), `fallbackEveningProse`, and the owner-tz lookup (lines 69-72) as the deterministic-digest template.
3. **T1 as merged**: `server/src/services/planning-sessions.ts` — confirm the `planning_sessions` columns (expected: `id`, `owner_id`, `created_at`, `branch`, `summary TEXT`, plus whatever T1 records for **action count** and **created-task count** — a count column, or related rows to `COUNT`). Bind the digest's counts to T1's real fields.
4. **T1 as merged**: `server/src/routes/plan-week.ts` — the existing router + any `broadcast(...)` SSE event T1 emits on a session mutation (reuse it after persisting; if T1 defines none, skip and rely on the response).
5. **T6 as merged**: `client/src/views/Settings.tsx` — the **Logs** tab (`activeTab` gains `'logs'`; today it is `'preferences' | 'connections'` at `Settings.tsx:62`), its session-selection state, and where a per-selection action bar mounts.
6. `client/src/lib/api.ts` — the `request` helper and T1's `api.planWeek` object. `client/src/stores/index.ts:302` — `aiAvailable()`.

## Files impacted

**New:**

- `server/src/services/planning-sessions-consolidate.test.ts` — service + owner-scoping tests (or extend T1's `planning-sessions.test.ts` if present; keep new cases in one place).

**Changed:**

- `server/src/services/planning-sessions.ts` — add `consolidateSessions(ids: string[]): Promise<{ summary: string; source: 'model' | 'fallback' }>` (deterministic digest builder + single `renderCopy('weekly_review', …)` call + persist).
- `server/src/routes/plan-week.ts` — add `POST /api/plan-week/sessions/consolidate` handler (validate `ids`, call the service, shape `{ summary, source }`).
- `client/src/lib/api.ts` — add `api.planWeek.consolidateSessions(ids: string[])`.
- `client/src/views/Settings.tsx` — wire the **"Consolidate (summarize)"** button into the Logs tab's selection action bar; render the returned summary; show the **"(AI)"** badge iff `source === 'model'`.

## Schema required

**None.** No migration. `planning_sessions` and its `summary` column are delivered by **T1**; the `copy_history` table used by `renderCopy` already exists (migration `0109`). (For reference only: the next free migration slot on main is `0127` — this ticket does not claim it.)

## Definition of Done

- [ ] `consolidateSessions(ids)` resolves the caller's own `planning_sessions` rows for `ids` (owner-scoped via `currentOwnerId()`), ordered by `created_at DESC`; ids not owned by the caller are ignored.
- [ ] It builds a **deterministic digest** string containing: the **session count**; the **date range** (`min → max` of `created_at`, date-only, owner timezone); the **distinct branches** used (sorted, deduped; a "no branch recorded" line when none); and the **summed action count + created-task count** (bound to T1's actual fields).
- [ ] It calls `renderCopy('weekly_review', { facts, fallback })` **exactly once**, passing the digest as **both** the model `facts` context and the `fallback`; `summary = copy.text`, `source = copy.source`.
- [ ] With no reachable Ollama, `consolidateSessions` returns the digest **verbatim** with `source: 'fallback'` and **never throws** (inherits `renderCopy`'s degrade contract).
- [ ] The consolidated `summary` is persisted onto the **newest selected** session's `planning_sessions.summary` (first row of the `created_at DESC` set); all source rows remain (no deletion, no new row).
- [ ] `POST /api/plan-week/sessions/consolidate` returns `200 { summary, source }`; a missing/empty/non-array `ids`, or an `ids` set that resolves to **zero** owned sessions, returns `422` with an `{ error }` body.
- [ ] The route is auth-gated by the global `requireAuth` (POST ⇒ `planning:write`); no `PUBLIC_PREFIXES` change.
- [ ] Client: `api.planWeek.consolidateSessions(ids)` posts the body and returns `{ summary, source }`.
- [ ] Client: the Logs tab shows a **"Consolidate (summarize)"** button that is enabled whenever ≥1 session is selected (works offline too); after the call it displays the summary and renders an **"(AI)"** badge **only** when `source === 'model'`.
- [ ] No new `Surface` member, no raw `generate()`, no tools/websearch, no new migration.

## Tests

Server tests are vitest (shared sequential DB, migration-on-import; new cases in `server/src/**/*.test.ts`). In CI there is **no reachable Ollama**, so `renderCopy` deterministically returns the fallback — assert the `source: 'fallback'` path and exact digest content.

- [ ] **digest content** — seed ≥2 `planning_sessions` for one owner across two dates and two branches with known action/created-task counts; `consolidateSessions([...])` returns `source: 'fallback'` and a `summary` containing the session count, the `min → max` date range, both branch names, and the summed counts.
- [ ] **persistence** — after consolidate, the newest selected session's `summary` equals the returned `summary`; the other selected rows are unchanged and **all rows still exist** (non-destructive).
- [ ] **owner scoping** — ids owned by a different owner are ignored: consolidating them from owner A neither reads nor mutates owner B's rows; an all-foreign / empty resolved set surfaces the `422` path (or the service returns an empty-selection error the route maps to `422`).
- [ ] **route** — `POST /api/plan-week/sessions/consolidate` with a valid owned `ids` returns `200 { summary, source }`; missing/empty/non-array `ids` returns `422`.
- [ ] **client (typecheck/build-gated)** — `api.planWeek.consolidateSessions` has the `{ summary, source }` return type and the badge helper shows "(AI)" iff `source === 'model'`; if no isolated unit exists, client `typecheck` + `build` are the gate (no Settings regression).

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client build
pnpm --filter client test
```

## Acceptance Criteria

- [ ] **Given** a user selects 3 sessions in the Logs tab **and** Ollama is reachable, **when** they click "Consolidate (summarize)", **then** one prose summary appears with an "(AI)" badge and it is saved to the newest selected session; the other two sessions remain listed.
- [ ] **Given** the same selection **but** Ollama is down, **when** they click Consolidate, **then** a deterministic digest (count, date range, branches, action/task totals) appears with **no** "(AI)" badge, and nothing errors.
- [ ] **Given** a request with `ids` from another owner, **when** it is processed, **then** no cross-owner data is read or written and the response is `422` (no owned sessions resolved).
- [ ] **Given** any consolidate, **then** no source session is deleted (Clear/T6 remains the only deletion path).
- [ ] `pnpm --filter server typecheck`, `pnpm --filter server test`, `pnpm --filter client typecheck`, `pnpm --filter client build`, and `pnpm --filter client test` all pass.

## Subtasks

1. [ ] Read T1's merged `planning-sessions.ts` + migration and T6's Logs tab; confirm the `planning_sessions` columns and the fields backing action / created-task counts.
2. [ ] Add `consolidateSessions(ids)` to `services/planning-sessions.ts`: owner-scoped resolve (`created_at DESC`), deterministic digest builder (owner-tz date range like `summarize.ts:69-72`), single `renderCopy('weekly_review', { facts, fallback })`, persist to the newest session's `summary`, return `{ summary, source }`.
3. [ ] Add `POST /api/plan-week/sessions/consolidate` to `routes/plan-week.ts`: validate `ids`, call the service, `422` on empty/invalid/zero-resolved, `200 { summary, source }`; reuse T1's session-updated SSE broadcast if one exists.
4. [ ] Add `api.planWeek.consolidateSessions(ids)` to `client/src/lib/api.ts`.
5. [ ] Wire the "Consolidate (summarize)" button + result display + source-gated "(AI)" badge into the Logs tab in `client/src/views/Settings.tsx`.
6. [ ] Write the server service + route + owner-scoping tests; run the five verification commands green.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
