# W — GraphQL CRUD layer — planning doc

**Status:** Planning only. **Depends on (soft):** Phase T (final owner-scoping shape), Phase U (auth context). Design work can start immediately; implementation should wait for T/U to stabilize so resolvers aren't built against a moving schema.

## Goal

Give the app a GraphQL CRUD surface, in addition to (not instead of) the existing REST API — **29 router files** under `server/src/routes/` (excluding `index.ts`), mounted in `server/src/routes/index.ts` (verified 2026-07-01; an earlier draft said "28") — client code, MCP tools, and any external integrations that already depend on REST keep working unchanged.

## Current state

100% REST today, Koa + `@koa/router`, one router file per resource area. No GraphQL dependency exists in `server/package.json`. Auth is a single Koa middleware (`requireAuth`) that resolves `ownerId` into `AsyncLocalStorage` (`lib/context.ts`), read by `currentOwnerId()` anywhere downstream — this pattern needs to extend cleanly into a GraphQL context, not be rebuilt separately.

## Real resource map (from the actual router list, not guessed)

| REST router | Likely GraphQL type(s) | Notes |
|---|---|---|
| `tasksRouter` | `Task` | Core entity — CRUD + subtasks (`parentId`) + recurrence fields |
| `blocksRouter` | `TimeBlock` | Core entity — the calendar |
| `blockTemplatesRouter` | `BlockTemplate` | |
| `possiblesRouter` | `PossibleTask` | Staging/inbox — promote→Task is a mutation with a side effect, not a plain field update |
| `tagsRouter` | `Tag` | Plus the `kind` discriminator ('pattern'\|'intention'\|'category') |
| `patternsRouter`, `patternBlocksRouter`, `patternPrefsRouter` | `Pattern`, `PatternBlock`, `PatternPref` | |
| `categoryPrefsRouter` | `CategoryPref` (or `TagPref` if S2 ships first — see `S-schema-consolidation.md`) | **Sequencing note:** if S2 (pattern/category-prefs merge) lands before W's implementation, design the GraphQL type against the *post-merge* shape, not the current two-table shape, to avoid redesigning twice. |
| `dayTypesRouter` | `DayType` | |
| `flightPlanRouter` | `FlightPlanEntry` | |
| `prefsRouter` | `SchedulingPrefs` | One object per owner — a 39-column type; consider whether GraphQL should expose it as one flat type (mirrors the DB) or broken into logical groups at the API layer even if the DB stays one table (a GraphQL-side grouping costs nothing structurally and reads better than a 39-field flat object) |
| `scheduleRouter`, `planRouter`, `plannerRouter` | Mutations/queries, not obviously simple CRUD (`find_slot`, autoplan triggers) — see note below | |
| `summaryRouter`, `reflectionsRouter`, `reviewRouter`, `objectivesRouter`, `starsRouter` | `DailyRecap`/`Reflection`/`Objective`/`DayStars` (or the merged `daily_recap` shape if S1 ships first — same sequencing note as above) | |
| `jobsRouter` | `ScheduledJob`, `JobRun` | Likely admin/internal-only in GraphQL — gate behind a scope |
| `notificationsRouter` | `PushSubscription`, `Reminder` | |
| `backupRouter` | Probably **excluded** from GraphQL — file-export/import semantics don't map cleanly to CRUD | |
| `oauthRouter`, `syncRouter` | Probably **excluded** — OAuth redirect flows aren't GraphQL operations | |
| `sseRouter` | GraphQL **subscriptions** are the natural analog if real-time push is wanted over GraphQL too — bigger scope decision, see below | |
| `memoryRouter`, `llmRouter` | Likely stays REST-only (AI/agent-facing, not a natural CRUD fit) | |
| `healthRouter` | Stays REST (liveness checks predate any API layer) | |

## Key open decisions

**1. Library.** Two realistic choices on top of Koa: `@graphql-yoga/node` (lightweight, framework-agnostic, easy Koa mounting) or `apollo-server-koa` (more ecosystem/tooling, heavier). Given this app's general preference for minimal dependencies (see how sparse `server/package.json` already is), **lean toward Yoga** unless there's a specific Apollo feature you need (e.g., Apollo Studio tracing) — but this is a real decision, not made here.

**2. Schema-first vs. code-first.** Schema-first (`.graphql` SDL files + resolver maps) is more explicit and easier to review in a PR; code-first (e.g., Pothos, building types in TypeScript) gets you type-safety derived from `schema.ts` more automatically. Given this codebase already treats `schema.ts` as a hand-maintained source of truth (not auto-generated), **schema-first probably fits the existing culture better** — but flag if type-safety-from-source is a higher priority.

**3. Does CRUD mean full mutability, or does GraphQL respect the same business-rule gates REST does?** Several "CRUD" operations in this app aren't plain field updates — e.g., completing a task also needs to reconcile `time_entries`/`actual_minutes`; promoting a `possible_task` creates a real `Task` row and updates staging state; deleting a task cascades through `time_blocks`/`reminders`/`flight_plan`. **The GraphQL layer should call the same service-layer functions the REST routes call (`services/*.ts`), not re-implement business logic against the DB directly** — this is the single most important design constraint to state up front, since it's the difference between "GraphQL is a second front door to the same house" (correct) and "GraphQL is a second house with its own rules" (a correctness and security risk — e.g., re-deriving owner-scoping checks twice is exactly how one of them ends up wrong).

**4. Real-time.** Does GraphQL need subscriptions (mirroring what SSE does today), or is GraphQL query/mutation-only, with SSE staying the one real-time channel for both REST and GraphQL clients? **Recommendation: skip subscriptions initially** — SSE already works, is simpler, and duplicating real-time transport is unnecessary scope. Revisit only if a GraphQL-native client specifically needs it.

**5. Auth context.** `requireAuth`'s output (`ownerId`, `scopes`) needs to flow into the GraphQL context function the same way it flows into Koa's `ctx` today — this is mechanical once U's auth modes are finalized (the GraphQL context function just reads `currentOwnerId()`, same as any REST handler does), not a new auth system.

## Dependencies & parallelization

- Full schema **design** (types, the resource map above, resolver-to-service mapping) can start now, in parallel with T and U.
- Final **implementation** should wait until T's owner-scoping and U's auth modes are locked, so resolvers read a stable `currentOwnerId()` contract.
- Fully parallel-safe with X (MCP vocabulary) and Y (env audit) — no overlap.
- **Sequencing note with S1/S2** (table consolidations from `S-schema-consolidation.md`): if those ship before W's types are finalized, design against the post-merge shape to avoid a rework.

## Effort estimate
**L** — not because any single resolver is hard, but because there are ~15-20 resource types once you exclude the non-CRUD routers, and the "call the same service functions as REST" discipline (decision #3) requires an audit of every route handler to find where business logic currently lives inline in the router vs. in a separate service file — some refactoring to extract shared logic may be needed *before* GraphQL can reuse it cleanly, which is itself worth scoping as a sub-ticket once decision #3 is confirmed.

## Definition of done
- [ ] Library + schema-first-vs-code-first decisions made.
- [ ] Full type list finalized against T's post-multi-tenant schema.
- [ ] Every resolver calls existing service-layer functions — no duplicated business logic or owner-scoping checks.
- [ ] Auth context wired through all three of U's auth modes.
- [ ] A representation doc (type ↔ REST route ↔ underly