# [Factory] Triality T4 — REST surface (`/api/triality/next` + `/feedback`)

> **Type:** Backend (routes) · **Phase:** Triality Wave 3 · **Branch:** `feat/triality-rest` · **Commit style:** `feat(triality): REST routes, 404 while flag off` · **Design:** `docs/triality-design.md` §8 · **Dependencies:** T3

## Goal

Thin route adapters over T3's service: `GET /api/triality/next` (compute, log
`shown`, return picks + vector + log ids) and `POST /api/triality/feedback`
(`{log_id, outcome}` → `stampOutcome`). Both **404 while `triality_enabled` is off**.

## Non-goals

No GraphQL (T5), no UI (T6), no logic in routes — everything through
`services/triality.ts`. No SSE events, no audit-log writes beyond the standard
mutating-route stamp on feedback (see pins). No pagination/history read endpoint
(the log is write-mostly fuel; a read surface is unscoped future work).

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- **Flag-gating idiom:** `routes/calibration.ts` — "Every route 404s while the
  owner's `time_sense_enabled` flag is off"; copy that structure for
  `triality_enabled`. The client learns the flag from `GET /api/prefs`, never by
  probing.
- Router shape: `export function trialityRouter()` returning `@koa/router`, mounted
  in `routes/index.ts` alongside `metricsRouter()` (L34/L75 when drafted).
- Owner identity: `currentOwnerId()`; scopes: read for GET, write for POST — match
  how `routes/metrics.ts` (read) and `routes/tasks.ts` close route (write) declare
  theirs.
- **WHO-stamp rule (owner ruling 2026-07-16):** feedback is a user-initiated write →
  `writeAudit` with the owner actor, matching mutating-route convention; the GET is
  read-only and must NOT audit or stamp anything beyond its `triality_log` inserts.
- 422 for a malformed body / unknown `outcome` / foreign `log_id` (owner-scope check
  — a log row belonging to another owner is a 404, not a 403; multi-tenant
  convention: don't confirm existence).
- Client API: extend `client/src/lib/api.ts` with `api.triality.next()` /
  `api.triality.feedback()` typed to the T3 shapes (snake_case wire, per prefs).

## Before implementation

Read: `routes/calibration.ts` (gating), `routes/metrics.ts` (read-route shape),
`routes/index.ts` mount list, T3's exported types.

## Files impacted

- **New:** `server/src/routes/triality.ts`, `server/test/triality-routes.test.ts`
- **Changed:** `server/src/routes/index.ts`, `client/src/lib/api.ts`

## Schema required

None.

## Definition of Done

- [ ] Flag off → both routes 404; flag on → GET returns picks or the typed refusal;
      POST stamps outcomes exactly once
- [ ] Every GET that returns picks appends matching `shown` rows and returns their ids
- [ ] Response includes the situation vector + full score breakdowns (the arithmetic
      IS the explanation — §8)

## Tests (route-level, `test/helpers.ts` idiom, x-test-owner headers)

- [ ] 404 when flag off (both verbs); 200/typed-refusal when on
- [ ] GET twice on frozen fixtures → identical picks, but *distinct* log rows
      (shown is an event, not a cache)
- [ ] feedback: valid stamp → `outcome_at` set once; repeat → `changed:false`;
      unknown outcome → 422; other owner's `log_id` → 404
- [ ] cross-tenant: owner B's GET never sees owner A's candidates or log ids
      (two-owner fixture — the #369 lesson class)
- [ ] audit: feedback writes one audit row; GET writes none

Verify: `pnpm --filter server test` · `pnpm typecheck` · `pnpm --filter client typecheck`.

## Acceptance Criteria

`curl` against a seeded flag-on owner returns three picks with score breakdowns;
flag-off owner gets 404s; the README HTTP-API table addition is drafted in T7 (not
here — docs move in one ticket).

## Subtasks

1. Router + gating + mounts
2. GET wiring (compute → logShown → respond)
3. POST feedback (validate → stampOutcome → audit)
4. api.ts client methods
5. Test battery above
