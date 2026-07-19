> **Type:** Backend + Frontend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/plan-week-llm-followups`
> **Commit style:** `feat(plan-week): LLM hybrid follow-up steps`
> **Design:** this ticket is the spec (FTUE framing in `docs/ftue-plan.md`)
> **Dependencies:** T3, T4, T5 (the three branch components + their fixed deterministic top-3), and T2 (the `PlanWeekAssistant` shell + its session transcript store these branches render inside)

> ### 🚧 LIVE — issue #343, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.

## Goal

Inside a Plan-Week branch, when the AI half of the app is usable (`aiAvailable()`), generate a **contextual follow-up question + exactly 3 suggested answer options** through the existing `renderCopy` Voice loop — the "hybrid" layer that sits *on top of* each branch's fixed deterministic top-3. When Ollama is down (or every draft fails the voice gate), the step degrades to the branch's fixed deterministic question + top-3 sub-steps from T3/T4/T5, with zero user-visible failure.

Deliver a new endpoint `POST /api/plan-week/next-step` → `{ question, options: string[3], source: "model" | "fallback" }`, backed by a service that renders every human-facing line through `renderCopy` (NO raw `generate()`/`generateJson()`, NO tools, NO websearch). The client gates the LLM call on `aiAvailable()` and records the returned `source` into the `PlanWeekAssistant` session transcript.

## Non-goals (fence off adjacent work)

- Do **not** build or modify T2 (`PlanWeekAssistant.tsx`) beyond wiring the LLM path + recording `source`; do **not** build T3/T4/T5 — this ticket *consumes* their fixed top-3, it does not author them.
- Do **not** add free-text / natural-language parsing of the user's answer — that is T8. This step only *offers* a question + 3 chips.
- Do **not** author or mutate a plan/schedule here — that is T9. This endpoint writes nothing but the `copy_history` anti-repetition window that `renderCopy` maintains.
- Do **not** call `generate()` / `generateJson()` / `parseJsonLoose()` directly, add tools, or add websearch. Every model line goes through `renderCopy` and its deterministic gate.
- Do **not** add a new LLM provider or any cloud inference. Ollama-only, via `renderCopy` → `mcp/ollama.ts` (local-first invariant).
- Do **not** duplicate the branch's fixed top-3 on the server. The server renders *on top of* the deterministic question + options the client supplies in the request body.
- Do **not** add a migration or any schema. `copy_history` (migration `0109_copy_history`) already backs `renderCopy`; a new surface is just a new key in the surface catalog + union.

## Pinned conventions

Verified against the current tree — match these exactly:

- **Voice loop is the only model path.** `renderCopy(surface, payload, opts?)` in `server/src/agents/render-copy.ts` returns `{ text, source: 'model' | 'fallback', surface }`, is bounded (draft + one regen), gate-checked (`server/src/agents/voice-gate.ts`), anti-repetitive, and **never throws** on an Ollama outage. Add surfaces by editing BOTH the `Surface` union (line ~33-41) AND the `SURFACES` catalog (line ~75-170). The narrative surfaces (`daily_brief`, `eod_alignment`, `weekly_review`) already use the caller-supplies-facts-and-fallback shape — model this ticket's surfaces on that shape: `required: () => []`, `facts: (p) => str(p.facts)`, `fallbacks: [(p) => str(p.fallback) || str(p.facts)]`.
- **`renderCopy` owner scoping.** It resolves `currentOwnerId()` when `opts.ownerId` is omitted; the route runs inside `runWithOwner` (via `requireAuth`), so the service can call `renderCopy(surface, payload)` with no explicit owner.
- **Gate facts (do not fight them):** the gate bans emoji + the phrase list in `voice-gate.ts` (`just`, `simply`, `leverage`, `seamless`, `empower`, `let's`/`lets`, `great job`, …), enforces `maxLen`, required datums, and anti-repetition. A `?` is allowed (question marks are not banned). A model draft that trips the gate twice → the deterministic fallback template. This is the same degrade path as every other surface.
- **Routes/services layout.** Service in `server/src/services/plan-week.ts` (new — no plan-week service exists today); route in `server/src/routes/plan-week.ts` (new), exporting `planWeekRouter()` and registered in `server/src/routes/index.ts` (import + append to the `mountRoutes` array). Handlers read `currentOwnerId()` from `server/src/lib/context.ts` (throws if unscoped).
- **Auth/scopes.** `/api/plan-week/*` is NOT in `PUBLIC_PREFIXES` (`server/src/lib/auth/requireAuth.ts`), so it is auth-gated. It is a `POST`, so the scope gate requires `planning:write` — correct here, because `renderCopy` writes the `copy_history` window.
- **This endpoint never 503s.** Unlike `POST /api/plan/instruct` (Ollama-down ⇒ 503), `next-step` must ALWAYS return a usable step. Ollama-down / gate-rejected ⇒ `source: "fallback"` with the caller's deterministic question + options, HTTP 200. The only error status is `422` for a malformed request body.
- **Client API + gating.** Add `api.planWeek.nextStep(...)` in `client/src/lib/api.ts` using the existing `request<T>(method, path, body)` helper (base `/api`). AI gating is `aiAvailable()` from `client/src/stores/index.ts` (fail-closed: false while integrations load or on error). The client calls the endpoint ONLY when `aiAvailable()` is true; when false it uses the branch's local fixed top-3 directly and never touches the network.
- **Ids/timestamps.** N/A for this ticket (no new rows authored beyond `copy_history`, which `renderCopy` already manages via `uuid7()`).

## Before implementation

Read these first and match what is actually there — do not guess:

- `server/src/agents/render-copy.ts` — the `Surface` union, the `SURFACES` catalog shape (`tier`, `maxLen`, `historyK`, `lengthHint`, `required`, `facts`, `fallbacks`), the `str()` helper, and the narrative-surface pattern (`daily_brief` et al.) you are copying.
- `server/src/agents/voice-gate.ts` — the banned-phrase list and gate reasons, so the follow-up copy stays inside the voice (avoid `let's`, exclamation marks, emoji).
- `server/src/mcp/ollama.ts` — confirm you never import `generate`/`generateJson` in this ticket; the only Ollama access is transitive, through `renderCopy`.
- `server/src/routes/plan.ts` + `server/src/routes/llm.ts` — the router/handler shape (`new Router()`, `router.post(...)`, `ctx.request.body`, `ctx.status`, `ctx.body`) and `currentOwnerId()` usage.
- `server/src/routes/index.ts` — the import + `mountRoutes` array registration pattern.
- `server/test/render-copy.test.ts` + `server/test/instruct.test.ts` + `server/test/helpers.ts` — how `../src/mcp/ollama.js` `generate` is mocked (`vi.mock` + `vi.fn`), how `resetDb()` / `startTestServer()` / the `api()` helper drive service and route tests.
- `client/src/lib/api.ts` (the `request<T>` helper at top; the `plan` and `llm` namespaces) and `client/src/stores/index.ts` (`aiAvailable()` at line ~302).
- **T2** `PlanWeekAssistant.tsx` — find the exact session-transcript store/signal (the thing you append the step + `source` to). **T3/T4/T5** branch components — find each branch's discriminator id, its fixed deterministic follow-up question, and its fixed top-3 option strings (these become the `fallbackQuestion` / `fallbackOptions` the client passes to the endpoint). These files do not exist in this worktree yet; they land with the dependency tickets.

## Files impacted

**New:**
- `server/src/services/plan-week.ts` — `planWeekNextStep(input)` service.
- `server/src/routes/plan-week.ts` — `planWeekRouter()` exposing `POST /api/plan-week/next-step`.
- `server/test/plan-week-next-step.test.ts` — service + route tests (mocked Ollama).
- `client/test/plan-week-api.test.ts` *(or the client test dir convention in use — confirm at implementation time)* — `api.planWeek.nextStep` contract test (mocked `fetch`).

**Changed:**
- `server/src/agents/render-copy.ts` — add `plan_week_followup` + `plan_week_option` to the `Surface` union and the `SURFACES` catalog.
- `server/src/routes/index.ts` — import + register `planWeekRouter()`.
- `client/src/lib/api.ts` — add the `planWeek.nextStep` method + `PlanWeekNextStepInput` / `PlanWeekNextStep` types.
- `client/src/views/PlanWeekAssistant.tsx` (or the T3/T4/T5 branch component that renders the step) — call `nextStep` when `aiAvailable()`, else use the local fixed top-3; record `source` into the T2 session transcript. *Wire only; do not restructure the T2 shell.*

## Schema required

None. No migration. `renderCopy` already persists its anti-repetition window to `copy_history` (created by `0109_copy_history`, columns `id, owner_id, surface, signature, created_at`); `surface` is free TEXT with no enum/CHECK constraint, so new surface names need no DDL. (Next free migration slot on main is `0127`, but this ticket assigns none.)

## Contract (pin these exactly)

Endpoint: `POST /api/plan-week/next-step`

Request body:
```jsonc
{
  "branch": "objectives",              // string discriminator of the active T3/T4/T5 branch (grounds the model)
  "context": { "openObjectives": 3 },  // flat record of deterministic facts to ground the follow-up (client-supplied)
  "fallbackQuestion": "Which objective matters most this week?",  // deterministic question for this branch (T3/T4/T5)
  "fallbackOptions": ["Ship the beta", "Close hiring", "Cut scope"] // the fixed top-3 (exactly 3 non-empty strings)
}
```

Response (HTTP 200):
```jsonc
{ "question": "…", "options": ["…", "…", "…"], "source": "model" | "fallback" }
```

`422` (no rendering attempted) when `fallbackQuestion` is missing/blank, or `fallbackOptions` is not an array of exactly 3 non-empty strings.

Service behavior (`planWeekNextStep`):
1. Render the question via `renderCopy('plan_week_followup', { facts: <serialized branch+context, capped at ~2000 chars>, fallback: fallbackQuestion })`.
2. **If the question render `source === 'fallback'`** (Ollama down or gate rejected): short-circuit — return `{ question: fallbackQuestion, options: fallbackOptions, source: 'fallback' }`. No per-option model calls (we already know the model is unusable).
3. **Else** (question `source === 'model'`): render exactly 3 options **sequentially** (not in parallel — sequential is required so `renderCopy`'s per-surface anti-repetition window makes the three chips distinct and so concurrent `copy_history` writes don't race), each `renderCopy('plan_week_option', { facts: <context + fallbackOptions[i] as the seed angle>, fallback: fallbackOptions[i] })`. Return `{ question, options, source: 'model' }`. A single option that internally degrades to its fallback does NOT flip the step's `source` — `source` reflects the QUESTION render (the step is model-driven).
4. Never throw. `renderCopy` is outage-safe; the route wraps nothing extra except body validation.

Surface catalog additions (`SURFACES`, `tier: 'small'`, caller-supplies-facts-and-fallback shape):
```ts
plan_week_followup: {
  tier: 'small', maxLen: 160, historyK: 8,
  lengthHint: 'one short question, warm and specific, ending with a question mark',
  required: () => [],
  facts: (p) => str(p.facts),
  fallbacks: [(p) => str(p.fallback) || str(p.facts)],
},
plan_week_option: {
  tier: 'small', maxLen: 48, historyK: 12,
  lengthHint: 'a terse answer chip, 2-5 words, no trailing period',
  required: () => [],
  facts: (p) => str(p.facts),
  fallbacks: [(p) => str(p.fallback) || str(p.facts)],
},
```

## Definition of Done

- [ ] `plan_week_followup` + `plan_week_option` exist in both the `Surface` union and the `SURFACES` catalog in `render-copy.ts`, matching the narrative-surface shape above.
- [ ] `planWeekNextStep` renders every line through `renderCopy` — no import of `generate`/`generateJson`/`parseJsonLoose`, no tools, no websearch.
- [ ] `POST /api/plan-week/next-step` returns `{ question, options: string[3], source }`, `options.length === 3` in every branch, registered in `routes/index.ts`, auth-gated (write scope), never returns 503.
- [ ] Ollama-down and all-drafts-rejected paths return `source: "fallback"` with `fallbackQuestion` + `fallbackOptions` verbatim, HTTP 200.
- [ ] `422` on a malformed body (blank `fallbackQuestion` or `fallbackOptions` not exactly 3 non-empty strings), with no `renderCopy` call.
- [ ] `api.planWeek.nextStep` + typed `PlanWeekNextStepInput` / `PlanWeekNextStep` added to `client/src/lib/api.ts`.
- [ ] Client calls the endpoint ONLY when `aiAvailable()` is true; when false it uses the branch's local fixed top-3 with no network call.
- [ ] The returned `source` is recorded into the `PlanWeekAssistant` session transcript (T2 store).
- [ ] All verification commands below pass.

## Tests

Server (`server/test/plan-week-next-step.test.ts`, mock `../src/mcp/ollama.js` `generate` as a `vi.fn`, mirror `render-copy.test.ts` + `instruct.test.ts`; use `resetDb()`, `startTestServer()`, the `api()` helper):

- [ ] Service: model returns a clean question + 3 clean options ⇒ `source: 'model'`, `options.length === 3`, and `copy_history` gains rows for `plan_week_followup` + `plan_week_option`.
- [ ] Service: the 3 rendered options are distinct (per-surface anti-repetition; assert `new Set(options).size === 3`).
- [ ] Service: Ollama down (`generate` rejects) ⇒ `source: 'fallback'`, `question === fallbackQuestion`, `options` deep-equal `fallbackOptions`, and NO option-level model calls beyond the single question attempt.
- [ ] Service: model keeps emitting banned copy (e.g. `"Let's just simplify."`) ⇒ question falls back ⇒ `source: 'fallback'` with the deterministic question + options.
- [ ] Route: `POST /api/plan-week/next-step` with a valid body ⇒ 200 and the `{ question, options[3], source }` shape.
- [ ] Route: never 503 — with `generate` rejecting, the endpoint still returns 200 + `source: 'fallback'`.
- [ ] Route: `422` when `fallbackOptions` has length ≠ 3, and when `fallbackQuestion` is blank — with `generate` NOT called.

Client (`client/test/plan-week-api.test.ts` — confirm the client test dir/convention in use; mock `fetch`):

- [ ] `api.planWeek.nextStep(input)` POSTs to `/api/plan-week/next-step` with the input body and returns the typed `{ question, options, source }`.
- [ ] A non-OK response rejects (mirrors the `request<T>` error path).

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client build
pnpm --filter client test
```

## Acceptance Criteria

- [ ] Given `aiAvailable()` is true and Ollama is up, when a branch requests the next step, then the user sees a contextual question + 3 contextual chips and the transcript records `source: "model"`.
- [ ] Given Ollama is down (or `aiAvailable()` is false), when the branch advances, then the user sees the branch's fixed deterministic question + fixed top-3 and the transcript records `source: "fallback"` — with no error, no spinner-hang, and (when `aiAvailable()` is false) no network request.
- [ ] Given any response, `options` always has exactly 3 entries.
- [ ] Given a malformed request body, the endpoint returns `422` and no model call is made.
- [ ] No direct `generate`/`generateJson` call, no tool, no websearch, no new provider is introduced anywhere in the diff.

## Subtasks

1. [ ] Add `plan_week_followup` + `plan_week_option` to the `Surface` union and `SURFACES` catalog in `server/src/agents/render-copy.ts` (values as pinned).
2. [ ] Create `server/src/services/plan-week.ts` with `planWeekNextStep(input)` implementing the contract (question render → short-circuit-or-render-3-options-sequentially → `source` from the question render).
3. [ ] Create `server/src/routes/plan-week.ts` (`planWeekRouter()`, `POST /api/plan-week/next-step`, body validation → 422, else 200); register it in `server/src/routes/index.ts`.
4. [ ] Add `api.planWeek.nextStep` + `PlanWeekNextStepInput` / `PlanWeekNextStep` types in `client/src/lib/api.ts`.
5. [ ] In the T3/T4/T5 branch step (inside `PlanWeekAssistant`), call `nextStep` only when `aiAvailable()`, else use the local fixed top-3; record `source` into the T2 session transcript.
6. [ ] Write `server/test/plan-week-next-step.test.ts` (service + route, mocked Ollama) and the client api contract test.
7. [ ] Run all five verification commands; fix until green.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
