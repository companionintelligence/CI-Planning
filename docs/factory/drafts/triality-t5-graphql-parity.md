# [Factory] Triality T5 — GraphQL parity (`trialityNext` / `trialityFeedback`)

> **Type:** Backend (GraphQL) · **Phase:** Triality Wave 3 · **Branch:** `feat/triality-graphql` · **Commit style:** `feat(graphql): triality query + feedback mutation` · **Design:** `docs/triality-design.md` §8 + §11.4 (owner-locked: parity ships with the build) · **Dependencies:** T3 (runs parallel to T4 — no shared files)

## Goal

Phase W parity by shared service layer: `trialityNext` query and
`trialityFeedback` mutation calling exactly the same `services/triality.ts`
entry points as the REST routes — including the flag gate, the refusal shape,
and the shown-row logging. A behavioral divergence from T4 is a bug by definition.

## Non-goals

No REST changes, no UI, no Relay connection (three picks max — a plain list type;
connections are for unbounded sets), no new service logic, no GraphiQL doc edits.

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- **Schema-first + auto-glob:** drop `triality.graphql` + `triality-resolvers.ts`
  into `server/src/graphql/` — `index.ts` readdirSync collects both (verified L10–46
  when drafted); **no registration edit anywhere**.
- Follow `flight-plan.graphql` / `flight-plan-resolvers.ts` as the closest shape
  (owner-scoped, small payload, mutation + query pair).
- Conventions from Phase W: `DateTime` scalar for `shown_at`/`outcome_at`; enums
  `TrialitySlot { HABITUAL CONTEXTUAL NOVEL }`, `TrialityOutcome { OPENED STAGED
  DISMISSED }` (GraphQL enums SCREAMING_CASE on the wire, mapped to the lowercase
  storage vocabulary in resolvers — pin the existing enum-mapping example in the
  W resolvers before writing your own).
- Flag off: same posture as REST — the resolver throws the standard not-found
  GraphQL error the W layer uses for gated resources (verify the exact error
  helper in the W resolvers; do NOT invent a `{enabled:false}` payload).
- Complexity: register field costs consistent with `complexity.ts` neighbors.

## Before implementation

Read: `graphql/index.ts` (glob + ordering comment), `flight-plan.graphql` +
resolvers, `complexity.ts`, one W enum mapping, T3/T4 tests for the behavior table.

## Files impacted

- **New:** `server/src/graphql/triality.graphql`,
  `server/src/graphql/triality-resolvers.ts`, `server/test/triality-graphql.test.ts`
- **Changed:** `server/src/graphql/complexity.ts` (only if neighbors register costs
  there — mirror, don't innovate)

## Schema required

None (SDL only).

## Definition of Done

- [ ] Query/mutation live at `POST /api/graphql` behind the same `requireAuth`
- [ ] Case-for-case parity with T4: flag-off, refusal, picks, once-only outcome
      stamping, cross-tenant invisibility

## Tests

- [ ] parity table: for each T4 route test, the GraphQL twin asserting the same
      observable (shared fixture builders — import, don't duplicate)
- [ ] enum round-trip: `HABITUAL` on the wire ↔ `habitual` in `triality_log`
- [ ] flag-off: gated error, and no log rows written
- [ ] introspection: types present; complexity within limit for the full query

Verify: `pnpm --filter server test` · `pnpm typecheck`.

## Acceptance Criteria

The same seeded owner gets byte-equivalent picks (modulo GraphQL envelope) from
REST and GraphQL in one test run.

## Subtasks

1. SDL
2. Resolvers over T3 service + enum mapping
3. Parity test battery
