> **Type:** Backend + Frontend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/plan-week-parse`
> **Commit style:** `feat(plan-week): parse free-text answer to intent`
> **Design:** this ticket is the spec (see also `docs/ftue-plan.md` — the Weekly Planning Assistant sits on the FTUE "fewest clicks" goal)
> **Dependencies:** T3, T4, T5 (the plan-week backend + transcript state and the `PlanWeekAssistant` shell from T2 that this hangs off of)

> ### 🚧 LIVE — issue #344, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.

## Goal

When the Weekly Planning Assistant asks a question, let the user answer in **free text** (not just the option chips) and turn that answer into a **structured scheduling intent** — the same `{ pins, hints }` shape the deterministic planner already understands — by reusing the existing `parseInstruction` seam. The parse is **parse-only** (no side effects): it returns the structured intent and the assistant records it in the transcript; execution/authoring happens elsewhere (T9). Because `parseInstruction` is Ollama-required with **no deterministic fallback**, the free-text box is **hidden** whenever `aiAvailable()` is false — in that mode only the option chips work.

## Non-goals (fence off adjacent work)

- **Do not** add voice input — T14 layers speech-to-text on top of this exact text path; keep this a plain text input.
- **Do not** generate follow-up questions — that is T7.
- **Do not** author or place a plan, and **do not apply** the parsed intent — no `applyPins`/`applyHints`, no block creation, no `plan_hints` writes. Authoring is T9. This route parses and returns only.
- **Do not** add a deterministic NL parser or any non-Ollama parsing fallback. `parseInstruction` is Ollama-only by design; when AI is down the client hides the box (chips-only), it does not fall back to a local parser.
- **Do not** modify `POST /api/plan/instruct`, `instructPlan`, `parseInstruction`, `validateInstruction`, or the `plan_hints` / obstacle-block apply path. Reuse `parseInstruction` unchanged.
- **Do not** add a migration or touch the schema.

## Pinned conventions

Verified against the current tree (migration head `0126`):

- **`parseInstruction(owner, date, text): Promise<InstructResult>`** lives at `server/src/agents/plan.ts:877-894`. It **performs NO writes** — it validates fully and returns `{ pins, hints }`. It throws `InstructError('unavailable', …)` when Ollama is unreachable (`isAvailable()` false, or the `generateJson` call fails) and `InstructError('invalid', …)` when the output is malformed / references an unknown tag / is contradictory / yields nothing actionable. This is the seam to reuse — **not** `instructPlan` (`server/src/services/engine-ops.ts:82-88`), which additionally applies pins/hints and writes an audit row.
- **`InstructError`** (`server/src/agents/plan.ts:794-799`) carries `code: 'unavailable' | 'invalid'`. Map `'unavailable' → 503` and `'invalid' → 422`, exactly as `POST /api/plan/instruct` does at `server/src/routes/plan.ts:36-43`. Re-throw any non-`InstructError`.
- **`InstructResult`** (`server/src/agents/plan.ts:792`) = `{ pins: PlanPin[]; hints: PlanHint[] }`; `PlanPin = { title; start_at; end_at }` (UTC ISO), `PlanHint = { kind: 'tag_before'|'tag_after'|'batch'; tag; time? }` (`plan.ts:790-791`).
- **Auth / scope:** every `/api/*` route is already behind `requireAuth()` (mounted once in `server/src/app.ts:55`); a `POST` maps to `planning:write` via `requiredScope()` (`server/src/lib/auth/scopes.ts:9-18`). Do **not** add a per-route guard.
- **Owner scoping:** read the owner from `currentOwnerId()` (`server/src/lib/context.ts`), never from the request body — same as `server/src/routes/plan.ts:28`.
- **Date default:** `body.date ?? localISODate()` using `localISODate` from `../lib/dates.js` (matches `server/src/routes/plan.ts:2,27`).
- **Response shape:** mirror the instruct response **minus `created`** (there is no apply): `{ ok: true, date, pins, hints }`. Empty-text guard returns `422 { error: 'text is required' }` before any LLM call, matching `plan.ts:26`.
- **Client AI gate:** `aiAvailable()` from `client/src/stores/index.ts:302` — fail-closed: it is `false` while `integrations` loads or errors, so the box stays hidden rather than dangling (`stores/index.ts:293-302`).
- **Client types:** `PlanPin` and `PlanHint` are already exported from `client/src/lib/api.ts:671-672` — **reuse them, do not redefine**. `InstructResponse` (`api.ts:673`) carries `created`; the new parse response must NOT.

## Before implementation

Read these to match reality:

- `server/src/agents/plan.ts` — `parseInstruction` (`:877`), `InstructError` (`:794`), `InstructResult`/`PlanPin`/`PlanHint` (`:790-792`). Confirm `parseInstruction` writes nothing.
- `server/src/routes/plan.ts` — the `POST /api/plan/instruct` handler (`:23-47`): the exact 422/503 mapping, the empty-text guard, and how it defaults `date`. Copy the error mapping; **drop** the `instructPlan`/`broadcast`/audit apply half.
- `server/src/services/engine-ops.ts:82-88` — `instructPlan`, so you can see precisely what the parse-only route must **not** do (the `applyPins`/`applyHints`/`writeAudit`).
- `server/src/lib/auth/scopes.ts` + `server/src/lib/auth/requireAuth.ts` — confirm POST ⇒ write scope and that gating is global (no per-route work).
- `server/src/routes/index.ts` — the `mountRoutes` array; where a new/edited router is registered.
- `server/test/instruct.test.ts` — the Ollama-mock pattern (`vi.mock('../src/mcp/ollama.js', …)`, `parseResp`), the `startTestServer`/`resetDb`/`api` helpers, and the "no writes" assertions to mirror.
- `client/src/lib/api.ts` — the `plan` namespace (`:249-259`) and `api.plan.instruct` (`:258`); the `planWeek` namespace **if T3/T4/T5 introduced one**; the `PlanPin`/`PlanHint`/`InstructResponse` types (`:671-673`).
- `client/src/stores/index.ts` — `aiAvailable()` (`:302`) and the fail-closed `integrations` resource (`:293-302`).
- The `PlanWeekAssistant` component and its `PromptStep`, plus the **transcript** state — introduced by **T2 (component/`PromptStep`)** and **T3/T4/T5 (transcript + plan-week backend/router)**. Confirm the merged file path, the transcript entry type, and the transcript-append helper/signal against those branches; this ticket wires into them.

## Files impacted

**Changed:**

- `server/src/routes/plan-week.ts` — add the `POST /api/plan-week/parse` handler to the plan-week router that T3/T4/T5 introduced. **If that file does not exist at implementation time**, create it (`New:` below) exporting `planWeekRouter()` and register it in `server/src/routes/index.ts`.
- `server/src/routes/index.ts` — register `planWeekRouter()` in the `mountRoutes` array **only if T3/T4/T5 has not already registered it**.
- `client/src/lib/api.ts` — add `planWeek.parse(text, date?)` (into the existing `planWeek` namespace from T3/T4/T5, or a new one) and a `PlanWeekParseResponse` type. Reuse the existing `PlanPin`/`PlanHint`.
- `client/src/components/PlanWeekAssistant.tsx` — the component T2 created (**confirm the exact path T2 landed**). In `PromptStep`: render the free-text input only when `aiAvailable()`; on submit, call `api.planWeek.parse`, append the parsed intent to the transcript, and handle the `invalid` path.

**New (only if the router does not yet exist):**

- `server/src/routes/plan-week.ts` — `planWeekRouter()` with the parse handler.
- `server/test/plan-week-parse.test.ts` — route test (see Tests).
- `client/src/components/PlanWeekAssistant.parse.test.tsx` — gating + parse test (see Tests).

## Schema required

None. No migration, no table, no column. This ticket reuses `parseInstruction` (which reads `scheduling_prefs`/`tags` and writes nothing) and adds no persistence of its own.

## Definition of Done

- [ ] `POST /api/plan-week/parse { text, date? }` exists, gated by the global `requireAuth` (POST ⇒ `planning:write`), owner from `currentOwnerId()`.
- [ ] Empty/whitespace `text` ⇒ `422 { error: 'text is required' }` **before** any Ollama call.
- [ ] `date` defaults to `localISODate()` when omitted.
- [ ] Handler calls `parseInstruction(owner, date, text)` (parse-only) and returns `{ ok: true, date, pins, hints }` on success.
- [ ] `InstructError('unavailable')` ⇒ `503 { error }`; `InstructError('invalid')` ⇒ `422 { error }`; any other error re-throws. Mapping is byte-for-byte the same as `routes/plan.ts:36-43`.
- [ ] The route makes **no writes** — no `time_blocks` rows (`source_kind = 'instruct'`), no `plan_hints` rows, no `writeAudit`, no `broadcast`. Verified by a test that inspects the DB after a valid parse.
- [ ] `api.planWeek.parse(text, date?)` returns a `PlanWeekParseResponse` (`{ ok; date; pins; hints }`, **no `created`**) reusing exported `PlanPin`/`PlanHint`.
- [ ] In `PlanWeekAssistant`'s `PromptStep`, the free-text box renders **iff** `aiAvailable()` is true. When false, only the option chips are shown/usable.
- [ ] On a successful parse the assistant appends the parsed intent (the raw answer + `{ pins, hints }`) to the transcript using the T3/T4/T5 transcript mechanism.
- [ ] On a `422 invalid` parse the assistant shows an inline, non-destructive "couldn't turn that into a plan change — rephrase or pick an option" message, appends **no** intent, and leaves the chips available.
- [ ] `pnpm --filter server typecheck`, `pnpm --filter client typecheck`, `pnpm --filter client build` all clean; server + client test suites green.

## Tests

Server — `server/test/plan-week-parse.test.ts` (mock Ollama exactly like `server/test/instruct.test.ts`: `vi.mock('../src/mcp/ollama.js', …)` with a settable `ollamaUp` and a `parseResp` mock; use `startTestServer`/`resetDb`/`api` from `./helpers.js`):

- [ ] Valid parse ⇒ `200` and body `{ ok: true, date, pins, hints }` echoing the parsed `pins`/`hints`; body has **no `created`** field.
- [ ] Valid parse writes **nothing** — assert `0` rows in `time_blocks WHERE source_kind = 'instruct'` and `0` rows in `plan_hints` for the date (the parse-only invariant that separates this from `/api/plan/instruct`).
- [ ] Malformed / unknown-tag / contradictory / nothing-actionable output ⇒ `422` (drive each via `parseResp`, mirroring the instruct cases).
- [ ] Ollama down (`ollamaUp = false`) ⇒ `503`, and still no writes.
- [ ] Empty/whitespace `text` ⇒ `422` and **no** `generateJson` call (guard fires first).

Client — `client/src/components/PlanWeekAssistant.parse.test.tsx` (`@solidjs/testing-library` + `jsdom`, matching `client/src/components/QuickAdd.test.tsx`); mock `api.planWeek.parse` and the `integrations`/`aiAvailable` gate:

- [ ] `aiAvailable()` false ⇒ the free-text input is **not** in the DOM; option chips render.
- [ ] `aiAvailable()` true ⇒ the free-text input renders; submitting text calls `api.planWeek.parse` once and appends the returned intent to the transcript.
- [ ] A rejected parse (mock rejects with a `422`) surfaces the inline error, appends no transcript intent, and keeps the chips usable.

```
# verification commands
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client build
pnpm --filter client test
```

## Acceptance Criteria

- [ ] **Given** Ollama is reachable, **when** the user types "no meetings before 11" into a `PromptStep` and submits, **then** `POST /api/plan-week/parse` returns the structured `{ pins, hints }`, the assistant records it in the transcript, and **no** calendar block or `plan_hints` row is created.
- [ ] **Given** Ollama is unreachable (`aiAvailable()` false), **when** the `PromptStep` renders, **then** there is no free-text box and the user can still answer via the option chips.
- [ ] **Given** the model returns something un-parseable, **when** the user submits, **then** the route responds `422`, the assistant shows the inline rephrase hint, and the transcript is unchanged.
- [ ] **Given** the route is called with an empty body `text`, **then** it responds `422` without invoking Ollama.
- [ ] **Given** a valid parse, **then** the DB is byte-identical before and after (no `time_blocks`/`plan_hints`/audit rows) — this endpoint never applies.

## Subtasks

1. [ ] Add `POST /api/plan-week/parse` to `server/src/routes/plan-week.ts` (create the router + register in `routes/index.ts` if T3/T4/T5 didn't): empty-text guard → `parseInstruction` → `{ ok, date, pins, hints }`, with the 503/422 `InstructError` mapping copied from `routes/plan.ts`.
2. [ ] Add `server/test/plan-week-parse.test.ts` covering success, the no-writes invariant, 422 variants, 503, and the empty-text short-circuit.
3. [ ] Add `PlanWeekParseResponse` and `api.planWeek.parse(text, date?)` to `client/src/lib/api.ts`, reusing `PlanPin`/`PlanHint`.
4. [ ] In `PlanWeekAssistant`'s `PromptStep`, gate the free-text box on `aiAvailable()`, call `api.planWeek.parse` on submit, append the parsed intent to the transcript, and render the inline error on `invalid`.
5. [ ] Add `client/src/components/PlanWeekAssistant.parse.test.tsx` for the gating + parse-append + error paths.
6. [ ] Run all five verification commands; confirm clean typecheck/build and green suites.
