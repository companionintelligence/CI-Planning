> **Type:** Backend + Frontend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/plan-week-author`
> **Commit style:** `feat(plan-week): LLM-authored week ordering`
> **Design:** this ticket is the spec (weekly-planning FTUE framing in `docs/ftue-plan.md` §5–§6)
> **Dependencies:** T3 (the Fill-next-week branch component, its `POST /api/auto/run` call, and the assistant transcript surface)

## Goal

When the T3 Fill-next-week branch runs and the client's `aiAvailable()` gate is true, order **every day of the week horizon** with the smart `authorPlanOrder` loop — reusing the existing agent and the `POST /api/plan/reauthor` (`{ force: true }`) semantics — instead of the current "day 0 smart, future days deterministic" split. When AI is off / Ollama is down / a call fails mid-loop, `authorPlanOrder` already degrades to the deterministic order, so the week still gets planned. Surface an "(AI)" affordance **truthfully** from the returned `llm` flag (never from `aiAvailable()` alone) and record the AI-vs-deterministic outcome in the T3 assistant transcript.

## Non-goals (MANDATORY — fence off adjacent work)

- Do **not** invent a new ordering algorithm. Reuse `authorPlanOrder` and `deterministicIndices`/`tagGroupPostPass` exactly as they are.
- Do **not** remove or weaken the deterministic path. It stays the fallback for every not-AI case, and the existing T-SCHED-2 Hands-off auto-horizon (day 0 smart, future days `{ deterministic: true }`) must be **byte-identical** when the new `smart` flag is absent.
- Do **not** add a new endpoint. Extend the existing `POST /api/auto/run` (and its GraphQL twin) with an opt-in `smart` flag; T3 already calls this route.
- Do **not** build the reactive re-plan nudge / accept flow (that is `POST /api/plan/reauthor`, already shipped) — only reuse its `{ force: true }` semantics.
- Do **not** do NL instruction parsing (T8) or plan follow-ups / rationale surfacing changes (T7).
- Do **not** generate any human-facing LLM copy here. The "(AI)" marker is a static UI label driven by a boolean; it does **not** route through `renderCopy`.

## Pinned conventions

- **Single authoring entry point.** `authorPlanOrder(owner, date, opts)` (`server/src/agents/plan.ts:624`) is the only day-authoring function. It persists `daily_plan.source = 'llm' | 'deterministic'` via `persistOrder` (`plan.ts:238–256`), and it **already** degrades to `'deterministic'` when `planning_mode !== 'smart'`, when `isAvailable()` is false at the pre-flight (`plan.ts:662–666`), or when an LLM call throws mid-loop (`plan.ts:762–769`). The smart-vs-deterministic gate is `plan.ts:662–663`; the source stamp is `plan.ts:752`.
- **Reauthor semantics = `{ force: true }`.** `routes/plan.ts:65` calls `authorPlanOrder(owner, date, { force: true })`; `force` `DELETE`s the prior authored order (`plan.ts:632`) so the author-once guard (`plan.ts:633`) re-opens and the day is freshly (re)authored through the smart gate. This is exactly the per-day behavior T9 wants across the horizon.
- **The horizon loop lives in the service.** `autoRun` in `server/src/services/engine-ops.ts:125–155` resolves the day count and loops the existing single-day placement. Today future days author with `{ deterministic: true }` (`engine-ops.ts:141`) to avoid one LLM call per day for the **unattended** T-SCHED-2 Hands-off horizon. Keep that default; add the smart override behind the new flag. `writeAudit` fires inside `autoRun`; the transport does the `broadcast(...)`.
- **`AutoResult` is defined twice and must stay in sync:** server `server/src/engine/autoplan.ts:37–46` and client `client/src/lib/api.ts:635–640`. Add the same optional field to both. GraphQL `AutoResultPayload.result` is `JSON!` (`server/src/graphql/engine-ops.graphql:90–96`) so the new result field needs **no** GraphQL schema change; but `AutoRunInput` (`engine-ops.graphql:98–105`) gains `smart` for REST/GraphQL parity (the #287 parity discipline).
- **Ollama-only, fail-closed.** Client gate is `aiAvailable()` (`client/src/stores/index.ts:302`, `integrations()?.ollama.available ?? false`). The T3 branch passes `smart: aiAvailable()`; the "(AI)" affordance is rendered **only** from the returned `result.llm`, so it stays truthful if Ollama drops between the gate check and the server call. No raw `generate()`, no new prompt.
- **Owner scoping.** `autoRun` and both transports already resolve `currentOwnerId()`; no new scoping code. `authorPlanOrder` reads/writes `daily_plan` owner-scoped.
- **No migration.** `daily_plan.source` already exists (`0062_daily_plan.ts:31`, `TEXT NOT NULL DEFAULT 'deterministic'`). The new `AutoResult.llm` is a transient response field, not persisted. (Next free migration slot on main is `0127`, but this ticket claims none.)

## Before implementation

Read these first and match what is there:

- `server/src/agents/plan.ts` — `authorPlanOrder` (624–770): every return point, `persistOrder` (238–256), the smart/deterministic gate (662–681), the `force` delete (632), the source stamp (752), the mid-loop catch (762–769).
- `server/src/routes/plan.ts:61–71` — the `POST /api/plan/reauthor` `{ force: true }` semantics to reuse.
- `server/src/services/engine-ops.ts:100–155` — `AutoRunInput` and the `autoRun` horizon loop (the line to change is `141`).
- `server/src/routes/flight-plan.ts:85–99` — the `POST /api/auto/run` body parse and SSE broadcast.
- `server/src/graphql/engine-ops-resolvers.ts:118–132` and `server/src/graphql/engine-ops.graphql:90–105` — the GraphQL `autoRun` resolver + `AutoRunInput` (parity target).
- `client/src/lib/api.ts:240–241` (`auto.run` body type) and `:635–640` (client `AutoResult`).
- `client/src/stores/index.ts:290–302` — `aiAvailable()` and the fail-closed rationale.
- The **merged T3 PR**: the Fill-next-week branch handler (its `api.auto.run({ ... })` call) and the assistant transcript component that renders each step. T9's client edits live inside these.
- `server/test/authoring-llm.test.ts:12–77` — the `vi.mock('../src/mcp/ollama.js', …)` pattern (tier `'small'` = generate/revise → index array; `'medium'` = judge → score object; `isAvailable` toggled by `ollamaUp`). Also lines `88` and `138`, which assert `authorPlanOrder(...).resolves.toBeUndefined()` — these break once the return type changes and must be updated.
- `server/test/sched-horizon.test.ts` — the existing horizon integration test (setup helpers, `setMode`, `countOn`).

## Files impacted

**New:**

- `server/test/plan-week-author.test.ts` — smart-week authoring integration test (own `vi.mock` of `../src/mcp/ollama.js`, mirroring `authoring-llm.test.ts`).

**Changed:**

- `server/src/agents/plan.ts` — export `type PlanOrderSource = 'llm' | 'deterministic'`; change `authorPlanOrder`'s return type from `Promise<void>` to `Promise<PlanOrderSource>`; `return` the persisted source at **every** exit (see Schema/Subtasks for each).
- `server/src/services/engine-ops.ts` — add `smart?: boolean` to `AutoRunInput`; in the multi-day branch author each day with `{ force: true }` when `smart` (else keep `d === 0 ? {} : { deterministic: true }`); capture each day's returned source and set `AutoResult.llm = true` iff any day returned `'llm'`; set `llm` on the single-day branch from its captured source too.
- `server/src/engine/autoplan.ts` — add `llm?: boolean` to `interface AutoResult` (37–46).
- `server/src/routes/flight-plan.ts` — read `body.smart` and pass `smart` into `autoRun` (85–99).
- `server/src/graphql/engine-ops.graphql` — add `smart: Boolean` to `input AutoRunInput` (98–105).
- `server/src/graphql/engine-ops-resolvers.ts` — thread `input.smart ?? undefined` into the `autoRun` call (118–132).
- `client/src/lib/api.ts` — add `llm?: boolean` to `AutoResult` (635–640); add `smart?: boolean` to the `auto.run` body type (240–241).
- **T3's Fill-next-week branch handler + transcript component** (client; exact path from the merged T3 PR) — pass `smart: aiAvailable()` alongside `horizon_days` on the `api.auto.run(...)` call; after it resolves, append a transcript entry that shows the "(AI)" marker when `result.llm === true` and a plain "planned" entry otherwise.
- `server/test/authoring-llm.test.ts` — update the two `.resolves.toBeUndefined()` assertions (lines `88` and `138`) to `.resolves.toBe('deterministic')` (both scenarios end deterministic: `genThrows` and `ollamaUp = false`).

## Schema required

None. No migration.

- `daily_plan.source` already exists — `0062_daily_plan.ts:31`: `source TEXT NOT NULL DEFAULT 'deterministic'` (`'llm'` when the loop passed, else `'deterministic'`). T9 only **reads/returns** it.
- `AutoResult.llm?: boolean` is a transient response field on the in-memory result object (server `engine/autoplan.ts` + client `lib/api.ts`); it is not stored and needs no Drizzle/DDL change.
- GraphQL: `AutoResultPayload.result` is `JSON!` (opaque) → the `llm` field rides along with no schema edit; only `AutoRunInput` gains `smart: Boolean` for parity.

## Definition of Done

- [ ] `authorPlanOrder` returns `PlanOrderSource` (`'llm' | 'deterministic'`) truthfully at every exit: the already-authored no-op returns the **existing** persisted `daily_plan.source`; the `< 2` staged short-circuit and every deterministic/fallback/catch path return `'deterministic'`; the LLM success path returns `result.passed ? 'llm' : 'deterministic'` (same value it stamps into `daily_plan`).
- [ ] `autoRun` accepts `smart?: boolean`. When `smart` is true and `days > 1`, every horizon day is authored with `{ force: true }` (reauthor semantics) — no `{ deterministic: true }` on future days. When `smart` is absent/false, the loop is byte-identical to today (`d === 0 ? {} : { deterministic: true }`).
- [ ] `AutoResult.llm` is set on both branches: `true` iff at least one authored day returned source `'llm'`, else `false`.
- [ ] `POST /api/auto/run` reads `smart` from the body and forwards it; the GraphQL `autoRun` mutation forwards `input.smart`. Both transports produce the same `AutoResult` including `llm`.
- [ ] The T3 Fill-next-week branch passes `smart: aiAvailable()` with its `horizon_days`, and renders the "(AI)" transcript marker from `result.llm` (not from `aiAvailable()`), with a deterministic-planned entry otherwise.
- [ ] Existing T-SCHED-2 behavior is unchanged: a Hands-off / explicit-`horizon_days` run **without** `smart` still authors day 0 smart and future days deterministically, fires one aggregated `auto:placed`, and remains per-day idempotent.
- [ ] All verification commands below pass.

## Tests

- [ ] `plan-week-author.test.ts` — **smart week authors every day via LLM.** Mock Ollama up (`ollamaUp = true`), `planning_mode = 'smart'`, stage tasks, `POST /api/auto/run { date, horizon_days: 3, smart: true }`; assert `result.days === 3`, `result.llm === true`, and `daily_plan.source === 'llm'` for **each** of the 3 days.
- [ ] `plan-week-author.test.ts` — **`smart` off keeps the T-SCHED-2 split.** Same setup, `POST /api/auto/run { date, horizon_days: 3 }` (no `smart`); assert `result.llm !== true`, day 0 `source === 'llm'`, and days 1–2 `source === 'deterministic'`.
- [ ] `plan-week-author.test.ts` — **truthful fallback.** `ollamaUp = false`, `smart: true`, `horizon_days: 3`; assert `result.llm === false` and every day's `source === 'deterministic'`; the request does not throw (200).
- [ ] `plan-week-author.test.ts` — **idempotent re-run.** Run the smart week twice with the same staged set; assert no duplicate auto blocks per day (mirror `sched-horizon.test.ts:82–94`) — `force` re-author + per-day `clearPriorAuto` keep it stable.
- [ ] `plan-week-author.test.ts` — **`authorPlanOrder` return contract:** returns `'llm'` on a passing smart loop, `'deterministic'` when `ollamaUp = false`, and the existing persisted source on an already-authored no-op call.
- [ ] `authoring-llm.test.ts` — update lines `88` and `138` from `.resolves.toBeUndefined()` to `.resolves.toBe('deterministic')`.
- [ ] Client typecheck + build pass with the `AutoResult.llm` / `auto.run` `smart` additions and the T3 branch wiring; if T3 ships a fill-branch component test, extend it to assert the "(AI)" marker renders iff `result.llm === true`.

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client build
pnpm --filter client test
```

## Acceptance Criteria

- [ ] **Given** `planning_mode = 'smart'` and Ollama reachable, **when** the T3 Fill-next-week branch runs, **then** every day of the horizon is authored by the LLM (`daily_plan.source = 'llm'` per day), `result.llm === true`, and the transcript shows the "(AI)" marker.
- [ ] **Given** AI is off (basic mode) or Ollama is down, **when** the same branch runs, **then** the week is still fully planned via the deterministic order, `result.llm === false`, no error is thrown, and the transcript shows a plain "planned" entry (no "(AI)").
- [ ] **Given** a legacy Hands-off / explicit-`horizon_days` call **without** `smart`, **when** it runs, **then** placement, day counts, the single aggregated `auto:placed`, and per-day idempotence are byte-identical to pre-T9 behavior.
- [ ] **Given** the same `smart` + `horizon_days` input, **when** invoked via REST `POST /api/auto/run` vs the GraphQL `autoRun` mutation, **then** both return the same `AutoResult` (including `llm`) and write the same audit row.
- [ ] The "(AI)" affordance is derived solely from `result.llm`; toggling `aiAvailable()` in the client without a matching server result never shows a false "(AI)".

## Subtasks

1. [ ] `plan.ts`: export `type PlanOrderSource = 'llm' | 'deterministic'`; change `authorPlanOrder`'s signature to `Promise<PlanOrderSource>`.
2. [ ] `plan.ts`: add a `return` at each exit — already-authored no-op returns the current `daily_plan.source` (query it; default `'deterministic'`); `staged.length < 2` returns `'deterministic'`; `persistDeterministic()` paths + the mid-loop catch return `'deterministic'`; the LLM success path returns the `source` it computed (`result.passed ? 'llm' : 'deterministic'`).
3. [ ] `engine-ops.ts`: add `smart?: boolean` to `AutoRunInput`; in the `days > 1` loop, author each day via `authorPlanOrder(owner, day, smart ? { force: true } : (d === 0 ? {} : { deterministic: true }))`; track `llm ||= (src === 'llm')`; return `{ …, days, llm }`. In the single-day branch, capture the source and return `{ …result, llm: src === 'llm' }`.
4. [ ] `autoplan.ts`: add `llm?: boolean` to `interface AutoResult`.
5. [ ] `flight-plan.ts`: parse `body.smart` and pass `smart: body.smart` into `autoRun`.
6. [ ] `engine-ops.graphql`: add `smart: Boolean` to `input AutoRunInput`; `engine-ops-resolvers.ts`: forward `smart: input.smart ?? undefined`.
7. [ ] `client/src/lib/api.ts`: add `llm?: boolean` to `AutoResult`; add `smart?: boolean` to the `auto.run` body type.
8. [ ] T3 branch (client): pass `smart: aiAvailable()` with `horizon_days` on the fill call; append a transcript entry driven by `result.llm` (with the "(AI)" marker when true).
9. [ ] Add `server/test/plan-week-author.test.ts` with the five cases above (own Ollama mock); update `authoring-llm.test.ts` lines `88` and `138`.
10. [ ] Run all five verification commands; fix until green.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
