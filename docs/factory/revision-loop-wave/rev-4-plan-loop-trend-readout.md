> **Type:** Backend
> **Phase:** Revision-loop wave — the agent loop's write-only log
> **Branch:** `feat/plan-loop-trend`
> **Commit style:** `feat(learning): expose the plan-loop stats trend`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 3 (stats rows must be written).

## Goal

Make the loop falsifiable. Expose the `plan_loop_stats` trend so a human can answer
"is the §A0 authoring loop actually getting better — did that prompt edit move the
first-try pass rate?" This ticket is why the wave is not `plan_outcomes` again
(migration 0095 dropped that rollup precisely because nothing read it): without a
read surface, tickets 1–3 ship a second write-only log.

## Non-goals

- **Do not build a client view.** This ticket ends at the API, exactly like the
  close-loop wave's readout ticket; a Jobs-view chart is a listed follow-up.
- **Do not compute stats here.** Ticket 3 writes the rows; this reads them. A
  second computation path would drift from the first.
- **Do not add a reset endpoint.** `DELETE /api/classification/exemplars` exists
  because exemplars *influence behaviour*; nothing in this wave influences
  anything, so there is nothing to reset. (This is the wave's terminus decision —
  README "Decisions of record".)
- **Do not read `plan_revision_log` or `plan_loop_runs` in the route.** The trend
  is the rollup; raw-evidence drill-down endpoints are future work.
- **Do not read or expose `audit_log`.**
- **Do not add a feature-flag gate.** Follow `routes/classification.ts`, not
  `routes/calibration.ts`: this learning has no flag to be off; a fresh install
  simply has an empty trend.

## Pinned conventions

- **Route module:** new `server/src/routes/plan-loop.ts`, exporting
  `planLoopRouter()` built as `new Router({ prefix: '/api/plan-loop' })`. Model it
  on `server/src/routes/classification.ts` — the closest peer (a thin, ungated,
  owner-scoped adapter over a learning service; zero business logic in the route).
- **Registration:** `server/src/routes/index.ts` — import `planLoopRouter` and add
  `planLoopRouter(),` to the router array, adjacent to `classificationRouter()`.
- **Auth:** inherits the standard `/api/*` gate; owner comes from
  `currentOwnerId()` (`../lib/context.js`). No new scope.
- **Endpoint:** `GET /api/plan-loop/trend?limit=26`
  - `limit` clamps to [1, 365], default **26** (half a year of weekly rows):
    `Math.min(Math.max(Number((ctx.query as Record<string, string>).limit) || 26, 1), 365)`
    — the classification.ts:26 clamp shape.
  - **Service function**, not SQL in the route: add
    `planLoopTrend(ownerId: string, limit = 26)` to
    `services/plan-loop-learning.ts`, mirroring `accuracyTrend`
    (classification-learning.ts:581):
    `SELECT stage, computed_date, period_days, runs, passed, escaped, first_try_pass, avg_iterations, pass_rate
       FROM plan_loop_stats WHERE owner_id = ? ORDER BY computed_date DESC, stage LIMIT ?`.
  - **Response shape:** `{ runs: [...] }` rows returned **newest first** (the
    `accuracyTrend` / `GET /api/classification/accuracy` posture — a client that
    wants chronological reverses; do NOT copy metrics.ts's reverse-to-ASC here,
    state which convention you followed in a route comment).
  - **NULL is not zero.** `avg_iterations` / `pass_rate` serialise as `null` when
    NULL — a chart must draw a gap, never a line through the floor. Never `?? 0`.
- **Route header comment:** state that this is the wave's terminus — a trend a
  human reads before editing a prompt or threshold; there is deliberately no apply
  stage and no reset (cite README).
- **README.md (repo root) API table:** add one row for
  `GET /api/plan-loop/trend` wherever the other learning read surfaces
  (`/api/classification/accuracy`, `/api/metrics/calibration`) are listed — find
  them with `grep -n "classification/accuracy" README.md`.

## Before implementation

Read `server/src/routes/classification.ts` in full (the peer: prefix router, clamp,
no gate, owner scoping), `server/src/services/classification-learning.ts:576-592`
(`accuracyTrend` — the query shape), and `server/src/routes/index.ts:49-90` (the
registration array).

## Files impacted

**New:**
- `server/src/routes/plan-loop.ts`
- `server/test/plan-loop-routes.test.ts`

**Changed:**
- `server/src/services/plan-loop-learning.ts` — add `planLoopTrend`
- `server/src/routes/index.ts` — import + register `planLoopRouter()`
- `README.md` — API table row

## Schema required

None — ticket 1 created `plan_loop_stats`.

## Definition of Done

- [ ] `GET /api/plan-loop/trend` returns the owner's stats rows, newest first
- [ ] `limit` is honoured, clamped to [1, 365], and defaults to 26
- [ ] NULL `avg_iterations`/`pass_rate` serialise as `null`, never `0`
- [ ] The endpoint is owner-scoped and 401s unauthenticated
- [ ] An owner with no rows gets `{ runs: [] }`, not a 404
- [ ] The route contains no SQL — it calls `planLoopTrend`

## Tests

New `server/test/plan-loop-routes.test.ts`, seeding `plan_loop_stats` rows directly
(the route-test pattern used by the classification/calibration route tests):

- [ ] Returns only the calling owner's rows; a second owner's rows never appear
- [ ] Rows come back newest first (`computed_date DESC`, then `stage`)
- [ ] `limit=2` caps the result; omitted limit returns up to 26; `limit=0` and
      `limit=9999` clamp rather than error
- [ ] A row inserted with NULL `pass_rate` serialises `pass_rate: null` (assert
      strict `null`, not falsy)
- [ ] Unauthenticated request → 401
- [ ] Fresh owner → `{ runs: [] }` with status 200

```bash
pnpm --filter server exec vitest run test/plan-loop-routes.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given several weeks of smart-mode planning and Monday runs, when the trend
      is fetched, then one row per (stage, run date) comes back with pass rate,
      first-try passes, escapes and average iterations — enough to see a prompt
      edit move the numbers week over week
- [ ] Given a week with no smart-mode runs, then that week is simply absent — a
      gap, not a zero
- [ ] Given two owners, then neither can read the other's trend

## Subtasks

1. [ ] Add `planLoopTrend` to the service
2. [ ] Write `routes/plan-loop.ts` (header comment: the terminus decision)
3. [ ] Register the router in `routes/index.ts`
4. [ ] Add the endpoint to the root `README.md` API table
5. [ ] Write `plan-loop-routes.test.ts` (six cases above)
6. [ ] Run the verification commands, then the full suite
