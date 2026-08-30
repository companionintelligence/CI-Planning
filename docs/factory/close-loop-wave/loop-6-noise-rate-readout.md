> **Type:** Backend
> **Phase:** Close-loop wave — dismissed suggestions
> **Branch:** `feat/dismissal-rate-readout`
> **Commit style:** `feat(learning): expose the dismissal-rate trend and a reset`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 3 (rate rows must be written). Independent of 4 and 5 — can land in parallel.

## Goal

Make the loop falsifiable. Expose the `possible_dismissal_rate` trend so someone can answer
"is the review queue actually getting quieter?", and give the owner a reset that clears the
learned index without destroying the evidence.

Without this, the wave ships a learning system nobody can tell is working — which is exactly
the failure mode the audit that opened this wave was about.

## Non-goals

- **Do not build a client view.** This ticket ends at the API. There is no client surface for
  this feature and adding one is a separate decision.
- **Do not compute the rate here.** Ticket 3 writes the rows; this reads them. A second
  computation path would drift from the first.
- **Do not delete `possible_outcome_log` on reset.** Reset clears the *rollup* only, so the
  adaptation is re-earned from evidence the owner already generated. Deleting the log would
  make the reset unrecoverable.
- **Do not add a "disable learning" preference.** Out of scope for this wave; if one is
  wanted it belongs with the other channel gates in Settings, not here.
- **Do not backfill history** for periods before ticket 3 shipped.
- **Do not expose another owner's rows.** Every query filters `owner_id`.

## Pinned conventions

- **Route module.** New `server/src/routes/dismissal-learning.ts`, registered where the other
  route modules are. Follow `server/src/routes/calibration.ts` exactly — it is the closest
  peer (a read surface over a learning table plus a small mutation), including its
  `router.get('/scopes')` / `router.delete('/pins/:scopeRef')` shape.
- **Auth.** Inherits the standard `/api/*` gate; owner comes from `currentOwnerId()`. No new
  scope.
- **Endpoints:**
  - `GET /api/dismissal-learning/trend?limit=90` — the owner's `possible_dismissal_rate`
    rows, oldest → newest, capped. Mirrors `GET /metrics/calibration?limit=90`, which is the
    established shape for a dated learning trend.
  - `DELETE /api/dismissal-learning/exemplars` — clears this owner's rollup, returns
    `{ ok: true, cleared: <n> }`.
- **NULL is not zero.** `rate` comes back as `null` for a period with `decided = 0`. Serialise
  it as `null`, never coerce to `0` — a consumer must be able to draw a gap rather than a
  line through the floor.
- **Response shape.** `{ trend: [{ computed_date, period_days, created, decided, dismissed, rate, exemplars, hinted }] }`.

## Before implementation

Read `server/src/routes/calibration.ts` in full (the peer read surface), the
`GET /metrics/calibration` handler in `server/src/routes/metrics.ts` for the dated-trend
shape and its `limit` handling, and ticket 3's rate-writing code so the fields mean the same
thing on both sides.

## Files impacted

**New:**
- `server/src/routes/dismissal-learning.ts`
- `server/test/dismissal-learning-routes.test.ts`

**Changed:**
- wherever route modules are registered (match how `routes/calibration.ts` is wired)
- `README.md` — the API table

## Schema required

None — ticket 1 created `possible_dismissal_rate`.

## Definition of Done

- [ ] `GET /api/dismissal-learning/trend` returns the owner's rows oldest → newest
- [ ] `limit` is honoured and defaults to 90
- [ ] `rate` is `null`, not `0`, for an unmeasured period
- [ ] `DELETE /api/dismissal-learning/exemplars` clears only this owner's rollup and reports
      the count
- [ ] The evidence log is untouched by the reset
- [ ] Both endpoints are owner-scoped and 401 unauthenticated

## Tests

- [ ] The trend returns only the calling owner's rows
- [ ] Rows come back oldest → newest
- [ ] `limit` caps the result; the default is 90
- [ ] A period with `decided = 0` serialises `rate: null` (assert `null`, not falsy)
- [ ] Reset deletes the caller's exemplars and returns the count
- [ ] Reset leaves `possible_outcome_log` row-for-row intact
- [ ] Reset does not touch another owner's exemplars
- [ ] Both endpoints 401 without auth
- [ ] An owner with no rows gets `{ trend: [] }`, not a 404

```bash
pnpm --filter server exec vitest run server/test/dismissal-learning-routes.test.ts
pnpm --filter server exec vitest run server/test/routes.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given several weeks of runs, when the trend is fetched, then one row per run comes back
      in date order with `rate` populated for measured periods
- [ ] Given a week where nothing was decided, then that row's `rate` is `null`
- [ ] Given an owner resets, when the next calibration runs, then the rollup is rebuilt from
      the surviving evidence
- [ ] Given two owners, then neither can read or reset the other's data

## Subtasks

1. [ ] Read `routes/calibration.ts` and the metrics trend handler
2. [ ] Write `routes/dismissal-learning.ts` with both endpoints
3. [ ] Register the module alongside the other route modules
4. [ ] Add the endpoints to the `README.md` API table
5. [ ] Write `dismissal-learning-routes.test.ts` covering all nine cases
6. [ ] Run the verification commands
